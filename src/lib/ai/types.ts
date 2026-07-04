// ============================================================
// Shared types for the AI reply assistant (bring-your-own-key).
//
// One small provider-agnostic surface so the inbox draft route and the
// inbound auto-reply bot both talk to `generateReply` without caring
// whether the account is on OpenAI or Anthropic.
// ============================================================

export type AiProvider = 'openai' | 'anthropic'

/** One toggle-able agent action: on/off + an admin-authored free-text
 *  guideline for when/how the model should use it (mirrors respond.io's
 *  per-action config box). */
export interface AiActionSetting {
  enabled: boolean
  guidelines: string | null
}

/** Every action is off by default — an account only gets tool-calling
 *  behaviour once an admin opts in per action (migration 040). */
export interface AiActionsConfig {
  updateTags: AiActionSetting
  updateContactFields: AiActionSetting
  triggerAutomations: AiActionSetting
}

/**
 * Account AI setup, decrypted and ready to use. Produced by
 * `loadAiConfig` — `apiKey` is the plaintext BYO provider key
 * (stored AES-256-GCM-encrypted at rest).
 */
export interface AiConfig {
  provider: AiProvider
  model: string
  apiKey: string
  systemPrompt: string | null
  isActive: boolean
  autoReplyEnabled: boolean
  /** NULL means no cap — the bot keeps replying indefinitely. */
  autoReplyMaxPerConversation: number | null
  /** What a brand-new (or reopened-from-closed) conversation is routed
   *  to by default — see migration 037. */
  defaultNewConversationOwner: 'ai' | 'human'
  /** Optional OpenAI-compatible key for embeddings. When set, the
   *  knowledge base is embedded and semantic retrieval turns on; when
   *  null, retrieval falls back to lexical full-text search. */
  embeddingsApiKey: string | null
  /** Tool-calling actions the agent may take beyond replying with text
   *  (migration 040). */
  actions: AiActionsConfig
}

/** Provider-agnostic tool schema, translated to each provider's own
 *  wire format by the adapter that needs it. */
export interface ToolDefinition {
  name: string
  description: string
  /** JSON Schema `object` describing the tool's arguments. */
  parameters: Record<string, unknown>
}

/** A tool invocation the model asked for, normalized across providers. */
export interface ToolCall {
  id: string
  name: string
  arguments: Record<string, unknown>
}

/** The outcome of actually running a `ToolCall`, fed back to the model
 *  as plain text so it can decide what (if anything) to say next. */
export interface ToolResult {
  id: string
  name: string
  content: string
}

/** A single conversation turn in the shape both providers accept. */
export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
}

/** Outcome of a generation call. */
export interface GenerateResult {
  /** The reply text, with any handoff sentinel stripped. */
  text: string
  /** True when the model asked to hand off to a human (auto-reply mode). */
  handoff: boolean
}

/**
 * Typed error for every AI failure mode. `status` maps cleanly to an
 * HTTP response in the draft route; `code` lets the UI/tests branch
 * (invalid_key vs rate_limited vs timeout, etc.).
 */
export class AiError extends Error {
  readonly code: string
  readonly status: number
  constructor(message: string, opts: { code?: string; status?: number } = {}) {
    super(message)
    this.name = 'AiError'
    this.code = opts.code ?? 'ai_error'
    this.status = opts.status ?? 502
  }
}
