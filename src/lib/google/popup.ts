/**
 * The page the Google OAuth popup (opened from the Bot Builder) ends on:
 * it tells the builder what happened and closes itself.
 *
 * Two channels, same origin only: window.opener.postMessage, and a
 * BroadcastChannel for browsers that cut the opener link while the popup
 * was on accounts.google.com (Cross-Origin-Opener-Policy). Only ids, the
 * email and a result code are sent — never a token.
 */

import { NextResponse } from 'next/server';

export const GOOGLE_POPUP_CHANNEL = 'bluetick:google';
export const GOOGLE_CONNECTED_MESSAGE = 'bluetick:google-connected';
export const GOOGLE_FAILED_MESSAGE = 'bluetick:google-failed';

export type PopupOutcome = { result: 'connected'; id: string; email: string | null } | { result: string };

export function popupMessage(outcome: PopupOutcome): Record<string, unknown> {
  return outcome.result === 'connected' && 'id' in outcome
    ? { type: GOOGLE_CONNECTED_MESSAGE, id: outcome.id, email: outcome.email }
    : { type: GOOGLE_FAILED_MESSAGE, result: outcome.result };
}

/** JSON safe to place inside an inline <script>. */
export function scriptJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');
}

export function popupResult(outcome: PopupOutcome): NextResponse {
  const msg = scriptJson(popupMessage(outcome));
  const ok = outcome.result === 'connected';
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Google</title></head>
<body style="font-family:system-ui,sans-serif;padding:24px;color:#333">
<p>${ok ? 'Google account connected.' : 'Google sign-in did not finish.'} You can close this window.</p>
<script>
(function () {
  var m = ${msg};
  try { if (window.opener) window.opener.postMessage(m, location.origin); } catch (e) {}
  try { var c = new BroadcastChannel(${scriptJson(GOOGLE_POPUP_CHANNEL)}); c.postMessage(m); c.close(); } catch (e) {}
  setTimeout(function () { window.close(); }, 150);
})();
</script></body></html>`;
  return new NextResponse(html, {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}
