'use client';

import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { formatDistanceToNow } from 'date-fns';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import {
  CheckCircle2,
  ExternalLink,
  Hand,
  Hourglass,
  Loader2,
  ThumbsDown,
  ThumbsUp,
  UserMinus,
  XCircle,
} from 'lucide-react';
import type { DrawerStackHelpers } from '@/components/drawer';
import { MarkdownProse } from '@/components/security-agent/MarkdownProse';
import { parseDoltDate } from '@/lib/wasteland/date';
import { useWastelandTRPC } from '@/lib/wasteland/trpc';
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
        {item.description ? (
          <MarkdownProse markdown={item.description} className="text-sm text-white/70" />
        ) : (
          <p className="text-sm text-white/40 italic">No description provided.</p>
        )}
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

      {/* "Pending review" overlay — shown when the viewer has an open PR on
          upstream for this item. Survives page reloads (unlike optimistic
          mutation state) and links out to DoltHub for admin review. Hidden
          when the drawer was pushed as a cross-reference (actions=null). */}
      {actions && <PendingReviewSection wastelandId={wastelandId} itemId={item.id} />}

      {actions && <ActionButtons wastelandId={wastelandId} item={item} actions={actions} />}

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

function ActionButtons({
  wastelandId,
  item,
  actions,
}: {
  wastelandId: string;
  item: WantedItem;
  actions: WantedPanelActions;
}) {
  const { isAdmin, onDone, onAccept, onReject, onCloseItem, onUnclaim } = actions;
  return (
    <div className="flex flex-col gap-2 border-t border-white/[0.06] pt-3">
      {item.status === 'open' && <ClaimAction wastelandId={wastelandId} item={item} />}
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

/**
 * Shows a "Pending review" banner with a PR link when the viewer has an
 * open upstream PR for this item. Backed by `listMyPendingClaims`, which
 * lists the viewer's own open PRs with `wl/<rig>/<itemId>` branches. This
 * bridges the gap between "click claim" and "admin merges the PR" — the
 * wanted board itself reads upstream `main`, which doesn't reflect the
 * in-flight change until the merge lands.
 */
function PendingReviewSection({ wastelandId, itemId }: { wastelandId: string; itemId: string }) {
  const trpc = useWastelandTRPC();
  const queryClient = useQueryClient();
  const pendingQuery = useQuery({
    ...trpc.wasteland.listMyPendingClaims.queryOptions({ wastelandId }),
    // Poll for updates while the drawer is open so the banner clears as
    // soon as the admin merges the PR upstream.
    refetchInterval: 15_000,
  });
  const pending = pendingQuery.data?.items.find(p => p.item_id === itemId);

  // When this item transitions from "has a pending PR" to "doesn't",
  // the upstream merge (or close) just landed. Kick the board and the
  // item-detail queries so they pick up the new `status=claimed` state
  // without waiting for their own poll intervals to elapse.
  const wasPendingRef = useRef(false);
  useEffect(() => {
    const isPending = pending !== undefined;
    if (wasPendingRef.current && !isPending) {
      void queryClient.invalidateQueries({
        queryKey: trpc.wasteland.browseWantedBoard.queryKey({ wastelandId }),
      });
      void queryClient.invalidateQueries({
        queryKey: trpc.wasteland.getWantedItem.queryKey({ wastelandId, itemId }),
      });
    }
    wasPendingRef.current = isPending;
  }, [pending, queryClient, trpc, wastelandId, itemId]);

  if (!pending) return null;
  return (
    <div className="flex flex-col gap-1.5 rounded-md border border-amber-500/20 bg-amber-500/[0.04] p-3">
      <div className="flex items-center gap-1.5 text-xs font-medium text-amber-300">
        <Hourglass className="size-3.5" />
        Pending review
      </div>
      <p className="text-[11px] leading-relaxed text-white/55">
        You opened a PR on upstream. An admin needs to merge it before the status updates here.
      </p>
      <a
        href={pending.pr_url}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-1 self-start text-[11px] text-amber-300 underline underline-offset-2 hover:text-amber-200"
      >
        <ExternalLink className="size-3" />
        PR #{pending.pull_id}
      </a>
    </div>
  );
}

/**
 * Inline "Claim this item" flow. First click primes a confirm state with a
 * descriptive blurb and a Cancel option; second click fires the mutation.
 * Kept inside the drawer (rather than a top-level Dialog) because the drawer
 * stack sits at z-[60] and the Dialog overlay is z-50, which means a modal
 * confirm would render behind the drawer.
 */
function ClaimAction({ wastelandId, item }: { wastelandId: string; item: WantedItem }) {
  const trpc = useWastelandTRPC();
  const queryClient = useQueryClient();
  const [isConfirming, setIsConfirming] = useState(false);

  const claimMutation = useMutation({
    ...trpc.wasteland.claimWantedItem.mutationOptions(),
    onSuccess: data => {
      // In PR mode (most contributors), `wl claim` opens a DoltHub PR that an
      // upstream admin has to merge before `status=claimed` lands on main.
      // Surface the PR URL immediately so the user knows what happened and
      // can follow up; admins running in direct mode won't have a pr_url and
      // see the simple "Item claimed" message.
      const prUrl = data.pr_url;
      if (prUrl) {
        toast.success('Claim submitted for review', {
          description: 'An upstream admin will merge the claim PR.',
          action: {
            label: 'View PR',
            onClick: () => window.open(prUrl, '_blank', 'noopener,noreferrer'),
          },
        });
      } else {
        toast.success('Item claimed');
      }
      void queryClient.invalidateQueries({
        queryKey: trpc.wasteland.browseWantedBoard.queryKey({ wastelandId }),
      });
      void queryClient.invalidateQueries({
        queryKey: trpc.wasteland.getWantedItem.queryKey({ wastelandId, itemId: item.id }),
      });
      // Refresh the pending-claims overlay so the "Pending review" badge
      // shows up without waiting for the next poll.
      void queryClient.invalidateQueries({
        queryKey: trpc.wasteland.listMyPendingClaims.queryKey({ wastelandId }),
      });
      setIsConfirming(false);
    },
    onError: err => {
      toast.error(err.message || 'Failed to claim item');
    },
  });

  if (!isConfirming) {
    return (
      <button
        type="button"
        onClick={() => setIsConfirming(true)}
        className="inline-flex items-center justify-center gap-1.5 rounded-md border border-emerald-500/20 bg-emerald-500/10 px-3 py-2 text-xs font-medium text-emerald-400 transition-colors hover:bg-emerald-500/20"
      >
        <Hand className="size-3.5" />
        Claim this item
      </button>
    );
  }

  return (
    <div className="flex flex-col gap-2 rounded-md border border-emerald-500/20 bg-emerald-500/[0.04] p-3">
      <p className="text-xs leading-relaxed text-white/70">
        Claim this item? You&apos;ll be responsible for completing it.
      </p>
      <div className="flex items-center gap-2">
        <button
          type="button"
          disabled={claimMutation.isPending}
          onClick={() => claimMutation.mutate({ wastelandId, itemId: item.id })}
          className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-md bg-emerald-500/20 px-3 py-2 text-xs font-medium text-emerald-300 transition-colors hover:bg-emerald-500/30 disabled:opacity-50"
        >
          {claimMutation.isPending ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <Hand className="size-3.5" />
          )}
          Yes, claim it
        </button>
        <button
          type="button"
          disabled={claimMutation.isPending}
          onClick={() => setIsConfirming(false)}
          className="inline-flex items-center justify-center rounded-md border border-white/[0.08] bg-white/[0.03] px-3 py-2 text-xs text-white/60 transition-colors hover:bg-white/[0.06] disabled:opacity-50"
        >
          Cancel
        </button>
      </div>
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
