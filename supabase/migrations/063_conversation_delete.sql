-- ============================================================
-- 063_conversation_delete.sql — "Delete conversation" from the inbox
-- (list row and thread header, both platforms), on top of the
-- existing pin/mute/archive columns (migration 048) and the message-
-- level "Delete for Me" pattern (migration 049).
--
-- Same WhatsApp-app semantics as message delete: this is a local hide
-- from the account's own inbox, never a real "delete for everyone" —
-- the Cloud API gives businesses no way to remove anything from the
-- customer's own WhatsApp, so nothing on their side is touched.
--
-- Unlike archived_at (which is meant to declutter a settled thread and
-- reversible any time), a deleted conversation is meant to be gone —
-- but it still MUST come back the moment the same contact messages
-- again, or the business would silently stop seeing a live customer.
-- Migration 048's unarchive trigger already fires on every message
-- insert for exactly this reason; extended here to also clear
-- deleted_at instead of adding a second trigger on the same event.
-- ============================================================

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz;

COMMENT ON COLUMN conversations.deleted_at IS
  'When set, this conversation (and its messages) is hidden from the inbox entirely, like a WhatsApp "delete chat" (not "archive"). A new inbound/outbound message clears this automatically, same as unarchiving — see unarchive_conversation_on_new_message().';

CREATE INDEX IF NOT EXISTS idx_conversations_deleted_at ON conversations(deleted_at) WHERE deleted_at IS NOT NULL;

CREATE OR REPLACE FUNCTION unarchive_conversation_on_new_message()
RETURNS trigger AS $$
BEGIN
  UPDATE conversations
  SET archived_at = NULL, deleted_at = NULL
  WHERE id = NEW.conversation_id AND (archived_at IS NOT NULL OR deleted_at IS NOT NULL);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- get_inbox_counts (migration 054/055) — every existing "archived_at
-- IS NULL" scope also needs to exclude deleted rows, the same way a
-- closed+archived row is excluded from the Closed count already.
-- 'archived' itself also drops deleted rows: once deleted, a
-- conversation no longer belongs in the Archived tab either.
CREATE OR REPLACE FUNCTION get_inbox_counts(p_account_id UUID)
RETURNS JSON
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT CASE
    WHEN NOT is_account_member(p_account_id) THEN NULL
    ELSE json_build_object(
      'all', (
        SELECT count(*) FROM conversations
        WHERE account_id = p_account_id AND archived_at IS NULL AND deleted_at IS NULL
      ),
      'active', (
        SELECT count(*) FROM conversations
        WHERE account_id = p_account_id AND archived_at IS NULL AND deleted_at IS NULL AND status != 'closed'
      ),
      'unread', (
        SELECT count(*) FROM conversations
        WHERE account_id = p_account_id AND archived_at IS NULL AND deleted_at IS NULL AND unread_count > 0
      ),
      'open', (
        SELECT count(*) FROM conversations
        WHERE account_id = p_account_id AND archived_at IS NULL AND deleted_at IS NULL AND status = 'open'
      ),
      'pending', (
        SELECT count(*) FROM conversations
        WHERE account_id = p_account_id AND archived_at IS NULL AND deleted_at IS NULL AND status = 'pending'
      ),
      'closed', (
        SELECT count(*) FROM conversations
        WHERE account_id = p_account_id AND archived_at IS NULL AND deleted_at IS NULL AND status = 'closed'
      ),
      'archived', (
        SELECT count(*) FROM conversations
        WHERE account_id = p_account_id AND archived_at IS NOT NULL AND deleted_at IS NULL
      ),
      'stages', (
        SELECT COALESCE(json_object_agg(stage_id, cnt), '{}'::json)
        FROM (
          SELECT c.lifecycle_stage_id AS stage_id, count(*) AS cnt
          FROM conversations conv
          JOIN contacts c ON c.id = conv.contact_id
          WHERE conv.account_id = p_account_id
            AND conv.archived_at IS NULL
            AND conv.deleted_at IS NULL
            AND c.lifecycle_stage_id IS NOT NULL
          GROUP BY c.lifecycle_stage_id
        ) s
      ),
      'tags', (
        SELECT COALESCE(json_object_agg(tag_id, cnt), '{}'::json)
        FROM (
          SELECT ct.tag_id, count(DISTINCT conv.id) AS cnt
          FROM conversations conv
          JOIN contact_tags ct ON ct.contact_id = conv.contact_id
          WHERE conv.account_id = p_account_id
            AND conv.archived_at IS NULL
            AND conv.deleted_at IS NULL
          GROUP BY ct.tag_id
        ) t
      )
    )
  END;
$$;
