import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { AiActionsConfig, ToolCall } from './types'

const h = vi.hoisted(() => ({
  runSpecificAutomation: vi.fn(),
}))

vi.mock('@/lib/automations/engine', () => ({
  runSpecificAutomation: h.runSpecificAutomation,
}))

import { buildToolDefinitions, executeToolCall, simulateToolCall } from './tools'

const ACCOUNT = 'acct-1'
const CTX = { accountId: ACCOUNT, contactId: 'contact-1', conversationId: 'conv-1' }

function disabledActions(): AiActionsConfig {
  return {
    updateTags: { enabled: false, guidelines: null },
    updateContactFields: { enabled: false, guidelines: null },
    triggerAutomations: { enabled: false, guidelines: null },
  }
}

/** A minimal fake SupabaseClient whose `.from(table)` returns
 *  whatever row set `tables[table]` holds, and records every
 *  upsert/delete for assertions. */
function fakeDb(tables: Record<string, unknown[]>) {
  const upserts: { table: string; payload: unknown }[] = []
  const deletes: { table: string; filters: [string, unknown][] }[] = []

  const db = {
    from: (table: string) => {
      const rows = tables[table] ?? []
      const chain = {
        select: () => chain,
        eq: () => chain,
        upsert: (payload: unknown) => {
          upserts.push({ table, payload })
          return Promise.resolve({ error: null })
        },
        delete: () => {
          const filters: [string, unknown][] = []
          const deleteChain = {
            eq: (k: string, v: unknown) => {
              filters.push([k, v])
              return deleteChain
            },
            then: (onF: (v: unknown) => unknown) => {
              deletes.push({ table, filters })
              return Promise.resolve({ error: null }).then(onF)
            },
          }
          return deleteChain
        },
        then: (onF: (v: unknown) => unknown) =>
          Promise.resolve({ data: rows, error: null }).then(onF),
      }
      return chain
    },
  }
  return { db: db as unknown as SupabaseClient, upserts, deletes }
}

function call(name: string, args: Record<string, unknown>): ToolCall {
  return { id: 'call-1', name, arguments: args }
}

beforeEach(() => {
  h.runSpecificAutomation.mockReset()
})

describe('buildToolDefinitions', () => {
  it('returns no tools when every action is disabled', async () => {
    const { db } = fakeDb({})
    const tools = await buildToolDefinitions(db, ACCOUNT, disabledActions())
    expect(tools).toEqual([])
  })

  it('skips update_tags when the account has no tags, even if enabled', async () => {
    const { db } = fakeDb({ tags: [] })
    const actions = { ...disabledActions(), updateTags: { enabled: true, guidelines: null } }
    const tools = await buildToolDefinitions(db, ACCOUNT, actions)
    expect(tools.find((t) => t.name === 'update_tags')).toBeUndefined()
  })

  it('builds update_tags with the account\'s real tag names as an enum', async () => {
    const { db } = fakeDb({ tags: [{ name: 'Hot Lead' }, { name: 'VIP' }] })
    const actions = {
      ...disabledActions(),
      updateTags: { enabled: true, guidelines: 'Tag VIP when they mention a bulk order.' },
    }
    const tools = await buildToolDefinitions(db, ACCOUNT, actions)
    const tool = tools.find((t) => t.name === 'update_tags')
    expect(tool).toBeDefined()
    expect(tool!.description).toContain('Hot Lead')
    expect(tool!.description).toContain('VIP')
    expect(tool!.description).toContain('Tag VIP when they mention a bulk order.')
    const props = tool!.parameters.properties as Record<string, { items: { enum: string[] } }>
    expect(props.add.items.enum).toEqual(['Hot Lead', 'VIP'])
  })

  it('builds trigger_automation only from active automations, with descriptions in the catalog', async () => {
    const { db } = fakeDb({
      automations: [{ name: 'FBR Certificate Flow', description: 'Sends the FBR PDF.' }],
    })
    const actions = {
      ...disabledActions(),
      triggerAutomations: { enabled: true, guidelines: null },
    }
    const tools = await buildToolDefinitions(db, ACCOUNT, actions)
    const tool = tools.find((t) => t.name === 'trigger_automation')
    expect(tool).toBeDefined()
    expect(tool!.description).toContain('FBR Certificate Flow')
    expect(tool!.description).toContain('Sends the FBR PDF.')
  })
})

