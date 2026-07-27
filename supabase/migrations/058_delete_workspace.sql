-- ============================================================
-- delete_workspace(p_account_id)
--
-- Owner-only, irreversible deletion of an entire workspace and every
-- account-scoped row under it (contacts, conversations, messages,
-- whatsapp_config, templates, pipelines, deals, memberships, …) via the
-- ON DELETE CASCADE that every `account_id → accounts(id)` FK already
-- carries (migration 017).
--
-- The one thing cascade must NOT be allowed to do on its own is delete
-- members' PROFILES: `profiles.account_id` is NOT NULL and also cascades
-- on account delete, so any profile still "viewing" this workspace when
-- the account row drops would be destroyed along with it. So before the
-- delete we relocate every such profile to one of that user's OTHER
-- workspaces. Invitations are additive (each invited member keeps their
-- own personal workspace), so a fallback always exists in practice; if
-- one somehow doesn't, we abort rather than orphan anyone.
--
-- Guards:
--   * caller must be a member AND the owner of the workspace
--   * caller must have at least one OTHER workspace to land in
--     (can't delete your only workspace)
--
-- Returns the account_id the caller was switched into, so the API/UI can
-- reflect the new active workspace without a second round-trip.
-- ============================================================
CREATE OR REPLACE FUNCTION public.delete_workspace(
  p_account_id UUID
) RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_role account_role_enum;
  v_caller_fallback UUID;
  r RECORD;
  v_other_account UUID;
  v_other_role account_role_enum;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  -- Must be a member, and specifically the owner.
  SELECT role INTO v_role
  FROM account_memberships
  WHERE account_id = p_account_id AND user_id = v_uid;

  IF v_role IS NULL THEN
    RAISE EXCEPTION 'You are not a member of this workspace' USING ERRCODE = '42501';
  END IF;
  IF v_role <> 'owner' THEN
    RAISE EXCEPTION 'Only the workspace owner can delete it' USING ERRCODE = '42501';
  END IF;

  -- Caller needs somewhere to land afterwards.
  SELECT account_id INTO v_caller_fallback
  FROM account_memberships
  WHERE user_id = v_uid AND account_id <> p_account_id
  ORDER BY created_at ASC
  LIMIT 1;

  IF v_caller_fallback IS NULL THEN
    RAISE EXCEPTION 'You cannot delete your only workspace' USING ERRCODE = '22023';
  END IF;

  -- Relocate every profile currently pointing at this workspace to one
  -- of that user's other workspaces, so the cascade can't take profiles
  -- down with the account.
  FOR r IN
    SELECT user_id FROM profiles WHERE account_id = p_account_id
  LOOP
    SELECT account_id, role INTO v_other_account, v_other_role
    FROM account_memberships
    WHERE user_id = r.user_id AND account_id <> p_account_id
    ORDER BY created_at ASC
    LIMIT 1;

    IF v_other_account IS NULL THEN
      RAISE EXCEPTION
        'A member of this workspace has no other workspace to fall back to — remove them before deleting.'
        USING ERRCODE = '22023';
    END IF;

    UPDATE profiles
    SET account_id = v_other_account,
        account_role = v_other_role
    WHERE user_id = r.user_id;
  END LOOP;

  -- Safe now: cascade cleans up all account-scoped data + memberships.
  DELETE FROM accounts WHERE id = p_account_id;

  RETURN v_caller_fallback;
END;
$$;

ALTER FUNCTION public.delete_workspace(UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.delete_workspace(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.delete_workspace(UUID) TO authenticated;
