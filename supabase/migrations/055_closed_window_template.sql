-- ============================================================
-- 055 — "Send a message to customer in closed window".
--
-- Additive and safe to run twice. Run after 052 (053/054 are
-- independent of this one).
--
-- Outside WhatsApp's 24-hour window only an approved template may be
-- sent. An admin picks one template whose body has a single {{1}}; the
-- inbox composer then lets agents type the {{1}} part and sends it as
-- that template. NULL = feature off (composer shows "use a template").
-- ============================================================

ALTER TABLE inbox_settings ADD COLUMN IF NOT EXISTS closed_window_template TEXT;
ALTER TABLE inbox_settings ADD COLUMN IF NOT EXISTS closed_window_template_language TEXT;

-- The inbox list's "settings or defaults" helper (044) built the default
-- row positionally — ROW(9 values)::inbox_settings — which stops casting
-- the moment the table gains a column ("cannot cast type record to
-- inbox_settings"). Build it by column name instead: columns not named
-- here (the two above, and any added later) default to NULL.
CREATE OR REPLACE FUNCTION inbox_effective_settings(p_account UUID)
RETURNS inbox_settings LANGUAGE sql STABLE AS $$
  SELECT COALESCE(
    (SELECT s FROM inbox_settings s WHERE s.account_id = p_account),
    jsonb_populate_record(NULL::inbox_settings, jsonb_build_object(
      'account_id', p_account,
      'reopen_on_inbound', TRUE,
      'sla_enabled', FALSE,
      'sla_first_response_minutes', 15,
      'sla_next_response_minutes', 30,
      'timezone', 'Asia/Kolkata',
      'tag_selection_limit', 50,
      'updated_at', NOW()
    ))
  )
$$;
