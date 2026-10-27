import { describe, expect, it } from 'vitest';
import { a1, buildRow, columnLetter, headerKeys, headerProblems, isBlankRow, letterHeaders, parseSpreadsheetId, rowToRecord } from './sheets';
import { findColumn, rowKey, tabKeyOf } from './sheet-trigger';

describe('Google Sheets helpers', () => {
  it('reads the spreadsheet id from a link or a bare id', () => {
    const id = '1AbCdEfGhIjKlMnOpQrStUvWxYz_0123456789-xy';
    expect(parseSpreadsheetId(`https://docs.google.com/spreadsheets/d/${id}/edit#gid=0`)).toBe(id);
    expect(parseSpreadsheetId(id)).toBe(id);
    expect(parseSpreadsheetId('https://example.com/not-a-sheet')).toBeNull();
    expect(parseSpreadsheetId('')).toBeNull();
  });

  it('quotes tab names for A1 ranges', () => {
    expect(a1('Leads', 'A1:ZZ1')).toBe("'Leads'!A1:ZZ1");
    expect(a1("Bob's leads")).toBe("'Bob''s leads'");
  });

  it('turns headers into unique variable keys', () => {
    expect(headerKeys(['Phone Number', 'Name', 'name', '', 'E-mail!'])).toEqual([
      'phone_number',
      'name',
      'name_2',
      'col_4',
      'e_mail',
    ]);
  });

  it('maps a row by header and skips blank rows', () => {
    expect(rowToRecord(['Name', 'Phone'], ['Asha', 9876543210])).toEqual({ name: 'Asha', phone: '9876543210' });
    expect(rowToRecord(['Name', 'Phone'], ['Asha'])).toEqual({ name: 'Asha', phone: '' });
    expect(isBlankRow(['', '  ', null])).toBe(true);
    expect(isBlankRow(['', 'x'])).toBe(false);
  });

  it('builds the row to append by header name (case-insensitive)', () => {
    const r = buildRow(['Name', 'Phone', 'Source', 'Notes'], [
      { column: 'phone', value: '+919876543210' },
      { column: 'Name', value: 'Asha' },
      { column: 'City', value: 'Pune' },
    ]);
    expect(r.row).toEqual(['Asha', '+919876543210']);
    expect(r.unknown).toEqual(['City']);
  });

  it('finds the phone column whatever its case or spacing', () => {
    expect(findColumn(['Name', ' Phone '], 'phone')).toBe(1);
    expect(findColumn(['Name'], 'Phone')).toBe(-1);
  });

  it('names columns by letter when the first row is data', () => {
    expect([0, 25, 26, 701].map(columnLetter)).toEqual(['A', 'Z', 'AA', 'ZZ']);
    expect(letterHeaders(3)).toEqual(['Column A', 'Column B', 'Column C']);
  });

  it('reports duplicate and blank headers instead of remapping', () => {
    expect(headerProblems(['Name', 'Phone', 'phone ', '', 'City', ''])).toEqual({ duplicates: ['Phone'], blank: [3] });
    expect(headerProblems(['Name', 'Phone'])).toEqual({ duplicates: [], blank: [] });
  });

  it('identifies a tab by its stable id and a row by position + content', () => {
    expect(tabKeyOf({ sheet_name: 'Leads', sheet_id: 0 })).toBe('#0');
    expect(tabKeyOf({ sheet_name: 'Leads' })).toBe('Leads');
    const k = rowKey('s1', '#0', 5, ['Asha', 98765]);
    expect(rowKey('s1', '#0', 5, ['Asha', '98765'])).toBe(k);
    expect(rowKey('s1', '#0', 6, ['Asha', 98765])).not.toBe(k);
    expect(rowKey('s1', '#0', 5, ['Asha B', 98765])).not.toBe(k);
  });
});
