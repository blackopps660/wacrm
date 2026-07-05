-- ============================================================
-- PUSH_DEVICE_TOKENS — mobile app (Phase 6)
--
-- Registers a device's Expo push token so the inbound-webhook
-- handler can fan out a push notification when a new WhatsApp
-- message arrives while the app is backgrounded/killed (realtime
-- covers the "app open" case already). One row per (user, device);
-- the mobile app registers on login and unregisters on logout, so a
-- device changing hands (different user signs in) doesn't leave a
-- stale row pointing at the wrong owner.
-- ============================================================

CREATE TABLE IF NOT EXISTS push_device_tokens (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  expo_push_token TEXT NOT NULL,
  platform TEXT NOT NULL CHECK (platform IN ('ios', 'android')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, expo_push_token)
);

-- The webhook handler's dispatch query looks up every token for an
-- account (all members with the app installed), scoped via the
-- service-role client (bypasses RLS) — this index serves that lookup.
CREATE INDEX IF NOT EXISTS idx_push_device_tokens_account
  ON push_device_tokens(account_id);

ALTER TABLE push_device_tokens ENABLE ROW LEVEL SECURITY;

-- Users manage only their own device registrations. No account-mate
-- visibility needed — nobody reads this table except the
-- service-role webhook dispatcher, which bypasses RLS entirely.
DROP POLICY IF EXISTS push_device_tokens_select ON push_device_tokens;
DROP POLICY IF EXISTS push_device_tokens_insert ON push_device_tokens;
DROP POLICY IF EXISTS push_device_tokens_update ON push_device_tokens;
DROP POLICY IF EXISTS push_device_tokens_delete ON push_device_tokens;

CREATE POLICY push_device_tokens_select ON push_device_tokens FOR SELECT
  USING (auth.uid() = user_id);
CREATE POLICY push_device_tokens_insert ON push_device_tokens FOR INSERT
  WITH CHECK (auth.uid() = user_id);
CREATE POLICY push_device_tokens_update ON push_device_tokens FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);
CREATE POLICY push_device_tokens_delete ON push_device_tokens FOR DELETE
  USING (auth.uid() = user_id);
