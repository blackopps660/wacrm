-- ============================================================
-- 061_ai_knowledge_corrections.sql — self-correcting knowledge base
--
-- Migration 060's self-learning only ever proposed brand-new knowledge
-- entries. In practice a human agent's reply often doesn't teach
-- something new — it corrects something the knowledge base already
-- has wrong or outdated (a changed price, an updated policy). This
-- migration lets a suggestion target an EXISTING document for
-- replacement instead of always creating a new one, and adds the
-- document-aware retrieval RPCs the learning cron needs to show the
-- extraction LLM which existing entries it's allowed to reference.
--
-- Still fully review-gated: a "correction" suggestion is exactly as
-- inert as a "new" one until an admin approves it from Settings.
-- ============================================================

ALTER TABLE ai_knowledge_suggestions
  ADD COLUMN IF NOT EXISTS target_document_id UUID REFERENCES ai_knowledge_documents(id) ON DELETE SET NULL;

COMMENT ON COLUMN ai_knowledge_suggestions.target_document_id IS
  'When set, this suggestion proposes REPLACING this existing document''s content (a correction) rather than creating a new one. NULL = new document.';

-- Document-aware variants of migration 030's match_ai_knowledge_semantic
-- / match_ai_knowledge_fts — the learning cron needs the owning
-- document's id + title (to offer as a correction target and show the
-- admin what's being replaced), not just a bare chunk. service_role
-- only: this is exclusively called from the learning cron's admin
-- client, never from a user-facing route.
CREATE OR REPLACE FUNCTION public.match_ai_knowledge_semantic_docs(
  p_account_id      uuid,
  p_query_embedding text,
  p_match_count     integer
)
RETURNS TABLE (document_id uuid, title text, content text, distance real)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT d.id, d.title, c.content,
         (c.embedding <=> p_query_embedding::vector(1536)) AS distance
  FROM ai_knowledge_chunks c
  JOIN ai_knowledge_documents d ON d.id = c.document_id
  WHERE c.account_id = p_account_id
    AND c.embedding IS NOT NULL
  ORDER BY c.embedding <=> p_query_embedding::vector(1536)
  LIMIT GREATEST(p_match_count, 0);
$$;

CREATE OR REPLACE FUNCTION public.match_ai_knowledge_fts_docs(
  p_account_id  uuid,
  p_query       text,
  p_match_count integer
)
RETURNS TABLE (document_id uuid, title text, content text, rank real)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT d.id, d.title, c.content,
         ts_rank(c.fts, plainto_tsquery('simple', p_query)) AS rank
  FROM ai_knowledge_chunks c
  JOIN ai_knowledge_documents d ON d.id = c.document_id
  WHERE c.account_id = p_account_id
    AND c.fts @@ plainto_tsquery('simple', p_query)
  ORDER BY rank DESC
  LIMIT GREATEST(p_match_count, 0);
$$;

REVOKE ALL ON FUNCTION public.match_ai_knowledge_semantic_docs(uuid, text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.match_ai_knowledge_semantic_docs(uuid, text, integer) TO service_role;
REVOKE ALL ON FUNCTION public.match_ai_knowledge_fts_docs(uuid, text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.match_ai_knowledge_fts_docs(uuid, text, integer) TO service_role;
