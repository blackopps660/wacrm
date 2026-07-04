-- ============================================================
-- 040_ai_agent_actions.sql — AI agent tool-calling actions
--
-- Lets the account's AI agent do things beyond replying with text:
-- update a contact's tags, fill in custom fields, or trigger one of
-- the account's existing Automations — each independently toggle-able,
-- with an admin-authored free-text guideline for when/how to use it
-- (mirrors respond.io's per-action config).
--
-- A single JSONB column (rather than a column per action) since this
-- is expected to grow more action types over time, and every action
-- shares the same {enabled, guidelines} shape — new ones are an app-
-- code change, not another migration.
--
-- Shape: { updateTags: {enabled, guidelines}, updateContactFields: {...},
--          triggerAutomations: {...} }. All keys optional/absent means
-- "disabled" — off by default for every account, same as every other
-- opt-in setting in this feature area.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE public.ai_configs
  ADD COLUMN IF NOT EXISTS actions JSONB NOT NULL DEFAULT '{}'::jsonb;
