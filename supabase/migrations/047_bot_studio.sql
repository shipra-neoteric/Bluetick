-- ============================================================
-- 047 — Bot Studio upgrade (Flows / Automations / AI), additive only.
--
-- Run AFTER 044, 045 and 046. Safe to re-run. Nothing is dropped,
-- no enum value is removed, existing rows keep their behaviour:
--
--   1. Flow versions: publishing snapshots a flow; new runs pin to the
--      snapshot, so editing an active flow no longer changes live
--      conversations until "Publish". Flows published before this
--      migration have no snapshot and keep running from live nodes.
--   2. New Flow node types (location, template, assign agent, set
--      field, working hours, opt-out, format value, AI reply).
--   3. Automation wait resumes: lease + reclaim of crashed workers.
--   4. Automation event outbox, filled by triggers on real committed
--      transitions (assigned, opened, closed, field changed) and
--      drained by the automations cron.
--   5. Atomic round-robin cursor.
--   6. First-daily-message ledger, SLA breach marker, business hours.
--   7. Inbound automation webhooks (token hash only, capture sample,
--      replay ledger) — service role only.
--   8. ai_usage_log mode 'flow' for the explicit Flow AI node.
-- ============================================================

-- 1. Flow versions ---------------------------------------------------
CREATE TABLE IF NOT EXISTS flow_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  flow_id UUID NOT NULL REFERENCES flows(id) ON DELETE CASCADE,
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  version INTEGER NOT NULL CHECK (version > 0),
  entry_node_id TEXT,
  trigger_type TEXT NOT NULL,
  trigger_config JSONB NOT NULL DEFAULT '{}'::jsonb,
  fallback_policy JSONB,
  -- [{node_key, node_type, config, position_x, position_y}, …]
  nodes JSONB NOT NULL,
  published_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (flow_id, version)
);
ALTER TABLE flow_versions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS flow_versions_select ON flow_versions;
CREATE POLICY flow_versions_select ON flow_versions
  FOR SELECT USING (is_account_member(account_id));
-- Writes only through the publish API (service role).

ALTER TABLE flows
  ADD COLUMN IF NOT EXISTS published_version INTEGER,
  ADD COLUMN IF NOT EXISTS has_unpublished_changes BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE flow_runs
  ADD COLUMN IF NOT EXISTS flow_version INTEGER;

-- 2. Flow node types (superset of 010 + 016) -------------------------
-- Skipped when a later migration (048+) already allows more types, so
-- re-running 047 never narrows the list under existing steps.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'flow_nodes_node_type_check'
      AND conrelid = 'public.flow_nodes'::regclass
      AND pg_get_constraintdef(oid) LIKE '%time_delay%'
  ) THEN
    RETURN;
  END IF;
  ALTER TABLE flow_nodes DROP CONSTRAINT IF EXISTS flow_nodes_node_type_check;
  -- NOT VALID: checks new and edited steps only; existing rows are kept.
  ALTER TABLE flow_nodes ADD CONSTRAINT flow_nodes_node_type_check CHECK (node_type IN (
    'start', 'send_buttons', 'send_list', 'send_message', 'collect_input',
    'condition', 'set_tag', 'handoff', 'http_fetch', 'end', 'send_media',
    'send_location', 'send_template', 'assign_agent', 'set_field',
    'working_hours', 'opt_out', 'format_value', 'ai_reply'
  )) NOT VALID;
END $$;

-- 3. Automation wait resumes: lease + reclaim ------------------------
ALTER TABLE automation_pending_executions
  ADD COLUMN IF NOT EXISTS locked_until TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS attempts INTEGER NOT NULL DEFAULT 0;

