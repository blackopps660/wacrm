// ============================================================
// /api/account/workspaces
//
//   GET  — list every workspace the caller belongs to.
//   POST — create a new workspace (self-serve) and switch into it.
//
// Backed by migration 031_account_memberships.sql: membership lives
// in `account_memberships`, "which one am I looking at right now"
// lives in `profiles.account_id`. Any member can list their own
// workspaces regardless of role.
//
// Two-query pattern (not an embedded FK join) — same reasoning as
// getCurrentAccount() and /api/account/members: a stale PostgREST
// schema cache makes embedded relationship lookups fail hard
// (PGRST200, issue #294), so we resolve accounts with a plain
// point lookup by id instead.
// ============================================================

import { NextResponse } from "next/server";

import { getCurrentAccount, toErrorResponse } from "@/lib/auth/account";
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from "@/lib/rate-limit";
import type { AccountRole } from "@/lib/auth/roles";
import { isAccountRole } from "@/lib/auth/roles";

interface MembershipRow {
  account_id: string;
  role: string;
}

interface AccountRow {
  id: string;
  name: string;
}

export async function GET() {
  try {
    const ctx = await getCurrentAccount();

    const { data: memberships, error: membershipsErr } = await ctx.supabase
      .from("account_memberships")
      .select("account_id, role")
      .eq("user_id", ctx.userId);

    if (membershipsErr) {
      console.error(
        "[GET /api/account/workspaces] memberships fetch error:",
        membershipsErr,
      );
      return NextResponse.json(
        { error: "Failed to load workspaces" },
        { status: 500 },
      );
    }

    const rows = (memberships ?? []) as MembershipRow[];
    if (rows.length === 0) {
      // Shouldn't happen post-signup, but don't 500 on it.
      return NextResponse.json({ workspaces: [] });
    }

    const accountIds = rows.map((r) => r.account_id);
    const { data: accounts, error: accountsErr } = await ctx.supabase
      .from("accounts")
      .select("id, name")
      .in("id", accountIds);

    if (accountsErr) {
      console.error(
        "[GET /api/account/workspaces] accounts fetch error:",
        accountsErr,
      );
      return NextResponse.json(
        { error: "Failed to load workspaces" },
        { status: 500 },
      );
    }

    const nameById = new Map(
      ((accounts ?? []) as AccountRow[]).map((a) => [a.id, a.name]),
    );

    const workspaces = rows
      .filter((r) => isAccountRole(r.role))
      .map((r) => ({
        id: r.account_id,
        name: nameById.get(r.account_id) ?? "Untitled workspace",
        role: r.role as AccountRole,
        isCurrent: r.account_id === ctx.accountId,
      }))
      // Current workspace first, then alphabetical — keeps the
      // switcher's active item pinned to the top regardless of join
      // order.
      .sort((a, b) => {
        if (a.isCurrent !== b.isCurrent) return a.isCurrent ? -1 : 1;
        return a.name.localeCompare(b.name);
      });

    return NextResponse.json({ workspaces });
  } catch (err) {
    return toErrorResponse(err);
  }
}

const MAX_NAME_LEN = 80;

export async function POST(request: Request) {
  try {
    const ctx = await getCurrentAccount();

    const limit = checkRateLimit(
      `account:createWorkspace:${ctx.userId}`,
      RATE_LIMITS.adminAction,
    );
    if (!limit.success) return rateLimitResponse(limit);

    const body = (await request.json().catch(() => null)) as
      | { name?: unknown }
      | null;
    const rawName = body?.name;

    if (typeof rawName !== "string") {
      return NextResponse.json(
        { error: "'name' must be a string" },
        { status: 400 },
      );
    }

    const name = rawName.trim();
    if (name.length === 0) {
      return NextResponse.json(
        { error: "Workspace name cannot be empty" },
        { status: 400 },
      );
    }
    if (name.length > MAX_NAME_LEN) {
      return NextResponse.json(
        { error: `Workspace name must be ${MAX_NAME_LEN} characters or fewer` },
        { status: 400 },
      );
    }

    const { data: accountId, error } = await ctx.supabase.rpc(
      "create_workspace",
      { p_name: name },
    );

    if (error) {
      console.error("[POST /api/account/workspaces] RPC error:", error);
      return NextResponse.json(
        { error: error.message || "Failed to create workspace" },
        { status: 400 },
      );
    }

    return NextResponse.json(
      { workspace: { id: accountId, name, role: "owner" as const } },
      { status: 201 },
    );
  } catch (err) {
    return toErrorResponse(err);
  }
}
