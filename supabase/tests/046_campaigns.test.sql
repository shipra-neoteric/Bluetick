-- Behaviour tests for 046_campaigns.sql. Runs after 044/045 tests on the
-- same throwaway database (reuses account A fixtures). Synthetic data only.
\set ON_ERROR_STOP 1
SET client_min_messages = notice;
RESET ROLE;
-- Fixture handle (temp tables don't survive across test files).
CREATE TEMP TABLE fx AS
SELECT (SELECT account_id FROM profiles WHERE user_id = '00000000-0000-0000-0000-0000000000a1') AS acc_a;
GRANT SELECT ON fx TO authenticated;

-- Template + a template message + a broadcast to contact 3.
INSERT INTO message_templates (id, user_id, account_id, name, category, language, body_text, status)
VALUES ('80000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000a1',
        (SELECT acc_a FROM fx), 'site_visit_followup', 'Marketing', 'en', 'Hi {{1}}', 'APPROVED');
INSERT INTO messages (conversation_id, sender_type, content_type, content_text, template_name, status, message_id)
VALUES ('20000000-0000-0000-0000-000000000001', 'agent', 'template', 'Hi', 'site_visit_followup', 'sent', 'wamid.TPL1');

INSERT INTO broadcasts (id, user_id, account_id, name, template_name, template_language, status, scheduled_at, audience_tag_id)
VALUES ('90000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000a1', (SELECT acc_a FROM fx),
        'Due campaign', 'site_visit_followup', 'en', 'scheduled', NOW() - interval '1 minute',
        '40000000-0000-0000-0000-000000000001'),
       ('90000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-0000000000a1', (SELECT acc_a FROM fx),
        'Future campaign', 'site_visit_followup', 'en', 'scheduled', NOW() + interval '1 day', NULL);
INSERT INTO broadcast_recipients (broadcast_id, contact_id, status, sent_at)
VALUES ('90000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000003', 'sent', NOW() - interval '5 minutes');

DO $$
BEGIN
  ASSERT (SELECT last_used_at FROM message_templates WHERE id = '80000000-0000-0000-0000-000000000001') IS NOT NULL,
    'template last_used_at set by an agent template message';
  ASSERT (SELECT created_by FROM message_templates WHERE id = '80000000-0000-0000-0000-000000000001') IS NOT NULL,
    'created_by backfilled';
END $$;

-- Scheduled claim: due one claimed exactly once; future one untouched.
DO $$
DECLARE a INTEGER; b INTEGER;
BEGIN
  SELECT COUNT(*) INTO a FROM claim_due_scheduled_broadcasts(10);
  SELECT COUNT(*) INTO b FROM claim_due_scheduled_broadcasts(10);
  ASSERT a = 1 AND b = 0, 'due broadcast claimed once (a=' || a || ', b=' || b || ')';
  ASSERT (SELECT status FROM broadcasts WHERE id = '90000000-0000-0000-0000-000000000001') = 'sending', 'claimed → sending';
  ASSERT (SELECT delivery_locked_at FROM broadcasts WHERE id = '90000000-0000-0000-0000-000000000001') IS NOT NULL, 'lock taken';
  ASSERT (SELECT status FROM broadcasts WHERE id = '90000000-0000-0000-0000-000000000002') = 'scheduled', 'future untouched';
  RAISE NOTICE 'PASS 046 scheduled claim';
END $$;

-- A broadcast held for template approval is re-checked every 10 min, not every tick.
INSERT INTO broadcasts (id, user_id, account_id, name, template_name, template_language, status, scheduled_at, hold_reason, hold_checked_at)
VALUES ('90000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-0000000000a1', (SELECT acc_a FROM fx),
        'Held campaign', 'site_visit_followup', 'en', 'scheduled', NOW() - interval '1 hour', 'template_not_approved', NOW());
DO $$ BEGIN
  ASSERT (SELECT COUNT(*) FROM claim_due_scheduled_broadcasts(10)) = 0, 'recently held broadcast not re-claimed';
  UPDATE broadcasts SET hold_checked_at = NOW() - interval '11 minutes' WHERE id = '90000000-0000-0000-0000-000000000003';
  ASSERT (SELECT COUNT(*) FROM claim_due_scheduled_broadcasts(10)) = 1, 'held broadcast re-checked after 10 minutes';
  ASSERT (SELECT hold_reason FROM broadcasts WHERE id = '90000000-0000-0000-0000-000000000003') IS NULL, 'claim clears hold';
  RAISE NOTICE 'PASS 046 hold backoff';
END $$;

-- Members can't claim; cancel only while scheduled.
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000b1', false);
DO $$ BEGIN
  BEGIN
    PERFORM * FROM claim_due_scheduled_broadcasts(1);
    RAISE EXCEPTION 'members must not claim';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    UPDATE broadcasts SET status = 'canceled' WHERE id = '90000000-0000-0000-0000-000000000001';
    RAISE EXCEPTION 'a sending broadcast must not be cancelable';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  UPDATE broadcasts SET status = 'canceled' WHERE id = '90000000-0000-0000-0000-000000000002';
  ASSERT (SELECT canceled_by FROM broadcasts WHERE id = '90000000-0000-0000-0000-000000000002') = auth.uid(), 'canceler recorded';
  RAISE NOTICE 'PASS 046 cancel guard';
END $$;

-- customer_page: tag filter, derived activity, unknown stays NULL.
DO $$
DECLARE r RECORD; n INTEGER;
BEGIN
  SELECT COUNT(*) INTO n FROM customer_page(NULL, NULL, 'created_desc', 50, 0);
  ASSERT n = 3, 'own tenant only (got ' || n || ')';
  SELECT * INTO r FROM customer_page('40000000-0000-0000-0000-000000000001', NULL, 'created_desc', 50, 0);
  ASSERT (r.contact->>'id') = '10000000-0000-0000-0000-000000000003', 'segment filter';
  ASSERT r.total_count = 1, 'segment count';
  ASSERT r.last_template_sent_at IS NOT NULL, 'broadcast send counts as last template sent';
  ASSERT r.first_message_received_at IS NULL, 'no inbound → unknown, not a date';
  SELECT * INTO r FROM customer_page(NULL, 'synthetic one', 'created_desc', 50, 0);
  ASSERT r.first_message_received_at IS NOT NULL AND r.last_message_sent_at IS NOT NULL, 'derived from messages';
  ASSERT r.ticket_replied, 'human reply recorded';
  RAISE NOTICE 'PASS 046 customer_page';
END $$;

-- View preferences are per user.
INSERT INTO user_view_preferences (user_id, account_id, view_key, prefs)
VALUES (auth.uid(), (SELECT acc_a FROM fx), 'customers.columns', '{"visible":["phone"]}');
SELECT set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', false);
DO $$ BEGIN
  ASSERT (SELECT COUNT(*) FROM user_view_preferences) = 0, 'another user cannot read my prefs';
  ASSERT (SELECT COUNT(*) FROM ads_integrations) = 0, 'ads credentials invisible to clients';
  RAISE NOTICE 'PASS 046 prefs + ads isolation';
END $$;
RESET ROLE;

-- Referral replay is deduplicated.
INSERT INTO message_referrals (account_id, contact_id, wa_message_id, source_type, source_id)
VALUES ((SELECT acc_a FROM fx), '10000000-0000-0000-0000-000000000001', 'wamid.REF1', 'ad', 'AD-1');
DO $$ BEGIN
  BEGIN
    INSERT INTO message_referrals (account_id, contact_id, wa_message_id, source_type, source_id)
    VALUES ((SELECT acc_a FROM fx), '10000000-0000-0000-0000-000000000001', 'wamid.REF1', 'ad', 'AD-1');
    RAISE EXCEPTION 'replayed referral must be rejected';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
  RAISE NOTICE 'PASS 046 referral dedupe';
END $$;
