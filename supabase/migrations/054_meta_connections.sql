-- ============================================================
-- 054 — Facebook (Meta) accounts for the "Lead From CTWA" trigger.
--
-- Additive and safe to run twice. Run after 053.
--
--   1. meta_connections: Facebook users connected with Facebook Login
--      (scope ads_read), several per Bluetick account. The Bot Builder
--      lists their campaigns / ad sets so a trigger can follow one.
--      Tokens are long-lived user tokens, encrypted by the app with
--      ENCRYPTION_KEY. No RLS policies: only the server (service role)
--      reads or writes this table; the UI asks the API for names only.
--   2. meta_ad_lookup: ad id → ad set / campaign, as read from the
--      Graph API when a Click-to-WhatsApp chat arrives, so each ad is
--      looked up once instead of on every message. A row with no
--      campaign_id records a failed lookup (retried after a while).
--
-- ads_integrations (046, the pasted token behind Ad Performance) is
-- unchanged.
-- ============================================================

-- 1. Connected Facebook users -------------------------------------------
CREATE TABLE IF NOT EXISTS meta_connections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  fb_user_id TEXT NOT NULL,
  fb_user_name TEXT,
  -- Encrypted (AES-GCM, app side). Never returned to the browser.
  access_token TEXT NOT NULL,
  token_expires_at TIMESTAMPTZ,
  scope TEXT,
  -- Set when Meta rejects the token (expired / revoked): the UI then
  -- asks to reconnect that Facebook account.
  last_error TEXT,
  connected_by UUID,
  connected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (account_id, fb_user_id)
);
ALTER TABLE meta_connections ENABLE ROW LEVEL SECURITY;
-- Deliberately no policies: service role only.

-- 2. Ad → ad set / campaign cache ---------------------------------------
CREATE TABLE IF NOT EXISTS meta_ad_lookup (
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  ad_id TEXT NOT NULL,
  ad_name TEXT,
  adset_id TEXT,
  adset_name TEXT,
  campaign_id TEXT,
  campaign_name TEXT,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (account_id, ad_id)
);
ALTER TABLE meta_ad_lookup ENABLE ROW LEVEL SECURITY;
-- Deliberately no policies: service role only.
