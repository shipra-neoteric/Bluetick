-- Behaviour tests for 049_call_api.sql. Runs after the 044–048 tests on the
-- same throwaway database (account A: owner a1, agent b1, viewer c1).
-- Synthetic data only; no request is ever made from SQL.
\set ON_ERROR_STOP 1
SET client_min_messages = notice;
RESET ROLE;
CREATE TEMP TABLE fx49 AS
SELECT (SELECT account_id FROM profiles WHERE user_id = '00000000-0000-0000-0000-0000000000a1') AS acc_a;
GRANT SELECT ON fx49 TO authenticated;

INSERT INTO api_definitions (id, account_id, name, method, url, headers, body)
VALUES ('a0490000-0000-0000-0000-000000000001', (SELECT acc_a FROM fx49), 'Lead CRM', 'POST',
        'https://example.invalid/leads', '[{"key":"Authorization","value":"Bearer synthetic"}]', '{"phone":"{{contact.phone}}"}');

DO $$ BEGIN
  BEGIN
    INSERT INTO api_definitions (account_id, name, method, url)
    VALUES ((SELECT acc_a FROM fx49), 'Bad', 'TRACE', 'https://example.invalid');
    RAISE EXCEPTION 'TRACE accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO api_definitions (account_id, name, method, url)
    VALUES ((SELECT acc_a FROM fx49), 'Lead CRM', 'GET', 'https://example.invalid');
    RAISE EXCEPTION 'duplicate name accepted';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
  RAISE NOTICE 'PASS 049 checks';
END $$;

-- Agents see (and can edit) saved APIs; viewers can't read credentials.
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000b1', false);
DO $$ BEGIN
  ASSERT (SELECT count(*) FROM api_definitions) = 1, 'agent sees the API';
  UPDATE api_definitions SET name = 'Lead CRM v2' WHERE id = 'a0490000-0000-0000-0000-000000000001';
  ASSERT (SELECT name FROM api_definitions) = 'Lead CRM v2', 'agent can edit';
  RAISE NOTICE 'PASS 049 agent access';
END $$;
SELECT set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c1', false);
DO $$ BEGIN
  ASSERT (SELECT count(*) FROM api_definitions) = 0, 'viewer cannot read headers';
  RAISE NOTICE 'PASS 049 viewer hidden';
END $$;
RESET ROLE;

-- call_api steps are allowed, and re-running 047/048 keeps them allowed.
INSERT INTO flow_nodes (flow_id, node_key, node_type, config)
VALUES ('f0480000-0000-0000-0000-000000000001', 'api1', 'call_api', '{"api_id":"a0490000-0000-0000-0000-000000000001"}');
\ir ../migrations/047_bot_studio.sql
\ir ../migrations/048_unified_flows.sql
DO $$ BEGIN
  ASSERT (SELECT pg_get_constraintdef(oid) LIKE '%call_api%' FROM pg_constraint WHERE conname = 'flow_nodes_node_type_check'),
    're-running 047/048 keeps call_api';
  RAISE NOTICE 'PASS 049 re-run order';
END $$;
