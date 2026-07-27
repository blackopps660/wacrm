// ============================================================
// DELETE /api/account/workspaces/[id]
//
// Owner-only, irreversible deletion of an entire workspace and all of
// its data. The heavy lifting + every guard (owner check, "not your
// only workspace", relocating members' profiles so the cascade can't
// orphan them) lives in the SECURITY DEFINER `delete_workspace` RPC
// (migration 058) so a direct API call can't bypass it. This route is
// a thin authenticated wrapper that surfaces the RPC's errors and
// returns the workspace the caller was switched into.
// ============================================================

import { NextResponse } from 'next/server';

import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account';
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit';

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await getCurrentAccount();

    const limit = checkRateLimit(
      `account:deleteWorkspace:${ctx.userId}`,
      RATE_LIMITS.adminAction
    );
    if (!limit.success) return rateLimitResponse(limit);

    const { id } = await params;
    if (!id) {
      return NextResponse.json(
        { error: 'Workspace id is required' },
        { status: 400 }
      );
    }

    // The RPC enforces owner-only + all safety guards and returns the
    // account the caller was relocated to.
    const { data: switchedTo, error } = await ctx.supabase.rpc(
      'delete_workspace',
      { p_account_id: id }
    );

    if (error) {
      console.error('[DELETE /api/account/workspaces/[id]] RPC error:', error);
      // Postgres SQLSTATE 42501 = insufficient privilege (not owner /
      // not a member); 22023 = invalid parameter value (only workspace,
      // stranded member). Map both to actionable client errors.
      const status = error.code === '42501' ? 403 : 400;
      return NextResponse.json(
        { error: error.message || 'Failed to delete workspace' },
        { status }
      );
    }

    return NextResponse.json({ success: true, switchedTo });
  } catch (err) {
    return toErrorResponse(err);
  }
}
