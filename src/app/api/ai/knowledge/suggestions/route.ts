import { NextResponse } from 'next/server'
import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account'

/**
 * GET /api/ai/knowledge/suggestions
 *
 * List the account's pending self-learning suggestions (any member) —
 * knowledge the self-learning cron (migration 060) found in a human
 * agent's replies but hasn't been approved into the live knowledge
 * base yet. Each row is either a brand-new document or, when
 * `target_document_id` is set (migration 061), a proposed correction —
 * the target's current title/content are embedded so the review UI
 * can show "current vs proposed" before an admin approves it.
 */
export async function GET() {
  try {
    const { supabase, accountId } = await getCurrentAccount()
    const { data, error } = await supabase
      .from('ai_knowledge_suggestions')
      .select(
        'id, title, content, conversation_id, created_at, target_document_id, ' +
          'target_document:ai_knowledge_documents!target_document_id(title, content)',
      )
      .eq('account_id', accountId)
      .eq('status', 'pending')
      .order('created_at', { ascending: false })
    if (error) {
      console.error('[ai/knowledge/suggestions GET] error:', error)
      return NextResponse.json(
        { error: 'Failed to load suggestions' },
        { status: 500 },
      )
    }
    return NextResponse.json({ suggestions: data ?? [] })
  } catch (err) {
    return toErrorResponse(err)
  }
}
