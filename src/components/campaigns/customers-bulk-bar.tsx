'use client';

/**
 * Actions for the contacts ticked in the Customers table:
 *   - Add to broadcast list (an existing list, or a new one),
 *   - Send broadcast (opens the wizard with exactly these contacts),
 *   - Assign agent (their chats; same audited RPC as the Inbox).
 */

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Loader2, Megaphone, Tag as TagIcon, UserCheck, X } from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import { isMissingSchemaError } from '@/lib/db/schema-compat';
import { SELECTED_CONTACTS_KEY } from '@/lib/campaigns/selected-contacts';
import type { Tag } from '@/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

const SELECT = 'h-9 w-full rounded-md border border-border bg-muted px-2 text-sm text-foreground';

export function CustomersBulkBar({
  selectedIds,
  tags,
  userId,
  accountId,
  canSend,
  total,
  onSelectAll,
  onClear,
  onDone,
}: {
  selectedIds: string[];
  tags: Tag[];
  userId: string | null;
  accountId: string | null;
  canSend: boolean;
  /** Contacts matching the current list + search. */
  total: number;
  onSelectAll: () => Promise<void>;
  onClear: () => void;
  /** Reload rows + list counts after a change. */
  onDone: () => void;
}) {
  const t = useTranslations('Campaigns.customers.bulk');
  const router = useRouter();
  const [dialog, setDialog] = useState<'list' | 'assign' | null>(null);
  const [busy, setBusy] = useState(false);
  const count = selectedIds.length;
  if (count === 0) return null;

  async function addToList(tagId: string | null, newName: string) {
    if (!userId || !accountId) return;
    setBusy(true);
    try {
      const supabase = createClient();
      let target = tagId;
      if (!target) {
        const name = newName.trim();
        if (!name) return;
        const { data, error } = await supabase
          .from('tags')
          .insert({ name, user_id: userId, account_id: accountId, color: '#25D366' })
          .select('id')
          .single();
        if (error) throw new Error(error.code === '23505' ? t('listExists') : error.message);
        target = (data as { id: string }).id;
      }
      for (const part of chunk(selectedIds, 200)) {
        const { error } = await supabase
          .from('contact_tags')
          .upsert(part.map((contact_id) => ({ contact_id, tag_id: target })), {
            onConflict: 'contact_id,tag_id',
            ignoreDuplicates: true,
          });
        if (error) throw error;
      }
      toast.success(t('addedToList', { count }));
      setDialog(null);
      onDone();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('failed'));
    } finally {
      setBusy(false);
    }
  }

  async function assign(agentId: string) {
    setBusy(true);
    try {
      const supabase = createClient();
      const convIds: string[] = [];
      for (const part of chunk(selectedIds, 200)) {
        const { data, error } = await supabase.from('conversations').select('id').in('contact_id', part);
        if (error) throw error;
        convIds.push(...((data ?? []) as { id: string }[]).map((r) => r.id));
      }
      if (convIds.length === 0) {
        toast.info(t('noChats'));
        return;
      }
      for (const id of convIds) {
        const { error } = await supabase.rpc('assign_conversation', { p_conversation_id: id, p_assignee: agentId });
        if (error && isMissingSchemaError(error)) {
          // Migration 044 not applied: plain update (no audit trail).
          for (const part of chunk(convIds, 200)) {
            const { error: updErr } = await supabase.from('conversations').update({ assigned_agent_id: agentId }).in('id', part);
            if (updErr) throw updErr;
          }
          break;
        }
        if (error) throw error;
      }
      toast.success(t('assigned', { count: convIds.length }));
      setDialog(null);
      onDone();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('failed'));
    } finally {
      setBusy(false);
    }
  }

  function sendBroadcast() {
    try {
      sessionStorage.setItem(SELECTED_CONTACTS_KEY, JSON.stringify(selectedIds));
    } catch {
      toast.error(t('storageBlocked'));
      return;
    }
    router.push('/broadcasts/new?selected=1');
  }

  return (
    <>
      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-primary/30 bg-primary/5 px-3 py-2 text-sm">
        <span className="font-medium">{t('selected', { count })}</span>
        {count < total && (
          <button
            type="button"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await onSelectAll();
              } catch (err) {
                toast.error(err instanceof Error ? err.message : t('failed'));
              } finally {
                setBusy(false);
              }
            }}
            className="text-xs font-medium text-primary hover:underline disabled:opacity-50"
          >
            {t('selectAll', { count: total })}
          </button>
        )}
        <button type="button" onClick={onClear} className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
          <X className="h-3.5 w-3.5" />
          {t('clear')}
        </button>
        {canSend && (
          <div className="ml-auto flex flex-wrap gap-2">
            <Button size="sm" variant="outline" onClick={() => setDialog('list')}>
              <TagIcon className="h-4 w-4" />
              {t('addToList')}
            </Button>
            <Button size="sm" variant="outline" onClick={sendBroadcast}>
              <Megaphone className="h-4 w-4" />
              {t('sendBroadcast')}
            </Button>
            <Button size="sm" variant="outline" onClick={() => setDialog('assign')}>
              <UserCheck className="h-4 w-4" />
              {t('assignAgent')}
            </Button>
          </div>
        )}
      </div>
      <ListDialog open={dialog === 'list'} onClose={() => setDialog(null)} tags={tags} count={count} busy={busy} onSave={addToList} />
      <AssignDialog open={dialog === 'assign'} onClose={() => setDialog(null)} count={count} busy={busy} onSave={assign} />
    </>
  );
}

