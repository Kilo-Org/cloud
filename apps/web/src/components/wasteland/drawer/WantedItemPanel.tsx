'use client';

import { formatDistanceToNow } from 'date-fns';
import { Badge } from '@/components/ui/badge';
import { CheckCircle2, Hand, ThumbsDown, ThumbsUp, UserMinus, XCircle } from 'lucide-react';
import type { DrawerStackHelpers } from '@/components/drawer';
import type { WantedItem, WantedPanelActions, WastelandDrawerRef } from './types';
import { RigLink } from './CrossRefs';

const STATUS_COLORS: Record<string, string> = {
  open: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20',
  claimed: 'bg-amber-500/10 text-amber-400 border-amber-500/20',
  in_review: 'bg-violet-500/10 text-violet-400 border-violet-500/20',
  completed: 'bg-sky-500/10 text-sky-400 border-sky-500/20',
  done: 'bg-sky-500/10 text-sky-400 border-sky-500/20',
  withdrawn: 'bg-white/[0.04] text-white/40 border-white/10',
};

const PRIORITY_COLORS: Record<string, string> = {
  low: 'text-white/55',
  medium: 'text-sky-300',
  high: 'text-amber-300',
  critical: 'text-red-300',
};

const TYPE_COLORS: Record<string, string> = {
  feature: 'bg-violet-500/10 text-violet-400 border-violet-500/20',
  bug: 'bg-red-500/10 text-red-400 border-red-500/20',
  docs: 'bg-blue-500/10 text-blue-400 border-blue-500/20',
  other: 'bg-white/[0.04] text-white/40 border-white/10',
};

