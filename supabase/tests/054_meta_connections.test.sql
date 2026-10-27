-- Behaviour tests for 054_meta_connections.sql. Runs after the 044–053
-- tests on the same throwaway database (account A: owner a1; account Z:
-- owner f1). Synthetic data only.
\set ON_ERROR_STOP 1
SET client_min_messages = notice;
RESET ROLE;
CREATE TEMP TABLE fx54 AS
SELECT (SELECT account_id FROM profiles WHERE user_id = '00000000-0000-0000-0000-0000000000a1') AS acc_a;
GRANT SELECT ON fx54 TO authenticated;

-- Several Facebook users per account; the same user once per account.
INSERT INTO meta_connections (account_id, fb_user_id, fb_user_name, access_token)
VALUES ((SELECT acc_a FROM fx54), 'synthetic-fb-1', 'Synthetic One', 'enc-token-1'),
       ((SELECT acc_a FROM fx54), 'synthetic-fb-2', 'Synthetic Two', 'enc-token-2');
DO $$ BEGIN
  BEGIN
    INSERT INTO meta_connections (account_id, fb_user_id, access_token)
    VALUES ((SELECT acc_a FROM fx54), 'synthetic-fb-1', 'enc-token-x');
    RAISE EXCEPTION 'duplicate Facebook user accepted';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
  RAISE NOTICE 'PASS 054 one row per Facebook user';
END $$;
INSERT INTO meta_ad_lookup (account_id, ad_id, ad_name, adset_id, adset_name, campaign_id, campaign_name)
VALUES ((SELECT acc_a FROM fx54), '1200000000001', 'Ad', '1200000000002', 'Set', '1200000000003', 'Campaign');

-- Service role only: members (even the owner) see nothing, write nothing.
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', false);
DO $$ BEGIN
  ASSERT (SELECT count(*) FROM meta_connections) = 0, 'tokens are not readable by members';
  ASSERT (SELECT count(*) FROM meta_ad_lookup) = 0, 'lookup cache is server-only';
  BEGIN
    INSERT INTO meta_connections (account_id, fb_user_id, access_token)
    VALUES ((SELECT acc_a FROM fx54), 'synthetic-fb-3', 'enc');
    RAISE EXCEPTION 'member inserted a connection';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  RAISE NOTICE 'PASS 054 service role only';
END $$;
RESET ROLE;

\ir ../migrations/054_meta_connections.sql
DO $$ BEGIN
  ASSERT (SELECT count(*) FROM meta_connections WHERE fb_user_id LIKE 'synthetic-fb-%') = 2, 're-run keeps rows';
  RAISE NOTICE 'PASS 054 re-run';
END $$;
DELETE FROM meta_connections WHERE fb_user_id LIKE 'synthetic-fb-%';
DELETE FROM meta_ad_lookup WHERE ad_id = '1200000000001';
