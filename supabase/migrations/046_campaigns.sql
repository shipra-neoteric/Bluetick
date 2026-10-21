-- 046_campaigns.sql
--
-- Campaigns: customers table, template library metadata,
-- broadcast lists/history metrics, scheduled broadcasts, CTWA referral
-- capture and Meta Ads settings. Purely ADDITIVE: new tables, columns,
-- functions, triggers and a widened CHECK. No data is rewritten except
-- harmless backfills of the new columns.
--
-- Sections:
--   1 per-user view preferences (column chooser)
--   2 contacts: provenance, WhatsApp profile name, last CTWA lead
--   3 message_templates: created_by, last_used_at, variable bindings
--   4 broadcasts: canceled status, audience list, header media, schedule
--     hold reason, timezone; recipients: reply attribution
--   5 scheduled broadcast claim RPC
--   6 CTWA referrals
--   7 Meta Ads integration settings (server-only)
--   8 customer_page RPC (derived activity columns)

-- ============================================================
-- 1. View preferences (e.g. visible customer columns)
-- ============================================================
CREATE TABLE IF NOT EXISTS user_view_preferences (
  user_id UUID NOT NULL,
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  view_key TEXT NOT NULL CHECK (length(view_key) BETWEEN 1 AND 100),
  prefs JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, view_key)
);
ALTER TABLE user_view_preferences ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS user_view_preferences_own ON user_view_preferences;
CREATE POLICY user_view_preferences_own ON user_view_preferences
  FOR ALL USING (user_id = auth.uid() AND is_account_member(account_id))
  WITH CHECK (user_id = auth.uid() AND is_account_member(account_id));

-- ============================================================
-- 2. Contacts
-- ============================================================
-- `source` = how the contact entered Bluetick (import, inbound message,
-- manual, api, broadcast_csv). It is provenance only — never consent.
ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS source TEXT,
  ADD COLUMN IF NOT EXISTS source_detail TEXT,
  ADD COLUMN IF NOT EXISTS wa_profile_name TEXT,
  ADD COLUMN IF NOT EXISTS last_ctwa_at TIMESTAMPTZ;

-- ============================================================
-- 3. Templates
-- ============================================================
ALTER TABLE message_templates
  ADD COLUMN IF NOT EXISTS created_by UUID,
  ADD COLUMN IF NOT EXISTS last_used_at TIMESTAMPTZ,
  -- { "1": {"kind":"field","key":"name"} | {"kind":"custom_field","id":"…"} }
  -- Pre-fills broadcast variable mapping; never executes anything.
  ADD COLUMN IF NOT EXISTS variable_bindings JSONB NOT NULL DEFAULT '{}'::jsonb;

-- Best available "created by" for existing rows: the row's user_id.
UPDATE message_templates SET created_by = user_id WHERE created_by IS NULL;

-- New rows: created_by = the signed-in user (falls back to user_id for
-- service-role inserts such as Meta sync).
CREATE OR REPLACE FUNCTION set_created_by()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.created_by := COALESCE(NEW.created_by, auth.uid(), NEW.user_id);
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS message_templates_set_created_by ON message_templates;
CREATE TRIGGER message_templates_set_created_by
  BEFORE INSERT ON message_templates
  FOR EACH ROW EXECUTE FUNCTION set_created_by();

-- "Last used on": an agent/bot template message, or a broadcast starting.
CREATE OR REPLACE FUNCTION touch_template_last_used()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_account UUID;
  v_name TEXT;
BEGIN
  IF TG_TABLE_NAME = 'messages' THEN
    IF NEW.template_name IS NULL OR NEW.sender_type = 'customer' THEN RETURN NEW; END IF;
    SELECT account_id INTO v_account FROM conversations WHERE id = NEW.conversation_id;
    v_name := NEW.template_name;
  ELSE
    IF NEW.status IS NOT DISTINCT FROM OLD.status OR NEW.status <> 'sending' THEN RETURN NEW; END IF;
    v_account := NEW.account_id;
    v_name := NEW.template_name;
  END IF;
  UPDATE message_templates SET last_used_at = NOW()
  WHERE account_id = v_account AND name = v_name;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS messages_touch_template ON messages;