export function WantedItemPanel({
  wastelandId,
  item,
  actions,
  push,
}: {
  wastelandId: string;
  item: WantedItem;
  /** `null` means the panel was pushed as a cross-reference — render read-only. */
  actions: WantedPanelActions | null;
  push: DrawerStackHelpers<WastelandDrawerRef>['push'];
}) {
  return (
    <div className="space-y-4 p-4">
      <h4 className="text-base font-semibold text-white/90">{item.title}</h4>

      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="outline" className={STATUS_COLORS[item.status] ?? ''}>
          {item.status}
        </Badge>
        <Badge variant="outline" className={TYPE_COLORS[item.type ?? 'other'] ?? TYPE_COLORS.other}>
          {item.type ?? 'other'}
        </Badge>
        <span
          className={`text-xs font-medium ${
            PRIORITY_COLORS[String(item.priority ?? 'medium')] ?? 'text-white/40'
          }`}
        >
          {item.priority ?? 'medium'} priority
        </span>
      </div>

      <div>
        <label className="mb-1 block text-[10px] font-semibold tracking-[0.08em] text-white/30 uppercase">
          Description
        </label>
        <p className="whitespace-pre-wrap text-sm text-white/70 leading-relaxed">
          {item.description || 'No description provided.'}
        </p>
      </div>

      {item.posted_by && (
        <div>
          <label className="mb-1 block text-[10px] font-semibold tracking-[0.08em] text-white/30 uppercase">
            Posted by
          </label>
          <RigLink handle={item.posted_by} wastelandId={wastelandId} push={push} />
        </div>
      )}

      {item.claimed_by && (
        <div>
          <label className="mb-1 block text-[10px] font-semibold tracking-[0.08em] text-white/30 uppercase">
            Claimed by
          </label>
          <RigLink handle={item.claimed_by} wastelandId={wastelandId} push={push} />
        </div>
      )}

      {item.evidence_url && (
        <div>
          <label className="mb-1 block text-[10px] font-semibold tracking-[0.08em] text-white/30 uppercase">
            Evidence
          </label>
          <a
            href={item.evidence_url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-sky-400 underline underline-offset-2 hover:text-sky-300"
          >
            {item.evidence_url}
          </a>
        </div>
      )}

      {actions && <ActionButtons item={item} actions={actions} />}

      <div className="space-y-1.5 border-t border-white/[0.06] pt-3">
        <DetailRow label="Created" value={formatTimestamp(item.created_at)} />
        <DetailRow label="Updated" value={formatTimestamp(item.updated_at)} />
      </div>

      <div className="border-t border-white/[0.06] pt-3">
        <DetailRow label="Item ID" value={item.id} mono />
      </div>
    </div>
  );
}

function ActionButtons({ item, actions }: { item: WantedItem; actions: WantedPanelActions }) {
  const { isAdmin, onClaim, onDone, onAccept, onReject, onCloseItem, onUnclaim } = actions;
  return (
    <div className="flex flex-col gap-2 border-t border-white/[0.06] pt-3">
      {item.status === 'open' && (
        <button
          type="button"
          onClick={() => onClaim(item)}
          className="inline-flex items-center justify-center gap-1.5 rounded-md border border-emerald-500/20 bg-emerald-500/10 px-3 py-2 text-xs font-medium text-emerald-400 transition-colors hover:bg-emerald-500/20"
        >
          <Hand className="size-3.5" />
          Claim this item
        </button>
      )}
      {item.status === 'claimed' && (
        <button
          type="button"
          onClick={() => onDone(item)}
          className="inline-flex items-center justify-center gap-1.5 rounded-md border border-sky-500/20 bg-sky-500/10 px-3 py-2 text-xs font-medium text-sky-400 transition-colors hover:bg-sky-500/20"
        >
          <CheckCircle2 className="size-3.5" />
          Mark as done
        </button>
      )}
      {isAdmin && item.status === 'claimed' && (
        <button
          type="button"
          onClick={() => onUnclaim(item)}
          className="inline-flex items-center justify-center gap-1.5 rounded-md border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-xs font-medium text-amber-400 transition-colors hover:bg-amber-500/20"
        >
          <UserMinus className="size-3.5" />
          Unclaim (admin)
        </button>
      )}
      {isAdmin && item.status === 'in_review' && (
        <>
          <button
            type="button"
            onClick={() => onAccept(item)}
            className="inline-flex items-center justify-center gap-1.5 rounded-md border border-emerald-500/20 bg-emerald-500/10 px-3 py-2 text-xs font-medium text-emerald-400 transition-colors hover:bg-emerald-500/20"
          >
            <ThumbsUp className="size-3.5" />
            Accept
          </button>
          <button
            type="button"
            onClick={() => onReject(item)}
            className="inline-flex items-center justify-center gap-1.5 rounded-md border border-red-500/20 bg-red-500/10 px-3 py-2 text-xs font-medium text-red-400 transition-colors hover:bg-red-500/20"
          >
            <ThumbsDown className="size-3.5" />
            Reject
          </button>
        </>
      )}
      {isAdmin &&
        (item.status === 'open' || item.status === 'claimed' || item.status === 'in_review') && (
          <button
            type="button"
            onClick={() => onCloseItem(item)}
            className="inline-flex items-center justify-center gap-1.5 rounded-md border border-white/[0.1] bg-white/[0.04] px-3 py-2 text-xs font-medium text-white/60 transition-colors hover:bg-white/[0.08]"
          >
            <XCircle className="size-3.5" />
            Close (admin)
          </button>
        )}
    </div>
  );
}

function DetailRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between text-xs">
      <span className="text-white/30">{label}</span>
      <span className={`text-white/60 ${mono ? 'font-mono text-[10px]' : ''}`}>{value}</span>
    </div>
  );
}

/**
 * Parses MySQL DATETIME strings coming from DoltHub, which omit timezone
 * markers but are actually UTC. Without this, `new Date()` parses them in
 * local time and produces values that look hours off.
 */
function parseDoltDate(value: unknown): Date | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  if (/[Zz]|[+-]\d{2}:?\d{2}$/.test(value)) return new Date(value);
  const normalized = value.includes('T') ? `${value}Z` : `${value.replace(' ', 'T')}Z`;
  const d = new Date(normalized);
  return Number.isNaN(d.getTime()) ? null : d;
}

function formatTimestamp(iso: string | null): string {
  if (!iso) return '—';
  const d = parseDoltDate(iso);
  if (!d) return iso;
  try {
    return formatDistanceToNow(d, { addSuffix: true });
  } catch {
    return iso;
  }
}