-- Claims due rows (and rows whose worker died: 'running' past its
-- lease). SKIP LOCKED: concurrent crons never take the same row.
CREATE OR REPLACE FUNCTION claim_automation_pending(
  p_limit INTEGER DEFAULT 50,
  p_lease_seconds INTEGER DEFAULT 300
) RETURNS SETOF automation_pending_executions
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  WITH due AS (
    SELECT id FROM automation_pending_executions
    WHERE attempts < 5
      AND (
        (status = 'pending' AND run_at <= NOW())
        OR (status = 'running' AND locked_until IS NOT NULL AND locked_until < NOW())
      )
    ORDER BY run_at
    LIMIT GREATEST(1, LEAST(p_limit, 200))
    FOR UPDATE SKIP LOCKED
  )
  UPDATE automation_pending_executions p
  SET status = 'running',
      locked_until = NOW() + make_interval(secs => GREATEST(30, p_lease_seconds)),
      attempts = p.attempts + 1
  FROM due WHERE p.id = due.id
  RETURNING p.*;
$$;
REVOKE ALL ON FUNCTION claim_automation_pending(INTEGER, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION claim_automation_pending(INTEGER, INTEGER) TO service_role;

-- 4. Automation event outbox -----------------------------------------
CREATE TABLE IF NOT EXISTS automation_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  contact_id UUID REFERENCES contacts(id) ON DELETE CASCADE,
  conversation_id UUID REFERENCES conversations(id) ON DELETE SET NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'done', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  locked_until TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_automation_events_pending
  ON automation_events (created_at) WHERE status IN ('pending', 'running');
ALTER TABLE automation_events ENABLE ROW LEVEL SECURITY;  -- service role only

-- Only record an event when some active automation listens for it, so
-- the outbox doesn't fill up for accounts that don't use the trigger.
CREATE OR REPLACE FUNCTION enqueue_automation_event(
  p_account UUID, p_type TEXT, p_contact UUID, p_conversation UUID, p_payload JSONB
) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF p_account IS NULL OR p_contact IS NULL THEN RETURN; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM automations
    WHERE account_id = p_account AND is_active AND trigger_type = p_type
  ) THEN RETURN; END IF;
  INSERT INTO automation_events (account_id, event_type, contact_id, conversation_id, payload)
  VALUES (p_account, p_type, p_contact, p_conversation, COALESCE(p_payload, '{}'::jsonb));
END;
$$;
REVOKE ALL ON FUNCTION enqueue_automation_event(UUID, TEXT, UUID, UUID, JSONB) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION conversations_emit_automation_events()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM enqueue_automation_event(NEW.account_id, 'conversation_opened', NEW.contact_id, NEW.id,
      jsonb_build_object('previous_status', NULL, 'status', NEW.status));
    IF NEW.assigned_agent_id IS NOT NULL THEN
      PERFORM enqueue_automation_event(NEW.account_id, 'conversation_assigned', NEW.contact_id, NEW.id,
        jsonb_build_object('agent_id', NEW.assigned_agent_id, 'previous_agent_id', NULL));
    END IF;
    RETURN NEW;
  END IF;
  -- Real transitions only — no-op writes emit nothing.
  IF NEW.assigned_agent_id IS DISTINCT FROM OLD.assigned_agent_id AND NEW.assigned_agent_id IS NOT NULL THEN
    PERFORM enqueue_automation_event(NEW.account_id, 'conversation_assigned', NEW.contact_id, NEW.id,
      jsonb_build_object('agent_id', NEW.assigned_agent_id, 'previous_agent_id', OLD.assigned_agent_id));
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NEW.status = 'closed' THEN
      PERFORM enqueue_automation_event(NEW.account_id, 'conversation_closed', NEW.contact_id, NEW.id,
        jsonb_build_object('previous_status', OLD.status, 'status', NEW.status));
    ELSIF OLD.status = 'closed' THEN
      PERFORM enqueue_automation_event(NEW.account_id, 'conversation_opened', NEW.contact_id, NEW.id,
        jsonb_build_object('previous_status', OLD.status, 'status', NEW.status));
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS conversations_automation_events ON conversations;
CREATE TRIGGER conversations_automation_events
  AFTER INSERT OR UPDATE OF status, assigned_agent_id ON conversations
  FOR EACH ROW EXECUTE FUNCTION conversations_emit_automation_events();

