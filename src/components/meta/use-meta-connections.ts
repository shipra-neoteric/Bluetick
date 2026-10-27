"use client";

/**
 * Connected Facebook accounts (migration 054), shared by the "Lead From
 * CTWA" trigger card and Settings → Integrations, plus the Facebook
 * Login popup. The popup ends on /api/meta/callback, which messages this
 * window (postMessage, or BroadcastChannel when Facebook cut the opener
 * link) with the new connection id and the person's name.
 */

import { useCallback, useEffect, useState } from "react";

export interface MetaConnection {
  id: string;
  fb_user_id: string;
  name: string | null;
  connected_at: string;
  token_expires_at: string | null;
  error: string | null;
}

export interface MetaConnectionsState {
  /** Facebook Login has META_APP_ID + secret + site URL on the server. */
  configured: boolean;
  /** false = migration 054 not run yet. */
  available: boolean;
  connections: MetaConnection[];
}

export function useMetaConnections() {
  const [state, setState] = useState<MetaConnectionsState | null>(null);
  const [failed, setFailed] = useState(false);
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((n) => n + 1), []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/meta/connections", { cache: "no-store" });
        const json = (await res.json().catch(() => ({}))) as Partial<MetaConnectionsState>;
        if (cancelled) return;
        if (!res.ok) {
          setFailed(true);
          setState({ configured: false, available: true, connections: [] });
          return;
        }
        setFailed(false);
        setState({ configured: Boolean(json.configured), available: json.available !== false, connections: json.connections ?? [] });
      } catch {
        if (!cancelled) {
          setFailed(true);
          setState({ configured: false, available: true, connections: [] });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tick]);

  return { state, failed, reload };
}

export type PopupResult = { ok: true; id: string; name: string | null } | { ok: false; reason: string };

const CONNECTED = "bluetick:meta-connected";
const FAILED = "bluetick:meta-failed";
const CHANNEL = "bluetick:meta";

/**
 * Open Facebook Login in a popup. Call from a click / change handler
 * (popup blockers). `done` resolves once with the outcome ("blocked" when
 * the window could not open, "cancelled" after cancel()). The popup's
 * `closed` flag is not used: it reads true while the popup is on
 * facebook.com in browsers that isolate it (COOP), so the UI offers
 * Cancel instead.
 */
export function connectFacebookPopup(): { done: Promise<PopupResult>; cancel: () => void } {
  let finish: (r: PopupResult) => void = () => {};
  const done = new Promise<PopupResult>((resolve) => {
    const w = 600;
    const h = 720;
    const left = Math.max(0, window.screenX + (window.outerWidth - w) / 2);
    const top = Math.max(0, window.screenY + (window.outerHeight - h) / 2);
    const popup = window.open("/api/meta/connect?popup=1", "bluetick-meta-login", `popup=yes,width=${w},height=${h},left=${left},top=${top}`);
    if (!popup) {
      resolve({ ok: false, reason: "blocked" });
      return;
    }
    let settled = false;
    let channel: BroadcastChannel | null = null;
    const handle = (data: unknown) => {
      const m = data as { type?: string; id?: string; name?: string | null; result?: string } | null;
      if (m?.type === CONNECTED && typeof m.id === "string") finish({ ok: true, id: m.id, name: m.name ?? null });
      else if (m?.type === FAILED) finish({ ok: false, reason: m.result ?? "error" });
    };
    const onMessage = (e: MessageEvent) => {
      if (e.origin === window.location.origin) handle(e.data);
    };
    finish = (r) => {
      if (settled) return;
      settled = true;
      window.removeEventListener("message", onMessage);
      channel?.close();
      resolve(r);
    };
    window.addEventListener("message", onMessage);
    try {
      channel = new BroadcastChannel(CHANNEL);
      channel.onmessage = (e) => handle(e.data);
    } catch {
      channel = null;
    }
  });
  return { done, cancel: () => finish({ ok: false, reason: "cancelled" }) };
}
