// /api/flows/[id]/webhook — manage a flow's inbound URL.
// Implementation shared with automations: see lib/bot/webhook-manage.
import { FLOW_HOOKS, getHook, postHook } from '@/lib/bot/webhook-manage'

export function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  return getHook(FLOW_HOOKS, request, context)
}

export function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return postHook(FLOW_HOOKS, request, context)
}
