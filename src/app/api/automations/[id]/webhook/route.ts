// /api/automations/[id]/webhook — manage an automation's inbound URL.
// Implementation shared with flows: see lib/bot/webhook-manage.
import { AUTOMATION_HOOKS, getHook, postHook } from '@/lib/bot/webhook-manage'

export function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  return getHook(AUTOMATION_HOOKS, request, context)
}

export function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return postHook(AUTOMATION_HOOKS, request, context)
}
