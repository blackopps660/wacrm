import { supabaseAdmin } from './admin-client'
import { loadDefaultAiConfig } from './config'
import { buildConversationContext } from './context'
import { retrieveKnowledge } from './knowledge'
import { generateReply } from './generate'
import { buildSystemPrompt } from './defaults'
import { latestUserMessage } from './query'
import { engineSendText } from '@/lib/flows/meta-send'
import { resolveAuditUserId } from '@/lib/api/v1/contacts'

export interface RescueCandidate {
  conversationId: string
  accountId: string
  contactId: string
  /** Rescue nudges already sent since the last human reply (migration 059). */
  aiRescueCount: number
  /** Hours since the customer's last (still-unanswered) message. */
  hoursSinceLastCustomerMessage: number
}

/**
 * One 24h-window rescue attempt for a single candidate conversation
 * (found by `get_stale_customer_conversations()`, migration 059).
 *
 * Deliberately mirrors `dispatchInboundToAiReply`'s shape (own db
 * client, own try/catch, never throws — the cron loop must keep going
 * even if one account's config or one LLM call misbehaves) but is a
 * genuinely different feature: this fires on conversations the AI does
 * NOT own, sends at most one short nudge, and never touches
 * `owner_kind` — the conversation stays the human agent's the whole
 * time, and their next real reply resets the rescue budget (trigger in
 * migration 059).
 *
 * Returns true when a rescue message was actually sent (for the cron's
 * summary count), false for every "not eligible / nothing to say" exit.
 */
export async function maybeSendRescueReply(
  candidate: RescueCandidate,
): Promise<boolean> {
  const { conversationId, accountId, contactId, aiRescueCount, hoursSinceLastCustomerMessage } =
    candidate

  try {
    const db = supabaseAdmin()

    const config = await loadDefaultAiConfig(db, accountId)
    if (!config || !config.rescueReplyEnabled) return false
    if (hoursSinceLastCustomerMessage < config.rescueAfterHours) return false
    if (aiRescueCount >= config.rescueMaxPerConversation) return false

    const messages = await buildConversationContext(db, conversationId)
    if (messages.length === 0) return false

    const knowledge = await retrieveKnowledge(
      db,
      accountId,
      config,
      latestUserMessage(messages),
    )

    const systemPrompt = buildSystemPrompt({
      userPrompt: config.systemPrompt,
      mode: 'rescue',
      knowledge,
    })

    // Plain single-call generation — no tool-calling loop here. A
    // re-engagement nudge has no business updating tags/fields/
    // triggering automations; keeping this simple also means a
    // misbehaving tool call can never block the one thing this path
    // must reliably do.
    const { text } = await generateReply({ config, systemPrompt, messages })
    if (!text) return false

    const configOwnerUserId = await resolveAuditUserId(db, accountId)

    await engineSendText({
      accountId,
      userId: configOwnerUserId,
      conversationId,
      contactId,
      text,
    })

    await db
      .from('conversations')
      .update({
        ai_rescue_count: aiRescueCount + 1,
        ai_rescue_last_sent_at: new Date().toISOString(),
      })
      .eq('id', conversationId)

    return true
  } catch (err) {
    console.error(
      `[ai rescue-reply] failed for conversation ${conversationId}:`,
      err,
    )
    return false
  }
}
