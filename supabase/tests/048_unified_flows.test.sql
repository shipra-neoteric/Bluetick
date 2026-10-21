-- Behaviour tests for 048_unified_flows.sql. Runs after the 044–047 tests
-- on the same throwaway database (account A: owner a1). Synthetic data only.
\set ON_ERROR_STOP 1
SET client_min_messages = notice;
RESET ROLE;
CREATE TEMP TABLE fx48 AS
SELECT (SELECT account_id FROM profiles WHERE user_id = '00000000-0000-0000-0000-0000000000a1') AS acc_a;

-- Event triggers and the new node types are accepted.
INSERT INTO flows (id, user_id, account_id, name, status, trigger_type, trigger_config, entry_node_id) VALUES
  ('f0480000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000a1', (SELECT acc_a FROM fx48), 'on close', 'active', 'conversation_closed', '{}', 'd1'),
  ('f0480000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-0000000000a1', (SELECT acc_a FROM fx48), 'chat bot', 'active', 'keyword', '{"keywords":["hi"]}', 's1');
INSERT INTO flow_nodes (flow_id, node_key, node_type, config) VALUES
  ('f0480000-0000-0000-0000-000000000001', 'd1', 'time_delay', '{"amount":1,"unit":"days","next_node_key":"a1"}'),
  ('f0480000-0000-0000-0000-000000000001', 'a1', 'action', '{"step_type":"close_conversation","step_config":{}}'),
  ('f0480000-0000-0000-0000-000000000001', 'w1', 'wait_until', '{"at":"2030-01-01T09:00"}');
DO $$ BEGIN
  BEGIN
    INSERT INTO flows (user_id, account_id, name, trigger_type) VALUES
      ('00000000-0000-0000-0000-0000000000a1', (SELECT acc_a FROM fx48), 'bad', 'not_a_trigger');
    RAISE EXCEPTION 'unknown trigger accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  RAISE NOTICE 'PASS 048 trigger + node checks';
END $$;

-- One conversation-holding run per contact; background runs don't count.
INSERT INTO flow_runs (flow_id, account_id, user_id, contact_id, status, current_node_key, exclusive) VALUES
  ('f0480000-0000-0000-0000-000000000002', (SELECT acc_a FROM fx48), '00000000-0000-0000-0000-0000000000a1', '10000000-0000-0000-0000-000000000001', 'active', 's1', TRUE),
  ('f0480000-0000-0000-0000-000000000001', (SELECT acc_a FROM fx48), '00000000-0000-0000-0000-0000000000a1', '10000000-0000-0000-0000-000000000001', 'active', 'd1', FALSE),
  ('f0480000-0000-0000-0000-000000000001', (SELECT acc_a FROM fx48), '00000000-0000-0000-0000-0000000000a1', '10000000-0000-0000-0000-000000000001', 'active', 'd1', FALSE);
DO $$ BEGIN
  BEGIN
    INSERT INTO flow_runs (flow_id, account_id, user_id, contact_id, status, current_node_key)
    VALUES ('f0480000-0000-0000-0000-000000000002', (SELECT acc_a FROM fx48), '00000000-0000-0000-0000-0000000000a1', '10000000-0000-0000-0000-000000000001', 'active', 's1');
    RAISE EXCEPTION 'second exclusive run accepted';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
  -- Claiming the slot from a background run fails while it is held.
  BEGIN
    UPDATE flow_runs SET exclusive = TRUE
    WHERE id = (SELECT id FROM flow_runs WHERE flow_id = 'f0480000-0000-0000-0000-000000000001' LIMIT 1);
    RAISE EXCEPTION 'background run took a held slot';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
  RAISE NOTICE 'PASS 048 exclusive slot';
END $$;

-- Due delays are claimed once; future ones and stale leases behave.
UPDATE flow_runs SET resume_at = NOW() - interval '1 minute'
WHERE id = (SELECT id FROM flow_runs WHERE flow_id = 'f0480000-0000-0000-0000-000000000001' ORDER BY started_at, id LIMIT 1);
UPDATE flow_runs SET resume_at = NOW() + interval '1 day'
WHERE flow_id = 'f0480000-0000-0000-0000-000000000001' AND resume_at IS NULL;
DO $$
DECLARE a INTEGER; b INTEGER;
BEGIN
  SELECT COUNT(*) INTO a FROM claim_flow_resumes(50, 60);
  SELECT COUNT(*) INTO b FROM claim_flow_resumes(50, 60);
  ASSERT a = 1 AND b = 0, 'due delay claimed once (a=' || a || ', b=' || b || ')';
  UPDATE flow_runs SET resume_locked_until = NOW() - interval '1 second' WHERE resume_locked_until IS NOT NULL;
  SELECT COUNT(*) INTO b FROM claim_flow_resumes(50, 60);
  ASSERT b = 1, 'stale resume lease reclaimed';
  UPDATE flow_runs SET resume_locked_until = NULL, resume_attempts = 5 WHERE resume_locked_until IS NOT NULL;
  SELECT COUNT(*) INTO b FROM claim_flow_resumes(50, 60);
  ASSERT b = 0, 'gives up after 5 attempts';
  RAISE NOTICE 'PASS 048 delay claim';
END $$;

-- Outbox records an event that only a flow listens for.
DELETE FROM automation_events;
UPDATE automations SET is_active = FALSE WHERE trigger_type = 'conversation_closed';
UPDATE conversations SET status = 'open' WHERE id = '20000000-0000-0000-0000-000000000001';
UPDATE conversations SET status = 'closed' WHERE id = '20000000-0000-0000-0000-000000000001';
DO $$ BEGIN
  ASSERT (SELECT COUNT(*) FROM automation_events WHERE event_type = 'conversation_closed') = 1, 'flow listener recorded';
  RAISE NOTICE 'PASS 048 outbox flow listener';
END $$;
UPDATE flows SET status = 'draft' WHERE id = 'f0480000-0000-0000-0000-000000000001';
UPDATE conversations SET status = 'open' WHERE id = '20000000-0000-0000-0000-000000000001';
UPDATE conversations SET status = 'closed' WHERE id = '20000000-0000-0000-0000-000000000001';
DO $$ BEGIN
  ASSERT (SELECT COUNT(*) FROM automation_events WHERE event_type = 'conversation_closed') = 1, 'no listener → no event';
  RAISE NOTICE 'PASS 048 outbox no listener';
END $$;

-- Conversion bookkeeping: one flow per source automation.
UPDATE flows SET source_automation_id = 'a0000000-0000-0000-0000-000000000001' WHERE id = 'f0480000-0000-0000-0000-000000000001';
DO $$ BEGIN
  BEGIN
    UPDATE flows SET source_automation_id = 'a0000000-0000-0000-0000-000000000001' WHERE id = 'f0480000-0000-0000-0000-000000000002';
    RAISE EXCEPTION 'automation converted twice';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
  RAISE NOTICE 'PASS 048 conversion unique';
END $$;

-- Webhook tables are service-role only.
DO $$ BEGIN
  ASSERT (SELECT relrowsecurity FROM pg_class WHERE relname = 'flow_webhooks'), 'RLS on flow_webhooks';
  ASSERT NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename IN ('flow_webhooks', 'flow_webhook_receipts')), 'no client policies';
  ASSERT NOT has_function_privilege('authenticated', 'claim_flow_resumes(integer, integer)', 'EXECUTE'), 'claim not callable by clients';
  RAISE NOTICE 'PASS 048 service-role only';
END $$;
