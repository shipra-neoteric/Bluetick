/**
 * Browser-safe helpers for the Call Api editor.
 *
 * parseCurl: "Import from cURL" — reads the request out of a pasted cURL
 * command (method, URL, headers, body). It only parses text; nothing is
 * ever executed.
 *
 * fillJsonTemplate: fills {{tokens}} inside a JSON body string by
 * string, so a value with quotes or newlines can't break the JSON. A
 * body that isn't valid JSON is filled as plain text.
 */

export interface ParsedCurl {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  url: string;
  headers: { key: string; value: string }[];
  body: string;
}

/** Split like a POSIX shell: quotes, backslash escapes, line continuations. */
export function shellSplit(input: string): string[] {
  const out: string[] = [];
  let cur = "";
  let has = false;
  let quote: '"' | "'" | null = null;
  const s = input.replace(/\\\r?\n/g, " ");
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote === "'") {
      if (c === "'") quote = null;
      else cur += c;
      continue;
    }
    if (quote === '"') {
      if (c === '"') quote = null;
      else if (c === "\\" && i + 1 < s.length && '"\\$`'.includes(s[i + 1])) cur += s[++i];
      else cur += c;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      has = true;
    } else if (c === "\\" && i + 1 < s.length) {
      cur += s[++i];
      has = true;
    } else if (/\s/.test(c)) {
      if (has) out.push(cur);
      cur = "";
      has = false;
    } else {
      cur += c;
      has = true;
    }
  }
  if (quote) throw new Error("Unclosed quote in the cURL command.");
  if (has) out.push(cur);
  return out;
}

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;

export function parseCurl(command: string): ParsedCurl {
  const tokens = shellSplit(command.trim());
  if (tokens[0]?.toLowerCase() !== "curl") throw new Error('Paste a command that starts with "curl".');
  let method: string | null = null;
  let url = "";
  const headers: { key: string; value: string }[] = [];
  const data: string[] = [];
  const takes = (t: string) => t.startsWith("--") ? t.split("=")[0] : t;
  for (let i = 1; i < tokens.length; i++) {
    const raw = tokens[i];
    const flag = takes(raw);
    const inline = raw.startsWith("--") && raw.includes("=") ? raw.slice(raw.indexOf("=") + 1) : null;
    const next = () => (inline ?? tokens[++i] ?? "");
    switch (flag) {
      case "-X":
      case "--request":
        method = next().toUpperCase();
        break;
      case "-H":
      case "--header": {
        const h = next();
        const at = h.indexOf(":");
        if (at > 0) headers.push({ key: h.slice(0, at).trim(), value: h.slice(at + 1).trim() });
        break;
      }
      case "-d":
      case "--data":
      case "--data-raw":
      case "--data-binary":
      case "--data-ascii":
      case "--data-urlencode":
        data.push(next());
        break;
      case "--json":
        data.push(next());
        if (!headers.some((h) => h.key.toLowerCase() === "content-type")) headers.push({ key: "Content-Type", value: "application/json" });
        if (!headers.some((h) => h.key.toLowerCase() === "accept")) headers.push({ key: "Accept", value: "application/json" });
        break;
      case "-u":
      case "--user":
        headers.push({ key: "Authorization", value: `Basic ${toBase64(next())}` });
        break;
      case "--url":
        url = next();
        break;
      default:
        // Flags with a value we don't use; skip the value too.
        if (["-o", "--output", "-A", "--user-agent", "-e", "--referer", "-m", "--max-time", "--connect-timeout", "-b", "--cookie"].includes(flag)) {
          if (inline === null) i++;
        } else if (!raw.startsWith("-") && !url) {
          url = raw;
        }
    }
  }
  if (!url) throw new Error("No URL found in the cURL command.");
  const m = (method ?? (data.length ? "POST" : "GET")) as ParsedCurl["method"];
  if (!METHODS.includes(m)) throw new Error(`Method ${m} isn't supported (use ${METHODS.join(", ")}).`);
  return { method: m, url, headers, body: data.join("&") };
}

function toBase64(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return typeof btoa === "function" ? btoa(bin) : Buffer.from(bin, "binary").toString("base64");
}

/** Fill {{tokens}} in a JSON body without breaking its syntax. */
export function fillJsonTemplate(template: string, fill: (s: string) => string): string {
  try {
    const parsed = JSON.parse(template);
    const walk = (v: unknown): unknown => {
      if (typeof v === "string") return fill(v);
      if (Array.isArray(v)) return v.map(walk);
      if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
      return v;
    };
    return JSON.stringify(walk(parsed));
  } catch {
    return fill(template);
  }
}
