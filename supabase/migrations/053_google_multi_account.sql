-- ============================================================
-- 053 — Several Google accounts per Bluetick account.
--
-- Additive and safe to run twice. Run after 052.
--
--   google_connections was keyed by account_id (one Google account per
--   Bluetick account). Each connection now has its own id, so a flow can
--   say which Google account it reads / writes with
--   (trigger_config.google_connection_id, google_sheets step
--   config.google_connection_id). Connecting the same Google account
--   again updates its row: unique (account_id, google_email).
--
--   Existing rows keep their tokens and get an id. Flows saved before
--   053 have no google_connection_id; the app then uses the account's
--   oldest connection, i.e. the one they were built with.
-- ============================================================

ALTER TABLE google_connections ADD COLUMN IF NOT EXISTS id UUID NOT NULL DEFAULT gen_random_uuid();

-- Primary key: account_id → id.
DO $$
DECLARE c TEXT;
BEGIN
  SELECT conname INTO c FROM pg_constraint
  WHERE conrelid = 'public.google_connections'::regclass AND contype = 'p';
  IF c IS NOT NULL AND (
    SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = c AND conrelid = 'public.google_connections'::regclass
  ) <> 'PRIMARY KEY (id)' THEN
    EXECUTE format('ALTER TABLE google_connections DROP CONSTRAINT %I', c);
    c := NULL;
  END IF;
  IF c IS NULL THEN
    ALTER TABLE google_connections ADD CONSTRAINT google_connections_pkey PRIMARY KEY (id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_google_connections_account ON google_connections(account_id, connected_at);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.google_connections'::regclass AND conname = 'google_connections_account_email_key'
  ) THEN
    ALTER TABLE google_connections
      ADD CONSTRAINT google_connections_account_email_key UNIQUE (account_id, google_email);
  END IF;
END $$;
-- RLS unchanged: still no policies (service role only).
