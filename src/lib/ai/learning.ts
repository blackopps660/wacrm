import { supabaseAdmin } from './admin-client'
import { loadDefaultAiConfig } from './config'
import { retrieveKnowledge } from './knowledge'
import { generateReply } from './generate'
import type { ChatMessage } from './types'

export interface LearningCandidate {
  messageId: string
  conversationId: string
  accountId: string
  contentText: string
}

const NO_NEW_INFO = 'NO_NEW_INFO'

const EXTRACTION_SYSTEM_PROMPT =
  'You audit a human customer-support agent\'s WhatsApp reply to decide whether it teaches the business\'s AI assistant something reusable it does not already know — a process step, a policy, a fact, or how to phrase a common answer. ' +
  `You are shown: the recent conversation leading up to the agent's reply, and excerpts already in the knowledge base (if any). If the agent's reply is small talk, specific to this one customer (their name, their order, a one-off apology), or already fully covered by the existing excerpts, respond with exactly ${NO_NEW_INFO} and nothing else. ` +
  'Otherwise respond with ONLY a JSON object of the shape {"title": "short label", "content": "the reusable knowledge, written as a standalone fact/policy/answer a future agent or bot could use without seeing this conversation"} — no markdown fences, no extra text. ' +
  'Write the content generally (not "as I told you above"), in whatever language the business/agent is using. Never invent facts beyond what the agent actually said.'

/**
 * One self-learning pass over a single human agent reply (found by
 * `get_unprocessed_agent_messages()`, migration 060).
 *
 * Mirrors `maybeSendRescueReply`'s shape (own db client, own try/catch,
 * never throws, always marks the message processed in its `finally` so
 * a failure can't wedge the same message in an infinite retry loop).
 * Never writes to the live knowledge base directly — every finding
 * lands in `ai_knowledge_suggestions` as `pending` for a human to
 * approve or reject from Settings.
 */
export async function processAgentMessage(
  candidate: LearningCandidate,
): Promise<boolean> {
  const { messageId, conversationId, accountId, contentText } = candidate
  const db = supabaseAdmin()

  try {
    const config = await loadDefaultAiConfig(db, accountId)
    if (!config || !config.learningEnabled) return false

    // A few turns of lead-up context, as of when this reply was sent —
    // not "the last N messages now" (the conversation may have moved on
    // since) — bounded by this message's own created_at.
    const { data: selfRow } = await db
      .from('messages')
      .select('created_at')
      .eq('id', messageId)
      .maybeSingle()
    const cutoff = selfRow?.created_at ?? new Date().toISOString()

    const { data: contextRows, error: contextErr } = await db
      .from('messages')
      .select('sender_type, content_text')
      .eq('conversation_id', conversationId)
      .eq('content_type', 'text')
      .lte('created_at', cutoff)
      .order('created_at', { ascending: false })
      .limit(6)
    if (contextErr) return false

    const transcript = ((contextRows ?? []) as { sender_type: string; content_text: string | null }[])
      .reverse()
      .filter((m) => m.content_text && m.content_text.trim())
      .map((m) => `${m.sender_type === 'customer' ? 'Customer' : 'Agent'}: ${m.content_text!.trim()}`)
      .join('\n')

    if (!transcript.trim()) return false

    // Ground the "is this already known" check in the same retrieval the
    // bot itself uses, so a suggestion only surfaces for genuinely new
    // ground, not something already answerable from the KB.
    const existing = await retrieveKnowledge(db, accountId, config, contentText, 3)

    const userContent =
      `Conversation leading up to the agent's reply:\n${transcript}\n\n` +
      (existing.length > 0
        ? `Knowledge base excerpts already on file:\n${existing.map((k, i) => `[${i + 1}] ${k}`).join('\n\n')}\n\n`
        : 'Knowledge base excerpts already on file: (none yet)\n\n') +
      'Does the agent\'s reply above teach anything reusable not already covered?'

    const messages: ChatMessage[] = [{ role: 'user', content: userContent }]

    const { text } = await generateReply({
      config,
      systemPrompt: EXTRACTION_SYSTEM_PROMPT,
      messages,
    })

    const trimmed = text.trim()
    if (!trimmed || trimmed === NO_NEW_INFO || trimmed.includes(NO_NEW_INFO)) {
      return false
    }

    let parsed: { title?: unknown; content?: unknown } | null = null
    try {
      // Models occasionally wrap JSON in a code fence despite the
      // instruction not to — strip one if present before parsing.
      const jsonText = trimmed.replace(/^```(?:json)?\s*/, '').replace(/```\s*$/, '')
      parsed = JSON.parse(jsonText)
    } catch {
      console.warn(
        `[ai learning] message ${messageId}: model output wasn't valid JSON, skipping`,
      )
      return false
    }

    const title = typeof parsed?.title === 'string' ? parsed.title.trim() : ''
    const content = typeof parsed?.content === 'string' ? parsed.content.trim() : ''
    if (!title || !content) return false

    const { error: insertErr } = await db.from('ai_knowledge_suggestions').insert({
      account_id: accountId,
      conversation_id: conversationId,
      source_message_id: messageId,
      title,
      content,
    })
    if (insertErr) {
      console.error('[ai learning] failed to insert suggestion:', insertErr.message)
      return false
    }

    return true
  } catch (err) {
    console.error(`[ai learning] failed for message ${messageId}:`, err)
    return false
  } finally {
    // Always advance the watermark — a message that keeps erroring
    // (bad transcript, provider hiccup) must not block every message
    // after it from ever being scanned.
    await db
      .from('messages')
      .update({ ai_learning_processed_at: new Date().toISOString() })
      .eq('id', messageId)
  }
}
