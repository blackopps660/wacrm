-- Pinned messages (WhatsApp-style) for the chat thread.
--
-- WhatsApp lets you pin a message to the top of a conversation for a
-- fixed window — 24 hours, 7 days, or 30 days — after which it
-- silently unpins itself. We mirror that with two columns rather than a
-- separate table: pins are low-cardinality (a handful per conversation
-- at most) and always read alongside the message row, so a join buys
-- nothing.
--
-- A message is "actively pinned" when `pinned_until IS NOT NULL AND
-- pinned_until > now()`. Expiry is therefore a pure read-time
-- comparison — no cron/sweeper needed. `pinned_at` is kept for display
-- ("Pinned 2h ago") and to order multiple pins newest-first.
--
-- This is per-account and purely local to this app's inbox view: like
-- deleted_at (migration 049), the WhatsApp Cloud API exposes no pin
-- primitive, so nothing is sent to the customer's device.

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS pinned_at timestamptz,
  ADD COLUMN IF NOT EXISTS pinned_until timestamptz;

COMMENT ON COLUMN messages.pinned_at IS
  'When this message was pinned to the top of its conversation. NULL = never pinned / unpinned.';
COMMENT ON COLUMN messages.pinned_until IS
  'When the pin auto-expires. A message counts as pinned only while pinned_until > now(). NULL = not pinned. Purely local to this app''s inbox — WhatsApp gives businesses no pin API.';

-- Partial index: the only query is "active pins in this conversation",
-- so index the rows that can ever be pinned and let the read-time
-- now() comparison filter the expired ones.
CREATE INDEX IF NOT EXISTS idx_messages_pinned
  ON messages(conversation_id, pinned_until DESC)
  WHERE pinned_until IS NOT NULL;
