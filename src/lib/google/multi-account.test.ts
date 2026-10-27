import { describe, expect, it } from 'vitest';
import { spreadsheetQuery } from './sheets';
import { connectionProblem, isContactId } from './sheet-trigger';
import { buildAuthUrl, isPopupState, oauthState } from './oauth';
import { GOOGLE_CONNECTED_MESSAGE, GOOGLE_FAILED_MESSAGE, popupMessage, scriptJson } from './popup';

describe('Google multi-account helpers', () => {
  it('lists only spreadsheets and escapes the name search', () => {
    expect(spreadsheetQuery()).toBe("mimeType='application/vnd.google-apps.spreadsheet' and trashed=false");
    expect(spreadsheetQuery('  ')).toBe(spreadsheetQuery());
    // Input: Bob's \ leads  →  Drive query: 'Bob\'s \\ leads'
    expect(spreadsheetQuery("Bob's \\ leads")).toBe(
      "mimeType='application/vnd.google-apps.spreadsheet' and trashed=false and name contains 'Bob\\'s \\\\ leads'",
    );
  });

  it('uses the chosen connection, else the oldest, and never a broken one', () => {
    const list = [
      { id: 'a', account_id: 'x', last_error: null },
      { id: 'b', account_id: 'x', last_error: 'revoked' },
    ];
    expect(connectionProblem(list)).toBeNull();
    expect(connectionProblem(list, 'a')).toBeNull();
    expect(connectionProblem(list, 'b')).toMatch(/revoked/);
    expect(connectionProblem(list, 'gone')).toMatch(/disconnected/);
    expect(connectionProblem([], undefined)).toMatch(/disconnected/);
  });

  it('accepts only uuid customer ids', () => {
    expect(isContactId(' 0f8fad5b-d9cb-469f-a165-70867728950e ')).toBe(true);
    expect(isContactId('12345')).toBe(false);
    expect(isContactId("x' or 1=1")).toBe(false);
  });

  it('marks popup sign-ins in the state and asks Google for an account chooser', () => {
    expect(isPopupState(oauthState('r4nd0m', true))).toBe(true);
    expect(isPopupState(oauthState('r4nd0m', false))).toBe(false);
    const url = new URL(buildAuthUrl('s'));
    expect(url.searchParams.get('prompt')).toBe('consent select_account');
    expect(url.searchParams.get('scope')).toContain('drive.metadata.readonly');
  });

  it('builds popup messages that cannot break out of the script tag', () => {
    expect(popupMessage({ result: 'connected', id: 'i', email: 'e@x' })).toEqual({ type: GOOGLE_CONNECTED_MESSAGE, id: 'i', email: 'e@x' });
    expect(popupMessage({ result: 'denied' })).toEqual({ type: GOOGLE_FAILED_MESSAGE, result: 'denied' });
    const s = scriptJson({ email: '</script><script>alert(1)</script>&' });
    expect(s).not.toMatch(/[<>&]/);
    expect(JSON.parse(s)).toEqual({ email: '</script><script>alert(1)</script>&' });
  });
});
