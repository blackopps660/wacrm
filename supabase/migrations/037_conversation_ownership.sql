-- ============================================================
-- 037_conversation_ownership.sql — explicit AI-vs-human conversation
-- ownership, per-workspace default-assignment policy, auto-close
--
-- Today "AI is handling this conversation" is implicit — inferred from
-- `assigned_agent_id IS NULL AND ai_configs.auto_reply_enabled`. That
-- works for gating auto-reply, but there's no first-class, visible
-- state an agent can see, pick from a dropdown, or take over from.
-- This migration adds the explicit three-way state and the workspace
-- settings needed to route conversations into it automatically.
--
-- 1. conversations.owner_kind — 'unassigned' | 'human' | 'ai'.
--    Source of truth for who owns a conversation right now. Existing
--    `assigned_agent_id` is unchanged (still the specific human when
--    owner_kind = 'human'); `ai_autoreply_disabled` / `ai_reply_count`
--    are unchanged too — they still apply once owner_kind = 'ai'.
--
-- 2. ai_configs.default_new_conversation_owner — 'ai' | 'human'.
--    The admin's choice for what a BRAND NEW conversation (new
--    contact, or an inbound message reopening a closed one) gets.
--    Defaults to 'human' — every workspace starts with this OFF
--    (routing to a human queue, today's behavior) until an admin
--    opts in, same precedent as `auto_reply_enabled DEFAULT false`
--    on this same table.
--
-- 3. accounts.auto_close_after_days — nullable integer. NULL (the
--    default) means never auto-close. An admin can set e.g. 3 to
--    have inactive open/pending conversations close automatically
--    (a separate cron job, not part of this migration, reads it).
--
-- Backfill preserves EXACTLY today's behavior for existing rows: a
-- conversation with a human already assigned becomes owner_kind =
-- 'human'; an unassigned conversation in an account that currently
-- has auto_reply_enabled becomes owner_kind = 'ai' (matching what
-- would actually happen today on the next inbound message); every
-- other unassigned conversation stays 'unassigned'. No existing
-- conversation's actual behavior changes the moment this ships.
--
-- Idempotent — safe to re-run.
-- ============================================================

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS owner_kind TEXT NOT NULL DEFAULT 'unassigned'
    CHECK (owner_kind IN ('unassigned', 'human', 'ai'));

CREATE INDEX IF NOT EXISTS idx_conversations_owner_kind
  ON conversations(account_id, owner_kind);

ALTER TABLE ai_configs
  ADD COLUMN IF NOT EXISTS default_new_conversation_owner TEXT NOT NULL DEFAULT 'human'
    CHECK (default_new_conversation_owner IN ('ai', 'human'));

ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS auto_close_after_days INTEGER
    CHECK (auto_close_after_days IS NULL OR auto_close_after_days > 0);

-- Backfill — see header comment for the exact rule.
UPDATE conversations c
SET owner_kind = 'human'
WHERE c.assigned_agent_id IS NOT NULL
  AND c.owner_kind = 'unassigned';

UPDATE conversations c
SET owner_kind = 'ai'
FROM ai_configs ac
WHERE c.account_id = ac.account_id
  AND c.assigned_agent_id IS NULL
  AND c.owner_kind = 'unassigned'
  AND ac.auto_reply_enabled = true;
