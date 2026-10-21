'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import {
  Columns3,
  Eye,
  LayoutGrid,
  List,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Send,
  Trash2,
} from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { useCan } from '@/hooks/use-can';
import type { MessageTemplate } from '@/types';
import { templateStatusConfig } from '@/lib/template-status';
import {
  STATUS_GROUPS,
  countByGroup,
  filterTemplates,
  type StatusGroup,
} from '@/lib/campaigns/template-library';
import { loadViewPrefs, saveViewPrefs } from '@/lib/campaigns/view-prefs';
import { Button } from '@/components/ui/button';
import { GatedButton } from '@/components/ui/gated-button';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { TemplatePhonePreview } from './template-phone-preview';
import { TemplateWizard } from './template-wizard';
import { memberName, useMembers } from './use-members';

const COLUMNS = ['category', 'language', 'status', 'quality', 'createdBy', 'createdAt', 'lastUsed', 'buttons'] as const;
type Column = (typeof COLUMNS)[number];
const EDITABLE = new Set(['APPROVED', 'REJECTED', 'PAUSED']);

interface Prefs {
  columns: Column[];
  mode: 'list' | 'cards';
}
const DEFAULT_PREFS: Prefs = {
  columns: ['category', 'language', 'status', 'createdBy', 'createdAt', 'lastUsed'],
  mode: 'list',
};

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(iso));
}

/**
 * Template library: every template in the account, grouped by status,
 * searchable and filterable, with the template wizard for new ones.
 * Same table and APIs as the classic manager in Settings → Templates.
 */
