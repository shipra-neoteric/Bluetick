/**
 * "Call Api" (Bot Builder A20): run a saved API definition from the
 * server. Shared by the Flow step and the editor's "Test API" button.
 *
 *   - SSRF guard: private / loopback / link-local destinations refused,
 *     redirects not followed, 10 s timeout, response capped at 64 KB.
 *   - Variables: {{vars.x}} / {{contact.*}} / {{trigger.*}} are filled in
 *     the URL, header values and the body. A JSON body is filled string
 *     by string, so a value containing quotes can't break the JSON.
 *   - Response mapping: `path` (dot notation, e.g. data.id) → variable.
 *
 * Browser-safe parts (parseCurl, fillJsonTemplate) live in ./curl.
 */

import { isDeliverableUrl } from "@/lib/webhooks/ssrf";
import { valueAtPath } from "./inbound-webhook";
import { fillJsonTemplate } from "./curl";

export const API_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
export type ApiMethod = (typeof API_METHODS)[number];

export interface ApiDefinition {
  id?: string;
  name?: string;
  method: ApiMethod;
  url: string;
  headers: { key: string; value: string }[];
  body?: string | null;
  response_map?: { path: string; var: string }[];
}

export interface ApiCallResult {
  ok: boolean;
  status: number;
  /** Parsed JSON when the response was JSON, else the (capped) text. */
  body: unknown;
  /** Values picked by response_map. */
  mapped: Record<string, unknown>;
  error?: string;
}

const MAX_RESPONSE_BYTES = 64 * 1024;
const VAR_KEY = /^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/;
// Headers the runtime controls; letting a definition set them invites
// request smuggling or broken requests.
const BLOCKED_HEADERS = new Set(["host", "content-length", "connection", "transfer-encoding"]);

export async function performApiCall(def: ApiDefinition, fill: (s: string) => string): Promise<ApiCallResult> {
  const fail = (error: string, status = 0): ApiCallResult => ({ ok: false, status, body: null, mapped: {}, error });
  if (!API_METHODS.includes(def.method)) return fail(`Unsupported method ${def.method}`);
  const url = fill(def.url ?? "").trim();
  if (!/^https?:\/\//i.test(url)) return fail("URL must start with https:// or http://");
  if (!(await isDeliverableUrl(url))) return fail("This destination is not allowed (private or local address).");

  const headers: Record<string, string> = {};
  for (const h of def.headers ?? []) {
    const key = (h.key ?? "").trim();
    if (!key || BLOCKED_HEADERS.has(key.toLowerCase())) continue;
    headers[key] = fill(h.value ?? "");
  }
  let body: string | undefined;
  if (def.method !== "GET" && def.body?.trim()) {
    body = fillJsonTemplate(def.body, fill);
    if (!Object.keys(headers).some((k) => k.toLowerCase() === "content-type")) headers["Content-Type"] = "application/json";
  }

  let res: Response;
  try {
    res = await fetch(url, {
      method: def.method,
      headers,
      body,
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    return fail(err instanceof Error && err.name === "TimeoutError" ? "The API did not answer within 10 seconds." : "Could not reach the API.");
  }

  const raw = await readCapped(res);
  let parsed: unknown = raw;
  try {
    parsed = raw ? JSON.parse(raw) : null;
  } catch {
    // Not JSON; keep the text.
  }
  const mapped: Record<string, unknown> = {};
  for (const m of def.response_map ?? []) {
    if (!m.path || !VAR_KEY.test(m.var ?? "")) continue;
    const v = valueAtPath(parsed, m.path);
    if (v !== undefined) mapped[m.var] = typeof v === "object" ? JSON.stringify(v) : v;
  }
  const ok = res.status >= 200 && res.status < 300;
  return { ok, status: res.status, body: parsed, mapped, ...(ok ? {} : { error: `The API answered ${res.status}.` }) };
}

async function readCapped(res: Response): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (size < MAX_RESPONSE_BYTES) {
    const { done, value } = await reader.read();
    if (done || !value) break;
    chunks.push(value);
    size += value.byteLength;
  }
  void reader.cancel().catch(() => {});
  const all = new Uint8Array(Math.min(size, MAX_RESPONSE_BYTES));
  let at = 0;
  for (const c of chunks) {
    const take = Math.min(c.byteLength, all.byteLength - at);
    all.set(c.subarray(0, take), at);
    at += take;
    if (at >= all.byteLength) break;
  }
  return new TextDecoder().decode(all);
}
