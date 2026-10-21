-- ============================================================
-- 050 — Insights: canonical analytics metrics + report history.
--
-- Additive and safe to run twice. Run after 044 (uses conversation_events,
-- awaiting_reply_since).
-- (version insights-v1). No backfill: lifecycle history exists from 044.
--
--   1. insights_response_samples(): one sample per customer waiting
--      episode, closed by a delivered HUMAN reply (same rule as the
--      inbox's awaiting_reply_since; bot/flow/AI replies don't count).
--   2. insights_metric(): response_time | replied | opened | closed,
--      bucketed (hour/day) in the caller's timezone, with period totals
--      and an agent breakdown, returned as one JSON document (no row
--      limits, one round trip, same numbers for the page and exports).
--      SECURITY INVOKER: row-level security still applies, and every
--      query is also filtered by the account passed in by the server.
--   3. report_requests: report history. Job status and file availability
--      are separate (expires_at); the file lives in the private row and is
--      never selectable by clients (column privileges).
-- ============================================================

-- 1. Response samples ------------------------------------------------
CREATE OR REPLACE FUNCTION insights_response_samples(p_account UUID, p_from TIMESTAMPTZ, p_to TIMESTAMPTZ)
RETURNS TABLE (conversation_id UUID, agent_id UUID, started_at TIMESTAMPTZ, replied_at TIMESTAMPTZ, seconds DOUBLE PRECISION)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public AS $$
  WITH m AS (
    SELECT msg.id, msg.conversation_id, msg.sender_type, msg.sender_id, msg.created_at
    FROM messages msg
    JOIN conversations c ON c.id = msg.conversation_id
    WHERE c.account_id = p_account
      AND msg.created_at >= p_from - interval '30 days'
      AND msg.created_at < p_to
      AND (msg.sender_type = 'customer'
           OR (msg.sender_type = 'agent' AND msg.status IN ('sent', 'delivered', 'read')))
  ), g AS (
    SELECT m.*,
      LAG(m.sender_type) OVER w AS prev_type,
      COUNT(*) FILTER (WHERE m.sender_type = 'agent') OVER w AS agent_seq
    FROM m
    WINDOW w AS (PARTITION BY m.conversation_id ORDER BY m.created_at, m.id ROWS UNBOUNDED PRECEDING)
  ), starts AS (
    -- Customer messages after the k-th human reply form episode k.
    SELECT g.conversation_id, g.agent_seq, MIN(g.created_at) AS started_at
    FROM g WHERE g.sender_type = 'customer'
    GROUP BY g.conversation_id, g.agent_seq
  ), replies AS (
    -- The first human reply after customer messages closes the episode.
    SELECT g.conversation_id, g.agent_seq, g.sender_id, g.created_at
    FROM g WHERE g.sender_type = 'agent' AND g.prev_type = 'customer'
  )
  SELECT r.conversation_id, r.sender_id, s.started_at, r.created_at,
         EXTRACT(EPOCH FROM (r.created_at - s.started_at))::double precision
  FROM replies r
  JOIN starts s ON s.conversation_id = r.conversation_id AND s.agent_seq = r.agent_seq - 1
  WHERE r.created_at >= p_from AND r.created_at < p_to
    AND r.created_at >= s.started_at;
$$;

-- 2. Metrics ----------------------------------------------------------
CREATE OR REPLACE FUNCTION insights_metric(
  p_account UUID, p_metric TEXT, p_from TIMESTAMPTZ, p_to TIMESTAMPTZ,
  p_tz TEXT, p_bucket TEXT, p_agent UUID DEFAULT NULL
) RETURNS JSONB LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = public AS $$
DECLARE
  r JSONB;
  fmt TEXT;
