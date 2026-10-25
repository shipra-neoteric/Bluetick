-- ============================================================
-- 051 — Google Sheets integration + "Lead From CTWA" trigger.
--
-- Additive and safe to run twice. Run after 050.
--
--   1. google_connections: one Google account per Bluetick account
--      (OAuth, scope "spreadsheets"). Tokens are encrypted by the app
--      with ENCRYPTION_KEY. No RLS policies: only the server (service
--      role) reads or writes this table; the UI asks the API for status.
--   2. google_sheet_watches: where the "On New Row Google Sheet" trigger
--      of each flow has read up to (polled by the flows cron), with a
--      short lease so two cron calls never start the same row twice.
--   3. flows.trigger_type adds 'google_sheet_new_row' and 'ctwa_lead'.
--   4. flow_nodes.node_type adds 'google_sheets' (Add Row).
-- ============================================================

-- 1. Google account connection -----------------------------------------
CREATE TABLE IF NOT EXISTS google_connections (
  account_id UUID PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  google_email TEXT,
  -- Encrypted (AES-GCM, app side). Never returned to the browser.
  refresh_token TEXT NOT NULL,
  access_token TEXT,
  access_token_expires_at TIMESTAMPTZ,
  scope TEXT,
  -- Set when Google rejects the refresh token (revoked / expired):
  -- the UI then asks an admin to reconnect.
  last_error TEXT,
  connected_by UUID,
  connected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE google_connections ENABLE ROW LEVEL SECURITY;
-- Deliberately no policies: service role only.

-- 2. New-row trigger cursor ---------------------------------------------
CREATE TABLE IF NOT EXISTS google_sheet_watches (
  flow_id UUID PRIMARY KEY REFERENCES flows(id) ON DELETE CASCADE,
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  spreadsheet_id TEXT NOT NULL,
  sheet_name TEXT NOT NULL,
  -- Rows (header included) already seen. New rows are those below it.
  last_row INTEGER NOT NULL DEFAULT 0 CHECK (last_row >= 0),
  locked_until TIMESTAMPTZ,
  last_checked_at TIMESTAMPTZ,
  last_fired_at TIMESTAMPTZ,
  rows_fired INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_google_sheet_watches_account ON google_sheet_watches(account_id);

ALTER TABLE google_sheet_watches ENABLE ROW LEVEL SECURITY;
-- Members may read the status (no secrets here); writes are server-only.
DROP POLICY IF EXISTS google_sheet_watches_select ON google_sheet_watches;
CREATE POLICY google_sheet_watches_select ON google_sheet_watches
  FOR SELECT USING (is_account_member(account_id));

-- 3. Flow triggers (superset of 048) --------------------------------------
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
  'template_delivered', 'sla_breached', 'incoming_webhook',
  'google_sheet_new_row', 'ctwa_lead'
)) NOT VALID;

-- 4. Flow node types (superset of 049) ------------------------------------
ALTER TABLE flow_nodes DROP CONSTRAINT IF EXISTS flow_nodes_node_type_check;
ALTER TABLE flow_nodes ADD CONSTRAINT flow_nodes_node_type_check CHECK (node_type IN (
  'start', 'send_buttons', 'send_list', 'send_message', 'collect_input',
  'condition', 'set_tag', 'handoff', 'http_fetch', 'end', 'send_media',
  'send_location', 'send_template', 'assign_agent', 'set_field',
  'working_hours', 'opt_out', 'format_value', 'ai_reply',
  'time_delay', 'wait_until', 'action', 'call_api', 'google_sheets'
)) NOT VALID;
