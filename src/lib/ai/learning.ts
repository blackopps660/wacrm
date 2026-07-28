import { supabaseAdmin } from './admin-client'
import { loadDefaultAiConfig } from './config'
import { retrieveKnowledgeCandidates, type KnowledgeCandidate } from './knowledge'
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
  'You audit a human customer-support agent\'s WhatsApp reply to decide whether it should change the business\'s AI assistant\'s knowledge base — either by teaching it something reusable it does not already know, or by CORRECTING an existing entry that the agent\'s reply contradicts (a changed price, an updated policy, a fact that turned out wrong). ' +
  `You are shown: the recent conversation leading up to the agent's reply, and a numbered list of existing knowledge base documents (each with its id). If the agent's reply is small talk, specific to this one customer (their name, their order, a one-off apology), or already fully and correctly covered by an existing document, respond with exactly ${NO_NEW_INFO} and nothing else. ` +
  'Otherwise respond with ONLY a JSON object — no markdown fences, no extra text — of one of these two shapes: ' +
  '{"action": "new", "title": "short label", "content": "the reusable knowledge, standalone, usable without seeing this conversation"} for something genuinely new; or ' +
  '{"action": "correct", "document_id": "<the exact id from the numbered list>", "title": "short label", "content": "the corrected, complete replacement text for that document"} when the agent\'s reply contradicts or updates one of the listed documents — "content" must be the FULL corrected document, not just the changed part. ' +
  'Only use "correct" with a document_id that actually appears in the numbered list; never invent one. ' +
  'Write the content generally (not "as I told you above"), in whatever language the business/agent is using. Never invent facts beyond what the agent actually said.'

function buildCandidateList(candidates: KnowledgeCandidate[]): string {
  if (candidates.length === 0) return 'Existing knowledge base documents: (none yet)'
  return (
    'Existing knowledge base documents:\n' +
    candidates
      .map((c, i) => `[${i + 1}] id=${c.documentId} title="${c.title}"\n${c.content}`)
      .join('\n\n')
  )
}

/**
 * One self-learning pass over a single human agent reply (found by
 * `get_unprocessed_agent_messages()`, migration 060).
 *
 * Mirrors `maybeSendRescueReply`'s shape (own db client, own try/catch,
 * never throws, always marks the message processed in its `finally` so
 * a failure can't wedge the same message in an infinite retry loop).
 * Never writes to the live knowledge base directly — every finding
 * (new document OR a correction to an existing one, migration 061)
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

    // Full candidate documents (not just chunk excerpts) so the model
    // can both judge "already covered" and, if it contradicts one,
    // reference it by id as a correction target.
    const candidates = await retrieveKnowledgeCandidates(db, accountId, config, contentText, 3)

    const userContent =
      `Conversation leading up to the agent's reply:\n${transcript}\n\n` +
      `${buildCandidateList(candidates)}\n\n` +
      'Does the agent\'s reply above teach something new, correct one of the listed documents, or add nothing?'

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

    let parsed: {
      action?: unknown
      document_id?: unknown
      title?: unknown
      content?: unknown
    } | null = null
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

    // "correct" only counts if the model referenced an id we actually
    // showed it — never trust a model-invented document id.
    let targetDocumentId: string | null = null
    if (parsed?.action === 'correct' && typeof parsed.document_id === 'string') {
      const match = candidates.find((c) => c.documentId === parsed!.document_id)
      if (match) targetDocumentId = match.documentId
    }

    const { error: insertErr } = await db.from('ai_knowledge_suggestions').insert({
      account_id: accountId,
      conversation_id: conversationId,
      source_message_id: messageId,
      target_document_id: targetDocumentId,
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
