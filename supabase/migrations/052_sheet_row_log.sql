-- ============================================================
-- 052 — "On New Row Google Sheet": one record per row the trigger saw.
--
-- Additive and safe to run twice. Run after 051.
--
-- Before a row starts its flow, the poller inserts its key here; a
-- duplicate key means the row was already handled (a retry after a
-- crash, or two overlapping cron calls), so it never starts twice.
-- The same rows explain what happened to each row on the trigger card
-- (started / skipped and why).
--
-- row_key = sha256(spreadsheet id | tab id | row number | row content):
-- an edited row at the same position is a different key, but rows above
-- the cursor are never re-read, so editing old rows does not re-fire.
-- ============================================================

CREATE TABLE IF NOT EXISTS google_sheet_row_log (
  id BIGSERIAL PRIMARY KEY,
  flow_id UUID NOT NULL REFERENCES flows(id) ON DELETE CASCADE,
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  row_number INTEGER NOT NULL CHECK (row_number > 0),
  row_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('started', 'skipped', 'failed')),
  -- Why a row was skipped / failed (no phone, bad number, …). No row data.
  detail TEXT,
  contact_id UUID REFERENCES contacts(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (flow_id, row_key)
);
CREATE INDEX IF NOT EXISTS idx_google_sheet_row_log_flow ON google_sheet_row_log(flow_id, created_at DESC);

ALTER TABLE google_sheet_row_log ENABLE ROW LEVEL SECURITY;
-- Members may read their account's row history; writes are server-only.
DROP POLICY IF EXISTS google_sheet_row_log_select ON google_sheet_row_log;
CREATE POLICY google_sheet_row_log_select ON google_sheet_row_log
  FOR SELECT USING (is_account_member(account_id));
