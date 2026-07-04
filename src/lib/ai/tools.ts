import type { SupabaseClient } from '@supabase/supabase-js'
import { runSpecificAutomation } from '@/lib/automations/engine'
import type { AiActionsConfig, ToolCall, ToolDefinition, ToolResult } from './types'

// ============================================================
// AI agent tool-calling actions (migration 040).
//
// Three independently-toggled actions, each described to the model
// with an enum of the account's *actual* tags/fields/automations so it
// can only ever reference something real — inventing a new tag name or
// a nonexistent automation isn't something the schema allows for. The
// executor re-validates against the account's live data anyway (the
// model can still send a name that no longer exists between building
// the tool list and executing the call), matching prod's dependency-
// resolution discipline elsewhere (e.g. webhook contact/account
// ownership checks).
// ============================================================

export interface ToolContext {
  accountId: string
  contactId: string
  conversationId: string
}

export async function buildToolDefinitions(
  db: SupabaseClient,
  accountId: string,
  actions: AiActionsConfig,
): Promise<ToolDefinition[]> {
  const tools: ToolDefinition[] = []

  if (actions.updateTags.enabled) {
    const { data: tags } = await db
      .from('tags')
      .select('name')
      .eq('account_id', accountId)
    const names = (tags ?? []).map((t) => t.name as string)
    // Nothing to tag with — skip the tool entirely rather than
    // offering the model an action with an empty enum.
    if (names.length > 0) {
      tools.push({
        name: 'update_tags',
        description: [
          "Add or remove existing tags on this contact. Only use tag names from the list below — never invent a new one.",
          `Available tags: ${names.join(', ')}.`,
          actions.updateTags.guidelines
            ? `When to use this: ${actions.updateTags.guidelines}`
            : '',
        ]
          .filter(Boolean)
          .join(' '),
        parameters: {
          type: 'object',
          properties: {
            add: {
              type: 'array',
              items: { type: 'string', enum: names },
              description: 'Tag names to add to this contact.',
            },
            remove: {
              type: 'array',
              items: { type: 'string', enum: names },
              description: 'Tag names to remove from this contact.',
            },
          },
        },
      })
    }
  }

  if (actions.updateContactFields.enabled) {
    const { data: fields } = await db
      .from('custom_fields')
      .select('field_name')
      .eq('account_id', accountId)
    const names = (fields ?? []).map((f) => f.field_name as string)
    if (names.length > 0) {
      tools.push({
        name: 'update_contact_field',
        description: [
          'Set a custom field value on this contact, based on information the customer gave in the conversation. Only use a field name from the list below.',
          `Available fields: ${names.join(', ')}.`,
          actions.updateContactFields.guidelines
            ? `When to use this: ${actions.updateContactFields.guidelines}`
            : '',
        ]
          .filter(Boolean)
          .join(' '),
        parameters: {
          type: 'object',
          properties: {
            field_name: { type: 'string', enum: names },
            value: { type: 'string', description: 'The value to store, as plain text.' },
          },
          required: ['field_name', 'value'],
        },
      })
    }
  }

  if (actions.triggerAutomations.enabled) {
    const { data: automations } = await db
      .from('automations')
      .select('name, description')
      .eq('account_id', accountId)
      .eq('is_active', true)
    const list = (automations ?? []) as { name: string; description: string | null }[]
    if (list.length > 0) {
      const names = list.map((a) => a.name)
      const catalog = list
        .map((a) => `- ${a.name}${a.description ? `: ${a.description}` : ''}`)
        .join('\n')
      tools.push({
        name: 'trigger_automation',
        description: [
          "Trigger one of the account's existing automations for this contact. Only use a name from the list below.",
          `Available automations:\n${catalog}`,
          actions.triggerAutomations.guidelines
            ? `When to use this: ${actions.triggerAutomations.guidelines}`
            : '',
        ]
          .filter(Boolean)
          .join('\n\n'),
        parameters: {
          type: 'object',
          properties: { automation_name: { type: 'string', enum: names } },
          required: ['automation_name'],
        },
      })
    }
  }

  return tools
}

/** Actually perform a tool call against real data. Never throws — a
 *  failure becomes a `ToolResult` telling the model what went wrong,
 *  the same way a customer-facing error would be described in text. */
export async function executeToolCall(
  db: SupabaseClient,
  call: ToolCall,
  ctx: ToolContext,
): Promise<ToolResult> {
  try {
    switch (call.name) {
      case 'update_tags':
        return await execUpdateTags(db, call, ctx)
      case 'update_contact_field':
        return await execUpdateContactField(db, call, ctx)
      case 'trigger_automation':
        return await execTriggerAutomation(db, call, ctx)
      default:
        return { id: call.id, name: call.name, content: 'Unknown tool — no action taken.' }
    }
  } catch (err) {
    console.error('[ai tools] executeToolCall failed:', call.name, err)
    return { id: call.id, name: call.name, content: 'That action failed unexpectedly.' }
  }
}

