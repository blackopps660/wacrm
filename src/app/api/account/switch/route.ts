// ============================================================
// POST /api/account/switch
//
// Moves the caller's "currently viewing" workspace pointer
// (profiles.account_id / account_role) to another workspace they
// already belong to. Every domain-table RLS policy keys off that
// pointer via is_account_member(), so this is what makes the
// switcher actually change which data the caller can see.
//
// The heavy lifting — verifying membership, writing the pointer —
// lives in the `switch_current_account` SECURITY DEFINER RPC
// (migration 031). This route just validates shape and forwards.
// ============================================================

import { NextResponse } from "next/server";
import type { PostgrestError } from "@supabase/supabase-js";

import { getCurrentAccount, toErrorResponse } from "@/lib/auth/account";
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from "@/lib/rate-limit";

function looksLikeUuid(v: unknown): v is string {
  return (
    typeof v === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)
  );
}

function rpcErrorToResponse(err: PostgrestError): NextResponse {
  if (err.code === "42501") {
    return NextResponse.json({ error: err.message }, { status: 403 });
  }
  console.error("[POST /api/account/switch] unexpected RPC error:", err);
  return NextResponse.json(
    { error: "Failed to switch workspace" },
    { status: 500 },
  );
}

export async function POST(request: Request) {
  try {
    const ctx = await getCurrentAccount();

    const limit = checkRateLimit(
      `account:switch:${ctx.userId}`,
      RATE_LIMITS.adminAction,
    );
    if (!limit.success) return rateLimitResponse(limit);

    const body = (await request.json().catch(() => null)) as
      | { accountId?: unknown }
      | null;
    const accountId = body?.accountId;

    if (!looksLikeUuid(accountId)) {
      return NextResponse.json(
        { error: "'accountId' must be a valid UUID" },
        { status: 400 },
      );
    }

    const { data: role, error } = await ctx.supabase.rpc(
      "switch_current_account",
      { p_account_id: accountId },
    );

    if (error) return rpcErrorToResponse(error);

    return NextResponse.json({ ok: true, role });
  } catch (err) {
    return toErrorResponse(err);
  }
}