describe('executeToolCall — update_tags', () => {
  it('adds and removes tags by name, case-insensitively', async () => {
    const { db, upserts, deletes } = fakeDb({
      tags: [
        { id: 'tag-hot', name: 'Hot Lead' },
        { id: 'tag-vip', name: 'VIP' },
      ],
    })
    const result = await executeToolCall(
      db,
      call('update_tags', { add: ['hot lead'], remove: ['VIP'] }),
      CTX,
    )
    expect(upserts).toEqual([
      { table: 'contact_tags', payload: { contact_id: 'contact-1', tag_id: 'tag-hot' } },
    ])
    expect(deletes).toHaveLength(1)
    expect(deletes[0].filters).toContainEqual(['tag_id', 'tag-vip'])
    expect(result.content).toContain('+Hot Lead')
    expect(result.content).toContain('-VIP')
  })

  it('ignores unknown tag names instead of inventing them', async () => {
    const { db, upserts } = fakeDb({ tags: [{ id: 'tag-hot', name: 'Hot Lead' }] })
    const result = await executeToolCall(
      db,
      call('update_tags', { add: ['Nonexistent Tag'] }),
      CTX,
    )
    expect(upserts).toEqual([])
    expect(result.content).toContain('Unknown tags ignored: Nonexistent Tag')
  })
})

describe('executeToolCall — update_contact_field', () => {
  it('resolves the field by name and upserts the value', async () => {
    const { db, upserts } = fakeDb({
      custom_fields: [{ id: 'cf-1', field_name: 'Order Number' }],
    })
    const result = await executeToolCall(
      db,
      call('update_contact_field', { field_name: 'order number', value: '12345' }),
      CTX,
    )
    expect(upserts).toEqual([
      {
        table: 'contact_custom_values',
        payload: { contact_id: 'contact-1', custom_field_id: 'cf-1', value: '12345' },
      },
    ])
    expect(result.content).toContain('Order Number')
  })

  it('refuses an unknown field name', async () => {
    const { db, upserts } = fakeDb({ custom_fields: [] })
    const result = await executeToolCall(
      db,
      call('update_contact_field', { field_name: 'Ghost Field', value: 'x' }),
      CTX,
    )
    expect(upserts).toEqual([])
    expect(result.content).toContain('Unknown field')
  })
})

describe('executeToolCall — trigger_automation', () => {
  it('resolves the automation by name and calls runSpecificAutomation', async () => {
    h.runSpecificAutomation.mockResolvedValue({ ok: true })
    const { db } = fakeDb({ automations: [{ id: 'auto-1', name: 'FBR Certificate Flow' }] })
    const result = await executeToolCall(
      db,
      call('trigger_automation', { automation_name: 'fbr certificate flow' }),
      CTX,
    )
    expect(h.runSpecificAutomation).toHaveBeenCalledWith({
      accountId: ACCOUNT,
      automationId: 'auto-1',
      contactId: 'contact-1',
      context: { conversation_id: 'conv-1' },
    })
    expect(result.content).toContain('Triggered "FBR Certificate Flow"')
  })

  it('refuses an unknown automation name without calling runSpecificAutomation', async () => {
    const { db } = fakeDb({ automations: [] })
    const result = await executeToolCall(
      db,
      call('trigger_automation', { automation_name: 'Ghost Flow' }),
      CTX,
    )
    expect(h.runSpecificAutomation).not.toHaveBeenCalled()
    expect(result.content).toContain('Unknown automation')
  })
})

describe('simulateToolCall', () => {
  it('never touches the database and always reports success', () => {
    const result = simulateToolCall(call('update_tags', { add: ['Anything'] }))
    expect(result.content).toContain('Playground only')
  })
})