export function TemplateLibrary() {
  const t = useTranslations('Campaigns.templates');
  const router = useRouter();
  const { user, accountId } = useAuth();
  const canManage = useCan('edit-settings');
  const canSend = useCan('send-messages');
  const members = useMembers();

  const [templates, setTemplates] = useState<MessageTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [search, setSearch] = useState('');
  const [group, setGroup] = useState<StatusGroup | 'all'>('all');
  const [category, setCategory] = useState('all');
  const [createdBy, setCreatedBy] = useState('all');
  const [prefs, setPrefs] = useState<Prefs>(DEFAULT_PREFS);
  const [showColumns, setShowColumns] = useState(false);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [editing, setEditing] = useState<MessageTemplate | null>(null);
  const [previewing, setPreviewing] = useState<MessageTemplate | null>(null);
  const [toDelete, setToDelete] = useState<MessageTemplate | null>(null);
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    // RLS scopes this to the caller's account — every member sees the
    // account's templates, not just the ones they created.
    const { data, error } = await createClient()
      .from('message_templates')
      .select('*')
      .order('created_at', { ascending: false });
    if (error) toast.error(t('loadFailed'));
    setTemplates((data ?? []) as MessageTemplate[]);
    setLoading(false);
  }, [t]);

  useEffect(() => {
    void load();
    void loadViewPrefs(createClient(), 'templates.library', DEFAULT_PREFS).then(setPrefs);
  }, [load]);

  function updatePrefs(next: Prefs) {
    setPrefs(next);
    if (user && accountId) void saveViewPrefs(createClient(), { userId: user.id, accountId }, 'templates.library', next);
  }

  async function sync() {
    setSyncing(true);
    try {
      const res = await fetch('/api/whatsapp/templates/sync', { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
      toast.success(t('synced', { inserted: data.inserted ?? 0, updated: data.updated ?? 0 }));
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('syncFailed'));
    } finally {
      setSyncing(false);
    }
  }

  async function confirmDelete() {
    if (!toDelete) return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/whatsapp/templates/${toDelete.id}`, { method: 'DELETE' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
      toast.success(t('deleted'));
      setToDelete(null);
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('deleteFailed'));
    } finally {
      setDeleting(false);
    }
  }

  const base = useMemo(
    () => filterTemplates(templates, { search, category, createdBy }),
    [templates, search, category, createdBy],
  );
  const counts = useMemo(() => countByGroup(base), [base]);
  const visible = useMemo(() => filterTemplates(base, { group }), [base, group]);
  const creators = useMemo(
    () => [...new Set(templates.map((x) => x.created_by ?? x.user_id).filter(Boolean))] as string[],
    [templates],
  );

  const openInBroadcast = (x: MessageTemplate) =>
    router.push(`/broadcasts/new?template=${encodeURIComponent(x.name)}&language=${encodeURIComponent(x.language ?? '')}`);

  function statusBadge(x: MessageTemplate) {
    const cfg = x.status ? templateStatusConfig[x.status] : null;
    return (
      <span className={`rounded-full border px-2 py-0.5 text-[11px] ${cfg?.classes ?? 'border-border text-muted-foreground'}`}>
        {cfg?.label ?? t('localOnly')}
      </span>
    );
  }

  function cell(x: MessageTemplate, c: Column) {
    switch (c) {
      case 'category':
        return t(`categories.${x.category}`);
      case 'language':
        return x.language ?? '—';
      case 'status':
        return statusBadge(x);
      case 'quality':
        return x.quality_score ?? '—';
      case 'createdBy':
        return memberName(members, x.created_by ?? x.user_id);
      case 'createdAt':
        return fmtDate(x.created_at);
      case 'lastUsed':
        return fmtDate(x.last_used_at);
      case 'buttons':
        return x.buttons?.length ? x.buttons.length : '—';
    }
  }

  function actions(x: MessageTemplate) {
    return (
      <div className="flex items-center justify-end gap-1">
        <IconButton label={t('preview')} onClick={() => setPreviewing(x)}><Eye className="h-4 w-4" /></IconButton>
        {canSend && x.status === 'APPROVED' && (
          <IconButton label={t('useInBroadcast')} onClick={() => openInBroadcast(x)}><Send className="h-4 w-4" /></IconButton>
        )}
        {canManage && EDITABLE.has(x.status ?? '') && (
          <IconButton label={t('edit')} onClick={() => { setEditing(x); setWizardOpen(true); }}><Pencil className="h-4 w-4" /></IconButton>
        )}
        {canManage && (
          <IconButton label={t('delete')} onClick={() => setToDelete(x)}><Trash2 className="h-4 w-4" /></IconButton>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-foreground">{t('title')}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{t('subtitle')}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <GatedButton canAct={canManage} gateReason="sync templates" variant="outline" onClick={() => void sync()} disabled={syncing}>
            <RefreshCw className={`h-4 w-4 ${syncing ? 'animate-spin' : ''}`} />
            {t('refresh')}
          </GatedButton>
          <GatedButton canAct={canManage} gateReason="create templates" onClick={() => { setEditing(null); setWizardOpen(true); }}>
            <Plus className="h-4 w-4" />
            {t('new')}
          </GatedButton>
        </div>
      </div>

      <div className="flex gap-1 overflow-x-auto border-b border-border" role="tablist">
        {(['all', ...STATUS_GROUPS] as const).map((g) => (
          <button
            key={g}
            role="tab"
            aria-selected={group === g}
            onClick={() => setGroup(g)}
            className={`-mb-px flex shrink-0 items-center gap-1.5 border-b-2 px-3 py-2 text-sm ${
              group === g ? 'border-primary font-medium text-primary' : 'border-transparent text-muted-foreground hover:text-foreground'
            }`}
          >
            {t(`groups.${g}`)}
            <span className="rounded-full bg-muted px-1.5 text-[11px] tabular-nums">{counts[g]}</span>
          </button>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[220px] flex-1">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t('search')} className="pl-8" />
        </div>
        <select value={category} onChange={(e) => setCategory(e.target.value)} className="h-9 rounded-md border border-border bg-muted px-2 text-sm" aria-label={t('category')}>
          <option value="all">{t('allCategories')}</option>
          {(['Marketing', 'Utility', 'Authentication'] as const).map((c) => (
            <option key={c} value={c}>{t(`categories.${c}`)}</option>
          ))}
        </select>
        <select value={createdBy} onChange={(e) => setCreatedBy(e.target.value)} className="h-9 rounded-md border border-border bg-muted px-2 text-sm" aria-label={t('agent')}>
          <option value="all">{t('allAgents')}</option>
          {creators.map((id) => (
            <option key={id} value={id}>{memberName(members, id)}</option>
          ))}
        </select>
        <div className="relative">
          <Button variant="outline" onClick={() => setShowColumns((s) => !s)} aria-expanded={showColumns}>
            <Columns3 className="h-4 w-4" />
            {t('viewOptions')}
          </Button>
          {showColumns && (
            <div className="absolute right-0 z-20 mt-1 w-56 space-y-1 rounded-lg border border-border bg-popover p-2 shadow-lg">
              {COLUMNS.map((c) => (
                <label key={c} className="flex items-center gap-2 rounded px-2 py-1 text-sm hover:bg-muted">
                  <input
                    type="checkbox"
                    checked={prefs.columns.includes(c)}
                    onChange={(e) =>
                      updatePrefs({
                        ...prefs,
                        columns: e.target.checked ? COLUMNS.filter((x) => x === c || prefs.columns.includes(x)) : prefs.columns.filter((x) => x !== c),
                      })
                    }
                  />
                  {t(`columns.${c}`)}
                </label>
              ))}
            </div>
          )}
        </div>
        <div className="flex rounded-lg border border-border p-0.5">
          <IconButton label={t('listView')} active={prefs.mode === 'list'} onClick={() => updatePrefs({ ...prefs, mode: 'list' })}><List className="h-4 w-4" /></IconButton>
          <IconButton label={t('cardView')} active={prefs.mode === 'cards'} onClick={() => updatePrefs({ ...prefs, mode: 'cards' })}><LayoutGrid className="h-4 w-4" /></IconButton>
        </div>
      </div>

      {loading ? (
        <div className="flex justify-center py-16"><Loader2 className="h-6 w-6 animate-spin text-primary" /></div>
      ) : visible.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border py-16 text-center text-sm text-muted-foreground">
          {templates.length === 0 ? t('emptyAll') : t('emptyFiltered')}
        </div>
      ) : prefs.mode === 'list' ? (
        <div className="overflow-x-auto rounded-xl border border-border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
              <tr>
                <th className="px-3 py-2 font-medium">{t('columns.name')}</th>
                {prefs.columns.map((c) => (
                  <th key={c} className="whitespace-nowrap px-3 py-2 font-medium">{t(`columns.${c}`)}</th>
                ))}
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {visible.map((x) => (
                <tr key={x.id} className="hover:bg-muted/30">
                  <td className="max-w-[320px] px-3 py-2">
                    <button className="font-medium text-foreground hover:underline" onClick={() => setPreviewing(x)}>{x.name}</button>
                    <p className="truncate text-xs text-muted-foreground">{x.body_text}</p>
                  </td>
                  {prefs.columns.map((c) => (
                    <td key={c} className="whitespace-nowrap px-3 py-2 text-muted-foreground">{cell(x, c)}</td>
                  ))}
                  <td className="px-3 py-2">{actions(x)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {visible.map((x) => (
            <div key={x.id} className="flex flex-col rounded-xl border border-border bg-card">
              <div className="flex items-start justify-between gap-2 p-3">
                <div className="min-w-0">
                  <p className="truncate font-medium text-foreground">{x.name}</p>
                  <p className="text-xs text-muted-foreground">
                    {t(`categories.${x.category}`)} · {x.language} · {t('lastUsedOn', { date: fmtDate(x.last_used_at) })}
                  </p>
                </div>
                {statusBadge(x)}
              </div>
              <div className="flex-1 px-3"><TemplatePhonePreview template={x} compact /></div>
              {x.status === 'REJECTED' && x.rejection_reason && (
                <p className="px-3 pt-2 text-xs text-red-500">{x.rejection_reason}</p>
              )}
              <div className="flex items-center justify-between border-t border-border p-2">
                <span className="text-xs text-muted-foreground">{memberName(members, x.created_by ?? x.user_id)}</span>
                {actions(x)}
              </div>
            </div>
          ))}
        </div>
      )}

      <TemplateWizard open={wizardOpen} onOpenChange={setWizardOpen} editing={editing} onSaved={() => void load()} />

      <Dialog open={!!previewing} onOpenChange={(o) => !o && setPreviewing(null)}>
        <DialogContent className="border-border bg-popover sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{previewing?.name}</DialogTitle>
            <DialogDescription>
              {previewing && `${t(`categories.${previewing.category}`)} · ${previewing.language ?? ''}`}
            </DialogDescription>
          </DialogHeader>
          {previewing && <TemplatePhonePreview template={previewing} />}
          {previewing?.rejection_reason && <p className="text-sm text-red-500">{previewing.rejection_reason}</p>}
        </DialogContent>
      </Dialog>

      <Dialog open={!!toDelete} onOpenChange={(o) => !o && setToDelete(null)}>
        <DialogContent className="border-border bg-popover sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{t('deleteTitle')}</DialogTitle>
            <DialogDescription>{t('deleteDesc', { name: toDelete?.name ?? '' })}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setToDelete(null)}>{t('cancel')}</Button>
            <Button variant="destructive" onClick={() => void confirmDelete()} disabled={deleting}>
              {deleting && <Loader2 className="h-4 w-4 animate-spin" />}
              {t('delete')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function IconButton({
  label,
  onClick,
  active,
  children,
}: {
  label: string;
  onClick: () => void;
  active?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      className={`rounded-md p-1.5 ${active ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-muted hover:text-foreground'}`}
    >
      {children}
    </button>
  );
}
