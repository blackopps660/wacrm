-- ============================================================
-- 036_scale_indexes.sql — composite indexes for query patterns that
-- only emerged once messages accumulate at scale
--
-- Every index this migration touches already had a single-column
-- index that only covered part of its query pattern:
--
--   - messages(conversation_id, created_at) — thread pagination
--     (message-thread.tsx: `.eq('conversation_id', x).order(
--     'created_at').limit(50)`, both the newest-page and "load
--     older" cursor queries) and the response-time RPC's window
--     function (migration 034: `PARTITION BY conversation_id ORDER
--     BY created_at`). The old lone `idx_messages_conversation`
--     could find the right conversation's rows but Postgres still
--     had to sort them separately every time; this composite index
--     is already in the right order, so both queries become a
--     straight index scan with no extra sort step. Replaces (fully
--     subsumes) the old single-column index rather than sitting
--     alongside it — no query used `conversation_id` without also
--     ordering/filtering by `created_at`.
--
--   - messages(created_at) — the conversations-series RPC's
--     `WHERE created_at >= p_start` account-wide date-range scan
--     (migration 034). This one has no natural per-conversation or
--     per-account column to lead on (RLS scopes it via a join to
--     conversations, not a column on messages itself), so a plain
--     index on the date range is what actually prunes the scan
--     before that join happens.
--
--   - conversations(account_id, last_message_at DESC) — the inbox
--     list's `.eq('account_id', x).order('last_message_at', {
--     ascending: false}).limit(50)` (conversation-list.tsx, migration
--     031's pagination). Same reasoning as messages above: replaces
--     the old lone `idx_conversations_account`, which could find the
--     account's rows but not in sorted order.
--
-- Idempotent — safe to re-run.
-- ============================================================

DROP INDEX IF EXISTS idx_messages_conversation;
CREATE INDEX IF NOT EXISTS idx_messages_conversation_created
  ON messages(conversation_id, created_at);

CREATE INDEX IF NOT EXISTS idx_messages_created_at
  ON messages(created_at);

DROP INDEX IF EXISTS idx_conversations_account;
CREATE INDEX IF NOT EXISTS idx_conversations_account_last_message
  ON conversations(account_id, last_message_at DESC);
