-- ============================================================
-- 032_accounts_select_by_membership.sql
--
-- Bug found while testing the workspace switcher (Phase 2 of the
-- multi-workspace rollout): `accounts_select` (migration 017) uses
-- is_account_member(id), which checks profiles.account_id — the
-- caller's single "currently active" workspace pointer. That's
-- correct for domain data (contacts, messages, ...), which should
-- only ever be visible for the active workspace, but wrong for the
-- `accounts` row itself: GET /api/account/workspaces reads every
-- workspace a member belongs to (account_memberships) and then
-- looks up each one's name/id from `accounts`. Under the old
-- policy, every workspace other than the currently-active one
-- returned zero rows, so the switcher fell back to "Untitled
-- workspace" for anything you weren't currently viewing.
--
-- Fix: accounts are visible to any member (via account_memberships),
-- not just the one currently active. `accounts_update` is left
-- untouched — renaming still requires being admin+ of the
-- *currently active* workspace, consistent with every other
-- settings mutation in the app (PATCH /api/account switches via
-- ctx.accountId, the active pointer).
--
-- Idempotent — safe to run multiple times.
-- ============================================================

DROP POLICY IF EXISTS accounts_select ON accounts;
CREATE POLICY accounts_select ON accounts FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM account_memberships m
      WHERE m.account_id = accounts.id AND m.user_id = auth.uid()
    )
  );
