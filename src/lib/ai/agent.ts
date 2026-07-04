import type { SupabaseClient } from '@supabase/supabase-js'
import type { AiConfig, ChatMessage, GenerateResult, ToolResult } from './types'
import { openAiAdapter } from './providers/openai'
import { anthropicAdapter } from './providers/anthropic'
import type { ProviderAdapter } from './providers/shared'
import { aiRequestTimeoutMs } from './defaults'
import { generateReply, parseGeneration } from './generate'
import { buildToolDefinitions, executeToolCall, simulateToolCall } from './tools'

// A tool-calling turn can bounce between "call a tool" and "read the
// result" several times before the model has enough to answer (e.g.
// tag the contact, then decide whether to also trigger an automation).
// Capped so a model that never stops calling tools can't loop forever
// on the account's own provider key.
const MAX_AGENT_ITERATIONS = 4

export interface AgentTurnArgs {
  config: AiConfig
  systemPrompt: string
  messages: ChatMessage[]
  db: SupabaseClient
  accountId: string
  /** Real contact/conversation to act on. Omit both (the Playground
   *  has no real contact) to run the exact same loop with simulated
   *  tool execution — no real writes happen, matching the "actions
   *  taken here are for testing only" contract test-chat UIs use. */
  contactId?: string
  conversationId?: string
}

/**
 * Generate the next reply, letting the model call any tools the
 * account has enabled (update tags/fields, trigger automations) along
 * the way. Falls back to the plain single-call `generateReply` when
 * there's nothing for the model to act on — either no action is
 * enabled, or an enabled action has no real tags/fields/automations to
 * offer — so the common case (most accounts have none of this turned
 * on) pays no extra latency or provider-request complexity.
 */
export async function runAgentTurn(args: AgentTurnArgs): Promise<GenerateResult> {
  const { config, systemPrompt, messages, db, accountId, contactId, conversationId } = args
  const simulate = !contactId || !conversationId

  const tools = await buildToolDefinitions(db, accountId, config.actions)
  if (tools.length === 0) {
    return generateReply({ config, systemPrompt, messages })
  }

  // Turn is opaque to this loop (see ProviderAdapter's own doc comment)
  // — erased to `unknown` here so the two providers' distinct wire
  // formats don't force TS to unify them into an impossible type.
  const adapter: ProviderAdapter<unknown> =
    config.provider === 'openai'
      ? (openAiAdapter as ProviderAdapter<unknown>)
      : (anthropicAdapter as ProviderAdapter<unknown>)
  const timeoutMs = aiRequestTimeoutMs()
  // `turns` starts as the plain transcript in the provider's own wire
  // format, then gains an assistant tool-call turn + tool-result turn
  // per loop iteration — same information a human agent would see if
  // they scrolled through "the bot checked X, then replied Y".
  let turns = adapter.initialTurns(messages)

  for (let i = 0; i < MAX_AGENT_ITERATIONS; i++) {
    const { text, toolCalls, assistantTurn } = await adapter.generateTurn({
      apiKey: config.apiKey,
      model: config.model,
      systemPrompt,
      timeoutMs,
      turns,
      tools,
    })

    if (toolCalls.length === 0) {
      return parseGeneration(text ?? '')
    }

    const results: ToolResult[] = []
    for (const call of toolCalls) {
      const result = simulate
        ? simulateToolCall(call)
        : await executeToolCall(db, call, {
            accountId,
            contactId: contactId!,
            conversationId: conversationId!,
          })
      results.push(result)
    }
    turns = adapter.appendToolResults(turns, assistantTurn, results)
  }

  // Exhausted the iteration cap without a final answer — treat it the
  // same as a model-requested handoff rather than sending nothing.
  return { text: '', handoff: true }
}
