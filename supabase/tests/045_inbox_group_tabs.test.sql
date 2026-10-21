-- Behaviour tests for 045_inbox_group_tabs.sql. Runs after
-- 044_inbox_parity.test.sql on the same throwaway database (reuses its
-- fixtures: account A with Alice/Bob, conversations 1–3).
\set ON_ERROR_STOP 1
SET client_min_messages = notice;
RESET ROLE;

-- Owners: contact 1 → Alice, contact 2 → Bob, contact 3 → Bob.
UPDATE contacts SET owner_user_id = '00000000-0000-0000-0000-0000000000a1' WHERE id = '10000000-0000-0000-0000-000000000001';
UPDATE contacts SET owner_user_id = '00000000-0000-0000-0000-0000000000b1'
WHERE id IN ('10000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000003');
-- Lead Status values with mixed spelling: two "Hot", one "warm".
INSERT INTO contact_custom_values (contact_id, custom_field_id, value) VALUES
  ('10000000-0000-0000-0000-000000000001', '50000000-0000-0000-0000-000000000001', 'hot - 60 days'),
  ('10000000-0000-0000-0000-000000000002', '50000000-0000-0000-0000-000000000001', 'Warm - 120 Days')
ON CONFLICT (contact_id, custom_field_id) DO UPDATE SET value = EXCLUDED.value;

SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000b1', false);
DO $$
BEGIN
  ASSERT (SELECT total FROM inbox_group_counts('owner', '{"queue":"all"}')
          WHERE group_value = '00000000-0000-0000-0000-0000000000b1') = 2, 'Bob owns two chats';
  ASSERT (SELECT COUNT(*) FROM inbox_query('{"queue":"all","owner":"00000000-0000-0000-0000-0000000000b1"}', 'newest', 50)) = 2,
    'owner filter matches the tab count';
  ASSERT (SELECT COUNT(*) FROM inbox_group_counts('50000000-0000-0000-0000-000000000001', '{"queue":"all"}')) = 2,
    'two distinct lead statuses (case-insensitive)';
  ASSERT (SELECT total FROM inbox_group_counts('50000000-0000-0000-0000-000000000001', '{"queue":"all"}')
          WHERE lower(group_value) = 'hot - 60 days') = 2, 'both Hot spellings grouped';
  ASSERT (SELECT COUNT(*) FROM inbox_group_counts('owner', '{"queue":"closed"}')) = 0,
    'tab counts respect the current queue';
  ASSERT NOT EXISTS (SELECT 1 FROM inbox_group_counts('not-a-field', '{}')), 'unknown group returns nothing';
  RAISE NOTICE 'PASS 045 group tabs';
END $$;
RESET ROLE;