CREATE TRIGGER messages_touch_template
  AFTER INSERT ON messages
  FOR EACH ROW EXECUTE FUNCTION touch_template_last_used();
DROP TRIGGER IF EXISTS broadcasts_touch_template ON broadcasts;
CREATE TRIGGER broadcasts_touch_template
  AFTER UPDATE OF status ON broadcasts
  FOR EACH ROW EXECUTE FUNCTION touch_template_last_used();

-- Backfill last_used_at from history.
UPDATE message_templates t SET last_used_at = s.last_used
FROM (
  SELECT c.account_id, m.template_name, MAX(m.created_at) AS last_used
  FROM messages m JOIN conversations c ON c.id = m.conversation_id
  WHERE m.template_name IS NOT NULL AND m.sender_type <> 'customer'
  GROUP BY c.account_id, m.template_name
) s
WHERE s.account_id = t.account_id AND s.template_name = t.name AND t.last_used_at IS NULL;

-- ============================================================
-- 4. Broadcasts
-- ============================================================
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'broadcasts_status_check') THEN
    ALTER TABLE broadcasts DROP CONSTRAINT broadcasts_status_check;
  END IF;
  ALTER TABLE broadcasts ADD CONSTRAINT broadcasts_status_check
    CHECK (status IN ('draft', 'scheduled', 'sending', 'sent', 'failed', 'canceled'));
END $$;

