'use client';

import { useEffect, useState } from 'react';

export interface MemberLite {
  user_id: string;
  full_name: string;
  email?: string | null;
}

/**
 * Account members for "Created by" columns and agent filters. Uses the
 * existing /api/account/members route (role-aware: emails only for
 * admins). Empty on failure — callers then show "—", never a guess.
 */
export function useMembers(): Map<string, MemberLite> {
  const [members, setMembers] = useState<Map<string, MemberLite>>(new Map());
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch('/api/account/members', { cache: 'no-store' });
        if (!res.ok) return;
        const json = (await res.json()) as { members?: MemberLite[] };
        if (!cancelled) {
          setMembers(new Map((json.members ?? []).map((m) => [m.user_id, m])));
        }
      } catch {
        // Members endpoint unreachable — names render as "—".
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);
  return members;
}

export function memberName(members: Map<string, MemberLite>, id: string | null | undefined): string {
  if (!id) return '—';
  const m = members.get(id);
  return m?.full_name || m?.email || '—';
}
