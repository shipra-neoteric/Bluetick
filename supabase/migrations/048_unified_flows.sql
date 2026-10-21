-- ============================================================
-- 048 — One "Flow": Flows take over every Automation trigger and action.
--
-- Additive and safe to run twice. Assumes 047 is applied.
--
--   1. flows.trigger_type accepts every automation trigger (event flows).
--   2. flow_nodes.node_type adds time_delay, wait_until and action
--      (`action` runs any automation step through the shared executor).
--   3. Background runs: a run only holds the contact's single
--      "conversation" slot (`exclusive`) while it waits for a reply, so
--      event flows and delays never block — or get blocked by — a chat bot.
--   4. Delayed runs: resume_at + lease, claimed by claim_flow_resumes().
--   5. Conversion bookkeeping: flows.source_automation_id and
--      automations.converted_flow_id (idempotent "convert" button).
--   6. The event outbox also records events that only a flow listens for.
--   7. Inbound webhook URLs for flows (flow_webhooks + receipts).
-- ============================================================

-- 1. Flow triggers ----------------------------------------------------
DO $$
DECLARE c TEXT;
BEGIN
  FOR c IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'public.flows'::regclass AND contype = 'c'
      AND pg_get_constraintdef(oid) ILIKE '%trigger_type%'
  LOOP
    EXECUTE format('ALTER TABLE flows DROP CONSTRAINT %I', c);
  END LOOP;
END $$;
ALTER TABLE flows ADD CONSTRAINT flows_trigger_type_check CHECK (trigger_type IN (
  'keyword', 'first_inbound_message', 'manual',
  'new_message_received', 'new_contact_created', 'conversation_assigned',
  'tag_added', 'time_based', 'interactive_reply',
  'conversation_opened', 'conversation_closed', 'contact_field_changed',
  'first_daily_message', 'no_keyword_match', 'ctwa_message',
  'template_delivered', 'sla_breached', 'incoming_webhook'
)) NOT VALID;  -- new/edited flows only; never blocks on an existing row

-- 2. Flow node types (superset of 047) --------------------------------
-- Skipped when a later migration (049+) already allows more types, so a
-- re-run never narrows the list under existing steps.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'flow_nodes_node_type_check'
      AND conrelid = 'public.flow_nodes'::regclass
      AND pg_get_constraintdef(oid) LIKE '%call_api%'
  ) THEN
    RETURN;
  END IF;
  ALTER TABLE flow_nodes DROP CONSTRAINT IF EXISTS flow_nodes_node_type_check;
  -- NOT VALID: checks new and edited steps only; existing rows are kept.
  ALTER TABLE flow_nodes ADD CONSTRAINT flow_nodes_node_type_check CHECK (node_type IN (
    'start', 'send_buttons', 'send_list', 'send_message', 'collect_input',
    'condition', 'set_tag', 'handoff', 'http_fetch', 'end', 'send_media',
    'send_location', 'send_template', 'assign_agent', 'set_field',
    'working_hours', 'opt_out', 'format_value', 'ai_reply',
    'time_delay', 'wait_until', 'action'
  )) NOT VALID;
END $$;

-- 3 + 4. Background and delayed runs ---------------------------------
ALTER TABLE flow_runs
  ADD COLUMN IF NOT EXISTS exclusive BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS resume_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS resume_locked_until TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS resume_attempts INTEGER NOT NULL DEFAULT 0;

-- Only runs that hold the conversation are limited to one per contact.
-- Existing rows default to exclusive = true, so nothing changes for them.
DROP INDEX IF EXISTS idx_one_active_run_per_contact;
CREATE UNIQUE INDEX IF NOT EXISTS idx_one_active_run_per_contact
  ON flow_runs(account_id, contact_id)
  WHERE status = 'active' AND exclusive;

CREATE INDEX IF NOT EXISTS idx_flow_runs_resume_due
  ON flow_runs(resume_at)
  WHERE status = 'active' AND resume_at IS NOT NULL;

-- Claims due delayed runs (and runs whose worker died mid-resume, once
-- their lease expires). Gives up after 5 attempts.
CREATE OR REPLACE FUNCTION claim_flow_resumes(
  p_limit INTEGER DEFAULT 50,
  p_lease_seconds INTEGER DEFAULT 120
) RETURNS SETOF flow_runs LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  RETURN QUERY
  UPDATE flow_runs r
  SET resume_locked_until = NOW() + make_interval(secs => p_lease_seconds),
      resume_attempts = r.resume_attempts + 1
  WHERE r.id IN (
    SELECT id FROM flow_runs
    WHERE status = 'active'
      AND resume_at IS NOT NULL
      AND resume_at <= NOW()
      AND (resume_locked_until IS NULL OR resume_locked_until < NOW())
      AND resume_attempts < 5
    ORDER BY resume_at
    LIMIT p_limit
    FOR UPDATE SKIP LOCKED
  )
  RETURNING r.*;
END;
$$;
REVOKE ALL ON FUNCTION claim_flow_resumes(INTEGER, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION claim_flow_resumes(INTEGER, INTEGER) TO service_role;

-- 5. Conversion bookkeeping ------------------------------------------
ALTER TABLE flows
  ADD COLUMN IF NOT EXISTS source_automation_id UUID REFERENCES automations(id) ON DELETE SET NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_flows_source_automation
  ON flows(source_automation_id) WHERE source_automation_id IS NOT NULL;
ALTER TABLE automations
  ADD COLUMN IF NOT EXISTS converted_flow_id UUID REFERENCES flows(id) ON DELETE SET NULL;

-- 6. Event outbox: a listening flow counts too ------------------------
CREATE OR REPLACE FUNCTION enqueue_automation_event(
  p_account UUID, p_type TEXT, p_contact UUID, p_conversation UUID, p_payload JSONB
) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF p_account IS NULL OR p_contact IS NULL THEN RETURN; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM automations
    WHERE account_id = p_account AND is_active AND trigger_type = p_type
  ) AND NOT EXISTS (
    SELECT 1 FROM flows
    WHERE account_id = p_account AND status = 'active' AND trigger_type = p_type
  ) THEN RETURN; END IF;
  INSERT INTO automation_events (account_id, event_type, contact_id, conversation_id, payload)
  VALUES (p_account, p_type, p_contact, p_conversation, COALESCE(p_payload, '{}'::jsonb));
END;
$$;
REVOKE ALL ON FUNCTION enqueue_automation_event(UUID, TEXT, UUID, UUID, JSONB) FROM PUBLIC, anon, authenticated;

-- 7. Inbound webhook URLs for flows -----------------------------------
CREATE TABLE IF NOT EXISTS flow_webhooks (
  flow_id UUID PRIMARY KEY REFERENCES flows(id) ON DELETE CASCADE,
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  token_encrypted TEXT NOT NULL,
  capture_until TIMESTAMPTZ,
  last_sample JSONB,
  last_sample_at TIMESTAMPTZ,
  created_by UUID,
  rotated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE flow_webhooks ENABLE ROW LEVEL SECURITY;  -- service role only

CREATE TABLE IF NOT EXISTS flow_webhook_receipts (
  flow_id UUID NOT NULL REFERENCES flows(id) ON DELETE CASCADE,
  dedupe_key TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (flow_id, dedupe_key)
);
ALTER TABLE flow_webhook_receipts ENABLE ROW LEVEL SECURITY;  -- service role only
