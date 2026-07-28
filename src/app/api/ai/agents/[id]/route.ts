import { NextResponse } from 'next/server'
import { getCurrentAccount, requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { encrypt, decrypt } from '@/lib/whatsapp/encryption'
import { validateAiCredentials } from '@/lib/ai/validate'
import { embedTexts } from '@/lib/ai/embeddings'
import { normalizeActions } from '@/lib/ai/config'
import { AiError, type AiProvider } from '@/lib/ai/types'

function bad(message: string) {
  return NextResponse.json({ error: message }, { status: 400 })
}

/**
 * GET /api/ai/agents/[id]
 *
 * Full config for one agent (minus key material — only `has_key`/
 * `has_embeddings_key` flags). Used by the agent editor form.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { supabase, accountId } = await getCurrentAccount()
    const { id } = await params

    const { data, error } = await supabase
      .from('ai_configs')
      .select(
        'name, provider, model, system_prompt, is_active, auto_reply_enabled, auto_reply_max_per_conversation, default_new_conversation_owner, actions, api_key, embeddings_api_key, rescue_reply_enabled, rescue_after_hours, rescue_max_per_conversation, learning_enabled',
      )
      .eq('id', id)
      .eq('account_id', accountId)
      .maybeSingle()

    if (error) {
      console.error('[ai/agents/[id] GET] fetch error:', error)
      return NextResponse.json({ error: 'Failed to load agent' }, { status: 500 })
    }
    if (!data) return NextResponse.json({ error: 'Agent not found' }, { status: 404 })

    const { api_key, embeddings_api_key, ...safe } = data
    return NextResponse.json({
      configured: true,
      has_key: !!api_key,
      has_embeddings_key: !!embeddings_api_key,
      ...safe,
      actions: normalizeActions(data.actions),
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}

/**
 * PATCH /api/ai/agents/[id]  (admin+)
 *
 * Update one agent. Validates the key with the provider only when the
 * credentials that affect reachability actually changed, same "skip
 * the round-trip on a no-op toggle flip" discipline as before.
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { supabase, accountId } = await requireRole('admin')
    const { id } = await params

    const limit = checkRateLimit(`ai-agents:${accountId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    const { data: existing } = await supabase
      .from('ai_configs')
      .select('id, provider, model, api_key')
      .eq('id', id)
      .eq('account_id', accountId)
      .maybeSingle()
    if (!existing) return NextResponse.json({ error: 'Agent not found' }, { status: 404 })

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
    const learningEnabled = body.learning_enabled === true

    const rawKey = typeof body.api_key === 'string' ? body.api_key.trim() : ''
    const rawEmbeddingsKey =
      typeof body.embeddings_api_key === 'string' ? body.embeddings_api_key.trim() : ''
    const clearEmbeddingsKey = body.embeddings_api_key === null

    let apiKeyPlain: string
    if (rawKey) {
      apiKeyPlain = rawKey
    } else if (existing.api_key) {
      try {
        apiKeyPlain = decrypt(existing.api_key)
      } catch {
        return bad('Stored API key could not be decrypted — re-enter your key.')
      }
    } else {
      return bad('api_key is required')
    }

    const credentialsChanged =
      rawKey !== '' || provider !== existing.provider || model !== existing.model

    if (credentialsChanged) {
      try {
        await validateAiCredentials({
          id,
          name,
          provider,
          model,
          apiKey: apiKeyPlain,
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
          learningEnabled,
        })
      } catch (err) {
        if (err instanceof AiError) {
          return NextResponse.json({ error: err.message, code: err.code }, { status: 400 })
        }
        console.error('[ai/agents/[id] PATCH] validation error:', err)
        return bad('Could not validate the API key with the provider.')
      }
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
        console.error('[ai/agents/[id] PATCH] embeddings validation error:', err)
        return bad('Could not validate the embeddings key.')
      }
    }

    const encryptedKey = rawKey ? encrypt(rawKey) : null
    const shared: Record<string, unknown> = {
      name,
      provider,
      model,
      system_prompt: systemPrompt,
      is_active: isActive,
      auto_reply_enabled: autoReplyEnabled,
      auto_reply_max_per_conversation: maxPer,
      default_new_conversation_owner: defaultNewConversationOwner,
      actions,
      rescue_reply_enabled: rescueReplyEnabled,
      rescue_after_hours: rescueAfterHours,
      rescue_max_per_conversation: rescueMaxPerConversation,
      learning_enabled: learningEnabled,
    }
    if (rawEmbeddingsKey) {
      shared.embeddings_api_key = encrypt(rawEmbeddingsKey)
    } else if (clearEmbeddingsKey) {
      shared.embeddings_api_key = null
    }

    const { error: upErr } = await supabase
      .from('ai_configs')
      .update(encryptedKey ? { ...shared, api_key: encryptedKey } : shared)
      .eq('id', id)
      .eq('account_id', accountId)
    if (upErr) {
      console.error('[ai/agents/[id] PATCH] update error:', upErr)
      return NextResponse.json({ error: 'Failed to save agent' }, { status: 500 })
    }

    return NextResponse.json({ success: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}

/**
 * DELETE /api/ai/agents/[id]  (admin+)
 *
 * Removes one agent. If it was the account's default,
 * `accounts.default_ai_config_id` reverts to NULL (ON DELETE SET
 * NULL) — the account is left with no default until an admin picks
 * another one, same as if it had never configured AI.
 */
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { supabase, accountId } = await requireRole('admin')
    const { id } = await params

    const { error } = await supabase
      .from('ai_configs')
      .delete()
      .eq('id', id)
      .eq('account_id', accountId)
    if (error) {
      console.error('[ai/agents/[id] DELETE] error:', error)
      return NextResponse.json({ error: 'Failed to delete agent' }, { status: 500 })
    }
    return NextResponse.json({ success: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
