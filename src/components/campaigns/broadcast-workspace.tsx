'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import {
  CalendarClock,
  ChevronRight,
  ClipboardPaste,
  Loader2,
  Lock,
  Plus,
  Search,
  Send,
  ShieldCheck,
  Upload,
  UserMinus,
  UserPlus,
  Users,
} from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { useCan } from '@/hooks/use-can';
import type { Broadcast, MessageTemplate, Tag } from '@/types';
import { deleteContactTag } from '@/lib/contacts/tag-api';
import { getBroadcastStatus } from '@/lib/broadcast-status';
import { metricsFromBroadcast } from '@/lib/campaigns/broadcast-metrics';
import { COUNTRY_CODES, addMemberToList, composePhone } from '@/lib/campaigns/list-members';
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
import { ImportModal } from '@/components/contacts/import-modal';
import { ContactDetailView } from '@/components/contacts/contact-detail-view';
import { BroadcastMetricsBar } from './broadcast-metrics-bar';
import { TemplatePhonePreview } from './template-phone-preview';

const MEMBER_PAGE = 50;

interface Member {
  id: string;
  name: string | null;
  phone: string;
  opt_in_status?: string | null;
}

/** Was this broadcast sent to `tagId`? (single-list audience or tag filter) */
export function broadcastTargetsTag(b: Broadcast, tagId: string): boolean {
  if (b.audience_tag_id) return b.audience_tag_id === tagId;
  const f = b.audience_filter as { type?: string; tagIds?: string[] } | undefined;
  return f?.type === 'tags' && Array.isArray(f.tagIds) && f.tagIds.includes(tagId);
}

/**
 * Broadcast workspace: lists | history | members.
 * Lists are the account's tags — the same audience as Customers
 * segments and Contacts groups, so nothing can drift apart.
 */
