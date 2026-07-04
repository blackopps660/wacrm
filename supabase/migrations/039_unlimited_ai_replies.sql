-- ============================================================
-- 039_unlimited_ai_replies.sql — remove the hard cap on AI auto-replies
--
-- ai_configs.auto_reply_max_per_conversation (029) was NOT NULL with a
-- CHECK (BETWEEN 1 AND 20) — every workspace was forced to cap the bot
-- at 20 replies per thread. Some workspaces want the bot to keep going
-- indefinitely (e.g. long support threads), so NULL now means
-- "no cap" instead of being disallowed. A numeric value still means
-- "stop after this many replies", with no upper bound anymore either.
--
-- claim_ai_reply_slot (029) is the sole enforcement point (the cap
-- check + increment happen atomically there) — updated so a NULL
-- max_replies always claims a slot.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE public.ai_configs
  ALTER COLUMN auto_reply_max_per_conversation DROP NOT NULL,
  ALTER COLUMN auto_reply_max_per_conversation DROP DEFAULT;

ALTER TABLE public.ai_configs
  DROP CONSTRAINT IF EXISTS ai_configs_auto_reply_max_per_conversation_check;

ALTER TABLE public.ai_configs
  ADD CONSTRAINT ai_configs_auto_reply_max_per_conversation_check
  CHECK (auto_reply_max_per_conversation IS NULL OR auto_reply_max_per_conversation >= 1);

CREATE OR REPLACE FUNCTION public.claim_ai_reply_slot(
  conversation_id uuid,
  max_replies integer
)
RETURNS boolean AS $$
  WITH claimed AS (
    UPDATE conversations
    SET ai_reply_count = ai_reply_count + 1
    WHERE id = conversation_id
      AND (max_replies IS NULL OR ai_reply_count < max_replies)
    RETURNING 1
  )
  SELECT EXISTS (SELECT 1 FROM claimed);
$$ LANGUAGE sql SECURITY DEFINER SET search_path = public;
