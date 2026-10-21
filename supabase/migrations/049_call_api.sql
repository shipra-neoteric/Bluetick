-- ============================================================
-- 049 — Bot Builder "Call Api": saved, reusable API definitions.
--
-- Additive and safe to run twice. Run after 048.
--
--   1. api_definitions: name, method, URL, headers, JSON body template
--      and response → variable mapping. Reused by any flow's Call Api
--      step. Headers can hold credentials, so only agents and above can
--      read them (viewers can't), and the server performs every request
--      (SSRF-guarded); the browser never calls third-party APIs.
--   2. flow_nodes.node_type adds 'call_api' (success / failure outputs).
-- ============================================================

CREATE TABLE IF NOT EXISTS api_definitions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 120),
  method TEXT NOT NULL DEFAULT 'POST' CHECK (method IN ('GET', 'POST', 'PUT', 'PATCH', 'DELETE')),
  url TEXT NOT NULL CHECK (length(url) <= 2048),
  -- [{"key": "Authorization", "value": "Bearer …"}]
  headers JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- JSON template; {{vars.x}} / {{contact.*}} / {{trigger.*}} tokens allowed.
  body TEXT,
  -- [{"path": "data.id", "var": "order_id"}]
  response_map JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (account_id, name)
);
CREATE INDEX IF NOT EXISTS idx_api_definitions_account ON api_definitions(account_id);

ALTER TABLE api_definitions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS api_definitions_select ON api_definitions;
CREATE POLICY api_definitions_select ON api_definitions
  FOR SELECT USING (is_account_member(account_id, 'agent'));
DROP POLICY IF EXISTS api_definitions_write ON api_definitions;
CREATE POLICY api_definitions_write ON api_definitions
  FOR ALL USING (is_account_member(account_id, 'agent'))
  WITH CHECK (is_account_member(account_id, 'agent'));

-- 2. Flow node type ---------------------------------------------------
-- Same list as 048 plus call_api; NOT VALID = new/edited rows only.
ALTER TABLE flow_nodes DROP CONSTRAINT IF EXISTS flow_nodes_node_type_check;
ALTER TABLE flow_nodes ADD CONSTRAINT flow_nodes_node_type_check CHECK (node_type IN (
  'start', 'send_buttons', 'send_list', 'send_message', 'collect_input',
  'condition', 'set_tag', 'handoff', 'http_fetch', 'end', 'send_media',
  'send_location', 'send_template', 'assign_agent', 'set_field',
  'working_hours', 'opt_out', 'format_value', 'ai_reply',
  'time_delay', 'wait_until', 'action', 'call_api'
)) NOT VALID;
