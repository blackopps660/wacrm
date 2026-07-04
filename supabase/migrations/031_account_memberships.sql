-- ============================================================
-- 031_account_memberships.sql — many-to-many workspace membership
--
-- Migration 017 made wacrm account-scoped but locked every user to
-- exactly one account (profiles.account_id / account_role acted as
-- both "which workspaces am I in" AND "which one am I looking at").
-- This migration adds a real membership layer so one user (e.g. the
-- platform owner running several businesses) can belong to several
-- accounts ("workspaces") and switch between them.
--
-- What this migration does
--   1. Adds `account_memberships(account_id, user_id, role)` — the
--      new source of truth for "who can access which workspace".
--      Backfilled 1:1 from the existing `profiles` rows.
--   2. Keeps `profiles.account_id` / `profiles.account_role` exactly
--      as they were, but their MEANING narrows to "the workspace
--      this session is currently looking at" (a cache/pointer, not
--      the membership record). `is_account_member()` — and every
--      RLS policy on every domain table — is untouched: it still
--      reads this pointer, so a session only ever sees ONE
--      workspace's data at a time, which is exactly the isolation
--      behaviour we want.
--   3. Drops the one-account-per-owner unique index on `accounts` —
--      a single user can now own several workspaces.
--   4. Revokes client UPDATE on `profiles.account_id` /
--      `account_role` — closes a latent privilege-escalation gap
--      where `profiles_update` only checked row ownership, not
--      which columns changed, so any authenticated user could PATCH
--      their own profile with an arbitrary account_id/role and read
--      another workspace's data. All legitimate account_id/role
--      writes now go through SECURITY DEFINER RPCs, none of which
--      are affected by this revoke (they run as the function owner).
--   5. New RPCs: `switch_current_account`, `create_workspace`.
--   6. Rewrites `redeem_invitation` / `remove_account_member` /
--      `set_member_role` / `transfer_account_ownership` /
--      `handle_new_user` to read/write `account_memberships`
--      instead of treating `profiles.account_id` as the only
--      membership record. Notably, joining an account via invite is
--      now ADDITIVE (you keep your other workspaces) instead of
--      destructively relocating the caller's profile and deleting
--      their old account.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

