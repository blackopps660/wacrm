-- ============================================================
-- 033_messages_idempotency.sql — dedup key for inbound webhook messages
--
-- Meta's WhatsApp webhook delivery is documented at-least-once — it can
-- redeliver the same message (network retry, infra hiccup on Meta's
-- side), independent of how fast we ACK. The webhook handler
-- (processMessage in src/app/api/whatsapp/webhook/route.ts) had no
-- idempotency check before inserting, so a redelivery would insert a
-- second `messages` row for the same WhatsApp message AND re-run
-- flows/automations/AI-auto-reply a second time for it.
--
-- `message_id` (Meta's wamid) is NOT globally unique — migration 009's
-- comment notes Meta ids repeat across different numbers — so the dedup
-- key is scoped to (conversation_id, message_id) rather than message_id
-- alone. NULL message_id (nothing currently produces one, but defensive)
-- is excluded via the partial index so it can never collide.
--
-- This is a safety net alongside an application-level existence check
-- added in the same change (webhook/route.ts) — the check avoids the
-- wasted work (Meta media-verification call, insert attempt) in the
-- common case; this index is what actually guarantees no duplicate row
-- can land even under a race (two redeliveries processed concurrently).
--
-- Idempotent — safe to run multiple times.
-- ============================================================

CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_conversation_message_id_unique
  ON messages(conversation_id, message_id)
  WHERE message_id IS NOT NULL;
