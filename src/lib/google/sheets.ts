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
  /** Tab titles, in order (kept for older builders). */
  tabs: string[];
  /** Tabs with Google's stable sheetId (survives renames). */
  sheets: { id: number; title: string }[];
}

export async function getSpreadsheetMeta(token: string, id: string): Promise<SpreadsheetMeta> {
  const j = await call<{
    properties?: { title?: string };
    sheets?: { properties?: { title?: string; sheetId?: number } }[];
  }>(token, `${API}/${encodeURIComponent(id)}?fields=properties.title,sheets.properties(title,sheetId)`);
  const sheets = (j.sheets ?? [])
    .map((s) => ({ id: Number(s.properties?.sheetId ?? -1), title: s.properties?.title ?? '' }))
    .filter((s) => s.title);
  return { id, title: j.properties?.title ?? '', tabs: sheets.map((s) => s.title), sheets };
}

/**
 * The tab's current title: looked up by stable sheetId when known (so a
 * renamed tab keeps working), else the saved title. Throws when the tab
 * no longer exists.
 */
export async function resolveTabTitle(token: string, spreadsheetId: string, sheetName: string, sheetId?: number | null): Promise<string> {
  if (sheetId === undefined || sheetId === null || !Number.isFinite(sheetId) || sheetId < 0) return sheetName;
  const meta = await getSpreadsheetMeta(token, spreadsheetId);
  const hit = meta.sheets.find((s) => s.id === sheetId);
  if (!hit) throw new SheetsApiError('The selected tab was deleted from the spreadsheet. Pick a tab again.', 404);
  return hit.title;
}

/** "A", "B", … "Z", "AA" for a 0-based column index. */
export function columnLetter(index: number): string {
  let n = index + 1;
  let out = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    out = String.fromCharCode(65 + r) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

/** Headers used when the first row is data: "Column A", "Column B", … */
export function letterHeaders(width: number): string[] {
  return Array.from({ length: Math.min(width, MAX_COLUMNS) }, (_, i) => `Column ${columnLetter(i)}`);
}

/** Header problems worth showing: blanks among used columns and duplicates. */
export function headerProblems(headers: string[]): { blank: number[]; duplicates: string[] } {
  const last = headers.reduce((m, h, i) => (h.trim() ? i : m), -1);
  const blank: number[] = [];
  const seen = new Map<string, number>();
  for (let i = 0; i <= last; i++) {
    const h = headers[i]?.trim() ?? '';
    if (!h) blank.push(i);
    else seen.set(h.toLowerCase(), (seen.get(h.toLowerCase()) ?? 0) + 1);
  }
  const duplicates = [...seen.entries()].filter(([, n]) => n > 1).map(([h]) => headers.find((x) => x.trim().toLowerCase() === h)!.trim());
  return { blank, duplicates };
}

type Values = { values?: unknown[][] };

/** First `limit` rows of a tab (header included) for the read-only preview. */
export async function getFirstRows(token: string, id: string, sheet: string, limit: number): Promise<unknown[][]> {
  const j = await call<Values>(
    token,
    `${API}/${encodeURIComponent(id)}/values/${encodeURIComponent(a1(sheet, `A1:${LAST_COL}${Math.max(1, Math.min(limit, 50))}`))}`,
  );
  return j.values ?? [];
}

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

const DRIVE_FILES = 'https://www.googleapis.com/drive/v3/files';

/**
 * Drive search for the spreadsheet picker: Google Sheets files only, not
 * trashed, optionally whose name contains `search`. Quotes and
 * backslashes are escaped as the Drive query language requires.
 */
export function spreadsheetQuery(search?: string | null): string {
  const base = "mimeType='application/vnd.google-apps.spreadsheet' and trashed=false";
  const s = (search ?? '').trim().slice(0, 100);
  if (!s) return base;
  return `${base} and name contains '${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

export interface SpreadsheetFile {
  id: string;
  name: string;
  modifiedTime: string | null;
}

/**
 * Spreadsheets the Google account can see (own, shared, shared drives),
 * newest first. Needs the drive.metadata.readonly scope (migration 053).
 */
export async function listSpreadsheets(token: string, search?: string | null, pageSize = 100): Promise<SpreadsheetFile[]> {
  const q = new URLSearchParams({
    q: spreadsheetQuery(search),
    fields: 'files(id,name,modifiedTime)',
    orderBy: 'modifiedTime desc',
    pageSize: String(Math.max(1, Math.min(pageSize, 200))),
    supportsAllDrives: 'true',
    includeItemsFromAllDrives: 'true',
    corpora: 'allDrives',
  });
  const res = await fetch(`${DRIVE_FILES}?${q.toString()}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(TIMEOUT_MS),
    cache: 'no-store',
  });
  const json = (await res.json().catch(() => ({}))) as {
    files?: { id?: string; name?: string; modifiedTime?: string }[];
    error?: { message?: string };
  };
  if (!res.ok) {
    if (res.status === 403) {
      throw new SheetsApiError(
        'This Google account cannot list spreadsheets yet. Sign in with Google again and allow access to file names (and make sure the Drive API is enabled).',
        403,
      );
    }
    throw new SheetsApiError(json.error?.message ?? `Google Drive error (${res.status})`, res.status);
  }
  return (json.files ?? [])
    .filter((f) => f.id && f.name)
    .map((f) => ({ id: f.id!, name: f.name!, modifiedTime: f.modifiedTime ?? null }));
}
