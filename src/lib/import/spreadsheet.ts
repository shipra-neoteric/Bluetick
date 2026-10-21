/**
 * Shared spreadsheet I/O for contact imports (Customers page, broadcast
 * lists, quick import) and exports.
 *
 * Reading: .csv / .tsv go through the existing RFC-4180 parser
 * (`parseCsvTable`) so text — leading `+`, leading zeros — is kept exactly.
 * .xlsx / .xls / .ods are read with SheetJS using cached cell values only:
 * formulas are never evaluated or exported, macros are ignored.
 *
 * Numeric phone cells: Excel stores 919876543210 as a number and its
 * *display* text is often "9.19876E+11". We read the raw value and print
 * integers in full, and flag anything that still looks like scientific
 * notation so it is rejected rather than silently corrupted.
 */

import * as XLSX from 'xlsx';
import { parseCsvTable, type CsvTable } from '@/lib/contacts/csv-mapping';

export const IMPORT_EXTENSIONS = ['csv', 'tsv', 'xlsx', 'xls', 'ods'] as const;
export const IMPORT_ACCEPT = '.csv,.tsv,.xlsx,.xls,.ods,text/csv';
/** Bounded so a browser tab can parse and preview without stalling. */
export const MAX_IMPORT_BYTES = 5 * 1024 * 1024;
export const MAX_IMPORT_ROWS = 20_000;

export type SpreadsheetResult =
  | { ok: true; table: CsvTable; truncated: boolean }
  | { ok: false; error: string };

function extOf(name: string): string {
  const i = name.lastIndexOf('.');
  return i >= 0 ? name.slice(i + 1).toLowerCase() : '';
}

/** Render a raw cell value as import text without losing digits. */
export function cellToText(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') {
    if (Number.isInteger(v) && Math.abs(v) < 1e21) return v.toFixed(0);
    return String(v);
  }
  if (v instanceof Date) return v.toISOString();
  return String(v).trim();
}

export function bound(table: CsvTable): { table: CsvTable; truncated: boolean } {
  if (table.rows.length <= MAX_IMPORT_ROWS) return { table, truncated: false };
  return { table: { headers: table.headers, rows: table.rows.slice(0, MAX_IMPORT_ROWS) }, truncated: true };
}

/** Parse workbook bytes (first sheet). Exported for tests. */
export function parseWorkbook(data: ArrayBuffer | Uint8Array): CsvTable {
  const wb = XLSX.read(data, {
    type: 'array',
    cellFormula: false, // never read or keep formulas
    cellHTML: false,
    cellDates: false,
    dense: true,
  });
  const sheetName = wb.SheetNames[0];
  if (!sheetName) return { headers: [], rows: [] };
  const rows = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[sheetName], {
    header: 1,
    raw: true,
    defval: '',
    blankrows: false,
  });
  const text = rows.map((r) => (Array.isArray(r) ? r.map(cellToText) : []));
  const nonBlank = text.filter((r) => r.some((c) => c !== ''));
  if (nonBlank.length === 0) return { headers: [], rows: [] };
  const [headers, ...body] = nonBlank;
  return { headers, rows: body };
}

export async function readSpreadsheetFile(file: File): Promise<SpreadsheetResult> {
  const ext = extOf(file.name);
  if (!(IMPORT_EXTENSIONS as readonly string[]).includes(ext)) {
    return { ok: false, error: 'Unsupported file type. Use .xlsx, .xls, .ods or .csv.' };
  }
  if (file.size > MAX_IMPORT_BYTES) {
    return { ok: false, error: 'File is larger than 5 MB. Split it into smaller files.' };
  }
  try {
    const table =
      ext === 'csv' || ext === 'tsv'
        ? parseCsvTable(await file.text())
        : parseWorkbook(new Uint8Array(await file.arrayBuffer()));
    if (table.headers.length === 0 || table.rows.length === 0) {
      return { ok: false, error: 'No data found. The first row must be column headings.' };
    }
    return { ok: true, ...bound(table) };
  } catch {
    return { ok: false, error: 'Could not read this file. Is it a valid spreadsheet?' };
  }
}

/** Looks like a phone that a spreadsheet turned into scientific notation. */
export function isScientificNotation(value: string): boolean {
  return /^\d(\.\d+)?e\+?\d+$/i.test(value.trim());
}

// ── Quick import (paste) ───────────────────────────────────────────────

/**
 * Parse pasted contacts: one per line, "name, phone", "phone, name",
 * "phone<TAB>name" or just "phone". Returned as a CsvTable with fixed
 * headers so it goes through the same mapping + validation as files.
 */
export function parseQuickImport(text: string): CsvTable {
  const rows: string[][] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const parts = line.split(/\t|,|;/).map((p) => p.trim()).filter(Boolean);
    const phoneIdx = parts.findIndex((p) => /^[+\d][\d\s().-]{5,}$/.test(p));
    if (phoneIdx === -1) {
      rows.push(['', line]);
      continue;
    }
    const phone = parts[phoneIdx];
    const name = parts.filter((_, i) => i !== phoneIdx).join(' ');
    rows.push([phone, name]);
  }
  return { headers: ['Phone', 'Name'], rows };
}

// ── Export ─────────────────────────────────────────────────────────────

/**
 * Neutralise spreadsheet formula injection (CSV/Excel "DDE" attacks) for
 * CSV exports: a cell starting with = + - @ TAB or CR is prefixed with an
 * apostrophe. Plain phone numbers like "+919876543210" are left as-is —
 * they can't form a formula and the `+` is meaningful.
 */
export function safeCsvCell(value: unknown): string {
  let s = value === null || value === undefined ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(s) && !/^\+?[\d\s().-]+$/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(headers: string[], rows: unknown[][]): string {
  return [headers, ...rows].map((r) => r.map(safeCsvCell).join(',')).join('\r\n');
}

/**
 * XLSX export with every cell written as a TEXT cell — no formulas can be
 * created and phone numbers keep their `+` and digits.
 */
export function toXlsxBytes(headers: string[], rows: unknown[][], sheetName = 'Contacts'): Uint8Array {
  const aoa = [headers, ...rows].map((r) => r.map((v) => (v === null || v === undefined ? '' : String(v))));
  const ws = XLSX.utils.aoa_to_sheet(aoa, { cellDates: false });
  // Force text type for every cell (aoa_to_sheet already uses 's' for
  // strings; this guards against future type inference changes).
  for (const key of Object.keys(ws)) {
    if (key.startsWith('!')) continue;
    const cell = ws[key] as XLSX.CellObject;
    cell.t = 's';
    cell.v = String(cell.v ?? '');
    delete cell.f;
  }
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, sheetName.slice(0, 31));
  return XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as Uint8Array;
}

/** Trigger a browser download. */
export function downloadBlob(data: BlobPart, filename: string, type: string): void {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Sample file users can fill in (synthetic example rows only). */
export function sampleImportRows(): { headers: string[]; rows: string[][] } {
  return {
    headers: ['Phone', 'Name', 'Email', 'Company', 'Tags'],
    rows: [
      ['+919000000001', 'Sample Customer', 'customer@example.com', 'Example Co', 'Garden City, Hot lead'],
      ['9000000002', 'Another Customer', '', '', 'Nature Park'],
    ],
  };
}
