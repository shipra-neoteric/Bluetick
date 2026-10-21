'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { AllBroadcasts } from '@/components/broadcasts/all-broadcasts';
import { BroadcastWorkspace } from '@/components/campaigns/broadcast-workspace';

type Tab = 'lists' | 'all';
const TAB_KEY = 'bluetick.broadcasts.tab';

/**
 * Broadcasts: the list workspace (lists / history / members) and the
 * original table of every broadcast, side by side as tabs.
 */
export default function BroadcastsPage() {
  const t = useTranslations('Campaigns.lists');
  const [tab, setTab] = useState<Tab>('lists');

  useEffect(() => {
    try {
      const saved = localStorage.getItem(TAB_KEY);
      // eslint-disable-next-line react-hooks/set-state-in-effect -- restore last tab
      if (saved === 'all' || saved === 'lists') setTab(saved);
    } catch {
      // Storage blocked — default tab.
    }
  }, []);

  function choose(next: Tab) {
    setTab(next);
    try {
      localStorage.setItem(TAB_KEY, next);
    } catch {
      // ignore
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex gap-1 border-b border-border" role="tablist">
        {(['lists', 'all'] as const).map((k) => (
          <button
            key={k}
            role="tab"
            aria-selected={tab === k}
            onClick={() => choose(k)}
            className={`-mb-px border-b-2 px-3 py-2 text-sm ${
              tab === k ? 'border-primary font-medium text-primary' : 'border-transparent text-muted-foreground hover:text-foreground'
            }`}
          >
            {t(k === 'lists' ? 'tabLists' : 'tabAll')}
          </button>
        ))}
      </div>
      {tab === 'lists' ? <BroadcastWorkspace /> : <AllBroadcasts />}
    </div>
  );
}