export function BroadcastWorkspace() {
  const t = useTranslations('Campaigns.lists');
  const tStatus = useTranslations('Broadcasts.status');
  const router = useRouter();
  const { user, accountId } = useAuth();
  const canEdit = useCan('edit-settings');
  const canSend = useCan('send-messages');

  const [tags, setTags] = useState<Tag[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [listSearch, setListSearch] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [broadcasts, setBroadcasts] = useState<Broadcast[]>([]);
  const [templates, setTemplates] = useState<Map<string, MessageTemplate>>(new Map());
  const [members, setMembers] = useState<Member[]>([]);
  const [memberTotal, setMemberTotal] = useState(0);
  const [memberSearch, setMemberSearch] = useState('');
  const [memberPage, setMemberPage] = useState(0);
  const [loadingLists, setLoadingLists] = useState(true);
  const [loadingMembers, setLoadingMembers] = useState(false);
  const [newListOpen, setNewListOpen] = useState(false);
  const [newListName, setNewListName] = useState('');
  const [addOpen, setAddOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [importMode, setImportMode] = useState<'file' | 'paste'>('file');
  const [accessOpen, setAccessOpen] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);

  const selected = tags.find((x) => x.id === selectedId) ?? null;

  const loadLists = useCallback(async () => {
    const supabase = createClient();
    const { data } = await supabase.from('tags').select('*').order('name');
    const list = ((data ?? []) as Tag[]).filter((x) => !x.archived_at);
    setTags(list);
    setSelectedId((cur) => cur ?? list[0]?.id ?? null);
    setLoadingLists(false);
    const perTag = await Promise.all(
      list.map((x) =>
        supabase.from('contact_tags').select('id', { count: 'exact', head: true }).eq('tag_id', x.id),
      ),
    );
    setCounts(Object.fromEntries(list.map((x, i) => [x.id, perTag[i].count ?? 0])));
  }, []);

  const loadHistory = useCallback(async () => {
    const supabase = createClient();
    const { data } = await supabase
      .from('broadcasts')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(500);
    const list = (data ?? []) as Broadcast[];
    setBroadcasts(list);
    const names = [...new Set(list.map((b) => b.template_name))];
    if (names.length) {
      const { data: tpl } = await supabase.from('message_templates').select('*').in('name', names);
      setTemplates(new Map(((tpl ?? []) as MessageTemplate[]).map((x) => [x.name, x])));
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch on mount
    void loadLists();
    void loadHistory();
  }, [loadLists, loadHistory]);

  const loadMembers = useCallback(async () => {
    if (!selectedId) return;
    setLoadingMembers(true);
    const q = memberSearch.trim().replace(/[%,()]/g, ' ');
    let query = createClient()
      .from('contact_tags')
      .select('contact:contacts!inner(id, name, phone, opt_in_status)', { count: 'exact' })
      .eq('tag_id', selectedId);
    if (q) query = query.or(`name.ilike.%${q}%,phone.ilike.%${q}%`, { referencedTable: 'contacts' });
    const first = await query.range(memberPage * MEMBER_PAGE, memberPage * MEMBER_PAGE + MEMBER_PAGE - 1);
    let { data, count } = first as { data: unknown[] | null; count: number | null };
    if (first.error) {
      // Pre-044: no opt_in_status column.
      let legacy = createClient()
        .from('contact_tags')
        .select('contact:contacts!inner(id, name, phone)', { count: 'exact' })
        .eq('tag_id', selectedId);
      if (q) legacy = legacy.or(`name.ilike.%${q}%,phone.ilike.%${q}%`, { referencedTable: 'contacts' });
      ({ data, count } = (await legacy.range(memberPage * MEMBER_PAGE, memberPage * MEMBER_PAGE + MEMBER_PAGE - 1)) as {
        data: unknown[] | null;
        count: number | null;
      });
    }
    const rows = ((data ?? []) as unknown as { contact: Member | Member[] }[])
      .map((r) => (Array.isArray(r.contact) ? r.contact[0] : r.contact))
      .filter(Boolean);
    setMembers(rows);
    setMemberTotal(count ?? rows.length);
    setLoadingMembers(false);
  }, [selectedId, memberSearch, memberPage]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- refetch on list/search/page change
    void loadMembers();
  }, [loadMembers]);

  const history = useMemo(
    () => (selectedId ? broadcasts.filter((b) => broadcastTargetsTag(b, selectedId)) : []),
    [broadcasts, selectedId],
  );
  const visibleLists = tags.filter((x) => x.name.toLowerCase().includes(listSearch.trim().toLowerCase()));

  async function createList() {
    const name = newListName.trim();
    if (!name || !user || !accountId) return;
    const { data, error } = await createClient()
      .from('tags')
      .insert({ name, user_id: user.id, account_id: accountId, color: '#25D366' })
      .select('*')
      .single();
    if (error) {
      toast.error(error.code === '23505' ? t('listExists') : t('listCreateFailed'));
      return;
    }
    toast.success(t('listCreated'));
    setNewListOpen(false);
    setNewListName('');
    await loadLists();
    setSelectedId((data as Tag).id);
  }

  async function removeMember(m: Member) {
    if (!selectedId) return;
    try {
      await deleteContactTag(m.id, selectedId);
      toast.success(t('memberRemoved'));
      setCounts((c) => ({ ...c, [selectedId]: Math.max(0, (c[selectedId] ?? 1) - 1) }));
      void loadMembers();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('memberRemoveFailed'));
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-foreground">{t('title')}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{t('subtitle')}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={() => router.push('/broadcasts/scheduled')}>
            <CalendarClock className="h-4 w-4" />
            {t('scheduled')}
          </Button>
          <GatedButton canAct={canSend} gateReason="create broadcasts" onClick={() => router.push('/broadcasts/new')}>
            <Plus className="h-4 w-4" />
            {t('newBroadcast')}
          </GatedButton>
        </div>
      </div>

      <div className="grid min-h-[560px] gap-4 lg:grid-cols-[260px_minmax(0,1fr)_320px]">
        {/* ── Lists ─────────────────────────────────────────── */}
        <section className="flex flex-col rounded-xl border border-border bg-card">
          <div className="space-y-2 border-b border-border p-3">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold">{t('lists')}</h2>
              <GatedButton canAct={canEdit} gateReason="create lists" size="sm" variant="outline" onClick={() => setNewListOpen(true)}>
                <Plus className="h-3.5 w-3.5" />
                {t('newList')}
              </GatedButton>
            </div>
            <div className="relative">
              <Search className="absolute left-2 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
              <Input value={listSearch} onChange={(e) => setListSearch(e.target.value)} placeholder={t('searchLists')} className="h-8 pl-7 text-sm" />
            </div>
          </div>
          <ul className="flex-1 overflow-y-auto p-1.5">
            {loadingLists ? (
              <li className="flex justify-center py-8"><Loader2 className="h-5 w-5 animate-spin text-primary" /></li>
            ) : visibleLists.length === 0 ? (
              <li className="px-2 py-6 text-center text-xs text-muted-foreground">{tags.length ? t('noListMatch') : t('noLists')}</li>
            ) : (
              visibleLists.map((x) => (
                <li key={x.id}>
                  <button
                    type="button"
                    onClick={() => { setSelectedId(x.id); setMemberPage(0); setMemberSearch(''); }}
                    className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm ${
                      x.id === selectedId ? 'bg-primary/10 text-primary' : 'hover:bg-muted'
                    }`}
                  >
                    <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: x.color || '#25D366' }} />
                    <span className="flex-1 truncate">{x.name}</span>
                    <span className="text-xs tabular-nums text-muted-foreground">{counts[x.id] ?? '…'}</span>
                  </button>
                </li>
              ))
            )}
          </ul>
        </section>

        {/* ── History ───────────────────────────────────────── */}
        <section className="flex min-w-0 flex-col rounded-xl border border-border bg-card">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border p-3">
            <div className="min-w-0">
              <h2 className="truncate text-sm font-semibold">{selected ? selected.name : t('pickList')}</h2>
              {selected && <p className="text-xs text-muted-foreground">{t('membersCount', { count: counts[selected.id] ?? 0 })}</p>}
            </div>
            {selected && (
              <div className="flex flex-wrap gap-2">
                <GatedButton canAct={canSend} gateReason="send broadcasts" size="sm" onClick={() => router.push(`/broadcasts/new?tag=${selected.id}`)}>
                  <Send className="h-3.5 w-3.5" />
                  {t('sendTemplate')}
                </GatedButton>
                {(['sendProducts', 'sendCatalogue'] as const).map((k) => (
                  <span
                    key={k}
                    title={t('commerceUnavailable')}
                    className="inline-flex cursor-not-allowed items-center gap-1 rounded-lg border border-dashed border-border px-2.5 py-1 text-xs text-muted-foreground opacity-60"
                  >
                    <Lock className="h-3 w-3" />
                    {t(k)}
                  </span>
                ))}
              </div>
            )}
          </div>
          <div className="flex-1 space-y-3 overflow-y-auto p-3">
            {!selected ? null : history.length === 0 ? (
              <p className="py-10 text-center text-sm text-muted-foreground">{t('noHistory')}</p>
            ) : (
              history.map((b) => {
                const status = getBroadcastStatus(b.status);
                const tpl = templates.get(b.template_name);
                return (
                  <article key={b.id} className="space-y-2 rounded-lg border border-border p-3">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <Link href={`/broadcasts/${b.id}`} className="font-medium hover:underline">{b.name}</Link>
                        <p className="text-xs text-muted-foreground">
                          {new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(b.scheduled_at ?? b.created_at))}
                          {' · '}{b.template_name}
                        </p>
                      </div>
                      <span className={`shrink-0 rounded-full border px-2 py-0.5 text-[11px] ${status.classes}`}>{tStatus(status.label)}</span>
                    </div>
                    {tpl && (
                      <details className="text-xs">
                        <summary className="cursor-pointer text-muted-foreground">{t('showMessage')}</summary>
                        <div className="mt-2 max-w-[320px]"><TemplatePhonePreview template={tpl} compact /></div>
                      </details>
                    )}
                    <BroadcastMetricsBar
                      counts={metricsFromBroadcast(b)}
                      compact
                      onSelect={(m) => router.push(`/broadcasts/${b.id}${m ? `?metric=${m}` : ''}`)}
                    />
                  </article>
                );
              })
            )}
          </div>
        </section>

        {/* ── Members ───────────────────────────────────────── */}
        <section className="flex flex-col rounded-xl border border-border bg-card">
          <div className="space-y-2 border-b border-border p-3">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold">{t('members')}</h2>
              <button type="button" onClick={() => setAccessOpen(true)} className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
                <ShieldCheck className="h-3.5 w-3.5" />
                {t('manageAccess')}
              </button>
            </div>
            {selected && (
              <div className="flex flex-wrap gap-1.5">
                <GatedButton canAct={canSend} gateReason="add members" size="sm" variant="outline" onClick={() => setAddOpen(true)}>
                  <UserPlus className="h-3.5 w-3.5" />
                  {t('addMember')}
                </GatedButton>
                <GatedButton canAct={canSend} gateReason="import contacts" size="sm" variant="outline" onClick={() => { setImportMode('file'); setImportOpen(true); }}>
                  <Upload className="h-3.5 w-3.5" />
                  {t('import')}
                </GatedButton>
                <GatedButton canAct={canSend} gateReason="import contacts" size="sm" variant="outline" onClick={() => { setImportMode('paste'); setImportOpen(true); }}>
                  <ClipboardPaste className="h-3.5 w-3.5" />
                  {t('quickImport')}
                </GatedButton>
              </div>
            )}
            <div className="relative">
              <Search className="absolute left-2 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
              <Input
                value={memberSearch}
                onChange={(e) => { setMemberSearch(e.target.value); setMemberPage(0); }}
                placeholder={t('searchMembers')}
                className="h-8 pl-7 text-sm"
                disabled={!selected}
              />
            </div>
          </div>
          <ul className="flex-1 divide-y divide-border overflow-y-auto">
            {loadingMembers ? (
              <li className="flex justify-center py-8"><Loader2 className="h-5 w-5 animate-spin text-primary" /></li>
            ) : members.length === 0 ? (
              <li className="px-3 py-8 text-center text-xs text-muted-foreground">{selected ? t('noMembers') : ''}</li>
            ) : (
              members.map((m) => (
                <li key={m.id} className="group flex items-center gap-2 px-3 py-2">
                  <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-muted text-xs">
                    {(m.name || m.phone).slice(0, 1).toUpperCase()}
                  </div>
                  <button type="button" onClick={() => setDetailId(m.id)} className="min-w-0 flex-1 text-left">
                    <p className="truncate text-sm">{m.name || m.phone}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      {m.phone}
                      {m.opt_in_status === 'opted_out' && <span className="ml-1 text-amber-600">· {t('optedOut')}</span>}
                    </p>
                  </button>
                  {canSend && (
                    <button
                      type="button"
                      title={t('removeFromList')}
                      aria-label={t('removeFromList')}
                      onClick={() => void removeMember(m)}
                      className="text-muted-foreground opacity-0 hover:text-red-500 group-hover:opacity-100 focus:opacity-100"
                    >
                      <UserMinus className="h-4 w-4" />
                    </button>
                  )}
                </li>
              ))
            )}
          </ul>
          {memberTotal > MEMBER_PAGE && (
            <div className="flex items-center justify-between border-t border-border px-3 py-2 text-xs text-muted-foreground">
              <span>{t('pageOf', { from: memberPage * MEMBER_PAGE + 1, to: Math.min(memberTotal, (memberPage + 1) * MEMBER_PAGE), total: memberTotal })}</span>
              <div className="flex gap-1">
                <Button size="sm" variant="outline" disabled={memberPage === 0} onClick={() => setMemberPage((p) => p - 1)}>‹</Button>
                <Button size="sm" variant="outline" disabled={(memberPage + 1) * MEMBER_PAGE >= memberTotal} onClick={() => setMemberPage((p) => p + 1)}>
                  <ChevronRight className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>
          )}
        </section>
      </div>

      <Dialog open={newListOpen} onOpenChange={setNewListOpen}>
        <DialogContent className="border-border bg-popover sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{t('newList')}</DialogTitle>
            <DialogDescription>{t('newListDesc')}</DialogDescription>
          </DialogHeader>
          <Input autoFocus value={newListName} onChange={(e) => setNewListName(e.target.value)} placeholder={t('listNamePlaceholder')} maxLength={60} />
          <DialogFooter>
            <Button variant="outline" onClick={() => setNewListOpen(false)}>{t('cancel')}</Button>
            <Button onClick={() => void createList()} disabled={!newListName.trim()}>{t('create')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {selected && user && accountId && (
        <AddMemberDialog
          open={addOpen}
          onOpenChange={setAddOpen}
          title={t('addMember')}
          description={t('addMemberDesc', { list: selected.name })}
          onAdd={async (name, phone) => {
            const r = await addMemberToList(createClient(), { accountId, userId: user.id, tagId: selected.id, name, phone });
            if (!r.ok) {
              toast.error(r.error === 'invalid_phone' ? t('invalidPhone') : r.message ?? t('addFailed'));
              return false;
            }
            toast.success(r.alreadyMember ? t('alreadyMember') : t('memberAdded'));
            if (!r.alreadyMember) setCounts((c) => ({ ...c, [selected.id]: (c[selected.id] ?? 0) + 1 }));
            void loadMembers();
            return true;
          }}
        />
      )}

      <ImportModal
        open={importOpen}
        onOpenChange={setImportOpen}
        defaultGroupTagId={selectedId}
        initialMode={importMode}
        onImported={() => { void loadLists(); void loadMembers(); }}
      />

      <ContactDetailView
        open={!!detailId}
        onOpenChange={(o) => !o && setDetailId(null)}
        contactId={detailId}
        onUpdated={() => void loadMembers()}
      />

      <Dialog open={accessOpen} onOpenChange={setAccessOpen}>
        <DialogContent className="border-border bg-popover sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t('manageAccess')}</DialogTitle>
            <DialogDescription>{t('accessExplain')}</DialogDescription>
          </DialogHeader>
          <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
            <li>{t('accessView')}</li>
            <li>{t('accessMembers')}</li>
            <li>{t('accessLists')}</li>
          </ul>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export function AddMemberDialog({
  open,
  onOpenChange,
  title,
  description,
  onAdd,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  title: string;
  description: string;
  onAdd: (name: string, phone: string) => Promise<boolean>;
}) {
  const t = useTranslations('Campaigns.lists');
  const [name, setName] = useState('');
  const [cc, setCc] = useState<string>('+91');
  const [number, setNumber] = useState('');
  const [busy, setBusy] = useState(false);
  const phone = composePhone(cc, number);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="border-border bg-popover sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={t('name')} />
          <div className="flex gap-2">
            <select value={cc} onChange={(e) => setCc(e.target.value)} className="h-9 rounded-md border border-border bg-muted px-2 text-sm" aria-label={t('countryCode')}>
              {COUNTRY_CODES.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
            <Input value={number} onChange={(e) => setNumber(e.target.value)} placeholder={t('phone')} inputMode="tel" />
          </div>
          {number && !phone && <p className="text-xs text-red-500">{t('invalidPhone')}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>{t('cancel')}</Button>
          <Button
            disabled={!phone || busy}
            onClick={async () => {
              if (!phone) return;
              setBusy(true);
              const ok = await onAdd(name, phone);
              setBusy(false);
              if (ok) { setName(''); setNumber(''); onOpenChange(false); }
            }}
          >
            {busy && <Loader2 className="h-4 w-4 animate-spin" />}
            <Users className="h-4 w-4" />
            {t('add')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
