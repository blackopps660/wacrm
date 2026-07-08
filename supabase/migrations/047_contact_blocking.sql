-- Adds contact blocking, surfaced from the mobile chat header's
-- 3-dot menu (web can grow the same UI later). Blocking is enforced
-- at the send layer (src/app/api/whatsapp/send/route.ts) — a blocked
-- contact still delivers inbound messages (WhatsApp doesn't let a
-- business silently drop a user's messages), but the account can no
-- longer send to them until unblocked.

ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS blocked_at timestamptz;

COMMENT ON COLUMN contacts.blocked_at IS
  'When set, this account has blocked the contact — outbound sends to them are rejected until unblocked (NULL again).';
