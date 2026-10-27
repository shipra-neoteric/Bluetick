-- Behaviour tests for 053_google_multi_account.sql. Runs after the 044–052
-- tests on the same throwaway database (account A: owner a1; account Z:
-- owner f1). Synthetic data only.
\set ON_ERROR_STOP 1
SET client_min_messages = notice;
RESET ROLE;
CREATE TEMP TABLE fx53 AS
SELECT (SELECT account_id FROM profiles WHERE user_id = '00000000-0000-0000-0000-0000000000a1') AS acc_a,
       (SELECT account_id FROM profiles WHERE user_id = '00000000-0000-0000-0000-0000000000f1') AS acc_z;
GRANT SELECT ON fx53 TO authenticated;

DELETE FROM google_connections WHERE account_id IN ((SELECT acc_a FROM fx53), (SELECT acc_z FROM fx53));
INSERT INTO google_connections (account_id, google_email, refresh_token) VALUES
  ((SELECT acc_a FROM fx53), 'first@test.invalid', 'ciphertext-synthetic-1'),
  ((SELECT acc_a FROM fx53), 'second@test.invalid', 'ciphertext-synthetic-2'),
  ((SELECT acc_z FROM fx53), 'first@test.invalid', 'ciphertext-synthetic-3');

DO $$ BEGIN
  ASSERT (SELECT count(*) FROM google_connections WHERE account_id = (SELECT acc_a FROM fx53)) = 2,
    'two Google accounts on one Bluetick account';
  ASSERT (SELECT count(DISTINCT id) FROM google_connections) = (SELECT count(*) FROM google_connections),
    'every connection has its own id';
  BEGIN
    INSERT INTO google_connections (account_id, google_email, refresh_token)
    VALUES ((SELECT acc_a FROM fx53), 'second@test.invalid', 'ciphertext-synthetic-4');
    RAISE EXCEPTION 'same Google account connected twice';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
  RAISE NOTICE 'PASS 053 several accounts, one row each';
END $$;

-- Reconnecting the same Google account updates its row (the app's upsert).
INSERT INTO google_connections (account_id, google_email, refresh_token)
VALUES ((SELECT acc_a FROM fx53), 'second@test.invalid', 'ciphertext-synthetic-5')
ON CONFLICT (account_id, google_email) DO UPDATE SET refresh_token = EXCLUDED.refresh_token;
DO $$ BEGIN
  ASSERT (SELECT refresh_token FROM google_connections
          WHERE account_id = (SELECT acc_a FROM fx53) AND google_email = 'second@test.invalid') = 'ciphertext-synthetic-5',
    'reconnect replaces the token';
  RAISE NOTICE 'PASS 053 upsert';
END $$;

SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', false);
DO $$ BEGIN
  ASSERT (SELECT count(*) FROM google_connections) = 0, 'members still cannot read tokens';
  RAISE NOTICE 'PASS 053 server only';
END $$;
RESET ROLE;

-- Re-running 051 and 053 keeps the rows, their ids and the new key.
CREATE TEMP TABLE fx53_ids AS SELECT id FROM google_connections;
\ir ../migrations/051_google_sheets_ctwa_lead.sql
\ir ../migrations/053_google_multi_account.sql
DO $$ BEGIN
  ASSERT (SELECT count(*) FROM google_connections c JOIN fx53_ids USING (id)) = (SELECT count(*) FROM fx53_ids),
    'rows and ids survive a re-run';
  ASSERT (SELECT pg_get_constraintdef(oid) FROM pg_constraint
          WHERE conrelid = 'public.google_connections'::regclass AND contype = 'p') = 'PRIMARY KEY (id)',
    'primary key is id';
  RAISE NOTICE 'PASS 053 re-run';
END $$;

DELETE FROM google_connections WHERE account_id IN ((SELECT acc_a FROM fx53), (SELECT acc_z FROM fx53));
