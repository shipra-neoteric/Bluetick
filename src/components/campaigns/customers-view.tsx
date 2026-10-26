'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import {
  ArrowUpDown,
  ClipboardPaste,
  Columns3,
  Download,
  Loader2,
  MessageSquare,
  MoreVertical,
  Pencil,
  Search,
  Tag as TagIcon,
  Trash2,
  Upload,
  UserPlus,
} from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { useCan } from '@/hooks/use-can';
import type { CustomField, Tag } from '@/types';
import { deleteContactTag } from '@/lib/contacts/tag-api';
import { downloadBlob, toCsv, toXlsxBytes } from '@/lib/import/spreadsheet';
import { loadViewPrefs, saveViewPrefs } from '@/lib/campaigns/view-prefs';
import { addMemberToList } from '@/lib/campaigns/list-members';
import {
  ACTIVITY_COLUMNS,
  BUILT_IN_COLUMNS,
  DEFAULT_COLUMNS,
  columnValue,
  fetchAllCustomers,
  fetchCustomerPage,
  type BuiltInColumn,
  type CustomerRow,
  type CustomerSort,
} from '@/lib/campaigns/customers';
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
import { AddMemberDialog } from './broadcast-workspace';
import { CustomersBulkBar } from './customers-bulk-bar';

const PAGE_SIZE = 50;
const PREFS_KEY = 'customers.table';

interface Prefs {
  columns: string[];
  sort: CustomerSort;
}

/**
 * Customers: segments (tags) on the left, a paged table
 * with a per-user column chooser, export of the whole filter, import /
 * quick import / add customer, and a row menu (open chat, edit, remove
 * from segment, delete).
 */
