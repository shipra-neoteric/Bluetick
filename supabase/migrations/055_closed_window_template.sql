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
