import { describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import {
  cellToText,
  isScientificNotation,
  parseQuickImport,
  parseWorkbook,
  safeCsvCell,
  toCsv,
  toXlsxBytes,
} from './spreadsheet';

function workbookBytes(aoa: unknown[][], bookType: XLSX.BookType = 'xlsx'): Uint8Array {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), 'Sheet1');
  return XLSX.write(wb, { type: 'array', bookType }) as Uint8Array;
}

describe('parseWorkbook', () => {
  it('reads xlsx with numeric phone cells printed in full (no 9.19E+11)', () => {
    const t = parseWorkbook(workbookBytes([['Phone', 'Name'], [919876543210, 'Asha'], ['+919000000001', 'Ravi']]));
    expect(t.headers).toEqual(['Phone', 'Name']);
    expect(t.rows).toEqual([['919876543210', 'Asha'], ['+919000000001', 'Ravi']]);
  });

  it('reads ods and xls too', () => {
    for (const bt of ['ods', 'biff8'] as XLSX.BookType[]) {
      const t = parseWorkbook(workbookBytes([['phone'], ['+15550000001']], bt));
      expect(t.rows).toEqual([['+15550000001']]);
    }
  });

  it('never evaluates or keeps formulas — only the cached value', () => {
    const ws = XLSX.utils.aoa_to_sheet([['Name'], ['x']]);
    ws.A2 = { t: 's', v: 'cached', f: 'HYPERLINK("http://evil","x")' };
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'S');
    const t = parseWorkbook(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }));
    expect(t.rows).toEqual([['cached']]);
  });
});

describe('cell helpers', () => {
  it('prints integers in full and flags scientific notation', () => {
    expect(cellToText(919876543210)).toBe('919876543210');
    expect(isScientificNotation('9.19876E+11')).toBe(true);
    expect(isScientificNotation('+919876543210')).toBe(false);
  });
});

describe('parseQuickImport', () => {
  it('accepts name/phone in either order and bare numbers', () => {
    const t = parseQuickImport('Asha, +91 98765 43210\n+919000000001\t Ravi\n9000000002\n\nnot a number');
    expect(t.rows).toEqual([
      ['+91 98765 43210', 'Asha'],
      ['+919000000001', 'Ravi'],
      ['9000000002', ''],
      ['', 'not a number'],
    ]);
  });
});

describe('export safety', () => {
  it('neutralises formula injection but keeps phone numbers intact', () => {
    expect(safeCsvCell('=HYPERLINK("http://x")')).toBe(`"'=HYPERLINK(""http://x"")"`);
    expect(safeCsvCell('@SUM(1)')).toBe("'@SUM(1)");
    expect(safeCsvCell('-2+3')).toBe("'-2+3");
    expect(safeCsvCell('+919876543210')).toBe('+919876543210');
    expect(toCsv(['a', 'b'], [['x,y', null]])).toBe('a,b\r\n"x,y",');
  });

  it('writes xlsx exports as text cells with no formulas', () => {
    const bytes = toXlsxBytes(['Phone', 'Note'], [['+919876543210', '=1+1']]);
    const wb = XLSX.read(bytes, { type: 'array', cellFormula: true });
    const ws = wb.Sheets[wb.SheetNames[0]];
    expect(ws.A2.v).toBe('+919876543210');
    expect(ws.B2.t).toBe('s');
    expect(ws.B2.f).toBeUndefined();
  });
});
