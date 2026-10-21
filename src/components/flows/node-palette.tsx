'use client';

/**
 * Bot Studio palette: searchable, collapsible categories, click to add.
 * Lists every addable node type — the original ten and the Bot Studio
 * additions — from the same catalogue as the list view.
 */

import { useMemo, useState } from 'react';
import { ChevronDown, Search, X } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils';
import { ADDABLE_NODE_TYPES, NodeIconChip, groupNodeTypesByCategory, type NodeType } from './shared';

/** dataTransfer type used when a step is dragged onto the canvas. */
export const NODE_DRAG_TYPE = 'application/bluetick-flow-node';

export function NodePalette({
  onAdd,
  onClose,
  embedded = false,
}: {
  onAdd: (type: NodeType) => void;
  onClose?: () => void;
  /** Rendered inside the Bot Studio side panel (no popover chrome). */
  embedded?: boolean;
}) {
  const t = useTranslations('Flows.builder');
  const tb = useTranslations('BotStudio.flows');
  const [q, setQ] = useState('');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const groups = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const types = needle
      ? ADDABLE_NODE_TYPES.filter((type) =>
          `${t(`nodes.${type}.label`)} ${t(`nodes.${type}.blurb`)}`.toLowerCase().includes(needle),
        )
      : ADDABLE_NODE_TYPES;
    return groupNodeTypesByCategory(types);
  }, [q, t]);

  return (
    <div
      className={
        embedded
          ? 'flex min-h-0 flex-1 flex-col'
          : 'border-border bg-popover flex max-h-[70vh] w-[280px] flex-col rounded-xl border shadow-[0_10px_30px_-10px_rgba(0,0,0,0.45)]'
      }
    >
      <div className="border-border flex items-center gap-2 border-b p-2">
        <Search className="text-muted-foreground h-4 w-4 shrink-0" />
        <input
          autoFocus={!embedded}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={tb('searchSteps')}
          aria-label={tb('searchSteps')}
          className="placeholder:text-muted-foreground min-w-0 flex-1 bg-transparent text-sm outline-none"
        />
        {onClose && (
          <button type="button" onClick={onClose} aria-label={tb('closePalette')} className="text-muted-foreground hover:text-foreground">
            <X className="h-4 w-4" />
          </button>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
        {groups.length === 0 && <p className="text-muted-foreground px-2 py-6 text-center text-xs">{tb('noStepMatch')}</p>}
        {groups.map((g) => {
          const isCollapsed = collapsed.has(g.id) && !q;
          return (
            <div key={g.id} className="mb-1">
              <button
                type="button"
                onClick={() =>
                  setCollapsed((prev) => {
                    const next = new Set(prev);
                    if (next.has(g.id)) next.delete(g.id);
                    else next.add(g.id);
                    return next;
                  })
                }
                aria-expanded={!isCollapsed}
                className="text-muted-foreground hover:text-foreground flex w-full items-center justify-between px-2 py-1.5 text-[11px] font-semibold tracking-wider uppercase"
              >
                {t(`categories.${g.id}`)}
                <ChevronDown className={cn('h-3.5 w-3.5 transition-transform', isCollapsed && '-rotate-90')} />
              </button>
              {!isCollapsed &&
                g.types.map((type) => (
                  <button
                    key={type}
                    type="button"
                    draggable
                    onDragStart={(e) => {
                      e.dataTransfer.setData(NODE_DRAG_TYPE, type);
                      e.dataTransfer.effectAllowed = 'move';
                    }}
                    title={tb('dragHint')}
                    onClick={() => onAdd(type)}
                    className="hover:bg-muted focus-visible:bg-muted flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left outline-none"
                  >
                    <NodeIconChip type={type} size={28} iconSize={16} className="rounded-md" />
                    <span className="min-w-0">
                      <span className="text-popover-foreground block truncate text-[13px] font-semibold">{t(`nodes.${type}.label`)}</span>
                      <span className="text-muted-foreground block truncate text-[11.5px]">{t(`nodes.${type}.blurb`)}</span>
                    </span>
                  </button>
                ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}