CREATE OR REPLACE FUNCTION contacts_emit_field_events()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE f TEXT;
BEGIN
  FOREACH f IN ARRAY ARRAY['name', 'email', 'company'] LOOP
    IF (to_jsonb(NEW) ->> f) IS DISTINCT FROM (to_jsonb(OLD) ->> f) THEN
      PERFORM enqueue_automation_event(NEW.account_id, 'contact_field_changed', NEW.id, NULL,
        jsonb_build_object('field', f, 'old_value', to_jsonb(OLD) ->> f, 'new_value', to_jsonb(NEW) ->> f));
    END IF;
  END LOOP;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS contacts_field_events ON contacts;
CREATE TRIGGER contacts_field_events
  AFTER UPDATE OF name, email, company ON contacts
  FOR EACH ROW EXECUTE FUNCTION contacts_emit_field_events();

CREATE OR REPLACE FUNCTION custom_values_emit_field_events()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_account UUID; v_old TEXT;
BEGIN
  v_old := CASE WHEN TG_OP = 'UPDATE' THEN OLD.value ELSE NULL END;
  IF NEW.value IS NOT DISTINCT FROM v_old THEN RETURN NEW; END IF;
  SELECT account_id INTO v_account FROM contacts WHERE id = NEW.contact_id;
  PERFORM enqueue_automation_event(v_account, 'contact_field_changed', NEW.contact_id, NULL,
    jsonb_build_object('field', 'custom:' || NEW.custom_field_id, 'old_value', v_old, 'new_value', NEW.value));
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS custom_values_field_events ON contact_custom_values;
CREATE TRIGGER custom_values_field_events
  AFTER INSERT OR UPDATE OF value ON contact_custom_values
  FOR EACH ROW EXECUTE FUNCTION custom_values_emit_field_events();

CREATE OR REPLACE FUNCTION claim_automation_events(
  p_limit INTEGER DEFAULT 50, p_lease_seconds INTEGER DEFAULT 120
) RETURNS SETOF automation_events
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  WITH due AS (
    SELECT id FROM automation_events
    WHERE attempts < 3
      AND (status = 'pending' OR (status = 'running' AND locked_until < NOW()))
    ORDER BY created_at
    LIMIT GREATEST(1, LEAST(p_limit, 200))
    FOR UPDATE SKIP LOCKED
  )
  UPDATE automation_events e
  SET status = 'running',
      locked_until = NOW() + make_interval(secs => GREATEST(30, p_lease_seconds)),
      attempts = e.attempts + 1
  FROM due WHERE e.id = due.id
  RETURNING e.*;
