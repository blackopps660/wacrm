import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/inbox/admin-client'

/**
 * Auto-close conversations that have gone inactive past a workspace's
 * configured threshold (`accounts.auto_close_after_days`, NULL = off).
 *
 * The actual sweep runs as a single cross-tenant SQL statement
 * (`close_inactive_conversations()`, migration 038) rather than looping
 * per-account here — one UPDATE...FROM join against `accounts` is far
 * cheaper than N per-account round trips as the number of workspaces
 * grows.
 *
 * Auth: re-uses `AUTOMATION_CRON_SECRET` so operators only have one
 * secret to provision, same rationale as `/api/flows/cron`.
 *
 * Hosting: hit on a schedule (Vercel Cron / GitHub Actions / external
 * pinger). Once per hour is more than enough — the setting is denominated
 * in whole days, so an hour of slop before a conversation closes is
 * invisible to users.
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
  const { data, error } = await admin.rpc('close_inactive_conversations')

  if (error) {
    console.error('[conversations-cron] auto-close sweep failed:', error.message)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ closed: data?.length ?? 0 })
}
