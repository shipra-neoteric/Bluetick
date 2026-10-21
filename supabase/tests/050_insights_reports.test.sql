-- Behaviour tests for 050_insights_reports.sql (metric contract insights-v1).
-- Runs after the 044–049 tests (account A: owner a1, agent b1, viewer c1;
-- account Z: owner f1). Synthetic data in 2030 so it never overlaps other
-- fixtures. No message is sent anywhere.
\set ON_ERROR_STOP 1
SET client_min_messages = notice;
RESET ROLE;
CREATE TEMP TABLE fx50 AS
SELECT (SELECT account_id FROM profiles WHERE user_id = '00000000-0000-0000-0000-0000000000a1') AS acc_a,
       (SELECT account_id FROM profiles WHERE user_id = '00000000-0000-0000-0000-0000000000f1') AS acc_z;
GRANT SELECT ON fx50 TO authenticated;

INSERT INTO contacts (id, user_id, account_id, phone, name) VALUES
  ('10500000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000a1', (SELECT acc_a FROM fx50), '+910000050001', 'Insights Fixture');
-- Created unassigned at 09:00 (the creation counts as "opened").
INSERT INTO conversations (id, user_id, account_id, contact_id, status, created_at, last_message_at) VALUES
  ('20500000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000a1', (SELECT acc_a FROM fx50),
   '10500000-0000-0000-0000-000000000001', 'open', '2030-01-01 09:00+00', '2030-01-01 09:00+00');

-- Assignment and lifecycle history with explicit times (the trigger
-- would stamp now(); history rows are what the metrics read).
INSERT INTO conversation_events (account_id, conversation_id, event_type, to_user_id, created_at) VALUES
  ((SELECT acc_a FROM fx50), '20500000-0000-0000-0000-000000000001', 'assigned', '00000000-0000-0000-0000-0000000000b1', '2030-01-01 09:00+00');
INSERT INTO conversation_events (account_id, conversation_id, event_type, from_value, to_value, created_at) VALUES
  ((SELECT acc_a FROM fx50), '20500000-0000-0000-0000-000000000001', 'status_changed', 'open', 'closed', '2030-01-01 10:30+00');
INSERT INTO conversation_events (account_id, conversation_id, event_type, from_user_id, to_user_id, created_at) VALUES
  ((SELECT acc_a FROM fx50), '20500000-0000-0000-0000-000000000001', 'assigned', '00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000a1', '2030-01-01 10:50+00');
INSERT INTO conversation_events (account_id, conversation_id, event_type, from_value, to_value, created_at) VALUES
  ((SELECT acc_a FROM fx50), '20500000-0000-0000-0000-000000000001', 'status_changed', 'closed', 'open', '2030-01-01 10:55+00'),
  ((SELECT acc_a FROM fx50), '20500000-0000-0000-0000-000000000001', 'status_changed', 'open', 'closed', '2030-01-01 11:30+00');

INSERT INTO messages (conversation_id, sender_type, sender_id, content_type, content_text, message_id, status, created_at) VALUES
  ('20500000-0000-0000-0000-000000000001', 'customer', NULL, 'text', 'hi', 'wamid.I50.1', 'delivered', '2030-01-01 10:00+00'),
  ('20500000-0000-0000-0000-000000000001', 'customer', NULL, 'text', 'anyone?', 'wamid.I50.2', 'delivered', '2030-01-01 10:01+00'),
  ('20500000-0000-0000-0000-000000000001', 'bot', NULL, 'text', 'auto reply', 'wamid.I50.3', 'sent', '2030-01-01 10:02+00'),
  ('20500000-0000-0000-0000-000000000001', 'agent', '00000000-0000-0000-0000-0000000000b1', 'text', 'hello', 'wamid.I50.4', 'sent', '2030-01-01 10:10+00'),
  ('20500000-0000-0000-0000-000000000001', 'customer', NULL, 'text', 'price?', 'wamid.I50.5', 'delivered', '2030-01-01 11:00+00'),
  ('20500000-0000-0000-0000-000000000001', 'agent', '00000000-0000-0000-0000-0000000000a1', 'text', '80 lakh', 'wamid.I50.6', 'sent', '2030-01-01 11:05+00'),
  ('20500000-0000-0000-0000-000000000001', 'agent', '00000000-0000-0000-0000-0000000000b1', 'text', 'never sent', 'wamid.I50.7', 'failed', '2030-01-01 11:06+00'),
  ('20500000-0000-0000-0000-000000000001', 'customer', NULL, 'text', 'ok', 'wamid.I50.8', 'delivered', '2030-01-01 12:00+00');
