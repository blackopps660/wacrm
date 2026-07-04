// ============================================================
// GET   /api/v1/conversations/{id} — read one conversation
//       (scope: conversations:read)
// PATCH /api/v1/conversations/{id} — update status and/or mark as
//       read/unread (scope: conversations:write)
//
// Both are account-scoped: a conversation belonging to another
// account returns 404 (never 403 — don't reveal it exists elsewhere).
//
// PATCH exists primarily so a client without its own Supabase session
// (e.g. a separate mobile app) can sync read state — set
// `unread_count: 0` after the user opens a thread, mirroring what the
// dashboard's MessageThread component does for a logged-in session.
// `status` is accepted too since it's the other field the dashboard
// itself mutates on this row; both update only when present in the
// body, matching the contacts PATCH endpoint's partial-update contract.
// ============================================================

import { requireApiKey } from '@/lib/auth/api-context';
import { ok, fail, toApiErrorResponse } from '@/lib/api/v1/respond';
import {
  CONVERSATION_SELECT,
  normalizeConversation,
} from '@/lib/inbox/conversations';
import { serializeConversation } from '@/lib/api/v1/conversations';
import type { Conversation } from '@/types';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await requireApiKey(request, 'conversations:read');
    const { id } = await params;

    const { data, error } = await ctx.supabase
      .from('conversations')
      .select(CONVERSATION_SELECT)
      .eq('id', id)
      .eq('account_id', ctx.accountId)
      .maybeSingle();

    if (error) {
      console.error('[api/v1/conversations] read error:', error);
      return fail('internal', 'Failed to read conversation', 500);
    }
    if (!data) return fail('not_found', 'Conversation not found', 404);

    return ok(serializeConversation(normalizeConversation(data as Conversation)));
  } catch (err) {
    return toApiErrorResponse(err);
  }
}

const VALID_STATUSES = new Set(['open', 'pending', 'closed']);

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await requireApiKey(request, 'conversations:write');
    const { id } = await params;

    const body = (await request.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    if (!body || typeof body !== 'object') {
      return fail('bad_request', 'Request body must be a JSON object', 400);
    }

    // Partial update — a field is touched only when its key is
    // PRESENT in the body, same contract as the contacts PATCH route.
    const updates: Record<string, unknown> = {};

    if ('unread_count' in body) {
      const value = body.unread_count;
      if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
        return fail(
          'bad_request',
          "'unread_count' must be a non-negative integer",
          400
        );
      }
      updates.unread_count = value;
    }

    if ('status' in body) {
      const value = body.status;
      if (typeof value !== 'string' || !VALID_STATUSES.has(value)) {
        return fail(
          'bad_request',
          "'status' must be one of open, pending, closed",
          400
        );
      }
      updates.status = value;
    }

    if (Object.keys(updates).length === 0) {
      return fail(
        'bad_request',
        "Provide at least one of 'status' or 'unread_count'",
        400
      );
    }

    updates.updated_at = new Date().toISOString();

    const { data, error } = await ctx.supabase
      .from('conversations')
      .update(updates)
      .eq('id', id)
      .eq('account_id', ctx.accountId)
      .select(CONVERSATION_SELECT)
      .maybeSingle();

    if (error) {
      console.error('[api/v1/conversations] update error:', error);
      return fail('internal', 'Failed to update conversation', 500);
    }
    if (!data) return fail('not_found', 'Conversation not found', 404);

    return ok(serializeConversation(normalizeConversation(data as Conversation)));
  } catch (err) {
    return toApiErrorResponse(err);
  }
}
