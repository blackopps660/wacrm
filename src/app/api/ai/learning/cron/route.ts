import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/ai/admin-client'
import { processAgentMessage } from '@/lib/ai/learning'

/**
 * Self-learning sweep — see migration 060 for the full design
 * rationale. Scans new human-agent replies (across every account that
 * opted in via `ai_configs.learning_enabled`) and, for each one, asks
 * the account's own AI provider whether it teaches something the
 * knowledge base doesn't already cover. Findings are staged in
 * `ai_knowledge_suggestions` — nothing here ever touches the live
 * knowledge base directly; a human approves/rejects from Settings.
 *
 * Batched to 50 messages per run so one invocation can't run long
 * enough to time out on an account with a big backlog — the next
 * scheduled run just picks up where this one left off (the watermark
 * is per-message, not per-account).
 *
 * Auth: same `AUTOMATION_CRON_SECRET` / `x-cron-secret` pattern as the
 * other cron endpoints. Hosting: hit on a schedule, same as those.
 */
export async function GET(request: Request) {
  const expected = process.env.AUTOMATION_CRON_SECRET
  if (!expected) {
    return NextResponse.json({ error: 'cron not configured' }, { status: 503 })
  }
  const supplied = request.headers.get('x-cron-secret') ?? ''
  const suppliedBuf = Buffer.from(supplied)
  const expectedBuf = Buffer.from(expected)
  if (
    suppliedBuf.length !== expectedBuf.length ||
    !timingSafeEqual(suppliedBuf, expectedBuf)
  ) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const admin = supabaseAdmin()
  const { data: candidates, error } = await admin.rpc(
    'get_unprocessed_agent_messages',
    { p_limit: 50 },
  )

  if (error) {
    console.error('[ai-learning-cron] candidate scan failed:', error.message)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  let suggested = 0
  for (const row of candidates ?? []) {
    const found = await processAgentMessage({
      messageId: row.message_id,
      conversationId: row.conversation_id,
      accountId: row.account_id,
      contentText: row.content_text,
    })
    if (found) suggested++
  }

  return NextResponse.json({ scanned: candidates?.length ?? 0, suggested })
}
