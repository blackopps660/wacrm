import { AiError, type ChatMessage, type ToolCall, type ToolDefinition, type ToolResult } from '../types'
import { MAX_OUTPUT_TOKENS } from '../defaults'
import {
  mergeConsecutive,
  providerHttpError,
  toNetworkError,
  type ProviderAdapter,
  type ProviderArgs,
} from './shared'

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages'
const ANTHROPIC_VERSION = '2023-06-01'

interface AnthropicResponse {
  content?: { type?: string; text?: string }[]
}

/**
 * Anthropic's Messages API requires strictly alternating roles that
 * begin with `user`. Merge consecutive turns, then drop any leading
 * assistant turns (an agent greeting before the customer said anything)
 * so the transcript always starts on the customer. Guarantees a valid,
 * non-empty payload.
 */
function normalizeForAnthropic(messages: ChatMessage[]): ChatMessage[] {
  const merged = mergeConsecutive(messages)
  while (merged.length > 0 && merged[0].role === 'assistant') {
    merged.shift()
  }
  if (merged.length === 0) {
    return [{ role: 'user', content: '(The customer has not sent a message yet.)' }]
  }
  return merged
}

/**
 * Call Anthropic's Messages endpoint with the caller's own key.
 * Returns the raw assistant text (handoff parsing happens in
 * `generateReply`).
 */
export async function generateAnthropic(args: ProviderArgs): Promise<string> {
  const { apiKey, model, systemPrompt, messages, timeoutMs } = args

  let res: Response
  try {
    res = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        system: systemPrompt,
        max_tokens: MAX_OUTPUT_TOKENS,
        messages: normalizeForAnthropic(messages),
      }),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (err) {
    throw toNetworkError(err)
  }

  if (!res.ok) {
    throw await providerHttpError('Anthropic', res)
  }

  const data = (await res.json().catch(() => null)) as AnthropicResponse | null
  const text = data?.content
    ?.filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('')
    .trim()
  if (!text) {
    throw new AiError('Anthropic returned an empty response.', {
      code: 'empty_response',
    })
  }
  return text
}

// ============================================================
// Tool-calling adapter (agent actions — update tags/fields, trigger
// automations). Kept separate from `generateAnthropic` above so the
// plain text-only path (draft, playground without actions) is
// completely unaffected — no `tools` field is ever sent unless the
// agent loop explicitly built one.
// ============================================================

interface AnthropicBlock {
  type: string
  text?: string
  id?: string
  name?: string
  input?: Record<string, unknown>
  tool_use_id?: string
  content?: string
}

export interface AnthropicTurn {
  role: 'user' | 'assistant'
  content: string | AnthropicBlock[]
}

interface AnthropicToolResponse {
  content?: AnthropicBlock[]
}

function toAnthropicTools(tools: ToolDefinition[]) {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters,
  }))
}

export const anthropicAdapter: ProviderAdapter<AnthropicTurn> = {
  initialTurns(messages: ChatMessage[]): AnthropicTurn[] {
    return normalizeForAnthropic(messages).map((m) => ({ role: m.role, content: m.content }))
  },

  async generateTurn({ apiKey, model, systemPrompt, timeoutMs, turns, tools }) {
    let res: Response
    try {
      res = await fetch(ANTHROPIC_URL, {
        method: 'POST',
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': ANTHROPIC_VERSION,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          system: systemPrompt,
          max_tokens: MAX_OUTPUT_TOKENS,
          messages: turns,
          tools: toAnthropicTools(tools),
        }),
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (err) {
      throw toNetworkError(err)
    }
    if (!res.ok) throw await providerHttpError('Anthropic', res)

    const data = (await res.json().catch(() => null)) as AnthropicToolResponse | null
    const blocks = data?.content
    if (!blocks) {
      throw new AiError('Anthropic returned an empty response.', { code: 'empty_response' })
    }

    const text = blocks
      .filter((b) => b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('')
      .trim()

    const toolCalls: ToolCall[] = blocks
      .filter((b) => b.type === 'tool_use' && b.id && b.name)
      .map((b) => ({ id: b.id!, name: b.name!, arguments: b.input ?? {} }))

    return {
      text: text || null,
      toolCalls,
      assistantTurn: { role: 'assistant', content: blocks },
    }
  },

  appendToolResults(turns, assistantTurn, results: ToolResult[]): AnthropicTurn[] {
    return [
      ...turns,
      assistantTurn,
      {
        role: 'user',
        content: results.map((r) => ({
          type: 'tool_result',
          tool_use_id: r.id,
          content: r.content,
        })),
      },
    ]
  },
}
