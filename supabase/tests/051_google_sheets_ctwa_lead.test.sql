-- Behaviour tests for 051_google_sheets_ctwa_lead.sql. Runs after the 044–050
-- tests on the same throwaway database (account A: owner a1, agent b1,
-- viewer c1; account Z: owner f1). Synthetic data only.
\set ON_ERROR_STOP 1
SET client_min_messages = notice;
RESET ROLE;
CREATE TEMP TABLE fx51 AS
SELECT (SELECT account_id FROM profiles WHERE user_id = '00000000-0000-0000-0000-0000000000a1') AS acc_a,
       (SELECT account_id FROM profiles WHERE user_id = '00000000-0000-0000-0000-0000000000f1') AS acc_z;
GRANT SELECT ON fx51 TO authenticated;

-- New triggers and the Add Row step are accepted.
INSERT INTO flows (id, user_id, account_id, name, status, trigger_type, trigger_config, entry_node_id) VALUES
  ('f0510000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000a1', (SELECT acc_a FROM fx51),
   'sheet leads', 'active', 'google_sheet_new_row',
   '{"spreadsheet_id":"synthetic-sheet-id-000000","sheet_name":"Leads","phone_column":"Phone"}', 'g1'),
  ('f0510000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-0000000000a1', (SELECT acc_a FROM fx51),
   'ad leads', 'active', 'ctwa_lead', '{"lead_mode":"new_contact"}', null);
INSERT INTO flow_nodes (flow_id, node_key, node_type, config) VALUES
  ('f0510000-0000-0000-0000-000000000001', 'g1', 'google_sheets',
   '{"spreadsheet_id":"synthetic-sheet-id-000000","sheet_name":"Leads","columns":[{"column":"Name","value":"{{contact.name}}"}]}');

DO $$ BEGIN
  BEGIN
    INSERT INTO flows (user_id, account_id, name, trigger_type)
    VALUES ('00000000-0000-0000-0000-0000000000a1', (SELECT acc_a FROM fx51), 'bad', 'not_a_trigger');
    RAISE EXCEPTION 'unknown trigger accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  RAISE NOTICE 'PASS 051 triggers and node';
END $$;

-- Connections: server only. Watches: members of the account may read.
INSERT INTO google_connections (account_id, google_email, refresh_token)
VALUES ((SELECT acc_a FROM fx51), 'sheets@test.invalid', 'ciphertext-synthetic');
INSERT INTO google_sheet_watches (flow_id, account_id, spreadsheet_id, sheet_name, last_row)
VALUES ('f0510000-0000-0000-0000-000000000001', (SELECT acc_a FROM fx51), 'synthetic-sheet-id-000000', 'Leads', 4);

SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', false);
DO $$ BEGIN
  ASSERT (SELECT count(*) FROM google_connections) = 0, 'owner cannot read tokens directly';
  ASSERT (SELECT count(*) FROM google_sheet_watches) = 1, 'member sees the watch status';
  BEGIN
    UPDATE google_sheet_watches SET last_row = 0;
    ASSERT NOT FOUND, 'members cannot move the cursor';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  RAISE NOTICE 'PASS 051 owner access';
END $$;
SELECT set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000f1', false);
DO $$ BEGIN
  ASSERT (SELECT count(*) FROM google_sheet_watches) = 0, 'other account sees nothing';
  RAISE NOTICE 'PASS 051 tenant isolation';
END $$;
RESET ROLE;

DO $$ BEGIN
  BEGIN
    UPDATE google_sheet_watches SET last_row = -1;
    RAISE EXCEPTION 'negative cursor accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  RAISE NOTICE 'PASS 051 cursor check';
END $$;

-- Re-running older migrations never narrows the lists again.
\ir ../migrations/047_bot_studio.sql
\ir ../migrations/048_unified_flows.sql
\ir ../migrations/049_call_api.sql
\ir ../migrations/051_google_sheets_ctwa_lead.sql
DO $$ BEGIN
  ASSERT (SELECT pg_get_constraintdef(oid) LIKE '%google_sheets%' FROM pg_constraint WHERE conname = 'flow_nodes_node_type_check'),
    're-runs keep google_sheets';
  ASSERT (SELECT pg_get_constraintdef(oid) LIKE '%ctwa_lead%' FROM pg_constraint WHERE conname = 'flows_trigger_type_check'),
    're-runs keep ctwa_lead';
  RAISE NOTICE 'PASS 051 re-run order';
END $$;

-- Deleting a flow drops its cursor.
DELETE FROM flows WHERE id = 'f0510000-0000-0000-0000-000000000001';
DO $$ BEGIN
  ASSERT (SELECT count(*) FROM google_sheet_watches) = 0, 'watch removed with its flow';
  RAISE NOTICE 'PASS 051 cascade';
END $$;
