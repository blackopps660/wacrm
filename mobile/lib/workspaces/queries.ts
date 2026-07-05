import type { SupabaseClient } from '@supabase/supabase-js';
import type { AccountRole } from '../roles';

// Ported from src/components/layout/workspace-switcher.tsx (web app).
// Workspace LIST is a direct read (account_memberships joined to
// accounts) — no RLS-blocked columns, no API route needed. The SWITCH
// itself calls the existing switch_current_account(p_account_id)
// SECURITY DEFINER RPC (migration 031) directly — it validates
// membership itself and updates profiles.account_id/account_role, so
// no backend changes are needed for this phase either.

export interface Workspace {
  id: string;
  name: string;
  role: AccountRole;
  isCurrent: boolean;
}

export async function loadWorkspaces(
  db: SupabaseClient,
  userId: string,
  currentAccountId: string | null,
): Promise<Workspace[]> {
  const { data, error } = await db
    .from('account_memberships')
    .select('account_id, role, accounts(name)')
    .eq('user_id', userId);
  if (error) throw error;

  return (
    (data ?? []) as unknown as Array<{
      account_id: string;
      role: AccountRole;
      accounts: { name: string }[] | { name: string } | null;
    }>
  )
    .map((row) => {
      const account = Array.isArray(row.accounts) ? row.accounts[0] : row.accounts;
      return {
        id: row.account_id,
        name: account?.name ?? 'Untitled workspace',
        role: row.role,
        isCurrent: row.account_id === currentAccountId,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Returns the new role on success — same contract as the RPC. */
export async function switchWorkspace(
  db: SupabaseClient,
  accountId: string,
): Promise<AccountRole> {
  const { data, error } = await db.rpc('switch_current_account', {
    p_account_id: accountId,
  });
  if (error) throw error;
  return data as AccountRole;
}