export function CustomersView() {
  const t = useTranslations('Campaigns.customers');
  const router = useRouter();
  const { user, accountId } = useAuth();
  const canSend = useCan('send-messages');

  const [tags, setTags] = useState<Tag[]>([]);
  const [segmentCounts, setSegmentCounts] = useState<Record<string, number>>({});
  const [allCount, setAllCount] = useState<number | null>(null);
  const [segmentSearch, setSegmentSearch] = useState('');
  const [tagId, setTagId] = useState<string | null>(null);
  const [customFields, setCustomFields] = useState<CustomField[]>([]);

  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [page, setPage] = useState(0);
  const [rows, setRows] = useState<CustomerRow[]>([]);
  const [total, setTotal] = useState(0);
  const [mode, setMode] = useState<'full' | 'basic'>('full');
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const [prefs, setPrefs] = useState<Prefs>({ columns: DEFAULT_COLUMNS, sort: 'created_desc' });
  const [columnsOpen, setColumnsOpen] = useState(false);
  const [columnSearch, setColumnSearch] = useState('');
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [exporting, setExporting] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [importMode, setImportMode] = useState<'file' | 'paste'>('file');
  const [addOpen, setAddOpen] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [toDelete, setToDelete] = useState<CustomerRow | null>(null);
  const seq = useRef(0);

  const segment = tags.find((x) => x.id === tagId) ?? null;
  const yesNo = useMemo(() => ({ yes: t('yes'), no: t('no') }), [t]);

  const loadSegments = useCallback(async () => {
    const supabase = createClient();
    const [{ data: tagRows }, { count }, { data: fields }] = await Promise.all([
      supabase.from('tags').select('*').order('name'),
      supabase.from('contacts').select('id', { count: 'exact', head: true }),
      supabase.from('custom_fields').select('*').order('field_name'),
    ]);
    const list = ((tagRows ?? []) as Tag[]).filter((x) => !x.archived_at);
    setTags(list);
    setAllCount(count ?? 0);
    setCustomFields(((fields ?? []) as CustomField[]).filter((f) => !f.archived_at));
    const per = await Promise.all(
      list.map((x) => supabase.from('contact_tags').select('id', { count: 'exact', head: true }).eq('tag_id', x.id)),
    );
    setSegmentCounts(Object.fromEntries(list.map((x, i) => [x.id, per[i].count ?? 0])));
  }, []);

  useEffect(() => {
    void loadSegments();
    void loadViewPrefs(createClient(), PREFS_KEY, { columns: DEFAULT_COLUMNS, sort: 'created_desc' as CustomerSort }).then(setPrefs);
  }, [loadSegments]);

  useEffect(() => {
    const id = setTimeout(() => setDebounced(search), 300);
    return () => clearTimeout(id);
  }, [search]);

  const load = useCallback(async () => {
    const mine = ++seq.current;
    setLoading(true);
    try {
      const res = await fetchCustomerPage(createClient(), {
        tagId, search: debounced, sort: prefs.sort, limit: PAGE_SIZE, offset: page * PAGE_SIZE,
      });
      if (mine !== seq.current) return;
      setRows(res.rows);
      setTotal(res.total);
      setMode(res.mode);
    } catch (err) {
      if (mine === seq.current) toast.error(err instanceof Error ? err.message : t('loadFailed'));
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, [tagId, debounced, prefs.sort, page, t]);

  useEffect(() => {
    void load();
  }, [load]);

  function savePrefs(next: Prefs) {
    setPrefs(next);
    if (user && accountId) void saveViewPrefs(createClient(), { userId: user.id, accountId }, PREFS_KEY, next);
  }

  const allColumns = useMemo(
    () => [
      ...BUILT_IN_COLUMNS.map((c) => ({ id: c as string, label: t(`columns.${c}`) })),
      ...customFields.map((f) => ({ id: `cf:${f.id}`, label: f.field_name })),
    ],
    [customFields, t],
  );
  const labelOf = (id: string) => allColumns.find((c) => c.id === id)?.label ?? id;
  const visibleColumns = prefs.columns.filter((c) => allColumns.some((x) => x.id === c));

  async function exportRows(kind: 'xlsx' | 'csv', onlySelected: boolean) {
    setExporting(kind);
    try {
      const data = onlySelected
        ? rows.filter((r) => selected.has(r.contact.id))
        : await fetchAllCustomers(createClient(), { tagId, search: debounced, sort: prefs.sort });
      const headers = visibleColumns.map(labelOf);
      const body = data.map((r) => visibleColumns.map((c) => columnValue(r, c, yesNo)));
      const name = `customers-${(segment?.name ?? 'all').replace(/[^\w-]+/g, '_')}-${new Date().toISOString().slice(0, 10)}`;
      if (kind === 'csv') downloadBlob(toCsv(headers, body), `${name}.csv`, 'text/csv;charset=utf-8');
      else downloadBlob(toXlsxBytes(headers, body, 'Customers') as BlobPart, `${name}.xlsx`, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      toast.success(t('exported', { count: data.length }));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('exportFailed'));
    } finally {
      setExporting(null);
    }
  }

  async function openChat(r: CustomerRow) {
    setMenuFor(null);
    if (r.conversation_id) {
      router.push(`/inbox?c=${r.conversation_id}`);
      return;
    }
    // Basic mode (or never messaged): look the thread up directly.
    const { data } = await createClient().from('conversations').select('id').eq('contact_id', r.contact.id).limit(1);
    const id = (data ?? [])[0]?.id as string | undefined;
    if (id) router.push(`/inbox?c=${id}`);
    else toast.info(t('noChatYet'));
  }

  async function removeFromSegment(r: CustomerRow) {
    setMenuFor(null);
    if (!tagId) return;
    try {
      await deleteContactTag(r.contact.id, tagId);
      toast.success(t('removedFromSegment'));
      setSegmentCounts((c) => ({ ...c, [tagId]: Math.max(0, (c[tagId] ?? 1) - 1) }));
      void load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('actionFailed'));
    }
  }

  async function confirmDelete() {
    if (!toDelete) return;
    const { error } = await createClient().from('contacts').delete().eq('id', toDelete.contact.id);
    if (error) toast.error(t('deleteFailed'));
    else {
      toast.success(t('deleted'));
      setToDelete(null);
      void load();
      void loadSegments();
    }
  }

  const pageIds = rows.map((r) => r.contact.id);
  const allOnPage = pageIds.length > 0 && pageIds.every((id) => selected.has(id));
  const segmentsShown = tags.filter((x) => x.name.toLowerCase().includes(segmentSearch.trim().toLowerCase()));

  return (
    <div className="grid gap-4 lg:grid-cols-[240px_minmax(0,1fr)]">
      {/* Segments */}
      <aside className="space-y-2 rounded-xl border border-border bg-card p-3 lg:self-start">
        <h2 className="text-sm font-semibold">{t('segments')}</h2>
        <div className="relative">
          <Search className="absolute left-2 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
          <Input value={segmentSearch} onChange={(e) => setSegmentSearch(e.target.value)} placeholder={t('searchSegments')} className="h-8 pl-7 text-sm" />
        </div>
        <ul className="max-h-[60vh] space-y-0.5 overflow-y-auto">
          {[{ id: null as string | null, name: t('allCustomers'), color: '' }, ...segmentsShown].map((s) => (
            <li key={s.id ?? 'all'}>
              <button
                type="button"
                onClick={() => { setTagId(s.id); setPage(0); setSelected(new Set()); }}
                className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm ${
                  tagId === s.id ? 'bg-primary/10 text-primary' : 'hover:bg-muted'
                }`}
              >
                {s.id ? <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: s.color || '#25D366' }} /> : <TagIcon className="h-3.5 w-3.5" />}
                <span className="flex-1 truncate">{s.name}</span>
                <span className="text-xs tabular-nums text-muted-foreground">
                  {s.id ? segmentCounts[s.id] ?? '…' : allCount ?? '…'}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </aside>

      <section className="min-w-0 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="text-lg font-semibold">{segment?.name ?? t('allCustomers')}</h2>
            <p className="text-xs text-muted-foreground">{t('count', { count: total })}</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <GatedButton canAct={canSend} gateReason="add customers" variant="outline" onClick={() => setAddOpen(true)}>
              <UserPlus className="h-4 w-4" />{t('add')}
            </GatedButton>
            <GatedButton canAct={canSend} gateReason="import contacts" variant="outline" onClick={() => { setImportMode('file'); setImportOpen(true); }}>
              <Upload className="h-4 w-4" />{t('import')}
            </GatedButton>
            <GatedButton canAct={canSend} gateReason="import contacts" variant="outline" onClick={() => { setImportMode('paste'); setImportOpen(true); }}>
              <ClipboardPaste className="h-4 w-4" />{t('quickImport')}
            </GatedButton>
          </div>
        </div>

        {mode === 'basic' && <p className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">{t('basicMode')}</p>}

        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-[220px] flex-1">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input value={search} onChange={(e) => { setSearch(e.target.value); setPage(0); }} placeholder={t('search')} className="pl-8" />
          </div>
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <ArrowUpDown className="h-3.5 w-3.5" />
            <select
              value={prefs.sort}
              onChange={(e) => { savePrefs({ ...prefs, sort: e.target.value as CustomerSort }); setPage(0); }}
              className="h-9 rounded-md border border-border bg-muted px-2 text-sm text-foreground"
              aria-label={t('sort')}
            >
              {(['created_desc', 'created_asc', 'name_asc'] as const).map((s) => <option key={s} value={s}>{t(`sorts.${s}`)}</option>)}
            </select>
          </label>
          <div className="relative">
            <Button variant="outline" onClick={() => setColumnsOpen((o) => !o)} aria-expanded={columnsOpen}>
              <Columns3 className="h-4 w-4" />{t('viewOptions')}
            </Button>
            {columnsOpen && (
              <div className="absolute right-0 z-30 mt-1 w-64 rounded-lg border border-border bg-popover p-2 shadow-lg">
                <Input value={columnSearch} onChange={(e) => setColumnSearch(e.target.value)} placeholder={t('searchColumns')} className="mb-2 h-8 text-sm" />
                <div className="max-h-72 space-y-0.5 overflow-y-auto">
                  {allColumns.filter((c) => c.label.toLowerCase().includes(columnSearch.toLowerCase())).map((c) => (
                    <label key={c.id} className="flex items-center gap-2 rounded px-2 py-1 text-sm hover:bg-muted">
                      <input
                        type="checkbox"
                        checked={prefs.columns.includes(c.id)}
                        onChange={(e) =>
                          savePrefs({
                            ...prefs,
                            columns: e.target.checked ? [...prefs.columns, c.id] : prefs.columns.filter((x) => x !== c.id),
                          })
                        }
                      />
                      <span className="flex-1 truncate">{c.label}</span>
                      {mode === 'basic' && ACTIVITY_COLUMNS.has(c.id as BuiltInColumn) && <span className="text-[10px] text-muted-foreground">046</span>}
                    </label>
                  ))}
                </div>
                <button type="button" className="mt-2 text-xs text-primary hover:underline" onClick={() => savePrefs({ ...prefs, columns: DEFAULT_COLUMNS })}>
                  {t('resetColumns')}
                </button>
              </div>
            )}
          </div>
          <div className="flex gap-1">
            <Button variant="outline" onClick={() => void exportRows('xlsx', selected.size > 0)} disabled={!!exporting || total === 0}>
              {exporting === 'xlsx' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
              {selected.size > 0 ? t('exportSelected', { count: selected.size }) : t('exportAll')}
            </Button>
            <Button variant="outline" onClick={() => void exportRows('csv', selected.size > 0)} disabled={!!exporting || total === 0} title={t('exportCsv')}>
              CSV
            </Button>
          </div>
        </div>

        <CustomersBulkBar
          selectedIds={[...selected]}
          tags={tags}
          userId={user?.id ?? null}
          accountId={accountId ?? null}
          canSend={canSend}
          total={total}
          onSelectAll={async () => {
            const all = await fetchAllCustomers(createClient(), { tagId, search: debounced, sort: prefs.sort });
            setSelected(new Set(all.map((r) => r.contact.id)));
          }}
          onClear={() => setSelected(new Set())}
          onDone={() => { setSelected(new Set()); void load(); void loadSegments(); }}
        />

        <div className="overflow-x-auto rounded-xl border border-border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
              <tr>
                <th className="w-8 px-3 py-2">
                  <input
                    type="checkbox"
                    aria-label={t('selectPage')}
                    checked={allOnPage}
                    onChange={(e) =>
                      setSelected((prev) => {
                        const next = new Set(prev);
                        for (const id of pageIds) {
                          if (e.target.checked) next.add(id);
                          else next.delete(id);
                        }
                        return next;
                      })
                    }
                  />
                </th>
                {visibleColumns.map((c) => <th key={c} className="whitespace-nowrap px-3 py-2 font-medium">{labelOf(c)}</th>)}
                <th className="w-10 px-2 py-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {loading ? (
                <tr><td colSpan={visibleColumns.length + 2} className="py-12 text-center"><Loader2 className="mx-auto h-5 w-5 animate-spin text-primary" /></td></tr>
              ) : rows.length === 0 ? (
                <tr><td colSpan={visibleColumns.length + 2} className="py-12 text-center text-sm text-muted-foreground">{t('empty')}</td></tr>
              ) : (
                rows.map((r) => (
                  <tr key={r.contact.id} className="hover:bg-muted/30">
                    <td className="px-3 py-2">
                      <input
                        type="checkbox"
                        aria-label={t('select')}
                        checked={selected.has(r.contact.id)}
                        onChange={(e) =>
                          setSelected((prev) => {
                            const next = new Set(prev);
                            if (e.target.checked) next.add(r.contact.id);
                            else next.delete(r.contact.id);
                            return next;
                          })
                        }
                      />
                    </td>
                    {visibleColumns.map((c) => (
                      <td key={c} className="max-w-[240px] truncate whitespace-nowrap px-3 py-2 text-muted-foreground first-of-type:text-foreground">
                        {c === 'name' ? (
                          <button type="button" className="font-medium text-foreground hover:underline" onClick={() => setDetailId(r.contact.id)}>
                            {columnValue(r, c, yesNo)}
                          </button>
                        ) : (
                          columnValue(r, c, yesNo)
                        )}
                      </td>
                    ))}
                    <td className="relative px-2 py-2">
                      <button type="button" aria-label={t('actions')} onClick={() => setMenuFor(menuFor === r.contact.id ? null : r.contact.id)} className="rounded p-1 text-muted-foreground hover:bg-muted">
                        <MoreVertical className="h-4 w-4" />
                      </button>
                      {menuFor === r.contact.id && (
                        <div className="absolute right-2 z-20 mt-1 w-48 rounded-lg border border-border bg-popover p-1 text-sm shadow-lg">
                          <MenuItem onClick={() => void openChat(r)} icon={<MessageSquare className="h-4 w-4" />}>{t('openChat')}</MenuItem>
                          <MenuItem onClick={() => { setMenuFor(null); setDetailId(r.contact.id); }} icon={<Pencil className="h-4 w-4" />}>{t('edit')}</MenuItem>
                          {tagId && canSend && (
                            <MenuItem onClick={() => void removeFromSegment(r)} icon={<TagIcon className="h-4 w-4" />}>{t('removeFromSegment')}</MenuItem>
                          )}
                          {canSend && (
                            <MenuItem danger onClick={() => { setMenuFor(null); setToDelete(r); }} icon={<Trash2 className="h-4 w-4" />}>{t('delete')}</MenuItem>
                          )}
                        </div>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {total > PAGE_SIZE && (
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>{t('pageOf', { from: page * PAGE_SIZE + 1, to: Math.min(total, (page + 1) * PAGE_SIZE), total })}</span>
            <div className="flex gap-1">
              <Button size="sm" variant="outline" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>{t('prev')}</Button>
              <Button size="sm" variant="outline" disabled={(page + 1) * PAGE_SIZE >= total} onClick={() => setPage((p) => p + 1)}>{t('next')}</Button>
            </div>
          </div>
        )}
      </section>

      {user && accountId && (
        <AddMemberDialog
          open={addOpen}
          onOpenChange={setAddOpen}
          title={t('add')}
          description={segment ? t('addToSegment', { segment: segment.name }) : t('addDesc')}
          onAdd={async (name, phone) => {
            const r = await addMemberToList(createClient(), { accountId, userId: user.id, tagId, name, phone });
            if (!r.ok) {
              toast.error(r.error === 'invalid_phone' ? t('invalidPhone') : r.message ?? t('actionFailed'));
              return false;
            }
            toast.success(r.created ? t('added') : t('alreadyExists'));
            void load();
            void loadSegments();
            return true;
          }}
        />
      )}

      <ImportModal
        open={importOpen}
        onOpenChange={setImportOpen}
        defaultGroupTagId={tagId}
        initialMode={importMode}
        onImported={() => { void load(); void loadSegments(); }}
      />

      <ContactDetailView open={!!detailId} onOpenChange={(o) => !o && setDetailId(null)} contactId={detailId} onUpdated={() => void load()} />

      <Dialog open={!!toDelete} onOpenChange={(o) => !o && setToDelete(null)}>
        <DialogContent className="border-border bg-popover sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{t('deleteTitle')}</DialogTitle>
            <DialogDescription>{t('deleteDesc', { name: toDelete?.contact.name || toDelete?.contact.phone || '' })}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setToDelete(null)}>{t('cancel')}</Button>
            <Button variant="destructive" onClick={() => void confirmDelete()}>{t('delete')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function MenuItem({ children, onClick, icon, danger }: { children: React.ReactNode; onClick: () => void; icon: React.ReactNode; danger?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-muted ${danger ? 'text-red-500' : ''}`}
    >
      {icon}
      {children}
    </button>
  );
}
