-- ============================================================
-- 038_auto_close_conversations.sql — auto-close inactive conversations
--
-- Per-workspace admin-configurable setting (accounts.auto_close_after_days,
-- added in 037) lets an admin say "close a conversation after N days of
-- no new messages". This migration adds the RPC the cron endpoint
-- (`GET /api/conversations/cron`) calls to actually do that sweep in one
-- statement across every account, rather than looping per-account in
-- application code.
--
-- SECURITY DEFINER + service_role-only grant: this needs to read/update
-- across every tenant's conversations in one query, which no per-tenant
-- RLS policy is meant to allow. Only the cron endpoint (which runs as
-- service_role) can call it — never exposed to `authenticated`.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

CREATE OR REPLACE FUNCTION public.close_inactive_conversations()
RETURNS TABLE(id UUID, account_id UUID)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE conversations c
  SET status = 'closed'
  FROM accounts a
  WHERE c.account_id = a.id
    AND a.auto_close_after_days IS NOT NULL
    AND c.status IN ('open', 'pending')
    AND c.last_message_at < now() - make_interval(days => a.auto_close_after_days)
  RETURNING c.id, c.account_id;
$$;

REVOKE ALL ON FUNCTION public.close_inactive_conversations() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.close_inactive_conversations() TO service_role;
