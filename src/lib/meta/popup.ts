/**
 * The page the Facebook Login popup (opened from the Bot Builder or
 * Settings) ends on: it tells the opener what happened and closes itself.
 *
 * Two channels, same origin only: window.opener.postMessage, and a
 * BroadcastChannel for browsers that cut the opener link while the popup
 * was on facebook.com (Cross-Origin-Opener-Policy). Only the connection
 * id, the person's name and a result code are sent — never a token.
 */

import { NextResponse } from 'next/server';

export const META_POPUP_CHANNEL = 'bluetick:meta';
export const META_CONNECTED_MESSAGE = 'bluetick:meta-connected';
export const META_FAILED_MESSAGE = 'bluetick:meta-failed';

export type MetaPopupOutcome = { result: 'connected'; id: string; name: string | null } | { result: string };

export function metaPopupMessage(outcome: MetaPopupOutcome): Record<string, unknown> {
  return outcome.result === 'connected' && 'id' in outcome
    ? { type: META_CONNECTED_MESSAGE, id: outcome.id, name: outcome.name }
    : { type: META_FAILED_MESSAGE, result: outcome.result };
}

/** JSON safe to place inside an inline <script>. */
export function scriptJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');
}

export function metaPopupResult(outcome: MetaPopupOutcome): NextResponse {
  const msg = scriptJson(metaPopupMessage(outcome));
  const ok = outcome.result === 'connected';
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Facebook</title></head>
<body style="font-family:system-ui,sans-serif;padding:24px;color:#333">
<p>${ok ? 'Facebook account connected.' : 'Facebook login did not finish.'} You can close this window.</p>
<script>
(function () {
  var m = ${msg};
  try { if (window.opener) window.opener.postMessage(m, location.origin); } catch (e) {}
  try { var c = new BroadcastChannel(${scriptJson(META_POPUP_CHANNEL)}); c.postMessage(m); c.close(); } catch (e) {}
  setTimeout(function () { window.close(); }, 150);
})();
</script></body></html>`;
  return new NextResponse(html, {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}
