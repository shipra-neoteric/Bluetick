-- Behaviour tests for 052_sheet_row_log.sql. Runs after the 044–051 tests
-- on the same throwaway database (account A: owner a1; account Z: owner f1).
-- Synthetic data only.
\set ON_ERROR_STOP 1
SET client_min_messages = notice;
RESET ROLE;
CREATE TEMP TABLE fx52 AS
SELECT (SELECT account_id FROM profiles WHERE user_id = '00000000-0000-0000-0000-0000000000a1') AS acc_a;
GRANT SELECT ON fx52 TO authenticated;

INSERT INTO flows (id, user_id, account_id, name, status, trigger_type, trigger_config) VALUES
  ('f0520000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000a1', (SELECT acc_a FROM fx52),
   'sheet rows', 'active', 'google_sheet_new_row', '{"spreadsheet_id":"synthetic-sheet-id-000000","sheet_name":"Leads","phone_column":"Phone"}');

-- A row key can be claimed once per flow: a retry is a unique violation.
INSERT INTO google_sheet_row_log (flow_id, account_id, row_number, row_key, status)
VALUES ('f0520000-0000-0000-0000-000000000001', (SELECT acc_a FROM fx52), 2, 'key-row-2', 'started');
DO $$ BEGIN
  BEGIN
    INSERT INTO google_sheet_row_log (flow_id, account_id, row_number, row_key, status)
    VALUES ('f0520000-0000-0000-0000-000000000001', (SELECT acc_a FROM fx52), 2, 'key-row-2', 'started');
    RAISE EXCEPTION 'duplicate row key accepted';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO google_sheet_row_log (flow_id, account_id, row_number, row_key, status)
    VALUES ('f0520000-0000-0000-0000-000000000001', (SELECT acc_a FROM fx52), 3, 'key-row-3', 'sent');
    RAISE EXCEPTION 'unknown status accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  RAISE NOTICE 'PASS 052 idempotent claim';
END $$;
INSERT INTO google_sheet_row_log (flow_id, account_id, row_number, row_key, status, detail)
VALUES ('f0520000-0000-0000-0000-000000000001', (SELECT acc_a FROM fx52), 3, 'key-row-3', 'skipped', 'no phone number in this row');

SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', false);
DO $$ BEGIN
  ASSERT (SELECT count(*) FROM google_sheet_row_log) = 2, 'member reads the row history';
  BEGIN
    DELETE FROM google_sheet_row_log;
    ASSERT NOT FOUND, 'members cannot delete the history';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  RAISE NOTICE 'PASS 052 member read-only';
END $$;
SELECT set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000f1', false);
DO $$ BEGIN
  ASSERT (SELECT count(*) FROM google_sheet_row_log) = 0, 'other account sees nothing';
  RAISE NOTICE 'PASS 052 tenant isolation';
END $$;
RESET ROLE;

\ir ../migrations/052_sheet_row_log.sql
DELETE FROM flows WHERE id = 'f0520000-0000-0000-0000-000000000001';
DO $$ BEGIN
  ASSERT (SELECT count(*) FROM google_sheet_row_log) = 0, 'history removed with its flow';
  RAISE NOTICE 'PASS 052 re-run + cascade';
END $$;
