-- ============================================================
-- 034_dashboard_aggregation_rpcs.sql — server-side dashboard aggregation
--
-- src/lib/dashboard/queries.ts pulled every message row in the
-- requested date range to the browser just to bucket/pair them in JS:
--   - loadConversationsSeries: every (created_at, sender_type) row in
--     the chart's range (up to 90 days), just to count incoming vs.
--     outgoing per day.
--   - loadResponseTime: every (conversation_id, sender_type, created_at)
--     row in the last 14 days, just to walk each conversation in order
--     and pair "first unreplied customer message" with "first
--     subsequent outbound message".
-- At 300 msgs/day per workspace × 6-10 workspaces, a 30-90 day chart
-- was fetching tens of thousands of rows per widget load just to
-- throw almost all of that data away after aggregating it client-side.
-- Both RPCs below do the aggregation in Postgres and return only the
-- small, already-reduced result (~one row per day, or one row per
-- actual customer/response exchange) instead.
--
-- SECURITY INVOKER (the default — no SECURITY DEFINER here): both
-- functions run as the calling user, so the existing RLS policies on
-- `messages` (via the conversations join) apply exactly as they would
-- for a plain `.select()` — this is not a new access path, just the
-- same query re-expressed inside Postgres.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

-- ============================================================
-- dashboard_conversations_series(p_start, p_tz_offset_minutes)
--
-- Buckets messages by calendar day for the "Conversations Over Time"
-- chart. `p_tz_offset_minutes` is the caller's local UTC offset
-- (JS: `-new Date().getTimezoneOffset()`) — date-utils.ts's existing
-- client-side bucketing is explicitly local-time ("what a business
-- user intuitively expects when they say 'today'"), so day boundaries
-- here are shifted by that offset before truncating to a date rather
-- than truncating in UTC.
--
-- Known tradeoff: a single numeric offset is captured once (now) and
-- applied uniformly across the whole range, whereas the old client-side
-- code re-derived each row's local day from its own historical instant
-- (correctly following DST if the browser's timezone observes it). The
-- two can disagree for messages sent during the hours immediately
-- around a DST transition that falls inside the requested range — at
-- most a handful of rows land in the adjacent day's bucket, twice a
-- year, only for callers in DST-observing timezones. Accepted: the
-- alternative (pulling every row to reproduce exact historical-instant
-- local time) is the every-row-to-the-browser cost this migration
-- exists to remove.
-- ============================================================
CREATE OR REPLACE FUNCTION public.dashboard_conversations_series(
  p_start TIMESTAMPTZ,
  p_tz_offset_minutes INT DEFAULT 0
) RETURNS TABLE(day DATE, incoming BIGINT, outgoing BIGINT)
LANGUAGE sql
STABLE
AS $$
  SELECT
    (created_at + make_interval(mins => p_tz_offset_minutes))::date AS day,
    COUNT(*) FILTER (WHERE sender_type = 'customer') AS incoming,
    COUNT(*) FILTER (WHERE sender_type <> 'customer') AS outgoing
  FROM messages
  WHERE created_at >= p_start
  GROUP BY 1
  ORDER BY 1;
$$;

REVOKE ALL ON FUNCTION public.dashboard_conversations_series(TIMESTAMPTZ, INT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.dashboard_conversations_series(TIMESTAMPTZ, INT) TO authenticated;

-- ============================================================
-- dashboard_response_time_samples(p_start)
--
-- Returns (customer_at, response_at) pairs — one per "first unreplied
-- customer message" -> "first subsequent outbound message" exchange —
-- instead of every raw message row, which the caller then buckets by
-- day-of-week / this-week-vs-last-week entirely in JS exactly as
-- before (that logic is unchanged; only the row-fetch got replaced).
--
-- Uses a gaps-and-islands window function to reproduce the previous
-- per-conversation JS walk as a set operation:
--   1. `grp` is a running count of non-customer (agent/bot) messages
--      seen so far in the conversation — it only increments AT a
--      response, so every customer message in an unanswered streak
--      shares the same `grp` as the streak that precedes the next
--      response.
--   2. The response to a customer streak is therefore the first
--      non-customer row whose `grp` is exactly one higher than the
--      streak's `grp` — joining customer batches to response batches
--      on `grp + 1` reproduces "pair the first message of each
--      unanswered streak with the next reply" exactly.
-- ============================================================
CREATE OR REPLACE FUNCTION public.dashboard_response_time_samples(
  p_start TIMESTAMPTZ
) RETURNS TABLE(customer_at TIMESTAMPTZ, response_at TIMESTAMPTZ)
LANGUAGE sql
STABLE
AS $$
  WITH tagged AS (
    SELECT
      conversation_id,
      sender_type,
      created_at,
      SUM(CASE WHEN sender_type <> 'customer' THEN 1 ELSE 0 END)
        OVER (
          PARTITION BY conversation_id
          ORDER BY created_at
          ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
        ) AS grp
    FROM messages
    WHERE created_at >= p_start
  ),
  customer_batches AS (
    SELECT conversation_id, grp, MIN(created_at) AS customer_at
    FROM tagged
    WHERE sender_type = 'customer'
    GROUP BY conversation_id, grp
  ),
  responses AS (
    SELECT conversation_id, grp, MIN(created_at) AS response_at
    FROM tagged
    WHERE sender_type <> 'customer'
    GROUP BY conversation_id, grp
  )
  SELECT cb.customer_at, r.response_at
  FROM customer_batches cb
  JOIN responses r
    ON r.conversation_id = cb.conversation_id
   AND r.grp = cb.grp + 1;
$$;

REVOKE ALL ON FUNCTION public.dashboard_response_time_samples(TIMESTAMPTZ) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.dashboard_response_time_samples(TIMESTAMPTZ) TO authenticated;
