-- ============================================================
-- 059_ai_rescue_reply.sql — 24h-window rescue reply
--
-- Problem: a conversation sits with an unanswered customer message
-- (no flow, no auto-reply — the AI only auto-replies on conversations
-- it explicitly owns, migration 037) and the human agent hasn't picked
-- it up. Once 24h pass since the customer's last message, WhatsApp's
-- Cloud API blocks any further free-form reply — only an approved
-- template can re-open it (see message-thread.tsx's 24h banner). That
-- forces a template send, which is worse UX and costs money on some
-- accounts.
--
-- This migration adds the config an admin opts into (off by default —
-- existing accounts get zero behaviour change) and the one query the
-- cron endpoint (`GET /api/ai/rescue/cron`, added alongside this)
-- needs: every conversation across every tenant whose LAST message is
-- still an unanswered customer message. "Last message is from the
-- customer" is deliberately the whole eligibility test for "has this
-- gone unanswered" — if an agent (or the bot) had replied since, the
-- last message wouldn't be the customer's anymore. No separate
-- "time since agent's last activity" bookkeeping needed.
--
-- The actual send is a single, human-sounding nudge (`rescue-reply.ts`)
-- — NOT a takeover. `owner_kind` is deliberately left untouched, so the
-- conversation stays visibly the human's; the rescue message is capped
-- (`rescue_max_per_conversation`, default 2) and stops firing the
-- moment the customer replies (their reply becomes the new last
-- message, sender_type='customer' again but freshly timed — it won't
-- re-match the age window for another `rescue_after_hours`).
-- ============================================================

ALTER TABLE ai_configs
  ADD COLUMN IF NOT EXISTS rescue_reply_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS rescue_after_hours integer NOT NULL DEFAULT 20,
  ADD COLUMN IF NOT EXISTS rescue_max_per_conversation integer NOT NULL DEFAULT 2;

ALTER TABLE ai_configs
  ADD CONSTRAINT ai_configs_rescue_after_hours_check
    CHECK (rescue_after_hours > 0 AND rescue_after_hours < 24);
ALTER TABLE ai_configs
  ADD CONSTRAINT ai_configs_rescue_max_per_conversation_check
    CHECK (rescue_max_per_conversation >= 1);

COMMENT ON COLUMN ai_configs.rescue_reply_enabled IS
  'Opt-in: send one contextual AI nudge on a stale, agent-unanswered conversation before the 24h WhatsApp session window closes. Independent of auto_reply_enabled — this fires on HUMAN-owned conversations, not AI-owned ones.';
COMMENT ON COLUMN ai_configs.rescue_after_hours IS
  'How many hours an inbound customer message can sit unanswered before the rescue reply fires. Must stay under 24 so the free-form send still succeeds.';
COMMENT ON COLUMN ai_configs.rescue_max_per_conversation IS
  'Cap on rescue nudges per conversation, reset to 0 whenever a human agent actually replies (see trigger below). Keeps the bot from nagging a customer who has gone quiet on their own.';

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS ai_rescue_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS ai_rescue_last_sent_at timestamptz;

COMMENT ON COLUMN conversations.ai_rescue_count IS
  'Rescue nudges sent since the last human agent reply. Reset to 0 by trg_reset_ai_rescue_on_agent_reply whenever sender_type=agent lands.';

-- Reset the counter the moment a human actually engages — a fresh
-- human reply means the next stall (if any) deserves its own fresh
-- rescue budget, not one shared across the conversation's whole
-- lifetime.
CREATE OR REPLACE FUNCTION public.reset_ai_rescue_on_agent_reply()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.sender_type = 'agent' THEN
    UPDATE conversations
    SET ai_rescue_count = 0
    WHERE id = NEW.conversation_id AND ai_rescue_count <> 0;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_reset_ai_rescue_on_agent_reply ON messages;
CREATE TRIGGER trg_reset_ai_rescue_on_agent_reply
  AFTER INSERT ON messages
  FOR EACH ROW
  EXECUTE FUNCTION public.reset_ai_rescue_on_agent_reply();

-- Cross-tenant candidate scan for the cron endpoint. Deliberately casts
-- a wide net (only a cheap age bound, not each account's own configured
-- rescue_after_hours/rescue_max_per_conversation) — the app layer loads
-- each account's actual AI config and re-checks the real thresholds
-- before sending, same "one source of truth" reasoning `loadDefaultAiConfig`
-- already centralizes for auto-reply.
CREATE OR REPLACE FUNCTION public.get_stale_customer_conversations()
RETURNS TABLE (
  conversation_id UUID,
  account_id UUID,
  contact_id UUID,
  ai_rescue_count INTEGER,
  hours_since_last_customer_message NUMERIC
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    c.id,
    c.account_id,
    c.contact_id,
    c.ai_rescue_count,
    EXTRACT(EPOCH FROM (now() - lm.created_at)) / 3600.0
  FROM conversations c
  JOIN LATERAL (
    SELECT sender_type, created_at
    FROM messages m
    WHERE m.conversation_id = c.id
    ORDER BY m.created_at DESC
    LIMIT 1
  ) lm ON true
  WHERE c.owner_kind <> 'ai'
    AND c.status <> 'closed'
    AND lm.sender_type = 'customer'
    AND lm.created_at <= now() - interval '1 hour'
    AND lm.created_at >= now() - interval '23 hours 30 minutes'
$$;

REVOKE ALL ON FUNCTION public.get_stale_customer_conversations() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_stale_customer_conversations() TO service_role;