-- Duplicate status delivery must not add samples or replies.
UPDATE messages SET status = 'delivered' WHERE message_id = 'wamid.I50.4';
UPDATE messages SET status = 'delivered' WHERE message_id = 'wamid.I50.4';

CREATE TEMP TABLE m50 AS SELECT
  insights_metric((SELECT acc_a FROM fx50), 'response_time', '2030-01-01 00:00+00', '2030-01-02 00:00+00', 'UTC', 'hour') AS rt,
  insights_metric((SELECT acc_a FROM fx50), 'response_time', '2030-01-01 00:00+00', '2030-01-02 00:00+00', 'UTC', 'hour', '00000000-0000-0000-0000-0000000000b1') AS rt_b,
  insights_metric((SELECT acc_a FROM fx50), 'replied', '2030-01-01 00:00+00', '2030-01-02 00:00+00', 'UTC', 'hour') AS rep,
  insights_metric((SELECT acc_a FROM fx50), 'opened', '2030-01-01 00:00+00', '2030-01-02 00:00+00', 'UTC', 'hour') AS op,
  insights_metric((SELECT acc_a FROM fx50), 'closed', '2030-01-01 00:00+00', '2030-01-02 00:00+00', 'UTC', 'day') AS cl,
  insights_metric((SELECT acc_a FROM fx50), 'replied', '2030-01-01 00:00+00', '2030-01-02 00:00+00', 'Asia/Kolkata', 'day') AS rep_ist;
GRANT SELECT ON m50 TO authenticated;

DO $$
DECLARE x m50;
BEGIN
  SELECT * INTO x FROM m50;
  -- Response time: repeated inbound joins the episode, bot reply ignored,
  -- failed send ignored, unanswered 12:00 is pending (not a sample).
  ASSERT (x.rt->>'samples')::int = 2, 'two samples: ' || (x.rt->>'samples');
  ASSERT (x.rt->>'total')::numeric = 450, 'weighted average (600+300)/2: ' || (x.rt->>'total');
  ASSERT (x.rt->>'total_seconds')::numeric = 900, 'total seconds';
  ASSERT (x.rt_b->>'samples')::int = 1 AND (x.rt_b->>'total')::numeric = 600, 'agent filter = performing agent';
  ASSERT jsonb_array_length(x.rt->'by_agent') = 2, 'per-agent rows';
  RAISE NOTICE 'PASS 050 response time';

  -- Replied: distinct conversations; bucket sum (2) differs from period total (1).
  ASSERT (x.rep->>'total')::int = 1, 'one distinct conversation replied';
  ASSERT jsonb_array_length(x.rep->'series') = 2, 'replies in two hourly buckets';
  ASSERT x.rep->'series'->0->>'bucket' = '2030-01-01T10:00', 'hour bucket label';
  ASSERT (x.rep->'by_agent'->0->>'agent_id') = '00000000-0000-0000-0000-0000000000b1'
     AND (x.rep->'by_agent'->0->>'value')::int = 1
     AND jsonb_array_length(x.rep->'by_agent') = 1, 'exclusive credit to the first replier; slices sum to total';
  RAISE NOTICE 'PASS 050 replied';

  -- Opened: creation (assignee b1 at 09:00) + reopen at 10:55 (a1 after reassignment).
  ASSERT (x.op->>'total')::int = 2, 'opened events: ' || (x.op->>'total');
  ASSERT (SELECT COUNT(*) FROM jsonb_array_elements(x.op->'by_agent') e WHERE (e->>'value')::int = 1) = 2, 'b1 and a1 one each';
  -- Closed: 10:30 (b1) and 11:30 (a1); daily bucket.
  ASSERT (x.cl->>'total')::int = 2 AND jsonb_array_length(x.cl->'series') = 1, 'two closes, one day bucket';
  ASSERT x.cl->'series'->0->>'bucket' = '2030-01-01', 'day bucket label';
  RAISE NOTICE 'PASS 050 lifecycle + attribution at event time';

  -- Timezone: 10:10–11:05 UTC is the same IST day.
  ASSERT x.rep_ist->'series'->0->>'bucket' = '2030-01-01', 'IST day bucket';
  ASSERT x.rt->>'version' = 'insights-v1', 'versioned';
  RAISE NOTICE 'PASS 050 timezone + version';
