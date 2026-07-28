import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/ai/admin-client'
import { maybeSendRescueReply } from '@/lib/ai/rescue-reply'

/**
 * 24h-window rescue sweep — see migration 059 for the full design
 * rationale. Scans every account's conversations for one whose LAST
 * message is still an unanswered customer message sitting close to (but
 * before) the 24h WhatsApp session cutoff, and — only for accounts that
 * opted in (`ai_configs.rescue_reply_enabled`) — sends one short,
 * contextual AI nudge to keep the window open for the human agent.
 *
 * Auth: same `AUTOMATION_CRON_SECRET` / `x-cron-secret` pattern as
 * `/api/conversations/cron` and `/api/flows/cron` — one secret to
 * provision regardless of how many cron endpoints exist.
 *
 * Hosting: hit on a schedule (Vercel Cron / GitHub Actions / external
 * pinger), same as the other cron endpoints. Every 15–30 minutes is a
 * reasonable cadence — the eligibility window is hours wide, so a few
 * minutes of slop is invisible to users.
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
    'get_stale_customer_conversations',
  )

  if (error) {
    console.error('[ai-rescue-cron] candidate scan failed:', error.message)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  let sent = 0
  for (const row of candidates ?? []) {
    const handled = await maybeSendRescueReply({
      conversationId: row.conversation_id,
      accountId: row.account_id,
      contactId: row.contact_id,
      aiRescueCount: row.ai_rescue_count,
      hoursSinceLastCustomerMessage: row.hours_since_last_customer_message,
    })
    if (handled) sent++
  }

  return NextResponse.json({ scanned: candidates?.length ?? 0, sent })
}
