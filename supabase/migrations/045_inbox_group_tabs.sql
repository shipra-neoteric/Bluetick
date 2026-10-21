-- 045_inbox_group_tabs.sql
--
-- "Group tabs" for the inbox view strip: pick a field
-- — Contact Owner or a dropdown custom field such as Lead Status — and the
-- strip shows one tab per value with a live count ("Ruchi Gupta 91").
--
-- Additive on top of 044:
--   1. inbox_conversation_matches gains an `owner` filter key
--      (contacts.owner_user_id).
--   2. inbox_group_counts(p_group, p_filters) returns per-value counts
--      under the caller's RLS, using the same predicate as the list.

-- 1. Same predicate as 044 plus `owner`.
CREATE OR REPLACE FUNCTION inbox_conversation_matches(
  c conversations, f JSONB, p_uid UUID, p_last_read TIMESTAMPTZ, s inbox_settings
) RETURNS BOOLEAN LANGUAGE sql STABLE AS $$
  SELECT
    (CASE COALESCE(f->>'queue', 'all')
      WHEN 'open' THEN c.status = 'open'
      WHEN 'pending' THEN c.status = 'pending'
      WHEN 'closed' THEN c.status = 'closed'
      WHEN 'awaiting' THEN c.awaiting_reply_since IS NOT NULL AND c.status <> 'closed'
      WHEN 'unread' THEN c.last_inbound_at IS NOT NULL
                     AND c.last_inbound_at > COALESCE(p_last_read, '-infinity'::timestamptz)
      WHEN 'unassigned' THEN c.assigned_agent_id IS NULL AND c.status <> 'closed'
      WHEN 'sla_breached' THEN COALESCE(s.sla_enabled, FALSE)
        AND c.awaiting_reply_since IS NOT NULL AND c.status <> 'closed'
        AND c.awaiting_reply_since + make_interval(mins => CASE
              WHEN c.first_human_reply_at IS NULL THEN s.sla_first_response_minutes
              ELSE s.sla_next_response_minutes END) < NOW()
      ELSE TRUE END)
    AND (COALESCE(f->>'scope', 'all') <> 'mine' OR c.assigned_agent_id = p_uid)
    AND (NULLIF(f->>'assignee', '') IS NULL OR c.assigned_agent_id = (f->>'assignee')::uuid)
    AND (
      NULLIF(f->>'owner', '') IS NULL
      OR EXISTS (
        SELECT 1 FROM contacts ct
        WHERE ct.id = c.contact_id AND ct.owner_user_id = (f->>'owner')::uuid
      )
    )
    AND (
      jsonb_typeof(f->'tag_ids') IS DISTINCT FROM 'array'
      OR jsonb_array_length(f->'tag_ids') = 0
      OR EXISTS (
        SELECT 1 FROM contact_tags ct
        WHERE ct.contact_id = c.contact_id
          AND ct.tag_id IN (SELECT (jsonb_array_elements_text(f->'tag_ids'))::uuid)
      )
    )
    AND (
      NULLIF(f->>'field_id', '') IS NULL OR NULLIF(btrim(f->>'field_value'), '') IS NULL
      OR EXISTS (
        SELECT 1 FROM contact_custom_values v
        WHERE v.contact_id = c.contact_id
          AND v.custom_field_id = (f->>'field_id')::uuid
          AND lower(btrim(v.value)) = lower(btrim(f->>'field_value'))
      )
    )
    AND (NULLIF(f->>'date_from', '') IS NULL
         OR COALESCE(c.last_message_at, c.created_at) >= (f->>'date_from')::timestamptz)
    AND (NULLIF(f->>'date_to', '') IS NULL
         OR COALESCE(c.last_message_at, c.created_at) < (f->>'date_to')::timestamptz)
    AND (
      NULLIF(btrim(f->>'search'), '') IS NULL
      OR c.last_message_text ILIKE '%' || btrim(f->>'search') || '%'
      OR EXISTS (
        SELECT 1 FROM contacts ct
        WHERE ct.id = c.contact_id
          AND (ct.name ILIKE '%' || btrim(f->>'search') || '%'
               OR ct.phone ILIKE '%' || btrim(f->>'search') || '%')
      )
    )
$$;

-- 2. Per-value counts for the group tabs.
--   p_group = 'owner'          → one row per contact owner (user id)
--   p_group = '<custom field>' → one row per distinct value (case-insensitive;
--                                the most common spelling is the label)
-- p_filters is applied first (queue, scope, assignee, tags, …); the
-- caller drops the group's own filter so every tab shows its own count.
CREATE OR REPLACE FUNCTION inbox_group_counts(
  p_group TEXT,
  p_filters JSONB DEFAULT '{}'::jsonb
) RETURNS TABLE (group_value TEXT, total INTEGER)
LANGUAGE plpgsql STABLE AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_account UUID;
  v_settings inbox_settings;
BEGIN
  SELECT account_id INTO v_account FROM profiles WHERE user_id = v_uid;
  IF v_account IS NULL THEN RETURN; END IF;
  v_settings := inbox_effective_settings(v_account);

  IF p_group = 'owner' THEN
    RETURN QUERY
      SELECT ct.owner_user_id::text, COUNT(*)::int
      FROM conversations c
      JOIN contacts ct ON ct.id = c.contact_id
      LEFT JOIN conversation_reads r ON r.conversation_id = c.id AND r.user_id = v_uid
      WHERE c.account_id = v_account
        AND ct.owner_user_id IS NOT NULL
        AND inbox_conversation_matches(c, p_filters, v_uid, r.last_read_at, v_settings)
      GROUP BY ct.owner_user_id
      ORDER BY 2 DESC;
  ELSIF p_group ~ '^[0-9a-fA-F-]{36}$' THEN
    RETURN QUERY
      WITH vals AS (
        SELECT lower(btrim(v.value)) AS k, btrim(v.value) AS label
        FROM conversations c
        JOIN contact_custom_values v
          ON v.contact_id = c.contact_id AND v.custom_field_id = p_group::uuid
        LEFT JOIN conversation_reads r ON r.conversation_id = c.id AND r.user_id = v_uid
        WHERE c.account_id = v_account
          AND NULLIF(btrim(v.value), '') IS NOT NULL
          AND inbox_conversation_matches(c, p_filters, v_uid, r.last_read_at, v_settings)
      )
      SELECT (SELECT v2.label FROM vals v2 WHERE v2.k = vals.k
              GROUP BY v2.label ORDER BY COUNT(*) DESC, v2.label LIMIT 1),
             COUNT(*)::int
      FROM vals
      GROUP BY vals.k
      ORDER BY 2 DESC;
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION inbox_group_counts(TEXT, JSONB) TO authenticated;
