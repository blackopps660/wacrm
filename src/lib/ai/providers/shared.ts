import { AiError, type ChatMessage, type ToolCall, type ToolDefinition, type ToolResult } from '../types'

// ============================================================
// Bits shared by the OpenAI + Anthropic adapters.
// ============================================================

export interface ProviderArgs {
  apiKey: string
  model: string
  systemPrompt: string
  messages: ChatMessage[]
  timeoutMs: number
}

/**
 * One round of a tool-calling conversation with a provider. `Turn` is
 * opaque to callers outside the adapter — each provider represents
 * "conversation so far, including any tool calls/results" in its own
 * wire format (OpenAI: flat messages with a `tool` role; Anthropic:
 * content-block arrays with `tool_use`/`tool_result` blocks). The
 * agent loop (`lib/ai/agent.ts`) only ever threads a `Turn[]` through
 * these three functions — it never inspects the shape itself.
 */
export interface ProviderAdapter<Turn> {
  /** Convert the plain conversation transcript into this provider's
   *  turn format, as the starting point for the tool-calling loop. */
  initialTurns(messages: ChatMessage[]): Turn[]
  /** One model call. Returns the assistant's text (null when it only
   *  made tool calls) plus any tool calls it asked for. */
  generateTurn(args: {
    apiKey: string
    model: string
    systemPrompt: string
    timeoutMs: number
    turns: Turn[]
    tools: ToolDefinition[]
  }): Promise<{ text: string | null; toolCalls: ToolCall[]; assistantTurn: Turn }>
  /** Append the assistant's turn (with its tool calls) and the
   *  executed results, ready for the next `generateTurn` call. */
  appendToolResults(turns: Turn[], assistantTurn: Turn, results: ToolResult[]): Turn[]
}

/** Map a fetch rejection (timeout / DNS / offline) to a typed AiError. */
export function toNetworkError(err: unknown): AiError {
  if (err instanceof DOMException && err.name === 'TimeoutError') {
    return new AiError('The AI provider took too long to respond.', {
      code: 'timeout',
      status: 504,
    })
  }
  const msg = err instanceof Error ? err.message : String(err)
  return new AiError(`Could not reach the AI provider: ${msg}`, {
    code: 'network_error',
    status: 502,
  })
}

/** Build a typed AiError from a non-2xx provider response, pulling the
 *  provider's own error message out of the JSON body when present. */
export async function providerHttpError(
  provider: string,
  res: Response,
): Promise<AiError> {
  let detail = ''
  try {
    const body = (await res.json()) as { error?: { message?: string } | string }
    detail =
      typeof body?.error === 'string'
        ? body.error
        : (body?.error?.message ?? '')
  } catch {
    // Non-JSON error body — fall back to the status line.
  }

  const { status } = res
  const code =
    status === 401 || status === 403
      ? 'invalid_key'
      : status === 429
        ? 'rate_limited'
        : 'provider_error'
  const base =
    code === 'invalid_key'
      ? `${provider} rejected the API key`
      : code === 'rate_limited'
        ? `${provider} rate limit reached`
        : `${provider} API error (${status})`

  return new AiError(detail ? `${base}: ${detail}` : base, {
    code,
    // Surface an auth failure as 401 so the settings "Test key" button
    // can show "invalid key"; everything else is an upstream 502.
    status: code === 'invalid_key' ? 401 : 502,
  })
}

/**
 * Collapse consecutive same-role turns into one (joined with blank
 * lines). Anthropic requires strictly alternating roles; merging is
 * also harmless for OpenAI and keeps the transcript compact.
 */
export function mergeConsecutive(messages: ChatMessage[]): ChatMessage[] {
  const out: ChatMessage[] = []
  for (const m of messages) {
    const last = out[out.length - 1]
    if (last && last.role === m.role) {
      last.content = `${last.content}\n\n${m.content}`
    } else {
      out.push({ role: m.role, content: m.content })
    }
  }
  return out
}
