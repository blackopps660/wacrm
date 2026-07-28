import type { SupabaseClient } from '@supabase/supabase-js'
import { decrypt } from '@/lib/whatsapp/encryption'
import type { AiActionSetting, AiActionsConfig, AiConfig } from './types'

interface AiConfigRow {
  id: string
  name: string
  provider: 'openai' | 'anthropic'
  model: string
  api_key: string
  system_prompt: string | null
  is_active: boolean
  auto_reply_enabled: boolean
  auto_reply_max_per_conversation: number | null
  embeddings_api_key: string | null
  default_new_conversation_owner: 'ai' | 'human'
  actions: unknown
  rescue_reply_enabled: boolean
  rescue_after_hours: number
  rescue_max_per_conversation: number
  learning_enabled: boolean
}

const CONFIG_COLUMNS =
  'id, name, provider, model, api_key, system_prompt, is_active, auto_reply_enabled, auto_reply_max_per_conversation, embeddings_api_key, default_new_conversation_owner, actions, rescue_reply_enabled, rescue_after_hours, rescue_max_per_conversation, learning_enabled'

function normalizeActionSetting(raw: unknown): AiActionSetting {
  const obj = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  return {
    enabled: obj.enabled === true,
    guidelines:
      typeof obj.guidelines === 'string' && obj.guidelines.trim()
        ? obj.guidelines.trim()
        : null,
  }
}

/** Defensive parse of the `actions` JSONB blob — a missing key, a
 *  malformed row from manual DB edits, or a brand-new account with no
 *  row at all all resolve to "every action disabled" rather than
 *  throwing. */
export function normalizeActions(raw: unknown): AiActionsConfig {
  const obj = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  return {
    updateTags: normalizeActionSetting(obj.updateTags),
    updateContactFields: normalizeActionSetting(obj.updateContactFields),
    triggerAutomations: normalizeActionSetting(obj.triggerAutomations),
  }
}

/** True when at least one agent action is toggled on — used to decide
 *  whether the system prompt needs the tool-usage guardrail line. */
export function hasAnyActionEnabled(actions: AiActionsConfig): boolean {
  return actions.updateTags.enabled || actions.updateContactFields.enabled || actions.triggerAutomations.enabled
}

function rowToConfig(row: AiConfigRow, accountId: string): AiConfig | null {
  // Defensive: the column is NOT NULL, but a partial write / manual DB
  // edit could leave it empty. Treat a missing key as "not configured"
  // rather than letting decrypt() throw on null.
  if (!row.api_key) return null

  // The embeddings key is optional and independent of the chat key —
  // a corrupt/undecryptable one should downgrade to lexical KB, not
  // take down draft/auto-reply, so decrypt failures are swallowed here.
  let embeddingsApiKey: string | null = null
  if (row.embeddings_api_key) {
    try {
      embeddingsApiKey = decrypt(row.embeddings_api_key)
    } catch {
      // Not silent — a rotated/mismatched ENCRYPTION_KEY here means
      // semantic search quietly stops working, so leave a breadcrumb.
      console.error(
        `[ai config] embeddings key for agent ${row.id} (account ${accountId}) could not be decrypted — check ENCRYPTION_KEY; semantic search is disabled until it is re-entered.`,
      )
      embeddingsApiKey = null
    }
  }

  return {
    id: row.id,
    name: row.name,
    provider: row.provider,
    model: row.model,
    apiKey: decrypt(row.api_key),
    systemPrompt: row.system_prompt,
    isActive: row.is_active,
    autoReplyEnabled: row.auto_reply_enabled,
    autoReplyMaxPerConversation: row.auto_reply_max_per_conversation,
    embeddingsApiKey,
    defaultNewConversationOwner: row.default_new_conversation_owner,
    actions: normalizeActions(row.actions),
    rescueReplyEnabled: row.rescue_reply_enabled,
    rescueAfterHours: row.rescue_after_hours,
    rescueMaxPerConversation: row.rescue_max_per_conversation,
    learningEnabled: row.learning_enabled,
  }
}

/**
 * Load and decrypt one specific agent by id, scoped to `accountId` (a
 * foreign agent id, or one that belongs to a different account, comes
 * back as `null` — same "not found" shape as a missing row, no
 * distinct error that would leak whether the id exists elsewhere).
 * Returns `null` when the master switch (`is_active`) is off — draft/
 * auto-reply treat "off" and "not configured" identically. Throws only
 * if the stored key can't be decrypted (mismatched `ENCRYPTION_KEY`),
 * so that distinct failure surfaces rather than looking unconfigured.
 *
 * Works with any client: pass the RLS-scoped SSR client from a
 * dashboard route, or the service-role admin client from the webhook.
 */
