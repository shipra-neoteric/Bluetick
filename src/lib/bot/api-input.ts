/**
 * Validation for saved API definitions (Call Api, migration 049). Used by
 * the API routes; the same limits as the database CHECKs, plus shape.
 */

import { API_METHODS, type ApiDefinition, type ApiMethod } from "./call-api";

const VAR_KEY = /^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/;

export function sanitizeApiInput(raw: unknown): { ok: true; value: Required<Omit<ApiDefinition, "id">> } | { ok: false; error: string } {
  const b = (raw ?? {}) as Record<string, unknown>;
  const name = typeof b.name === "string" ? b.name.trim() : "";
  if (!name || name.length > 120) return { ok: false, error: "Give the API a name (up to 120 characters)." };
  const method = String(b.method ?? "POST").toUpperCase();
  if (!API_METHODS.includes(method as ApiMethod)) return { ok: false, error: `Method must be one of ${API_METHODS.join(", ")}.` };
  const url = typeof b.url === "string" ? b.url.trim() : "";
  if (!/^https?:\/\//i.test(url) || url.length > 2048) return { ok: false, error: "Enter an http(s) endpoint URL." };
  const headers = (Array.isArray(b.headers) ? b.headers : [])
    .map((h) => ({ key: String((h as { key?: unknown }).key ?? "").trim(), value: String((h as { value?: unknown }).value ?? "") }))
    .filter((h) => h.key)
    .slice(0, 30);
  if (headers.some((h) => !/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(h.key))) return { ok: false, error: "A header name has characters HTTP doesn't allow." };
  const body = typeof b.body === "string" ? b.body : "";
  if (body.length > 20_000) return { ok: false, error: "Body is too long (20,000 characters max)." };
  const response_map = (Array.isArray(b.response_map) ? b.response_map : [])
    .map((m) => ({ path: String((m as { path?: unknown }).path ?? "").trim(), var: String((m as { var?: unknown }).var ?? "").trim() }))
    .filter((m) => m.path || m.var)
    .slice(0, 30);
  if (response_map.some((m) => !m.path || !VAR_KEY.test(m.var))) {
    return { ok: false, error: "Each response mapping needs a path and a variable name (letters, digits, _)." };
  }
  return { ok: true, value: { name, method: method as ApiMethod, url, headers, body, response_map } };
}