-- ============================================================
-- ACCOUNT_MEMBERSHIPS
-- ============================================================
CREATE TABLE IF NOT EXISTS account_memberships (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role account_role_enum NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (account_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_account_memberships_user
  ON account_memberships(user_id);
CREATE INDEX IF NOT EXISTS idx_account_memberships_account
  ON account_memberships(account_id);

ALTER TABLE account_memberships ENABLE ROW LEVEL SECURITY;

-- Any user reads their own membership rows (needed for a "your
-- workspaces" switcher, regardless of which one is currently
-- active). Any current member of a workspace reads its full roster
-- (mirrors the existing profiles_select behaviour for the Members
-- tab). No client INSERT/UPDATE/DELETE — every mutation goes through
-- a SECURITY DEFINER RPC below.
DROP POLICY IF EXISTS account_memberships_select ON account_memberships;
CREATE POLICY account_memberships_select ON account_memberships FOR SELECT
  USING (user_id = auth.uid() OR is_account_member(account_id));

-- ============================================================
-- BACKFILL — one membership row per existing profile.
-- ============================================================
INSERT INTO account_memberships (account_id, user_id, role)
SELECT p.account_id, p.user_id, p.account_role
FROM profiles p
WHERE NOT EXISTS (
  SELECT 1 FROM account_memberships m
  WHERE m.account_id = p.account_id AND m.user_id = p.user_id
);

-- ============================================================
-- ACCOUNTS — allow one user to own more than one workspace.
-- ============================================================
DROP INDEX IF EXISTS idx_accounts_one_per_owner;

COMMENT ON TABLE accounts IS
  'A workspace. Membership (who can access it) lives in account_memberships; owner_user_id is denormalised for fast "am I the owner" reads.';
COMMENT ON COLUMN profiles.account_id IS
  'The workspace this session is currently viewing (a pointer, not the membership record). Full membership list is account_memberships. Client-writable only via SECURITY DEFINER RPCs — see the REVOKE below.';

-- ============================================================
-- Close the client-side privilege-escalation gap: profiles_update
-- (migration 017) only checks `auth.uid() = user_id`, not which
-- columns changed, so a raw PATCH could set account_id/account_role
-- to any workspace. Revoking column-level UPDATE privilege blocks
-- that path for PostgREST/client requests. SECURITY DEFINER
-- functions are unaffected — they execute as the function owner,
-- not as `authenticated`.
-- ============================================================
REVOKE UPDATE (account_id, account_role) ON public.profiles FROM authenticated;

-- ============================================================
-- switch_current_account(p_account_id)
--
-- Moves the caller's "currently viewing" pointer to a workspace
-- they already belong to. Every domain-table RLS policy keys off
-- profiles.account_id, so this is what makes the switcher work.
-- ============================================================
CREATE OR REPLACE FUNCTION public.switch_current_account(
  p_account_id UUID
) RETURNS account_role_enum
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role account_role_enum;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  SELECT role INTO v_role
  FROM account_memberships
  WHERE account_id = p_account_id AND user_id = auth.uid();

  IF v_role IS NULL THEN
    RAISE EXCEPTION 'You are not a member of this workspace' USING ERRCODE = '42501';
  END IF;

  UPDATE profiles
  SET account_id = p_account_id,
      account_role = v_role
  WHERE user_id = auth.uid();

  RETURN v_role;
END;
$$;

ALTER FUNCTION public.switch_current_account(UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.switch_current_account(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.switch_current_account(UUID) TO authenticated;

-- ============================================================
-- create_workspace(p_name)
--
-- Self-serve workspace creation. Caller becomes owner of a brand
-- new account and is switched into it immediately.
-- ============================================================
CREATE OR REPLACE FUNCTION public.create_workspace(
  p_name TEXT
) RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_name TEXT;
  v_new_account_id UUID;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  v_name := NULLIF(TRIM(p_name), '');
  IF v_name IS NULL THEN
    RAISE EXCEPTION 'Workspace name is required' USING ERRCODE = '22023';
  END IF;
  IF LENGTH(v_name) > 80 THEN
    RAISE EXCEPTION 'Workspace name must be 80 characters or fewer' USING ERRCODE = '22023';
  END IF;

  INSERT INTO accounts (name, owner_user_id)
  VALUES (v_name, auth.uid())
  RETURNING id INTO v_new_account_id;

  INSERT INTO account_memberships (account_id, user_id, role)
  VALUES (v_new_account_id, auth.uid(), 'owner');

  UPDATE profiles
  SET account_id = v_new_account_id,
      account_role = 'owner'
  WHERE user_id = auth.uid();

  RETURN v_new_account_id;
END;
$$;

ALTER FUNCTION public.create_workspace(TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.create_workspace(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_workspace(TEXT) TO authenticated;

-- ============================================================
-- redeem_invitation(p_token_hash) — now ADDITIVE.
--
-- Previously this destructively relocated the caller's profile
-- from their personal account to the inviter's, then deleted the
-- personal account (refusing if it held any data). With
-- memberships, joining a workspace no longer requires giving up any
-- other — it just adds a row and switches the caller's active view
-- to the newly joined workspace.
-- ============================================================
CREATE OR REPLACE FUNCTION public.redeem_invitation(
  p_token_hash TEXT
) RETURNS UUID  -- the joined account_id
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_id UUID := auth.uid();
  v_inv account_invitations%ROWTYPE;
  v_already_member BOOLEAN;
BEGIN
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_inv
  FROM account_invitations
  WHERE token_hash = p_token_hash
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invitation not found' USING ERRCODE = '22023';
  END IF;
  IF v_inv.accepted_at IS NOT NULL THEN
    RAISE EXCEPTION 'Invitation has already been redeemed'
      USING ERRCODE = '22023';
  END IF;
  IF v_inv.expires_at <= NOW() THEN
    RAISE EXCEPTION 'Invitation has expired' USING ERRCODE = '22023';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM account_memberships
    WHERE account_id = v_inv.account_id AND user_id = v_caller_id
  ) INTO v_already_member;

  IF v_already_member THEN
    RAISE EXCEPTION 'You are already a member of this account'
      USING ERRCODE = '23505';
  END IF;

  INSERT INTO account_memberships (account_id, user_id, role)
  VALUES (v_inv.account_id, v_caller_id, v_inv.role);

  UPDATE account_invitations
  SET accepted_at = NOW(),
      accepted_by_user_id = v_caller_id
  WHERE id = v_inv.id;

  -- Land the caller in the workspace they just joined, same as
  -- before (the /join page does a full reload to /dashboard right
  -- after this call and expects the new workspace to be active).
  UPDATE profiles
  SET account_id = v_inv.account_id,
      account_role = v_inv.role
  WHERE user_id = v_caller_id;

  RETURN v_inv.account_id;
END;
$$;

ALTER FUNCTION public.redeem_invitation(TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.redeem_invitation(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.redeem_invitation(TEXT) TO authenticated;

-- ============================================================
-- remove_account_member(p_user_id)
--
-- Now deletes the membership row instead of relocating the user to
-- a fresh personal account unconditionally. If the removed user's
-- *currently active* workspace was the one they got removed from,
-- they're relocated to another workspace they still belong to (most
-- recently joined), or — only if that was their last membership —
-- a fresh personal account, exactly like before.
-- ============================================================
CREATE OR REPLACE FUNCTION public.remove_account_member(
  p_user_id UUID
) RETURNS UUID  -- the account_id the removed user now lands on
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_account_id UUID;
  v_caller_role account_role_enum;
  v_target_role account_role_enum;
  v_target_name TEXT;
  v_target_email TEXT;
  v_target_current_account UUID;
  v_fallback_account_id UUID;
  v_fallback_role account_role_enum;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  SELECT account_id, account_role
  INTO v_caller_account_id, v_caller_role
  FROM profiles
  WHERE user_id = auth.uid();

  IF v_caller_account_id IS NULL THEN
    RAISE EXCEPTION 'Caller has no account' USING ERRCODE = '42501';
  END IF;

  IF v_caller_role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'This action requires the admin role or higher'
      USING ERRCODE = '42501';
  END IF;

  IF p_user_id = auth.uid() THEN
    RAISE EXCEPTION 'Cannot remove yourself; transfer ownership or leave the account instead'
      USING ERRCODE = '22023';
  END IF;

  SELECT role INTO v_target_role
  FROM account_memberships
  WHERE account_id = v_caller_account_id AND user_id = p_user_id;

  IF v_target_role IS NULL THEN
    RAISE EXCEPTION 'Target user is not a member of your account'
      USING ERRCODE = '22023';
  END IF;

  IF v_target_role = 'owner' THEN
    RAISE EXCEPTION 'Cannot remove the account owner; transfer ownership first'
      USING ERRCODE = '22023';
  END IF;

  DELETE FROM account_memberships
  WHERE account_id = v_caller_account_id AND user_id = p_user_id;

  SELECT account_id, full_name, email
  INTO v_target_current_account, v_target_name, v_target_email
  FROM profiles
  WHERE user_id = p_user_id;

  IF v_target_current_account IS DISTINCT FROM v_caller_account_id THEN
    -- The removed user wasn't actively viewing this workspace —
    -- their pointer stays put, nothing else to do.
    RETURN v_target_current_account;
  END IF;

  SELECT account_id, role INTO v_fallback_account_id, v_fallback_role
  FROM account_memberships
  WHERE user_id = p_user_id
  ORDER BY created_at DESC
  LIMIT 1;

  IF v_fallback_account_id IS NULL THEN
    -- Last membership just got removed — mirror the old signup-time
    -- behaviour and give them a fresh personal account so they're
    -- never left pointing at a workspace they can no longer read.
    INSERT INTO accounts (name, owner_user_id)
    VALUES (
      COALESCE(NULLIF(v_target_name, ''), v_target_email, 'My account'),
      p_user_id
    )
    RETURNING id INTO v_fallback_account_id;

    INSERT INTO account_memberships (account_id, user_id, role)
    VALUES (v_fallback_account_id, p_user_id, 'owner');

    v_fallback_role := 'owner';
  END IF;

  UPDATE profiles
  SET account_id = v_fallback_account_id,
      account_role = v_fallback_role
  WHERE user_id = p_user_id;

  RETURN v_fallback_account_id;
END;
$$;

ALTER FUNCTION public.remove_account_member(UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.remove_account_member(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.remove_account_member(UUID) TO authenticated;

-- ============================================================
-- set_member_role(p_user_id, p_new_role)
--
-- Writes account_memberships.role (source of truth) and mirrors it
-- onto profiles.account_role only if the target is currently
-- viewing this workspace (keeps the RLS-facing cache correct).
-- ============================================================
CREATE OR REPLACE FUNCTION public.set_member_role(
  p_user_id UUID,
  p_new_role account_role_enum
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_account_id UUID;
  v_caller_role account_role_enum;
  v_target_role account_role_enum;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  SELECT account_id, account_role
  INTO v_caller_account_id, v_caller_role
  FROM profiles
  WHERE user_id = auth.uid();

  IF v_caller_account_id IS NULL THEN
    RAISE EXCEPTION 'Caller has no account' USING ERRCODE = '42501';
  END IF;

  IF v_caller_role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'This action requires the admin role or higher'
      USING ERRCODE = '42501';
  END IF;

  IF p_user_id = auth.uid() THEN
    RAISE EXCEPTION 'Cannot change your own role'
      USING ERRCODE = '22023';
  END IF;

  SELECT role INTO v_target_role
  FROM account_memberships
  WHERE account_id = v_caller_account_id AND user_id = p_user_id;

  IF v_target_role IS NULL THEN
    RAISE EXCEPTION 'Target user is not a member of your account' USING ERRCODE = '22023';
  END IF;

  IF v_target_role = 'owner' THEN
    RAISE EXCEPTION 'Use transfer_account_ownership to demote an owner'
      USING ERRCODE = '22023';
  END IF;
  IF p_new_role = 'owner' THEN
    RAISE EXCEPTION 'Use transfer_account_ownership to promote to owner'
      USING ERRCODE = '22023';
  END IF;

  UPDATE account_memberships
  SET role = p_new_role
  WHERE account_id = v_caller_account_id AND user_id = p_user_id;

  UPDATE profiles
  SET account_role = p_new_role
  WHERE user_id = p_user_id AND account_id = v_caller_account_id;
END;
$$;

ALTER FUNCTION public.set_member_role(UUID, account_role_enum) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.set_member_role(UUID, account_role_enum) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_member_role(UUID, account_role_enum) TO authenticated;

-- ============================================================
-- transfer_account_ownership(p_new_owner_user_id)
--
-- Same contract as before, now writing through account_memberships
-- (source of truth) and mirroring onto profiles.account_role for
-- whichever party has this workspace as their active view.
-- ============================================================
CREATE OR REPLACE FUNCTION public.transfer_account_ownership(
  p_new_owner_user_id UUID
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_account_id UUID;
  v_caller_role account_role_enum;
  v_target_role account_role_enum;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  SELECT account_id, account_role
  INTO v_caller_account_id, v_caller_role
  FROM profiles
  WHERE user_id = auth.uid();

  IF v_caller_account_id IS NULL THEN
    RAISE EXCEPTION 'Caller has no account' USING ERRCODE = '42501';
  END IF;

  IF v_caller_role <> 'owner' THEN
    RAISE EXCEPTION 'Only the account owner can transfer ownership'
      USING ERRCODE = '42501';
  END IF;

  IF p_new_owner_user_id = auth.uid() THEN
    RAISE EXCEPTION 'You are already the owner'
      USING ERRCODE = '22023';
  END IF;

  SELECT role INTO v_target_role
  FROM account_memberships
  WHERE account_id = v_caller_account_id AND user_id = p_new_owner_user_id;

  IF v_target_role IS NULL THEN
    RAISE EXCEPTION 'Target user is not a member of your account'
      USING ERRCODE = '42501';
  END IF;

  UPDATE account_memberships SET role = 'admin'
  WHERE account_id = v_caller_account_id AND user_id = auth.uid();
  UPDATE account_memberships SET role = 'owner'
  WHERE account_id = v_caller_account_id AND user_id = p_new_owner_user_id;

  UPDATE profiles SET account_role = 'admin'
  WHERE user_id = auth.uid() AND account_id = v_caller_account_id;
  UPDATE profiles SET account_role = 'owner'
  WHERE user_id = p_new_owner_user_id AND account_id = v_caller_account_id;

  UPDATE accounts SET owner_user_id = p_new_owner_user_id
  WHERE id = v_caller_account_id;
END;
$$;

ALTER FUNCTION public.transfer_account_ownership(UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.transfer_account_ownership(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.transfer_account_ownership(UUID) TO authenticated;

-- ============================================================
-- SIGNUP TRIGGER — also record the membership row.
-- ============================================================
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_full_name TEXT;
  v_account_id UUID;
BEGIN
  v_full_name := COALESCE(NEW.raw_user_meta_data->>'full_name', '');

  INSERT INTO public.accounts (name, owner_user_id)
  VALUES (COALESCE(NULLIF(v_full_name, ''), NEW.email, 'My account'), NEW.id)
  RETURNING id INTO v_account_id;

  INSERT INTO public.profiles (user_id, full_name, email, account_id, account_role)
  VALUES (NEW.id, v_full_name, NEW.email, v_account_id, 'owner');

  INSERT INTO public.account_memberships (account_id, user_id, role)
  VALUES (v_account_id, NEW.id, 'owner');

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'Failed to bootstrap account/profile for user %: %', NEW.id, SQLERRM;
  RETURN NEW;
END;
$$;

ALTER FUNCTION public.handle_new_user() OWNER TO postgres;
