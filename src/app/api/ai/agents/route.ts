import { NextResponse } from 'next/server'
import { getCurrentAccount, requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { encrypt } from '@/lib/whatsapp/encryption'
import { validateAiCredentials } from '@/lib/ai/validate'
import { embedTexts } from '@/lib/ai/embeddings'
import { listAiConfigs, normalizeActions } from '@/lib/ai/config'
import { AiError, type AiProvider } from '@/lib/ai/types'

function bad(message: string) {
  return NextResponse.json({ error: message }, { status: 400 })
}

/**
 * GET /api/ai/agents
 *
 * Lightweight summary of every agent configured for the account (no
 * key material) plus which one is the default. Any member may read —
 * the inbox/settings need to know whether AI is set up at all.
 */
export async function GET() {
  try {
    const { supabase, accountId } = await getCurrentAccount()
    const agents = await listAiConfigs(supabase, accountId)
    return NextResponse.json({ agents })
  } catch (err) {
    return toErrorResponse(err)
  }
}

/**
 * POST /api/ai/agents  (admin+)
 *
 * Create a new agent (an account can have several since migration
 * 043). Validates the key with the provider before persisting, same
 * "verify before save" discipline as the single-agent version. The
 * very first agent an account creates is automatically made its
 * default — otherwise every new account would sit in a confusing
 * "configured but nothing is default" state until an admin manually
 * picked one.
 */
export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('admin')

    const limit = checkRateLimit(`ai-agents:${userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    const body = await request.json().catch(() => null)
    if (!body || typeof body !== 'object') return bad('Invalid request body')

    const name = typeof body.name === 'string' ? body.name.trim() : ''
    if (!name) return bad('name is required')

    const provider = body.provider as AiProvider
    if (provider !== 'openai' && provider !== 'anthropic') {
      return bad('provider must be "openai" or "anthropic"')
    }
    const model = typeof body.model === 'string' ? body.model.trim() : ''
    if (!model) return bad('model is required')

    const rawKey = typeof body.api_key === 'string' ? body.api_key.trim() : ''
    if (!rawKey) return bad('api_key is required')

    const systemPrompt =
      typeof body.system_prompt === 'string' && body.system_prompt.trim()
        ? body.system_prompt.trim()
        : null
    const isActive = body.is_active === true
    const autoReplyEnabled = body.auto_reply_enabled === true

    let maxPer: number | null = null
    if (body.auto_reply_max_per_conversation !== null) {
      const n = Number(body.auto_reply_max_per_conversation)
      maxPer = Number.isFinite(n) ? Math.max(1, Math.floor(n)) : null
    }

    const defaultNewConversationOwner =
      body.default_new_conversation_owner === 'ai' ? 'ai' : 'human'
    const actions = normalizeActions(body.actions)

    const rescueReplyEnabled = body.rescue_reply_enabled === true
    let rescueAfterHours = 20
    if (body.rescue_after_hours !== undefined) {
      const n = Number(body.rescue_after_hours)
      rescueAfterHours = Number.isFinite(n) ? Math.min(23, Math.max(1, Math.floor(n))) : 20
    }
    let rescueMaxPerConversation = 2
    if (body.rescue_max_per_conversation !== undefined) {
      const n = Number(body.rescue_max_per_conversation)
      rescueMaxPerConversation = Number.isFinite(n) ? Math.max(1, Math.floor(n)) : 2
    }

    const rawEmbeddingsKey =
      typeof body.embeddings_api_key === 'string' ? body.embeddings_api_key.trim() : ''

    try {
      await validateAiCredentials({
        id: '',
        name,
        provider,
        model,
        apiKey: rawKey,
        systemPrompt,
        isActive,
        autoReplyEnabled,
        autoReplyMaxPerConversation: maxPer,
        embeddingsApiKey: null,
        defaultNewConversationOwner,
        actions,
        rescueReplyEnabled,
        rescueAfterHours,
        rescueMaxPerConversation,
      })
    } catch (err) {
      if (err instanceof AiError) {
        return NextResponse.json({ error: err.message, code: err.code }, { status: 400 })
      }
      console.error('[ai/agents POST] validation error:', err)
      return bad('Could not validate the API key with the provider.')
    }

    if (rawEmbeddingsKey) {
      try {
        await embedTexts(rawEmbeddingsKey, ['ping'])
      } catch (err) {
        if (err instanceof AiError) {
          return NextResponse.json(
            { error: `Embeddings key: ${err.message}`, code: err.code },
            { status: 400 },
          )
        }
        console.error('[ai/agents POST] embeddings validation error:', err)
        return bad('Could not validate the embeddings key.')
      }
    }

    const { data: inserted, error: insErr } = await supabase
      .from('ai_configs')
      .insert({
        account_id: accountId,
        created_by: userId,
        name,
        provider,
        model,
        api_key: encrypt(rawKey),
        embeddings_api_key: rawEmbeddingsKey ? encrypt(rawEmbeddingsKey) : null,
        system_prompt: systemPrompt,
        is_active: isActive,
        auto_reply_enabled: autoReplyEnabled,
        auto_reply_max_per_conversation: maxPer,
        default_new_conversation_owner: defaultNewConversationOwner,
        actions,
        rescue_reply_enabled: rescueReplyEnabled,
        rescue_after_hours: rescueAfterHours,
        rescue_max_per_conversation: rescueMaxPerConversation,
      })
      .select('id')
      .single()

    if (insErr || !inserted) {
      console.error('[ai/agents POST] insert error:', insErr)
      return NextResponse.json({ error: 'Failed to create agent' }, { status: 500 })
    }

    // First agent for this account — make it the default so auto-reply/
    // routing/draft have something to use immediately.
    const { data: account } = await supabase
      .from('accounts')
      .select('default_ai_config_id')
      .eq('id', accountId)
      .maybeSingle()
    if (!account?.default_ai_config_id) {
      await supabase
        .from('accounts')
        .update({ default_ai_config_id: inserted.id })
        .eq('id', accountId)
    }

    return NextResponse.json({ id: inserted.id }, { status: 201 })
  } catch (err) {
    return toErrorResponse(err)
  }
}
