import { isMissingSchemaError } from '@/lib/db/schema-compat'
import type { supabaseAdmin } from '@/lib/flows/admin-client'

/**
 * Store the current graph as the next version. Returns the version
 * number, or null on a database without migration 047 (the flow then
 * runs from live nodes, as before).
 */
export async function publishSnapshot(
  admin: ReturnType<typeof supabaseAdmin>,
  flowId: string,
  userId: string,
): Promise<number | null> {
  const [{ data: flow }, { data: nodes }, { data: last, error: lastErr }] = await Promise.all([
    admin
      .from('flows')
      .select('account_id, trigger_type, trigger_config, entry_node_id, fallback_policy')
      .eq('id', flowId)
      .maybeSingle(),
    admin
      .from('flow_nodes')
      .select('node_key, node_type, config, position_x, position_y')
      .eq('flow_id', flowId),
    admin
      .from('flow_versions')
      .select('version')
      .eq('flow_id', flowId)
      .order('version', { ascending: false })
      .limit(1),
  ])
  if (lastErr) {
    if (isMissingSchemaError(lastErr)) return null
    throw new Error(lastErr.message)
  }
  if (!flow) return null
  const next = (((last ?? [])[0] as { version?: number } | undefined)?.version ?? 0) + 1
  const { error } = await admin.from('flow_versions').insert({
    flow_id: flowId,
    account_id: (flow as { account_id: string }).account_id,
    version: next,
    entry_node_id: (flow as { entry_node_id: string | null }).entry_node_id,
    trigger_type: (flow as { trigger_type: string }).trigger_type,
    trigger_config: (flow as { trigger_config: unknown }).trigger_config ?? {},
    fallback_policy: (flow as { fallback_policy: unknown }).fallback_policy ?? null,
    nodes: nodes ?? [],
    published_by: userId,
  })
  if (error) {
    if (isMissingSchemaError(error)) return null
    throw new Error(error.message)
  }
  return next
}
