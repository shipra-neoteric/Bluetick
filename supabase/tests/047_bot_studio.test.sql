-- Behaviour tests for 047_bot_studio.sql. Runs after the 044–046 tests on
-- the same throwaway database (reuses account A: owner a1, agent b1,
-- viewer c1). Synthetic data only.
\set ON_ERROR_STOP 1
SET client_min_messages = notice;
RESET ROLE;
CREATE TEMP TABLE fx AS
SELECT (SELECT account_id FROM profiles WHERE user_id = '00000000-0000-0000-0000-0000000000a1') AS acc_a;
GRANT SELECT ON fx TO authenticated;

-- An active automation listening to every lifecycle event.
INSERT INTO automations (id, user_id, account_id, name, trigger_type, trigger_config, is_active) VALUES
  ('a0000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000a1', (SELECT acc_a FROM fx), 'on assign', 'conversation_assigned', '{}', TRUE),
  ('a0000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-0000000000a1', (SELECT acc_a FROM fx), 'on close', 'conversation_closed', '{}', TRUE),
  ('a0000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-0000000000a1', (SELECT acc_a FROM fx), 'on open', 'conversation_opened', '{}', TRUE),
  ('a0000000-0000-0000-0000-000000000004', '00000000-0000-0000-0000-0000000000a1', (SELECT acc_a FROM fx), 'on field', 'contact_field_changed', '{}', TRUE);

-- ── Outbox: real transitions only ──────────────────────────────────────
DELETE FROM automation_events;
UPDATE conversations SET assigned_agent_id = '00000000-0000-0000-0000-0000000000b1'
WHERE id = '20000000-0000-0000-0000-000000000003';
UPDATE conversations SET assigned_agent_id = '00000000-0000-0000-0000-0000000000b1'
WHERE id = '20000000-0000-0000-0000-000000000003';             -- no-op write
UPDATE conversations SET status = 'closed' WHERE id = '20000000-0000-0000-0000-000000000003';
UPDATE conversations SET status = 'open' WHERE id = '20000000-0000-0000-0000-000000000003';
UPDATE contacts SET name = 'Synthetic Three B' WHERE id = '10000000-0000-0000-0000-000000000003';
UPDATE contacts SET name = 'Synthetic Three B' WHERE id = '10000000-0000-0000-0000-000000000003';  -- no-op
DO $$
BEGIN
  ASSERT (SELECT COUNT(*) FROM automation_events WHERE event_type = 'conversation_assigned') = 1, 'one assign event (no-op ignored)';
  ASSERT (SELECT COUNT(*) FROM automation_events WHERE event_type = 'conversation_closed') = 1, 'close event';
  ASSERT (SELECT COUNT(*) FROM automation_events WHERE event_type = 'conversation_opened') = 1, 'reopen event';
  ASSERT (SELECT COUNT(*) FROM automation_events WHERE event_type = 'contact_field_changed') = 1, 'one field event (no-op ignored)';
  ASSERT (SELECT payload->>'previous_status' FROM automation_events WHERE event_type = 'conversation_opened') = 'closed', 'previous value kept';
  RAISE NOTICE 'PASS 047 outbox transitions';
END $$;

-- No listener → no row.
UPDATE automations SET is_active = FALSE WHERE id = 'a0000000-0000-0000-0000-000000000002';
UPDATE conversations SET status = 'closed' WHERE id = '20000000-0000-0000-0000-000000000002';
DO $$ BEGIN
  ASSERT (SELECT COUNT(*) FROM automation_events WHERE event_type = 'conversation_closed') = 1, 'inactive automation: no event';
  RAISE NOTICE 'PASS 047 outbox only when listened';
END $$;

-- Claim each event once.
DO $$
DECLARE a INTEGER; b INTEGER;
BEGIN
  SELECT COUNT(*) INTO a FROM claim_automation_events(100, 60);
  SELECT COUNT(*) INTO b FROM claim_automation_events(100, 60);
  ASSERT a = 4 AND b = 0, 'events claimed once (a=' || a || ', b=' || b || ')';
  -- A crashed worker's lease expires → reclaimable.
  UPDATE automation_events SET locked_until = NOW() - interval '1 second' WHERE event_type = 'conversation_closed';
  SELECT COUNT(*) INTO b FROM claim_automation_events(100, 60);
  ASSERT b = 1, 'stale lease reclaimed';
  RAISE NOTICE 'PASS 047 event claim';
END $$;

-- ── Pending waits: lease + reclaim ─────────────────────────────────────
INSERT INTO automation_pending_executions (automation_id, account_id, user_id, contact_id, next_step_position, context, run_at, status)
VALUES ('a0000000-0000-0000-0000-000000000001', (SELECT acc_a FROM fx), '00000000-0000-0000-0000-0000000000a1',
        '10000000-0000-0000-0000-000000000001', 1, '{}', NOW() - interval '1 minute', 'pending'),
       ('a0000000-0000-0000-0000-000000000001', (SELECT acc_a FROM fx), '00000000-0000-0000-0000-0000000000a1',
        '10000000-0000-0000-0000-000000000001', 1, '{}', NOW() + interval '1 day', 'pending');