export async function loadAiConfig(
  db: SupabaseClient,
  accountId: string,
  configId: string,
  opts: { requireActive?: boolean } = {},
): Promise<AiConfig | null> {
  const { requireActive = true } = opts
  const { data, error } = await db
    .from('ai_configs')
    .select(CONFIG_COLUMNS)
    .eq('id', configId)
    .eq('account_id', accountId)
    .maybeSingle()

  if (error) throw error
  if (!data) return null

  const row = data as AiConfigRow
  // The Playground passes requireActive:false so an admin can test the
  // agent before flipping the master switch on.
  if (requireActive && !row.is_active) return null

  return rowToConfig(row, accountId)
}

/**
 * Load and decrypt the account's *default* agent — the one auto-reply,
 * the webhook's new-conversation routing, and the inbox draft button
 * all use. Returns `null` when the account has no default agent set
 * (no agents yet, or the default was deleted and none was re-picked).
 */
export async function loadDefaultAiConfig(
  db: SupabaseClient,
  accountId: string,
  opts: { requireActive?: boolean } = {},
): Promise<AiConfig | null> {
  const { data: account, error } = await db
    .from('accounts')
    .select('default_ai_config_id')
    .eq('id', accountId)
    .maybeSingle()
  if (error || !account?.default_ai_config_id) return null

  return loadAiConfig(db, accountId, account.default_ai_config_id, opts)
}

/** Lightweight summary of one agent — no key material, safe to send to
 *  the client as-is. Used by the agents list page. */
export interface AiConfigSummary {
  id: string
  name: string
  provider: 'openai' | 'anthropic'
  model: string
  isActive: boolean
  autoReplyEnabled: boolean
  isDefault: boolean
}

/** List every agent configured for the account, most-recently-created
 *  first, flagging which one is the default. Never touches key
 *  material — no decrypt, no throw on a corrupt key. */
export async function listAiConfigs(
  db: SupabaseClient,
  accountId: string,
): Promise<AiConfigSummary[]> {
  const [{ data: account }, { data: rows, error }] = await Promise.all([
    db.from('accounts').select('default_ai_config_id').eq('id', accountId).maybeSingle(),
    db
      .from('ai_configs')
      .select('id, name, provider, model, is_active, auto_reply_enabled, created_at')
      .eq('account_id', accountId)
      .order('created_at', { ascending: false }),
  ])
  if (error) throw error

  const defaultId = account?.default_ai_config_id ?? null
  return (rows ?? []).map((r) => ({
    id: r.id,
    name: r.name,
    provider: r.provider,
    model: r.model,
    isActive: r.is_active,
    autoReplyEnabled: r.auto_reply_enabled,
    isDefault: r.id === defaultId,
  }))
}

/**
 * Load + decrypt just the *default* agent's embeddings key, independent
 * of `is_active`. Used by the knowledge-base ingest routes so the KB
 * gets embedded (and semantic search works) whenever the default
 * agent has an embeddings key, even if its master switch is off.
 *
 * Knowledge base documents are account-wide, not per-agent (migration
 * 030 predates multi-agent) — a non-default agent's own
 * `embeddings_api_key` is simply not used for this; the settings UI
 * makes that explicit rather than silently ignoring it.
 *
 * Returns `{ key, corrupt }`: `key` is null when there's no default
 * agent, no key, or it can't be decrypted; `corrupt` distinguishes the
 * "set but unusable" case so callers can warn instead of silently
 * indexing lexical-only and reporting success.
 */
export async function loadEmbeddingsKey(
  db: SupabaseClient,
  accountId: string,
): Promise<{ key: string | null; corrupt: boolean }> {
  const { data: account } = await db
    .from('accounts')
    .select('default_ai_config_id')
    .eq('id', accountId)
    .maybeSingle()
  if (!account?.default_ai_config_id) return { key: null, corrupt: false }

  const { data, error } = await db
    .from('ai_configs')
    .select('embeddings_api_key')
    .eq('id', account.default_ai_config_id)
    .maybeSingle()
  if (error || !data?.embeddings_api_key) return { key: null, corrupt: false }
  try {
    return { key: decrypt(data.embeddings_api_key), corrupt: false }
  } catch {
    console.error(
      `[ai config] embeddings key for account ${accountId}'s default agent could not be decrypted — check ENCRYPTION_KEY.`,
    )
    return { key: null, corrupt: true }
  }
}
