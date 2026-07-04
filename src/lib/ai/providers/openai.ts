import { AiError, type ChatMessage, type ToolCall, type ToolDefinition, type ToolResult } from '../types'
import { MAX_OUTPUT_TOKENS } from '../defaults'
import {
  mergeConsecutive,
  providerHttpError,
  toNetworkError,
  type ProviderAdapter,
  type ProviderArgs,
} from './shared'

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions'

interface OpenAiResponse {
  choices?: { message?: { content?: string } }[]
}

/**
 * Call OpenAI's Chat Completions endpoint with the caller's own key.
 * Returns the raw assistant text (handoff parsing happens in
 * `generateReply`).
 */
export async function generateOpenAi(args: ProviderArgs): Promise<string> {
  const { apiKey, model, systemPrompt, messages, timeoutMs } = args

  let res: Response
  try {
    res = await fetch(OPENAI_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          ...mergeConsecutive(messages),
        ],
        max_completion_tokens: MAX_OUTPUT_TOKENS,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (err) {
    throw toNetworkError(err)
  }

  if (!res.ok) {
    throw await providerHttpError('OpenAI', res)
  }

  const data = (await res.json().catch(() => null)) as OpenAiResponse | null
  const text = data?.choices?.[0]?.message?.content
  if (!text || typeof text !== 'string' || !text.trim()) {
    throw new AiError('OpenAI returned an empty response.', {
      code: 'empty_response',
    })
  }
  return text
}

// ============================================================
// Tool-calling adapter (agent actions — update tags/fields, trigger
// automations). Kept separate from `generateOpenAi` above so the
// plain text-only path (draft, playground without actions) is
// completely unaffected — no `tools` field is ever sent unless the
// agent loop explicitly built one.
// ============================================================

interface OpenAiToolCallWire {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

export interface OpenAiTurn {
  role: 'user' | 'assistant' | 'tool'
  content?: string | null
  tool_calls?: OpenAiToolCallWire[]
  tool_call_id?: string
}

interface OpenAiToolResponse {
  choices?: {
    message?: { content?: string | null; tool_calls?: OpenAiToolCallWire[] }
  }[]
}

function toOpenAiTools(tools: ToolDefinition[]) {
  return tools.map((t) => ({
    type: 'function' as const,
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }))
}

export const openAiAdapter: ProviderAdapter<OpenAiTurn> = {
  initialTurns(messages: ChatMessage[]): OpenAiTurn[] {
    return mergeConsecutive(messages).map((m) => ({ role: m.role, content: m.content }))
  },

  async generateTurn({ apiKey, model, systemPrompt, timeoutMs, turns, tools }) {
    let res: Response
    try {
      res = await fetch(OPENAI_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          messages: [{ role: 'system', content: systemPrompt }, ...turns],
          tools: toOpenAiTools(tools),
          max_completion_tokens: MAX_OUTPUT_TOKENS,
        }),
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (err) {
      throw toNetworkError(err)
    }
    if (!res.ok) throw await providerHttpError('OpenAI', res)

    const data = (await res.json().catch(() => null)) as OpenAiToolResponse | null
    const message = data?.choices?.[0]?.message
    if (!message) {
      throw new AiError('OpenAI returned an empty response.', { code: 'empty_response' })
    }

    const toolCalls: ToolCall[] = (message.tool_calls ?? []).map((tc) => {
      let args: Record<string, unknown> = {}
      try {
        args = JSON.parse(tc.function.arguments)
      } catch {
        // Malformed JSON from the model — treat as no arguments rather
        // than failing the whole turn; the tool executor validates
        // required fields anyway and will report back what's missing.
      }
      return { id: tc.id, name: tc.function.name, arguments: args }
    })

    return {
      text: typeof message.content === 'string' ? message.content : null,
      toolCalls,
      assistantTurn: {
        role: 'assistant',
        content: message.content ?? null,
        tool_calls: message.tool_calls,
      },
    }
  },

  appendToolResults(turns, assistantTurn, results: ToolResult[]): OpenAiTurn[] {
    return [
      ...turns,
      assistantTurn,
      ...results.map((r) => ({
        role: 'tool' as const,
        tool_call_id: r.id,
        content: r.content,
      })),
    ]
  },
}