DO $$
DECLARE a INTEGER; b INTEGER;
BEGIN
  SELECT COUNT(*) INTO a FROM claim_automation_pending(50, 60);
  SELECT COUNT(*) INTO b FROM claim_automation_pending(50, 60);
  ASSERT a = 1 AND b = 0, 'due wait claimed once, future one untouched';
  UPDATE automation_pending_executions SET locked_until = NOW() - interval '1 second' WHERE status = 'running';
  SELECT COUNT(*) INTO b FROM claim_automation_pending(50, 60);
  ASSERT b = 1, 'crashed worker reclaimed';
  RAISE NOTICE 'PASS 047 pending lease';
END $$;

-- ── Round-robin rotates over eligible agents only ──────────────────────
DO $$
DECLARE x UUID; y UUID; z UUID; v UUID;
BEGIN
  x := next_round_robin_agent((SELECT acc_a FROM fx), 'all', '{}');
  y := next_round_robin_agent((SELECT acc_a FROM fx), 'all', '{}');
  z := next_round_robin_agent((SELECT acc_a FROM fx), 'all', '{}');
  ASSERT x <> y AND x = z, 'rotates a1/b1 (viewer c1 excluded)';
  ASSERT x IN ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000b1'), 'eligible member';
  v := next_round_robin_agent((SELECT acc_a FROM fx), 'viewer-only', ARRAY['00000000-0000-0000-0000-0000000000c1']::uuid[]);
  ASSERT v IS NULL, 'pool of ineligible members → NULL';
  RAISE NOTICE 'PASS 047 round robin';
END $$;

-- ── Daily first ledger is unique per day ───────────────────────────────
INSERT INTO contact_daily_firsts (account_id, contact_id, day)
VALUES ((SELECT acc_a FROM fx), '10000000-0000-0000-0000-000000000001', '2026-10-18');
DO $$ BEGIN
  BEGIN
    INSERT INTO contact_daily_firsts (account_id, contact_id, day)
    VALUES ((SELECT acc_a FROM fx), '10000000-0000-0000-0000-000000000001', '2026-10-18');
    RAISE EXCEPTION 'second first-of-day must be rejected';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
  RAISE NOTICE 'PASS 047 daily first';
END $$;

-- ── Client isolation ───────────────────────────────────────────────────
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000b1', false);
DO $$ BEGIN
  ASSERT (SELECT COUNT(*) FROM automation_events) = 0, 'outbox invisible to clients';
  ASSERT (SELECT COUNT(*) FROM automation_webhooks) = 0, 'webhook tokens invisible to clients';
  BEGIN
    INSERT INTO business_hours (account_id) VALUES ((SELECT acc_a FROM fx));
    RAISE EXCEPTION 'agents must not edit business hours';
  EXCEPTION WHEN insufficient_privilege OR check_violation THEN NULL;
  END;
  BEGIN
    PERFORM next_round_robin_agent((SELECT acc_a FROM fx), 'x', '{}');
    RAISE EXCEPTION 'clients must not move the round-robin cursor';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  RAISE NOTICE 'PASS 047 isolation';
END $$;
SELECT set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', false);
INSERT INTO business_hours (account_id) VALUES ((SELECT acc_a FROM fx));
DO $$ BEGIN
  ASSERT (SELECT timezone FROM business_hours) = 'Asia/Kolkata', 'admin can configure hours';
  RAISE NOTICE 'PASS 047 business hours';
END $$;
RESET ROLE;

-- ── Flow node types + versions ─────────────────────────────────────────
INSERT INTO flows (id, user_id, account_id, name, trigger_type, trigger_config, status)
VALUES ('f0000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000a1', (SELECT acc_a FROM fx), 'demo', 'keyword', '{"keywords":["hi"]}', 'draft');
INSERT INTO flow_nodes (flow_id, node_key, node_type, config) VALUES
  ('f0000000-0000-0000-0000-000000000001', 'loc', 'send_location', '{}'),
  ('f0000000-0000-0000-0000-000000000001', 'wh', 'working_hours', '{}');
INSERT INTO flow_versions (flow_id, account_id, version, trigger_type, nodes)
VALUES ('f0000000-0000-0000-0000-000000000001', (SELECT acc_a FROM fx), 1, 'keyword', '[]');
DO $$ BEGIN
  BEGIN
    INSERT INTO flow_versions (flow_id, account_id, version, trigger_type, nodes)
    VALUES ('f0000000-0000-0000-0000-000000000001', (SELECT acc_a FROM fx), 1, 'keyword', '[]');
    RAISE EXCEPTION 'duplicate version must be rejected';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO flow_nodes (flow_id, node_key, node_type, config)
    VALUES ('f0000000-0000-0000-0000-000000000001', 'bad', 'not_a_node', '{}');
    RAISE EXCEPTION 'unknown node type must be rejected';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  RAISE NOTICE 'PASS 047 flow nodes + versions';
END $$;