BEGIN
  IF p_bucket NOT IN ('hour', 'day') THEN RAISE EXCEPTION 'insights: bucket must be hour or day'; END IF;
  IF p_to <= p_from OR p_to - p_from > interval '93 days' THEN RAISE EXCEPTION 'insights: invalid range'; END IF;
  PERFORM now() AT TIME ZONE p_tz;  -- raises on an unknown timezone
  fmt := CASE WHEN p_bucket = 'hour' THEN 'YYYY-MM-DD"T"HH24:00' ELSE 'YYYY-MM-DD' END;

  IF p_metric = 'response_time' THEN
    WITH s AS (
      SELECT * FROM insights_response_samples(p_account, p_from, p_to)
      WHERE p_agent IS NULL OR agent_id = p_agent
    ), b AS (
      SELECT to_char(date_trunc(p_bucket, replied_at AT TIME ZONE p_tz), fmt) AS bucket,
             SUM(seconds) AS total, COUNT(*) AS n
      FROM s GROUP BY 1
    ), a AS (
      SELECT agent_id, SUM(seconds) AS total, COUNT(*) AS n FROM s GROUP BY agent_id
    )
    SELECT jsonb_build_object(
      'series', COALESCE((SELECT jsonb_agg(jsonb_build_object('bucket', bucket, 'value', total / n, 'samples', n, 'total_seconds', total) ORDER BY bucket) FROM b), '[]'::jsonb),
      'total', (SELECT SUM(seconds) / NULLIF(COUNT(*), 0) FROM s),
      'samples', (SELECT COUNT(*) FROM s),
      'total_seconds', (SELECT COALESCE(SUM(seconds), 0) FROM s),
      'by_agent', COALESCE((SELECT jsonb_agg(jsonb_build_object('agent_id', agent_id, 'value', total / n, 'samples', n, 'total_seconds', total) ORDER BY total / n) FROM a), '[]'::jsonb)
    ) INTO r;

  ELSIF p_metric = 'replied' THEN
    WITH m AS (
      SELECT msg.conversation_id, msg.sender_id, msg.created_at
      FROM messages msg JOIN conversations c ON c.id = msg.conversation_id
      WHERE c.account_id = p_account
        AND msg.sender_type = 'agent' AND msg.status IN ('sent', 'delivered', 'read')
        AND msg.created_at >= p_from AND msg.created_at < p_to
        AND (p_agent IS NULL OR msg.sender_id = p_agent)
    ), b AS (
      SELECT to_char(date_trunc(p_bucket, created_at AT TIME ZONE p_tz), fmt) AS bucket,
             COUNT(DISTINCT conversation_id) AS n
      FROM m GROUP BY 1
    ), first_reply AS (
      -- Exclusive credit: the first human who replied in the period.
      SELECT DISTINCT ON (conversation_id) conversation_id, sender_id
      FROM m ORDER BY conversation_id, created_at
    ), a AS (
      SELECT sender_id AS agent_id, COUNT(*) AS n FROM first_reply GROUP BY sender_id
    )
    SELECT jsonb_build_object(
      'series', COALESCE((SELECT jsonb_agg(jsonb_build_object('bucket', bucket, 'value', n) ORDER BY bucket) FROM b), '[]'::jsonb),
      'total', (SELECT COUNT(DISTINCT conversation_id) FROM m),
      'by_agent', COALESCE((SELECT jsonb_agg(jsonb_build_object('agent_id', agent_id, 'value', n) ORDER BY n DESC) FROM a), '[]'::jsonb)
    ) INTO r;

  ELSIF p_metric IN ('opened', 'closed') THEN
    WITH ev AS (
      SELECT c.id AS conversation_id, c.created_at AS at
      FROM conversations c
      WHERE p_metric = 'opened' AND c.account_id = p_account
        AND c.created_at >= p_from AND c.created_at < p_to
      UNION ALL
      SELECT e.conversation_id, e.created_at
      FROM conversation_events e
      WHERE e.account_id = p_account AND e.event_type = 'status_changed'
        AND e.created_at >= p_from AND e.created_at < p_to
        AND ((p_metric = 'opened' AND e.from_value = 'closed' AND e.to_value <> 'closed')
          OR (p_metric = 'closed' AND e.to_value = 'closed'))
    ), att AS (
      -- Assignee at the time of the event (assignment history, 044+).
      SELECT ev.*, (
        SELECT a.to_user_id FROM conversation_events a
        WHERE a.conversation_id = ev.conversation_id
          AND a.event_type IN ('assigned', 'unassigned')
          AND a.created_at <= ev.at
        ORDER BY a.created_at DESC, a.id DESC LIMIT 1
      ) AS agent_id
      FROM ev
    ), f AS (
      SELECT * FROM att WHERE p_agent IS NULL OR agent_id = p_agent
    ), b AS (
      SELECT to_char(date_trunc(p_bucket, at AT TIME ZONE p_tz), fmt) AS bucket, COUNT(*) AS n
      FROM f GROUP BY 1
    ), a AS (
      SELECT agent_id, COUNT(*) AS n FROM f GROUP BY agent_id
    )
    SELECT jsonb_build_object(
      'series', COALESCE((SELECT jsonb_agg(jsonb_build_object('bucket', bucket, 'value', n) ORDER BY bucket) FROM b), '[]'::jsonb),
      'total', (SELECT COUNT(*) FROM f),
      'by_agent', COALESCE((SELECT jsonb_agg(jsonb_build_object('agent_id', agent_id, 'value', n) ORDER BY n DESC) FROM a), '[]'::jsonb)
    ) INTO r;

  ELSE
    RAISE EXCEPTION 'insights: unknown metric %', p_metric;
  END IF;

  RETURN r || jsonb_build_object(
    'metric', p_metric, 'version', 'insights-v1',
    'history_since', (SELECT MIN(created_at) FROM conversation_events WHERE account_id = p_account)
  );