function ListDialog({
  open,
  onClose,
  tags,
  count,
  busy,
  onSave,
}: {
  open: boolean;
  onClose: () => void;
  tags: Tag[];
  count: number;
  busy: boolean;
  onSave: (tagId: string | null, newName: string) => void;
}) {
  const t = useTranslations('Campaigns.customers.bulk');
  const [tagId, setTagId] = useState('');
  const [newName, setNewName] = useState('');
  const creating = tagId === '__new';
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="border-border bg-popover sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{t('addToList')}</DialogTitle>
          <DialogDescription>{t('addToListDesc', { count })}</DialogDescription>
        </DialogHeader>
        <select value={tagId} onChange={(e) => setTagId(e.target.value)} className={SELECT} aria-label={t('list')}>
          <option value="">{t('pickList')}</option>
          {tags.map((x) => (
            <option key={x.id} value={x.id}>
              {x.name}
            </option>
          ))}
          <option value="__new">{t('newList')}</option>
        </select>
        {creating && (
          <Input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder={t('newListName')} maxLength={60} autoFocus />
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t('cancel')}
          </Button>
          <Button
            disabled={busy || !tagId || (creating && !newName.trim())}
            onClick={() => onSave(creating ? null : tagId, newName)}
          >
            {busy && <Loader2 className="h-4 w-4 animate-spin" />}
            {t('add')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface Member {
  user_id: string;
  full_name?: string;
  email?: string;
  role?: string;
}

function AssignDialog({
  open,
  onClose,
  count,
  busy,
  onSave,
}: {
  open: boolean;
  onClose: () => void;
  count: number;
  busy: boolean;
  onSave: (agentId: string) => void;
}) {
  const t = useTranslations('Campaigns.customers.bulk');
  const [members, setMembers] = useState<Member[]>([]);
  const [agentId, setAgentId] = useState('');
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void (async () => {
      const res = await fetch('/api/account/members', { cache: 'no-store' }).catch(() => null);
      const json = (res?.ok ? await res.json().catch(() => ({})) : {}) as { members?: Member[] };
      if (!cancelled) setMembers((json.members ?? []).filter((m) => m.role !== 'viewer'));
    })();
    return () => {
      cancelled = true;
    };
  }, [open]);
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="border-border bg-popover sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{t('assignAgent')}</DialogTitle>
          <DialogDescription>{t('assignDesc', { count })}</DialogDescription>
        </DialogHeader>
        <select value={agentId} onChange={(e) => setAgentId(e.target.value)} className={SELECT} aria-label={t('agent')}>
          <option value="">{t('pickAgent')}</option>
          {members.map((m) => (
            <option key={m.user_id} value={m.user_id}>
              {m.full_name || m.email || m.user_id}
            </option>
          ))}
        </select>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t('cancel')}
          </Button>
          <Button disabled={busy || !agentId} onClick={() => onSave(agentId)}>
            {busy && <Loader2 className="h-4 w-4 animate-spin" />}
            {t('assign')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