/** Playground equivalent — same shape, no real writes. Mirrors the
 *  "actions taken here are for testing only" disclaimer respond.io
 *  itself shows in its own test-chat panel. */
export function simulateToolCall(call: ToolCall): ToolResult {
  return {
    id: call.id,
    name: call.name,
    content:
      '(Playground only — no real change was made.) Assume it succeeded and continue the conversation.',
  }
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
}

async function execUpdateTags(
  db: SupabaseClient,
  call: ToolCall,
  ctx: ToolContext,
): Promise<ToolResult> {
  const add = stringArray(call.arguments.add)
  const remove = stringArray(call.arguments.remove)
  if (add.length === 0 && remove.length === 0) {
    return { id: call.id, name: call.name, content: 'No tags specified — no change made.' }
  }

  const { data: tags } = await db
    .from('tags')
    .select('id, name')
    .eq('account_id', ctx.accountId)
  const byName = new Map(
    (tags ?? []).map((t) => [String(t.name).toLowerCase(), t as { id: string; name: string }]),
  )

  const applied: string[] = []
  const unknown: string[] = []

  for (const name of add) {
    const tag = byName.get(name.toLowerCase())
    if (!tag) {
      unknown.push(name)
      continue
    }
    const { error } = await db
      .from('contact_tags')
      .upsert({ contact_id: ctx.contactId, tag_id: tag.id }, { onConflict: 'contact_id,tag_id' })
    if (!error) applied.push(`+${tag.name}`)
  }

  for (const name of remove) {
    const tag = byName.get(name.toLowerCase())
    if (!tag) {
      unknown.push(name)
      continue
    }
    const { error } = await db
      .from('contact_tags')
      .delete()
      .eq('contact_id', ctx.contactId)
      .eq('tag_id', tag.id)
    if (!error) applied.push(`-${tag.name}`)
  }

  const summary = applied.length > 0 ? `Applied: ${applied.join(', ')}.` : 'No changes applied.'
  const unknownNote = unknown.length > 0 ? ` Unknown tags ignored: ${unknown.join(', ')}.` : ''
  return { id: call.id, name: call.name, content: summary + unknownNote }
}

async function execUpdateContactField(
  db: SupabaseClient,
  call: ToolCall,
  ctx: ToolContext,
): Promise<ToolResult> {
  const fieldName =
    typeof call.arguments.field_name === 'string' ? call.arguments.field_name : ''
  const value = typeof call.arguments.value === 'string' ? call.arguments.value : ''
  if (!fieldName || !value) {
    return {
      id: call.id,
      name: call.name,
      content: 'field_name and value are both required — no change made.',
    }
  }

  const { data: fields } = await db
    .from('custom_fields')
    .select('id, field_name')
    .eq('account_id', ctx.accountId)
  const field = (fields ?? []).find(
    (f) => String(f.field_name).toLowerCase() === fieldName.toLowerCase(),
  ) as { id: string; field_name: string } | undefined
  if (!field) {
    return {
      id: call.id,
      name: call.name,
      content: `Unknown field "${fieldName}" — no change made.`,
    }
  }

  const { error } = await db
    .from('contact_custom_values')
    .upsert(
      { contact_id: ctx.contactId, custom_field_id: field.id, value },
      { onConflict: 'contact_id,custom_field_id' },
    )
  if (error) {
    return { id: call.id, name: call.name, content: `Failed to update ${field.field_name}.` }
  }
  return {
    id: call.id,
    name: call.name,
    content: `Set ${field.field_name} = "${value}".`,
  }
}

async function execTriggerAutomation(
  db: SupabaseClient,
  call: ToolCall,
  ctx: ToolContext,
): Promise<ToolResult> {
  const name =
    typeof call.arguments.automation_name === 'string' ? call.arguments.automation_name : ''
  if (!name) {
    return { id: call.id, name: call.name, content: 'automation_name is required.' }
  }

  const { data: automations } = await db
    .from('automations')
    .select('id, name')
    .eq('account_id', ctx.accountId)
    .eq('is_active', true)
  const automation = (automations ?? []).find(
    (a) => String(a.name).toLowerCase() === name.toLowerCase(),
  ) as { id: string; name: string } | undefined
  if (!automation) {
    return {
      id: call.id,
      name: call.name,
      content: `Unknown automation "${name}" — nothing triggered.`,
    }
  }

  const result = await runSpecificAutomation({
    accountId: ctx.accountId,
    automationId: automation.id,
    contactId: ctx.contactId,
    context: { conversation_id: ctx.conversationId },
  })
  return {
    id: call.id,
    name: call.name,
    content: result.ok
      ? `Triggered "${automation.name}".`
      : `Failed to trigger "${automation.name}".`,
  }
}