END $$;

-- Invalid input is refused, not guessed.
DO $$ BEGIN
  BEGIN PERFORM insights_metric((SELECT acc_a FROM fx50), 'replied', '2030-01-01', '2030-06-01', 'UTC', 'day'); RAISE EXCEPTION 'range accepted';
  EXCEPTION WHEN raise_exception THEN IF SQLERRM NOT LIKE 'insights:%' THEN RAISE; END IF; END;
  BEGIN PERFORM insights_metric((SELECT acc_a FROM fx50), 'replied', '2030-01-01', '2030-01-02', 'Mars/Base', 'day'); RAISE EXCEPTION 'tz accepted';
  EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
  RAISE NOTICE 'PASS 050 input validation';
END $$;

-- Another account can't see account A's numbers, even by passing its id.
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000f1', false);
DO $$ BEGIN
  ASSERT (insights_metric((SELECT acc_a FROM fx50), 'replied', '2030-01-01 00:00+00', '2030-01-02 00:00+00', 'UTC', 'day')->>'total')::int = 0,
    'other tenant sees nothing';
  ASSERT (insights_metric((SELECT acc_a FROM fx50), 'response_time', '2030-01-01 00:00+00', '2030-01-02 00:00+00', 'UTC', 'day')->>'samples')::int = 0,
    'other tenant: no samples';
  RAISE NOTICE 'PASS 050 tenant isolation';
END $$;
RESET ROLE;

-- Report history: one active request per requester/type/params; file bytes not readable by clients.
INSERT INTO report_requests (id, account_id, report_type, params, params_key, status, requested_by, file_name, file_data, expires_at)
VALUES ('30500000-0000-0000-0000-000000000001', (SELECT acc_a FROM fx50), 'agent_activity', '{}', 'k1', 'generating', '00000000-0000-0000-0000-0000000000a1', NULL, NULL, NULL);
DO $$ BEGIN
  BEGIN
    INSERT INTO report_requests (account_id, report_type, params, params_key, status, requested_by)
    VALUES ((SELECT acc_a FROM fx50), 'agent_activity', '{}', 'k1', 'queued', '00000000-0000-0000-0000-0000000000a1');
    RAISE EXCEPTION 'duplicate active request accepted';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
  RAISE NOTICE 'PASS 050 duplicate active blocked';
END $$;
UPDATE report_requests SET status = 'complete', file_name = 'r.xlsx', file_data = '\x01'::bytea, expires_at = NOW() - interval '1 day'
WHERE id = '30500000-0000-0000-0000-000000000001';
INSERT INTO report_requests (account_id, report_type, params, params_key, status, requested_by)
VALUES ((SELECT acc_a FROM fx50), 'agent_activity', '{}', 'k1', 'queued', '00000000-0000-0000-0000-0000000000a1');  -- finished one can repeat

SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', false);
DO $$ BEGIN
  ASSERT (SELECT COUNT(*) FROM report_requests WHERE id = '30500000-0000-0000-0000-000000000001') = 1, 'admin lists history';
  BEGIN
    PERFORM file_data FROM report_requests LIMIT 1;
    RAISE EXCEPTION 'file bytes readable';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  RAISE NOTICE 'PASS 050 history visibility';
END $$;
SELECT set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000b1', false);
DO $$ BEGIN
  ASSERT (SELECT COUNT(*) FROM report_requests) = 0, 'agents do not see report history';
  RAISE NOTICE 'PASS 050 agent hidden';
END $$;
RESET ROLE;

DO $$ BEGIN
  ASSERT purge_expired_reports() = 1, 'expired file purged';
  ASSERT (SELECT file_data IS NULL AND status = 'complete' FROM report_requests WHERE id = '30500000-0000-0000-0000-000000000001'),
    'history kept, file gone';
  RAISE NOTICE 'PASS 050 expiry';
END $$;
