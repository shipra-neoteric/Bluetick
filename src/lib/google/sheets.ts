/**
 * Google Sheets REST (v4) helpers for the Bot Builder:
 *   - read a spreadsheet's tabs and a tab's header row (builder pickers),
 *   - read rows (the "On New Row Google Sheet" trigger),
 *   - append one row mapped by header name ("Google Sheets" Add Row step).
 *
 * The first row of a tab is its header row. Values are written RAW, never
 * USER_ENTERED: text that a customer typed such as "=IMPORTXML(…)" stays
 * text in the sheet instead of becoming a formula.
 */

const API = 'https://sheets.googleapis.com/v4/spreadsheets';
const TIMEOUT_MS = 20_000;
/** Widest range read or written (A..ZZ = 702 columns). */
const LAST_COL = 'ZZ';
export const MAX_COLUMNS = 702;
export const MAX_CELL_CHARS = 50_000;

/** Spreadsheet id from a full Google Sheets URL or a bare id. */
export function parseSpreadsheetId(input: string): string | null {
  const s = (input ?? '').trim();
  const m = s.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]{20,})/);
  if (m) return m[1];
  return /^[a-zA-Z0-9_-]{20,}$/.test(s) ? s : null;
}

/** A1 range for a tab name; quotes are doubled inside 'single quotes'. */
export function a1(sheet: string, range?: string): string {
  const quoted = `'${sheet.replace(/'/g, "''")}'`;
  return range ? `${quoted}!${range}` : quoted;
}

/**
 * Variable key for a header: "Phone Number" → "phone_number". Used for
 * {{trigger.row.<key>}} so headers with spaces still make valid tokens.
 */
export function headerKey(header: string): string {
  const k = header
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60);
  return k || 'column';
}

/** Unique keys for a header row (duplicates get _2, _3 …; blanks col_<n>). */
export function headerKeys(headers: string[]): string[] {
  const seen = new Map<string, number>();
  return headers.map((h, i) => {
    const base = h.trim() ? headerKey(h) : `col_${i + 1}`;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return n === 1 ? base : `${base}_${n}`;
  });
}

/** One sheet row as { key: value } using the header row. */
export function rowToRecord(headers: string[], row: unknown[]): Record<string, string> {
  const keys = headerKeys(headers);
  const out: Record<string, string> = {};
  const width = Math.max(headers.length, row.length);
  for (let i = 0; i < width && i < MAX_COLUMNS; i++) {
    const key = keys[i] ?? `col_${i + 1}`;
    const v = row[i];
    out[key] = v === undefined || v === null ? '' : String(v);
  }
  return out;
}

/** Is the row blank (every cell empty)? Blank rows never start a flow. */
export function isBlankRow(row: unknown[]): boolean {
  return row.every((v) => v === undefined || v === null || String(v).trim() === '');
}

/**
 * Build the row to append: each mapped column lands under its header.
 * Unknown headers are reported, not silently dropped.
 */
export function buildRow(
  headers: string[],
  columns: { column: string; value: string }[],
): { row: string[]; unknown: string[] } {
  const norm = (h: string) => h.trim().toLowerCase();
  const index = new Map<string, number>();
  headers.forEach((h, i) => {
    if (h.trim() && !index.has(norm(h))) index.set(norm(h), i);
  });
  const row: string[] = new Array(headers.length).fill('');
  const unknown: string[] = [];
  for (const c of columns) {
    if (!c.column?.trim()) continue;
    const i = index.get(norm(c.column));
    if (i === undefined) {
      unknown.push(c.column);
      continue;
    }
    row[i] = (c.value ?? '').slice(0, MAX_CELL_CHARS);
  }
  // Trailing empty cells are not written (keeps the row tidy).
  let end = row.length;
  while (end > 0 && row[end - 1] === '') end--;
  return { row: row.slice(0, end), unknown };
}

export class SheetsApiError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'SheetsApiError';
    this.status = status;
  }
}

async function call<T>(token: string, url: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(TIMEOUT_MS),
    cache: 'no-store',
  });
  const json = (await res.json().catch(() => ({}))) as { error?: { message?: string; status?: string } } & T;
  if (!res.ok) {
    const msg = json.error?.message ?? `Google Sheets error (${res.status})`;
    if (res.status === 404) throw new SheetsApiError('Spreadsheet or tab not found. Check the link and the tab name.', 404);
    if (res.status === 403) {
      throw new SheetsApiError(
        'The connected Google account cannot open this spreadsheet. Share it with that account (Editor) or connect another account.',
        403,
      );
    }
    throw new SheetsApiError(msg, res.status);
  }
  return json;
}

export interface SpreadsheetMeta {
  id: string;
  title: string;
  tabs: string[];
}

export async function getSpreadsheetMeta(token: string, id: string): Promise<SpreadsheetMeta> {
  const j = await call<{ properties?: { title?: string }; sheets?: { properties?: { title?: string } }[] }>(
    token,
    `${API}/${encodeURIComponent(id)}?fields=properties.title,sheets.properties.title`,
  );
  return {
    id,
    title: j.properties?.title ?? '',
    tabs: (j.sheets ?? []).map((s) => s.properties?.title ?? '').filter(Boolean),
  };
}

type Values = { values?: unknown[][] };

export async function getHeaders(token: string, id: string, sheet: string): Promise<string[]> {
  const j = await call<Values>(token, `${API}/${encodeURIComponent(id)}/values/${encodeURIComponent(a1(sheet, `A1:${LAST_COL}1`))}`);
  return (j.values?.[0] ?? []).map((v) => String(v ?? ''));
}

/** Every row of a tab (header first). Trailing blank rows are trimmed by Google. */
export async function getAllRows(token: string, id: string, sheet: string): Promise<unknown[][]> {
  const j = await call<Values>(
    token,
    `${API}/${encodeURIComponent(id)}/values/${encodeURIComponent(a1(sheet, `A:${LAST_COL}`))}?valueRenderOption=FORMATTED_VALUE`,
  );
  return j.values ?? [];
}

/** Appends one row; returns the A1 range Google wrote it to. */
export async function appendRow(token: string, id: string, sheet: string, row: string[]): Promise<string | null> {
  const url =
    `${API}/${encodeURIComponent(id)}/values/${encodeURIComponent(a1(sheet, 'A1'))}:append` +
    '?valueInputOption=RAW&insertDataOption=INSERT_ROWS';
  const j = await call<{ updates?: { updatedRange?: string } }>(token, url, {
    method: 'POST',
    body: JSON.stringify({ majorDimension: 'ROWS', values: [row] }),
  });
  return j.updates?.updatedRange ?? null;
}
