-- ============================================================
-- 060_ai_self_learning.sql — learn from manually-handled chats
--
-- Every time a human agent replies to a customer, that reply may
-- contain information the AI's knowledge base doesn't have yet (a
-- process step, a policy, a common question's answer). This migration
-- adds the plumbing for a cron job (`GET /api/ai/learning/cron`) to
-- scan new agent replies, ask the account's own AI provider whether
-- each one contains reusable knowledge not already covered, and — if
-- so — stage it for a human to approve before it becomes part of what
-- the bot actually says. Suggestions are NEVER auto-applied: a wrong
-- or one-off human answer permanently poisoning the bot's knowledge is
-- a much worse failure mode than a slower rollout.
--
-- `messages.ai_learning_processed_at` is the per-message watermark —
-- every agent text message is looked at exactly once, whichever
-- outcome ("nothing new here" or "staged a suggestion") is stored, no
-- separate per-conversation bookkeeping needed.
-- ============================================================

ALTER TABLE ai_configs
  ADD COLUMN IF NOT EXISTS learning_enabled boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN ai_configs.learning_enabled IS
  'Opt-in: scan human agent replies for knowledge the bot does not have yet and stage it for review (ai_knowledge_suggestions). Off by default.';

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS ai_learning_processed_at timestamptz;

COMMENT ON COLUMN messages.ai_learning_processed_at IS
  'Set once the self-learning scan has looked at this (agent) message, whether or not it produced a suggestion. NULL = not yet scanned.';

CREATE INDEX IF NOT EXISTS idx_messages_learning_unprocessed
  ON messages(created_at)
  WHERE sender_type = 'agent' AND ai_learning_processed_at IS NULL;

CREATE TABLE IF NOT EXISTS ai_knowledge_suggestions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  conversation_id UUID REFERENCES conversations(id) ON DELETE SET NULL,
  source_message_id UUID REFERENCES messages(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  -- Set once approved and copied into ai_knowledge_documents, so the
  -- review UI can link straight to the live document.
  knowledge_document_id UUID REFERENCES ai_knowledge_documents(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  reviewed_at TIMESTAMPTZ,
  reviewed_by UUID REFERENCES auth.users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_ai_knowledge_suggestions_account_status
  ON ai_knowledge_suggestions(account_id, status);

ALTER TABLE ai_knowledge_suggestions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ai_knowledge_suggestions_select ON ai_knowledge_suggestions;
CREATE POLICY ai_knowledge_suggestions_select ON ai_knowledge_suggestions FOR SELECT
  USING (is_account_member(account_id));

-- Only the cron job (service_role, bypasses RLS) inserts suggestions —
-- no authenticated-role INSERT policy needed or granted.

DROP POLICY IF EXISTS ai_knowledge_suggestions_update ON ai_knowledge_suggestions;
CREATE POLICY ai_knowledge_suggestions_update ON ai_knowledge_suggestions FOR UPDATE
  USING (is_account_member(account_id, 'admin'));

-- Cross-tenant candidate scan for the cron endpoint — new agent text
-- messages, not yet scanned, only for accounts whose default agent has
-- opted in. Mirrors get_stale_customer_conversations (migration 059):
-- casts the eligibility net here, the app layer does the actual LLM
-- extraction call per row.
CREATE OR REPLACE FUNCTION public.get_unprocessed_agent_messages(p_limit integer DEFAULT 50)
RETURNS TABLE (
  message_id UUID,
  conversation_id UUID,
  account_id UUID,
  content_text TEXT,
  created_at TIMESTAMPTZ
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT m.id, m.conversation_id, m.account_id, m.content_text, m.created_at
  FROM messages m
  JOIN accounts a ON a.id = m.account_id
  JOIN ai_configs ac ON ac.id = a.default_ai_config_id
  WHERE m.sender_type = 'agent'
    AND m.content_type = 'text'
    AND m.content_text IS NOT NULL
    AND m.ai_learning_processed_at IS NULL
    AND ac.learning_enabled = true
    AND ac.is_active = true
  ORDER BY m.created_at ASC
  LIMIT p_limit
$$;

REVOKE ALL ON FUNCTION public.get_unprocessed_agent_messages(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_unprocessed_agent_messages(integer) TO service_role;
