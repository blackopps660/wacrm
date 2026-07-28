import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { loadEmbeddingsKey } from '@/lib/ai/config'
import { ingestDocument } from '@/lib/ai/knowledge'
import { AiError } from '@/lib/ai/types'

/**
 * PATCH /api/ai/knowledge/suggestions/[id]  (admin+)
 *
 * Approve or reject a self-learning suggestion. Approving copies it
 * into `ai_knowledge_documents` via the exact same insert + chunk/embed
 * path as manually adding a document (`POST /api/ai/knowledge`) — a
 * suggestion becomes indistinguishable from hand-written knowledge
 * once accepted. Rejecting just marks it so; the row is kept (not
 * deleted) as an audit trail of what the bot proposed and why it was
 * turned down.
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { supabase, accountId, userId } = await requireRole('admin')
    const { id } = await params

    const limit = checkRateLimit(`ai-kb-suggestions:${userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    const body = await request.json().catch(() => null)
    const action = body?.action
    if (action !== 'approve' && action !== 'reject') {
      return NextResponse.json(
        { error: 'action must be "approve" or "reject"' },
        { status: 400 },
      )
    }

    const { data: suggestion, error: fetchErr } = await supabase
      .from('ai_knowledge_suggestions')
      .select('id, title, content, status')
      .eq('id', id)
      .eq('account_id', accountId)
      .maybeSingle()
    if (fetchErr || !suggestion) {
      return NextResponse.json({ error: 'Suggestion not found' }, { status: 404 })
    }
    if (suggestion.status !== 'pending') {
      return NextResponse.json(
        { error: `Already ${suggestion.status}` },
        { status: 409 },
      )
    }

    if (action === 'reject') {
      const { error } = await supabase
        .from('ai_knowledge_suggestions')
        .update({ status: 'rejected', reviewed_at: new Date().toISOString(), reviewed_by: userId })
        .eq('id', id)
      if (error) {
        console.error('[ai/knowledge/suggestions PATCH] reject error:', error)
        return NextResponse.json({ error: 'Failed to reject' }, { status: 500 })
      }
      return NextResponse.json({ success: true })
    }

    // Approve: create the live document, same path as the manual form.
    const { data: doc, error: docErr } = await supabase
      .from('ai_knowledge_documents')
      .insert({
        account_id: accountId,
        created_by: userId,
        title: suggestion.title,
        content: suggestion.content,
      })
      .select('id')
      .single()
    if (docErr || !doc) {
      console.error('[ai/knowledge/suggestions PATCH] doc insert error:', docErr)
      return NextResponse.json({ error: 'Failed to save document' }, { status: 500 })
    }

    let warning: string | undefined
    const { key: embeddingsApiKey, corrupt } = await loadEmbeddingsKey(supabase, accountId)
    try {
      await ingestDocument(supabase, accountId, { embeddingsApiKey }, doc.id, suggestion.content)
      if (corrupt) {
        warning =
          'Saved with keyword search only — your embeddings key could not be decrypted (check ENCRYPTION_KEY, then re-enter the key).'
      }
    } catch (err) {
      const message = err instanceof AiError ? err.message : 'indexing failed'
      console.error('[ai/knowledge/suggestions PATCH] ingest error:', err)
      warning = `Saved, but semantic indexing failed (${message}). Lexical search still works; use Reindex to retry.`
    }

    const { error: updErr } = await supabase
      .from('ai_knowledge_suggestions')
      .update({
        status: 'approved',
        reviewed_at: new Date().toISOString(),
        reviewed_by: userId,
        knowledge_document_id: doc.id,
      })
      .eq('id', id)
    if (updErr) {
      console.error('[ai/knowledge/suggestions PATCH] status update error:', updErr)
      return NextResponse.json({ error: 'Failed to update suggestion' }, { status: 500 })
    }

    return NextResponse.json({ success: true, document_id: doc.id, warning })
  } catch (err) {
    return toErrorResponse(err)
  }
}