ALTER TABLE broadcasts
  -- The broadcast list (tag) it was sent to, when sent from a list.
  ADD COLUMN IF NOT EXISTS audience_tag_id UUID REFERENCES tags(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS audience_label TEXT,
  -- Media header URL used for every recipient (resume/scheduled sends).
  ADD COLUMN IF NOT EXISTS header_media_url TEXT,
  ADD COLUMN IF NOT EXISTS scheduled_timezone TEXT,
  -- Why a due scheduled broadcast is waiting (e.g. template_not_approved).
  ADD COLUMN IF NOT EXISTS hold_reason TEXT,
  ADD COLUMN IF NOT EXISTS hold_checked_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS canceled_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS canceled_by UUID,
  ADD COLUMN IF NOT EXISTS created_by UUID;

UPDATE broadcasts SET created_by = user_id WHERE created_by IS NULL;
DROP TRIGGER IF EXISTS broadcasts_set_created_by ON broadcasts;
CREATE TRIGGER broadcasts_set_created_by
  BEFORE INSERT ON broadcasts
  FOR EACH ROW EXECUTE FUNCTION set_created_by();

-- Backfill the list link for broadcasts sent to exactly one tag.
UPDATE broadcasts b SET audience_tag_id = (b.audience_filter->'tagIds'->>0)::uuid
WHERE b.audience_tag_id IS NULL
  AND b.audience_filter->>'type' = 'tags'
  AND jsonb_typeof(b.audience_filter->'tagIds') = 'array'
  AND jsonb_array_length(b.audience_filter->'tagIds') = 1
  AND EXISTS (SELECT 1 FROM tags t WHERE t.id = (b.audience_filter->'tagIds'->>0)::uuid);

CREATE INDEX IF NOT EXISTS idx_broadcasts_audience_tag ON broadcasts (audience_tag_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_broadcasts_scheduled_due ON broadcasts (scheduled_at) WHERE status = 'scheduled';

-- 'context' = the customer replied to the broadcast message itself;
-- 'window' = first inbound within 72h of a send with no reply context.
ALTER TABLE broadcast_recipients
  ADD COLUMN IF NOT EXISTS reply_attribution TEXT
    CHECK (reply_attribution IS NULL OR reply_attribution IN ('context', 'window'));
CREATE INDEX IF NOT EXISTS idx_broadcast_recipients_contact ON broadcast_recipients (contact_id, created_at DESC);

-- ============================================================
-- 5. Scheduled broadcasts: atomic claim for the cron worker
-- ============================================================
-- Moves due rows from 'scheduled' to 'sending' and takes the delivery
-- lock in one statement (SKIP LOCKED), so two workers can never both
-- start the same broadcast. Service role only.
CREATE OR REPLACE FUNCTION claim_due_scheduled_broadcasts(p_limit INTEGER DEFAULT 5)
RETURNS TABLE (broadcast_id UUID, account_id UUID)
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  WITH due AS (
    SELECT b.id FROM broadcasts b
    WHERE b.status = 'scheduled' AND b.scheduled_at <= NOW()
      -- A held broadcast (template not approved yet) is re-checked every
      -- 10 minutes, not on every tick.
      AND (b.hold_checked_at IS NULL OR b.hold_checked_at < NOW() - interval '10 minutes')
    ORDER BY b.scheduled_at
    LIMIT GREATEST(1, LEAST(p_limit, 50))
    FOR UPDATE SKIP LOCKED
  )
  UPDATE broadcasts b
  SET status = 'sending', delivery_locked_at = NOW(), hold_reason = NULL, hold_checked_at = NULL, updated_at = NOW()
  FROM due WHERE b.id = due.id
  RETURNING b.id, b.account_id;
$$;
REVOKE ALL ON FUNCTION claim_due_scheduled_broadcasts(INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION claim_due_scheduled_broadcasts(INTEGER) TO service_role;

-- Members may cancel only while still scheduled (RLS already limits
-- writes to agent+; this pins the transition).
CREATE OR REPLACE FUNCTION guard_broadcast_cancel()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'canceled' AND OLD.status IS DISTINCT FROM 'canceled' THEN
    IF OLD.status NOT IN ('scheduled', 'draft') THEN
      RAISE EXCEPTION 'only scheduled or draft broadcasts can be canceled' USING ERRCODE = '42501';
    END IF;
    NEW.canceled_at := NOW();
    NEW.canceled_by := COALESCE(auth.uid(), NEW.canceled_by);
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS broadcasts_guard_cancel ON broadcasts;
CREATE TRIGGER broadcasts_guard_cancel
  BEFORE UPDATE OF status ON broadcasts
  FOR EACH ROW EXECUTE FUNCTION guard_broadcast_cancel();

-- ============================================================
-- 6. Click-to-WhatsApp referrals (captured from inbound webhooks)
-- ============================================================
CREATE TABLE IF NOT EXISTS message_referrals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  contact_id UUID REFERENCES contacts(id) ON DELETE SET NULL,
  conversation_id UUID REFERENCES conversations(id) ON DELETE SET NULL,
  wa_message_id TEXT,
  source_type TEXT,          -- 'ad' | 'post' | …
  source_id TEXT,            -- the ad (or post) id when source_type = 'ad'
  source_url TEXT,
  headline TEXT,
  body TEXT,
  ctwa_clid TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- Webhook replays must not double-count a lead.
CREATE UNIQUE INDEX IF NOT EXISTS idx_message_referrals_wamid
  ON message_referrals (account_id, wa_message_id) WHERE wa_message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_message_referrals_source
  ON message_referrals (account_id, source_id, created_at DESC);
ALTER TABLE message_referrals ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS message_referrals_select ON message_referrals;
CREATE POLICY message_referrals_select ON message_referrals
  FOR SELECT USING (is_account_member(account_id));

-- ============================================================
-- 7. Meta Ads integration (credentials never readable by clients)
-- ============================================================
CREATE TABLE IF NOT EXISTS ads_integrations (
  account_id UUID PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  ad_account_id TEXT NOT NULL,
  access_token TEXT NOT NULL,        -- encrypted with ENCRYPTION_KEY
  currency TEXT,
  timezone_name TEXT,
  last_sync_at TIMESTAMPTZ,
  last_error TEXT,
  updated_by UUID,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- RLS on with no policies: only the service role (server routes) can
-- read or write. The API returns status without the token.
ALTER TABLE ads_integrations ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- 8. customer_page — paged customers with derived activity columns
-- ============================================================
-- One row per contact on the requested page, with values derived from
-- stored events. NULL means "not known" (e.g. history before Bluetick).
-- "Ticket" = the contact's conversation (Bluetick keeps one per contact).
-- Runs as the caller (RLS applies).
CREATE OR REPLACE FUNCTION customer_page(
  p_tag_id UUID DEFAULT NULL,
  p_search TEXT DEFAULT NULL,
  p_sort TEXT DEFAULT 'created_desc',
  p_limit INTEGER DEFAULT 25,
  p_offset INTEGER DEFAULT 0
) RETURNS TABLE (
  contact JSONB,
  total_count BIGINT,
  conversation_id UUID,
  ticket_status TEXT,
  ticket_opened_at TIMESTAMPTZ,
  ticket_closed_at TIMESTAMPTZ,
  ticket_replied BOOLEAN,
  first_message_received_at TIMESTAMPTZ,
  first_message_sent_at TIMESTAMPTZ,
  last_message_sent_at TIMESTAMPTZ,
  last_template_sent_at TIMESTAMPTZ
)
LANGUAGE sql STABLE AS $$
  WITH base AS (
    SELECT c.*
    FROM contacts c
    WHERE (p_tag_id IS NULL OR EXISTS (
            SELECT 1 FROM contact_tags ct WHERE ct.contact_id = c.id AND ct.tag_id = p_tag_id))
      AND (NULLIF(btrim(p_search), '') IS NULL
           OR c.name ILIKE '%' || btrim(p_search) || '%'
           OR c.phone ILIKE '%' || btrim(p_search) || '%'
           OR c.email ILIKE '%' || btrim(p_search) || '%')
  ),
  page AS (
    SELECT b.*, COUNT(*) OVER () AS total
    FROM base b
    ORDER BY
      CASE WHEN p_sort = 'name_asc' THEN lower(COALESCE(b.name, b.phone)) END ASC NULLS LAST,
      CASE WHEN p_sort = 'created_asc' THEN b.created_at END ASC,
      CASE WHEN p_sort = 'created_desc' OR p_sort IS NULL THEN b.created_at END DESC,
      b.id
    LIMIT GREATEST(1, LEAST(p_limit, 200)) OFFSET GREATEST(0, p_offset)
  )
  SELECT
    to_jsonb(p) - 'total',
    p.total,
    cv.id,
    cv.status,
    cv.created_at,
    cv.resolved_at,
    CASE WHEN cv.id IS NULL THEN NULL ELSE cv.first_human_reply_at IS NOT NULL END,
    (SELECT MIN(m.created_at) FROM messages m WHERE m.conversation_id = cv.id AND m.sender_type = 'customer'),
    (SELECT MIN(m.created_at) FROM messages m WHERE m.conversation_id = cv.id AND m.sender_type <> 'customer'),
    (SELECT MAX(m.created_at) FROM messages m WHERE m.conversation_id = cv.id AND m.sender_type <> 'customer'),
    GREATEST(
      (SELECT MAX(m.created_at) FROM messages m
       WHERE m.conversation_id = cv.id AND m.sender_type <> 'customer' AND m.template_name IS NOT NULL),
      (SELECT MAX(br.sent_at) FROM broadcast_recipients br WHERE br.contact_id = p.id)
    )
  FROM page p
  LEFT JOIN LATERAL (
    SELECT * FROM conversations c2
    WHERE c2.contact_id = p.id AND c2.account_id = p.account_id
    ORDER BY c2.created_at LIMIT 1
  ) cv ON TRUE
  ORDER BY
    CASE WHEN p_sort = 'name_asc' THEN lower(COALESCE(p.name, p.phone)) END ASC NULLS LAST,
    CASE WHEN p_sort = 'created_asc' THEN p.created_at END ASC,
    CASE WHEN p_sort = 'created_desc' OR p_sort IS NULL THEN p.created_at END DESC,
    p.id
$$;
GRANT EXECUTE ON FUNCTION customer_page(UUID, TEXT, TEXT, INTEGER, INTEGER) TO authenticated;

-- ============================================================
-- 9. Realtime
-- ============================================================
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime')
     AND NOT EXISTS (SELECT 1 FROM pg_publication_tables
                     WHERE pubname = 'supabase_realtime' AND tablename = 'broadcasts') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE broadcasts;
  END IF;
END $$;