$$;
REVOKE ALL ON FUNCTION claim_automation_events(INTEGER, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION claim_automation_events(INTEGER, INTEGER) TO service_role;

-- 5. Atomic round-robin ----------------------------------------------
CREATE TABLE IF NOT EXISTS round_robin_cursors (
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  pool_key TEXT NOT NULL,
  last_user_id UUID,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (account_id, pool_key)
);
ALTER TABLE round_robin_cursors ENABLE ROW LEVEL SECURITY;  -- service role only

-- Next eligible agent after the cursor. Eligible = in the pool (or any
-- owner/admin/agent when the pool is empty) AND still an active agent of
-- the account. The cursor row is locked, so concurrent assignments
-- rotate instead of colliding. Returns NULL when nobody is eligible.
CREATE OR REPLACE FUNCTION next_round_robin_agent(
  p_account UUID, p_pool_key TEXT, p_pool UUID[]
) RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_last UUID; v_next UUID;
BEGIN
  INSERT INTO round_robin_cursors (account_id, pool_key) VALUES (p_account, p_pool_key)
  ON CONFLICT DO NOTHING;
  SELECT last_user_id INTO v_last FROM round_robin_cursors
  WHERE account_id = p_account AND pool_key = p_pool_key FOR UPDATE;

  WITH eligible AS (
    SELECT p.user_id FROM profiles p
    WHERE p.account_id = p_account
      AND p.account_role IN ('owner', 'admin', 'agent')
      AND (COALESCE(array_length(p_pool, 1), 0) = 0 OR p.user_id = ANY (p_pool))
  )
  SELECT user_id INTO v_next FROM eligible
  ORDER BY (v_last IS NOT NULL AND user_id <= v_last), user_id
  LIMIT 1;

  IF v_next IS NOT NULL THEN
    UPDATE round_robin_cursors SET last_user_id = v_next, updated_at = NOW()
    WHERE account_id = p_account AND pool_key = p_pool_key;
  END IF;
  RETURN v_next;
END;
$$;
REVOKE ALL ON FUNCTION next_round_robin_agent(UUID, TEXT, UUID[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION next_round_robin_agent(UUID, TEXT, UUID[]) TO service_role;

-- 6. First daily message, SLA breach, business hours ------------------
CREATE TABLE IF NOT EXISTS contact_daily_firsts (
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  contact_id UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  day DATE NOT NULL,           -- calendar day in the account's inbox timezone
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (account_id, contact_id, day)
);
ALTER TABLE contact_daily_firsts ENABLE ROW LEVEL SECURITY;  -- service role only

ALTER TABLE conversations ADD COLUMN IF NOT EXISTS sla_breached_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS business_hours (
  account_id UUID PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  timezone TEXT NOT NULL DEFAULT 'Asia/Kolkata',
  -- {"mon":[["09:00","18:00"]], "tue":[…], …}; a missing/empty day = closed
  schedule JSONB NOT NULL DEFAULT '{"mon":[["09:00","18:00"]],"tue":[["09:00","18:00"]],"wed":[["09:00","18:00"]],"thu":[["09:00","18:00"]],"fri":[["09:00","18:00"]],"sat":[["09:00","18:00"]]}'::jsonb,
  -- ["2026-10-20", …] — whole days treated as outside working hours
  holidays JSONB NOT NULL DEFAULT '[]'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by UUID
);
ALTER TABLE business_hours ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS business_hours_select ON business_hours;
CREATE POLICY business_hours_select ON business_hours
  FOR SELECT USING (is_account_member(account_id));
DROP POLICY IF EXISTS business_hours_write ON business_hours;
CREATE POLICY business_hours_write ON business_hours
  FOR ALL USING (is_account_member(account_id, 'admin'))
  WITH CHECK (is_account_member(account_id, 'admin'));

-- 7. Inbound automation webhooks -------------------------------------
CREATE TABLE IF NOT EXISTS automation_webhooks (
  automation_id UUID PRIMARY KEY REFERENCES automations(id) ON DELETE CASCADE,
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,   -- sha256 of the URL token (lookup key)
  token_encrypted TEXT NOT NULL,     -- encrypted with ENCRYPTION_KEY, to show the URL again
  capture_until TIMESTAMPTZ,         -- while set and in the future: store a sample, do not run
  last_sample JSONB,
  last_sample_at TIMESTAMPTZ,
  created_by UUID,
  rotated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE automation_webhooks ENABLE ROW LEVEL SECURITY;  -- service role only

CREATE TABLE IF NOT EXISTS automation_webhook_receipts (
  automation_id UUID NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
  dedupe_key TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (automation_id, dedupe_key)
);
ALTER TABLE automation_webhook_receipts ENABLE ROW LEVEL SECURITY;  -- service role only

-- 8. AI usage from the explicit Flow AI node --------------------------
ALTER TABLE ai_usage_log DROP CONSTRAINT IF EXISTS ai_usage_log_mode_check;
ALTER TABLE ai_usage_log ADD CONSTRAINT ai_usage_log_mode_check
  CHECK (mode IN ('auto_reply', 'draft', 'flow'));