END;
$$;
REVOKE ALL ON FUNCTION insights_response_samples(UUID, TIMESTAMPTZ, TIMESTAMPTZ) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION insights_metric(UUID, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, TEXT, TEXT, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION insights_response_samples(UUID, TIMESTAMPTZ, TIMESTAMPTZ) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION insights_metric(UUID, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, TEXT, TEXT, UUID) TO authenticated, service_role;

CREATE INDEX IF NOT EXISTS idx_conversation_events_account_type_time
  ON conversation_events (account_id, event_type, created_at);

-- 3. Report history ---------------------------------------------------
CREATE TABLE IF NOT EXISTS report_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  report_type TEXT NOT NULL CHECK (report_type IN ('agent_activity')),
  -- Immutable request: {from, to, tz, agent_id?}; params_key = normalized copy.
  params JSONB NOT NULL,
  params_key TEXT NOT NULL,
  definition_version TEXT NOT NULL DEFAULT 'insights-v1',
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'generating', 'complete', 'failed')),
  error TEXT,
  requested_by UUID,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  file_name TEXT,
  file_size INTEGER,
  file_data BYTEA,
  -- Availability is separate from status: a Complete report can expire.
  expires_at TIMESTAMPTZ,
  regenerated_from UUID REFERENCES report_requests(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_report_requests_account ON report_requests (account_id, requested_at DESC);
-- One active request per (requester, type, parameters); finished ones can repeat.
CREATE UNIQUE INDEX IF NOT EXISTS idx_report_requests_active
  ON report_requests (account_id, report_type, params_key, requested_by)
  WHERE status IN ('queued', 'generating');

ALTER TABLE report_requests ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS report_requests_select ON report_requests;
CREATE POLICY report_requests_select ON report_requests
  FOR SELECT USING (is_account_member(account_id, 'admin'));
-- Writes go through the reports API (service role). Clients can list
-- history but never read the file bytes.
REVOKE ALL ON report_requests FROM anon, authenticated;
GRANT SELECT (id, account_id, report_type, params, definition_version, status, error, requested_by,
              requested_at, completed_at, file_name, file_size, expires_at, regenerated_from)
  ON report_requests TO authenticated;

-- Drop expired files (rows stay as history). Called by the crons.
CREATE OR REPLACE FUNCTION purge_expired_reports() RETURNS INTEGER
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  WITH d AS (
    UPDATE report_requests SET file_data = NULL
    WHERE file_data IS NOT NULL AND expires_at IS NOT NULL AND expires_at < NOW()
    RETURNING 1
  ) SELECT COUNT(*)::int FROM d;
$$;
REVOKE ALL ON FUNCTION purge_expired_reports() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION purge_expired_reports() TO service_role;
