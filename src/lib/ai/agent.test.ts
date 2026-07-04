import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { AiConfig, ToolCall } from './types'

const h = vi.hoisted(() => ({
  generateReply: vi.fn(),
  buildToolDefinitions: vi.fn(),
  executeToolCall: vi.fn(),
  simulateToolCall: vi.fn(),
  generateTurn: vi.fn(),
}))

vi.mock('./generate', () => ({
  generateReply: h.generateReply,
  parseGeneration: (raw: string) => {
    const HANDOFF = '[[HANDOFF]]'
    return { text: raw.split(HANDOFF).join('').trim(), handoff: raw.includes(HANDOFF) }
  },
}))

vi.mock('./tools', () => ({
  buildToolDefinitions: h.buildToolDefinitions,
  executeToolCall: h.executeToolCall,
  simulateToolCall: h.simulateToolCall,
}))

// Both providers route through the same mocked `generateTurn` so a single
// mock controls the loop regardless of which provider the test config picks.
vi.mock('./providers/openai', () => ({
  openAiAdapter: {
    initialTurns: (messages: unknown) => messages,
    generateTurn: h.generateTurn,
    appendToolResults: (turns: unknown[], assistantTurn: unknown, results: unknown) => [
      ...turns,
      assistantTurn,
      results,
    ],
  },
}))
vi.mock('./providers/anthropic', () => ({
  anthropicAdapter: {
    initialTurns: (messages: unknown) => messages,
    generateTurn: h.generateTurn,
    appendToolResults: (turns: unknown[], assistantTurn: unknown, results: unknown) => [
      ...turns,
      assistantTurn,
      results,
    ],
  },
}))

import { runAgentTurn } from './agent'

function config(overrides: Partial<AiConfig> = {}): AiConfig {
  return {
    provider: 'openai',
    model: 'gpt-test',
    apiKey: 'sk-test',
    systemPrompt: null,
    isActive: true,
    autoReplyEnabled: true,
    autoReplyMaxPerConversation: 3,
    embeddingsApiKey: null,
    defaultNewConversationOwner: 'human',
    actions: {
      updateTags: { enabled: true, guidelines: null },
      updateContactFields: { enabled: false, guidelines: null },
      triggerAutomations: { enabled: false, guidelines: null },
    },
    ...overrides,
  }
}

const BASE_ARGS = {
  config: config(),
  systemPrompt: 'system',
  messages: [{ role: 'user' as const, content: 'hi' }],
  db: {} as SupabaseClient,
  accountId: 'acct-1',
}

function toolCall(name = 'update_tags'): ToolCall {
  return { id: 'call-1', name, arguments: { add: ['Hot Lead'] } }
}

beforeEach(() => {
  h.generateReply.mockReset()
  h.buildToolDefinitions.mockReset()
  h.executeToolCall.mockReset()
  h.simulateToolCall.mockReset()
  h.generateTurn.mockReset()
})

describe('runAgentTurn — no tools available', () => {
  it('falls back to the plain single-call generateReply', async () => {
    h.buildToolDefinitions.mockResolvedValue([])
    h.generateReply.mockResolvedValue({ text: 'Hello!', handoff: false })

    const result = await runAgentTurn({ ...BASE_ARGS, contactId: 'c1', conversationId: 'conv-1' })

    expect(result).toEqual({ text: 'Hello!', handoff: false })
    expect(h.generateTurn).not.toHaveBeenCalled()
  })
})

describe('runAgentTurn — with tools, real execution', () => {
  it('executes a tool call for real, then returns the final text', async () => {
    h.buildToolDefinitions.mockResolvedValue([
      { name: 'update_tags', description: 'd', parameters: {} },
    ])
    h.executeToolCall.mockResolvedValue({ id: 'call-1', name: 'update_tags', content: 'done' })
    h.generateTurn
      .mockResolvedValueOnce({
        text: null,
        toolCalls: [toolCall()],
        assistantTurn: { role: 'assistant', tool_calls: [toolCall()] },
      })
      .mockResolvedValueOnce({
        text: 'All set!',
        toolCalls: [],
        assistantTurn: { role: 'assistant', content: 'All set!' },
      })

    const result = await runAgentTurn({
      ...BASE_ARGS,
      contactId: 'contact-1',
      conversationId: 'conv-1',
    })

    expect(h.executeToolCall).toHaveBeenCalledWith(
      BASE_ARGS.db,
      toolCall(),
      { accountId: 'acct-1', contactId: 'contact-1', conversationId: 'conv-1' },
    )
    expect(h.simulateToolCall).not.toHaveBeenCalled()
    expect(result).toEqual({ text: 'All set!', handoff: false })
  })
})

describe('runAgentTurn — Playground (no real contact)', () => {
  it('simulates tool calls instead of executing them', async () => {
    h.buildToolDefinitions.mockResolvedValue([
      { name: 'update_tags', description: 'd', parameters: {} },
    ])
    h.simulateToolCall.mockReturnValue({ id: 'call-1', name: 'update_tags', content: 'simulated' })
    h.generateTurn
      .mockResolvedValueOnce({
        text: null,
        toolCalls: [toolCall()],
        assistantTurn: { role: 'assistant' },
      })
      .mockResolvedValueOnce({ text: 'Done!', toolCalls: [], assistantTurn: { role: 'assistant' } })

    // No contactId/conversationId — Playground path.
    const result = await runAgentTurn(BASE_ARGS)

    expect(h.simulateToolCall).toHaveBeenCalledWith(toolCall())
    expect(h.executeToolCall).not.toHaveBeenCalled()
    expect(result).toEqual({ text: 'Done!', handoff: false })
  })
})

describe('runAgentTurn — iteration cap', () => {
  it('treats an endless tool-calling loop as a handoff instead of looping forever', async () => {
    h.buildToolDefinitions.mockResolvedValue([
      { name: 'update_tags', description: 'd', parameters: {} },
    ])
    h.simulateToolCall.mockReturnValue({ id: 'call-1', name: 'update_tags', content: 'simulated' })
    // Always returns another tool call — never a final answer.
    h.generateTurn.mockResolvedValue({
      text: null,
      toolCalls: [toolCall()],
      assistantTurn: { role: 'assistant' },
    })

    const result = await runAgentTurn(BASE_ARGS)

    expect(result).toEqual({ text: '', handoff: true })
    expect(h.generateTurn).toHaveBeenCalledTimes(4)
  })
})
