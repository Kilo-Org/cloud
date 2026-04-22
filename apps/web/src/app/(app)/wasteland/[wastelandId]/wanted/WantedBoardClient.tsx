'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useWastelandTRPC } from '@/lib/wasteland/trpc';
import type { WastelandOutputs } from '@/lib/wasteland/trpc';
import { useSetWastelandPageHeader } from '../WastelandPageHeaderContext';
import { useDrawerStack } from '@/components/wasteland/drawer/WastelandDrawerStack';
import { Badge } from '@/components/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { ArrowUpDown, Loader2, Plus, RefreshCw, ScrollText, Search } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { AnimatePresence, motion } from 'motion/react';
import { toast } from 'sonner';

type WantedItem = WastelandOutputs['wasteland']['browseWantedBoard'][number];

type SortField = 'priority' | 'activity';

/**
 * Parse a DoltHub timestamp. DoltHub returns MySQL DATETIME strings in the
 * form `"YYYY-MM-DD HH:MM:SS"` without a timezone suffix — the underlying
 * data is UTC but the string is not ISO-8601, so `new Date(str)` is
 * browser-dependent (often parsed as local time, producing values that
 * look hours in the future or past).
 *
 * This helper normalizes by treating the value as UTC when no timezone
 * marker is present.
 */
function parseDoltDate(value: unknown): Date | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  // Already has a timezone (Z or ±HH:MM) → trust it.
  if (/[Zz]|[+-]\d{2}:?\d{2}$/.test(value)) return new Date(value);
  // MySQL DATETIME `YYYY-MM-DD HH:MM:SS` → treat as UTC.
  const normalized = value.includes('T') ? `${value}Z` : `${value.replace(' ', 'T')}Z`;
  const d = new Date(normalized);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Most recent timestamp out of `updated_at` / `created_at`, in epoch ms. */
function lastActivityMs(item: Record<string, unknown>): number {
  const updated = parseDoltDate(item.updated_at)?.getTime();
  const created = parseDoltDate(item.created_at)?.getTime();
  return Math.max(updated ?? 0, created ?? 0);
}

const STATUS_COLORS: Record<string, string> = {
  open: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20',
  claimed: 'bg-amber-500/10 text-amber-400 border-amber-500/20',
  in_review: 'bg-violet-500/10 text-violet-400 border-violet-500/20',
  completed: 'bg-sky-500/10 text-sky-400 border-sky-500/20',
  done: 'bg-sky-500/10 text-sky-400 border-sky-500/20',
  withdrawn: 'bg-white/[0.04] text-white/40 border-white/10',
};

const STATUS_DOT: Record<string, string> = {
  open: 'bg-emerald-400',
  claimed: 'bg-amber-400',
  in_review: 'bg-violet-400',
  completed: 'bg-sky-400',
  done: 'bg-sky-400',
  withdrawn: 'bg-white/20',
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

// ── Slow operation toast helper ──────────────────────────────────────────

const COLD_START_DELAY_MS = 3000;

/**
 * Shows a "Starting wasteland container..." toast if an operation takes
 * longer than 3 seconds (likely a cold start).
 */
function useSlowOperationToast(isPending: boolean) {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const toastIdRef = useRef<string | number | null>(null);

  useEffect(() => {
    if (isPending) {
      timerRef.current = setTimeout(() => {
        toastIdRef.current = toast.loading('Starting wasteland container...');
      }, COLD_START_DELAY_MS);
    } else {
      if (timerRef.current) clearTimeout(timerRef.current);
      if (toastIdRef.current !== null) {
        toast.dismiss(toastIdRef.current);
        toastIdRef.current = null;
      }
    }
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [isPending]);
}

// ── Main component ───────────────────────────────────────────────────────

type WantedBoardClientProps = {
  wastelandId: string;
};

export function WantedBoardClient({ wastelandId }: WantedBoardClientProps) {
  const trpc = useWastelandTRPC();
  const queryClient = useQueryClient();
  const { open: openDrawer } = useDrawerStack();

  const [statusFilter, setStatusFilter] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [sortField, setSortField] = useState<SortField>('activity');

  // Dialog state
  const [claimItem, setClaimItem] = useState<WantedItem | null>(null);
  const [doneItem, setDoneItem] = useState<WantedItem | null>(null);
  const [acceptItem, setAcceptItem] = useState<WantedItem | null>(null);
  const [rejectItem, setRejectItem] = useState<WantedItem | null>(null);
  const [closeItem, setCloseItem] = useState<WantedItem | null>(null);
  const [unclaimItem, setUnclaimItem] = useState<WantedItem | null>(null);
  const [showPostDialog, setShowPostDialog] = useState(false);

  const wantedQuery = useQuery({
    ...trpc.wasteland.browseWantedBoard.queryOptions({ wastelandId }),
    refetchInterval: 30_000,
  });

  // Credential status drives admin affordances. Not required — contributors
  // without credentials get `data = null` and isAdmin stays false.
  const credentialQuery = useQuery(
    trpc.wasteland.getCredentialStatus.queryOptions({ wastelandId })
  );
  const isAdmin = credentialQuery.data?.is_upstream_admin ?? false;

  const refreshMutation = {
    isPending: false,
    mutate: () => {
      void queryClient.invalidateQueries({
        queryKey: trpc.wasteland.browseWantedBoard.queryKey({ wastelandId }),
      });
    },
  };

  const invalidateBoard = useCallback(() => {
    void queryClient.invalidateQueries({
      queryKey: trpc.wasteland.browseWantedBoard.queryKey({ wastelandId }),
    });
  }, [queryClient, trpc, wastelandId]);

  const items = wantedQuery.data ?? [];

  const statusCounts = useMemo(() => {
    const counts: Record<string, number> = {
      open: 0,
      claimed: 0,
      in_review: 0,
      completed: 0,
    };
    for (const item of items) {
      counts[item.status] = (counts[item.status] ?? 0) + 1;
    }
    return counts;
  }, [items]);

  const filteredItems = useMemo(() => {
    let result = items;

    if (statusFilter) {
      result = result.filter(item => item.status === statusFilter);
    }

    if (search.trim()) {
      const q = search.toLowerCase();
      result = result.filter(item => item.title.toLowerCase().includes(q));
    }

    result = [...result].sort((a, b) => {
      if (sortField === 'priority') {
        return (Number(a.priority) || 3) - (Number(b.priority) || 3);
      }
      return lastActivityMs(b) - lastActivityMs(a);
    });

    return result;
  }, [items, statusFilter, search, sortField]);

  const handleRefresh = useCallback(() => {
    refreshMutation.mutate();
  }, [refreshMutation, wastelandId]);

  const toggleSort = useCallback(() => {
    setSortField(prev => (prev === 'priority' ? 'activity' : 'priority'));
  }, []);

  const handleOpenItem = useCallback(
    (item: WantedItem) => {
      openDrawer({
        type: 'wanted-item',
        wastelandId,
        item,
        actions: {
          isAdmin,
          onClaim: setClaimItem,
          onDone: setDoneItem,
          onAccept: setAcceptItem,
          onReject: setRejectItem,
          onCloseItem: setCloseItem,
          onUnclaim: setUnclaimItem,
        },
      });
    },
    [openDrawer, wastelandId, isAdmin]
  );

  // Contribute page title, item count, and CTAs into the wasteland navbar.
  useSetWastelandPageHeader({
    title: 'Wanted Board',
    icon: <ScrollText className="size-4 text-[color:oklch(70%_0.15_30_/_0.6)]" />,
    count: items.length,
    actions: (
      <>
        <button
          type="button"
          onClick={() => setShowPostDialog(true)}
          className="inline-flex items-center gap-1.5 rounded-md border border-white/[0.08] bg-white/[0.03] px-2.5 py-1.5 text-xs text-white/60 transition-colors hover:bg-white/[0.06] hover:text-white/80"
        >
          <Plus className="size-3" />
          Post Wanted Item
        </button>
        <button
          type="button"
          onClick={handleRefresh}
          disabled={refreshMutation.isPending}
          className="inline-flex items-center gap-1.5 rounded-md border border-white/[0.08] bg-white/[0.03] px-2.5 py-1.5 text-xs text-white/60 transition-colors hover:bg-white/[0.06] hover:text-white/80 disabled:opacity-50"
        >
          <RefreshCw className={`size-3 ${refreshMutation.isPending ? 'animate-spin' : ''}`} />
          Refresh
        </button>
      </>
    ),
  });

  return (
    <div className="flex h-full">
      {/* Main list */}
      <div className="flex flex-1 flex-col overflow-hidden">
        {/* Filter bar */}
        <div className="flex items-center gap-3 border-b border-white/[0.06] px-6 py-2">
          {/* Search */}
          <div className="flex items-center gap-1.5 rounded-md border border-white/[0.08] bg-white/[0.03] px-2.5 py-1.5">
            <Search className="size-3 text-white/30" />
            <input
              type="text"
              placeholder="Search wanted items..."
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="w-48 bg-transparent text-xs text-white/80 outline-none placeholder:text-white/25"
            />
          </div>

          {/* Status filter chips */}
          <div className="flex items-center gap-1">
            <FilterChip
              label="All"
              count={items.length}
              active={statusFilter === null}
              onClick={() => setStatusFilter(null)}
            />
            {(['open', 'claimed', 'in_review', 'completed'] as const).map(status => (
              <FilterChip
                key={status}
                label={status}
                count={statusCounts[status] ?? 0}
                active={statusFilter === status}
                onClick={() => setStatusFilter(statusFilter === status ? null : status)}
                dotColor={STATUS_DOT[status]}
              />
            ))}
          </div>

          {/* Sort toggle */}
          <button
            type="button"
            onClick={toggleSort}
            className="ml-auto inline-flex items-center gap-1 rounded-md px-2 py-1 text-[10px] font-medium text-white/30 transition-colors hover:bg-white/[0.04] hover:text-white/50"
          >
            <ArrowUpDown className="size-3" />
            {sortField === 'priority' ? 'Priority' : 'Last activity'}
          </button>
        </div>

        {/* Item list */}
        <div className="flex-1 overflow-y-auto">
          {wantedQuery.isLoading && <WantedListSkeleton />}

          {!wantedQuery.isLoading && filteredItems.length === 0 && (
            <div className="flex flex-col items-center justify-center py-16 text-center">
              <ScrollText className="mb-3 size-8 text-white/10" />
              <p className="text-sm text-white/30">
                {search || statusFilter
                  ? 'No wanted items match your filters.'
                  : 'No wanted items yet.'}
              </p>
            </div>
          )}

          <AnimatePresence mode="popLayout">
            {filteredItems.map((item, i) => (
              <motion.div
                key={item.id}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ delay: Math.min(i * 0.02, 0.3), duration: 0.15 }}
                onClick={() => handleOpenItem(item)}
                className="group flex cursor-pointer items-center gap-3 border-b border-white/[0.04] px-6 py-2.5 transition-colors hover:bg-white/[0.02]"
              >
                <span
                  className={`size-2 shrink-0 rounded-full ${STATUS_DOT[item.status] ?? 'bg-white/20'}`}
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm text-white/80">{item.title}</span>
                    <Badge
                      variant="outline"
                      className={`text-[9px] ${TYPE_COLORS[item.type ?? 'other'] ?? TYPE_COLORS.other}`}
                    >
                      {item.type ?? 'other'}
                    </Badge>
                    <Badge
                      variant="outline"
                      className={`text-[9px] ${STATUS_COLORS[item.status] ?? ''}`}
                    >
                      {item.status}
                    </Badge>
                  </div>
                  <div className="mt-0.5 flex items-center gap-2 text-[10px] text-white/30">
                    {item.description && (
                      <span className="line-clamp-1 max-w-xs">{item.description}</span>
                    )}
                    {'posted_by' in item && (
                      <>
                        <span className="text-white/15">|</span>
                        <span>{String(item.posted_by)}</span>
                      </>
                    )}
                    {(() => {
                      const activity = Math.max(
                        parseDoltDate(item.updated_at)?.getTime() ?? 0,
                        parseDoltDate(item.created_at)?.getTime() ?? 0
                      );
                      if (!activity) return null;
                      return (
                        <>
                          <span className="text-white/15">|</span>
                          <span>{formatDistanceToNow(activity, { addSuffix: true })}</span>
                        </>
                      );
                    })()}
                  </div>
                </div>
                <span
                  className={`shrink-0 text-[10px] font-medium ${PRIORITY_COLORS[String(item.priority ?? 'medium')] ?? 'text-white/40'}`}
                >
                  {item.priority ?? 'medium'}
                </span>
              </motion.div>
            ))}
          </AnimatePresence>
        </div>
      </div>

      {/* Dialogs */}
      <ClaimDialog
        wastelandId={wastelandId}
        item={claimItem}
        onClose={() => setClaimItem(null)}
        onSuccess={invalidateBoard}
      />
      <MarkDoneDialog
        wastelandId={wastelandId}
        item={doneItem}
        onClose={() => setDoneItem(null)}
        onSuccess={invalidateBoard}
      />
      <AcceptDialog
        wastelandId={wastelandId}
        item={acceptItem}
        onClose={() => setAcceptItem(null)}
        onSuccess={invalidateBoard}
      />
      <RejectDialog
        wastelandId={wastelandId}
        item={rejectItem}
        onClose={() => setRejectItem(null)}
        onSuccess={invalidateBoard}
      />
      <CloseItemDialog
        wastelandId={wastelandId}
        item={closeItem}
        onClose={() => setCloseItem(null)}
        onSuccess={invalidateBoard}
      />
      <UnclaimDialog
        wastelandId={wastelandId}
        item={unclaimItem}
        onClose={() => setUnclaimItem(null)}
        onSuccess={invalidateBoard}
      />
      <PostWantedItemDialog
        wastelandId={wastelandId}
        open={showPostDialog}
        onClose={() => setShowPostDialog(false)}
        onSuccess={invalidateBoard}
      />
    </div>
  );
}

// ── Claim dialog ──────────────────────────────────────────────────────────

function ClaimDialog({
  wastelandId,
  item,
  onClose,
  onSuccess,
}: {
  wastelandId: string;
  item: WantedItem | null;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const trpc = useWastelandTRPC();

  const claimMutation = useMutation({
    ...trpc.wasteland.claimWantedItem.mutationOptions(),
    onSuccess: () => {
      toast.success('Item claimed successfully');
      onSuccess();
      onClose();
    },
    onError: err => {
      toast.error(err.message || 'Failed to claim item');
    },
  });

  useSlowOperationToast(claimMutation.isPending);

  return (
    <Dialog
      open={item !== null}
      onOpenChange={open => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="border-white/10 bg-[color:oklch(0.155_0_0)]">
        <DialogHeader>
          <DialogTitle className="text-white/90">Claim wanted item</DialogTitle>
          <DialogDescription className="text-white/50">
            Claim this item? You&apos;ll be responsible for completing it.
          </DialogDescription>
        </DialogHeader>

        {item && (
          <div className="rounded-md border border-white/[0.08] bg-white/[0.03] p-3">
            <p className="text-sm font-medium text-white/80">{item.title}</p>
            <p className="mt-1 text-xs text-white/40 line-clamp-2">{item.description}</p>
          </div>
        )}

        <DialogFooter>
          <button
            type="button"
            onClick={onClose}
            disabled={claimMutation.isPending}
            className="rounded-md border border-white/[0.08] bg-white/[0.03] px-4 py-2 text-sm text-white/60 transition-colors hover:bg-white/[0.06] disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={claimMutation.isPending || !item}
            onClick={() => {
              if (item) claimMutation.mutate({ wastelandId, itemId: item.id });
            }}
            className="inline-flex items-center gap-1.5 rounded-md bg-emerald-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-emerald-500 disabled:opacity-50"
          >
            {claimMutation.isPending && <Loader2 className="size-3.5 animate-spin" />}
            Claim
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Mark done dialog ─────────────────────────────────────────────────────

function MarkDoneDialog({
  wastelandId,
  item,
  onClose,
  onSuccess,
}: {
  wastelandId: string;
  item: WantedItem | null;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const trpc = useWastelandTRPC();
  const [evidence, setEvidence] = useState('');

  const doneMutation = useMutation({
    ...trpc.wasteland.markWantedItemDone.mutationOptions(),
    onSuccess: () => {
      toast.success('Item marked as done');
      onSuccess();
      handleClose();
    },
    onError: err => {
      toast.error(err.message || 'Failed to mark item as done');
    },
  });

  useSlowOperationToast(doneMutation.isPending);

  const handleClose = useCallback(() => {
    setEvidence('');
    onClose();
  }, [onClose]);

  const handleSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      if (item && evidence.trim()) {
        doneMutation.mutate({ wastelandId, itemId: item.id, evidence: evidence.trim() });
      }
    },
    [doneMutation, wastelandId, item, evidence]
  );

  return (
    <Dialog
      open={item !== null}
      onOpenChange={open => {
        if (!open) handleClose();
      }}
    >
      <DialogContent className="border-white/10 bg-[color:oklch(0.155_0_0)]">
        <DialogHeader>
          <DialogTitle className="text-white/90">Mark as done</DialogTitle>
          <DialogDescription className="text-white/50">
            Provide evidence (PR or commit URL) that this item has been completed.
          </DialogDescription>
        </DialogHeader>

        {item && (
          <div className="rounded-md border border-white/[0.08] bg-white/[0.03] p-3">
            <p className="text-sm font-medium text-white/80">{item.title}</p>
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label
              htmlFor="evidence-url"
              className="mb-1.5 block text-xs font-medium text-white/60"
            >
              Evidence URL
            </label>
            <input
              id="evidence-url"
              type="url"
              required
              placeholder="https://github.com/org/repo/pull/123"
              value={evidence}
              onChange={e => setEvidence(e.target.value)}
              className="w-full rounded-md border border-white/[0.08] bg-white/[0.03] px-3 py-2 text-sm text-white/80 outline-none placeholder:text-white/25 focus:border-white/20"
            />
          </div>

          <DialogFooter>
            <button
              type="button"
              onClick={handleClose}
              disabled={doneMutation.isPending}
              className="rounded-md border border-white/[0.08] bg-white/[0.03] px-4 py-2 text-sm text-white/60 transition-colors hover:bg-white/[0.06] disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={doneMutation.isPending || !evidence.trim()}
              className="inline-flex items-center gap-1.5 rounded-md bg-sky-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-sky-500 disabled:opacity-50"
            >
              {doneMutation.isPending && <Loader2 className="size-3.5 animate-spin" />}
              Mark as done
            </button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ── Accept dialog ────────────────────────────────────────────────────────

function AcceptDialog({
  wastelandId,
  item,
  onClose,
  onSuccess,
}: {
  wastelandId: string;
  item: WantedItem | null;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const trpc = useWastelandTRPC();
  const [quality, setQuality] = useState<'excellent' | 'good' | 'fair' | 'poor'>('good');
  // `message` maps to `wl accept --message` — it's recorded on the stamp,
  // not as a free-form PR comment.
  const [message, setMessage] = useState('');

  const acceptMutation = useMutation({
    ...trpc.wasteland.acceptWantedItem.mutationOptions(),
    onSuccess: () => {
      toast.success('Contribution accepted');
      onSuccess();
      handleClose();
    },
    onError: err => toast.error(err.message || 'Failed to accept contribution'),
  });

  useSlowOperationToast(acceptMutation.isPending);

  const handleClose = useCallback(() => {
    setQuality('good');
    setMessage('');
    onClose();
  }, [onClose]);

  const handleSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      if (!item) return;
      acceptMutation.mutate({
        wastelandId,
        itemId: item.id,
        quality,
        message: message.trim() || undefined,
      });
    },
    [acceptMutation, wastelandId, item, quality, message]
  );

  return (
    <Dialog
      open={item !== null}
      onOpenChange={open => {
        if (!open) handleClose();
      }}
    >
      <DialogContent className="border-white/10 bg-[color:oklch(0.155_0_0)]">
        <DialogHeader>
          <DialogTitle className="text-white/90">Accept contribution</DialogTitle>
          <DialogDescription className="text-white/50">
            Stamp this contribution as approved. A stamp is committed to the upstream rigs table.
          </DialogDescription>
        </DialogHeader>

        {item && (
          <div className="rounded-md border border-white/[0.08] bg-white/[0.03] p-3">
            <p className="text-sm font-medium text-white/80">{item.title}</p>
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label
              htmlFor="accept-quality"
              className="mb-1.5 block text-xs font-medium text-white/60"
            >
              Quality
            </label>
            <select
              id="accept-quality"
              value={quality}
              onChange={e => setQuality(e.target.value as typeof quality)}
              className="w-full rounded-md border border-white/[0.08] bg-white/[0.03] px-3 py-2 text-sm text-white/80 outline-none focus:border-white/20"
            >
              <option value="excellent">Excellent</option>
              <option value="good">Good</option>
              <option value="fair">Fair</option>
              <option value="poor">Poor</option>
            </select>
          </div>

          <div>
            <label
              htmlFor="accept-message"
              className="mb-1.5 block text-xs font-medium text-white/60"
            >
              Stamp message (optional)
            </label>
            <textarea
              id="accept-message"
              rows={3}
              value={message}
              onChange={e => setMessage(e.target.value)}
              placeholder="Leave a note on the stamp..."
              className="w-full resize-none rounded-md border border-white/[0.08] bg-white/[0.03] px-3 py-2 text-sm text-white/80 outline-none placeholder:text-white/25 focus:border-white/20"
            />
          </div>

          <DialogFooter>
            <button
              type="button"
              onClick={handleClose}
              disabled={acceptMutation.isPending}
              className="rounded-md border border-white/[0.08] bg-white/[0.03] px-4 py-2 text-sm text-white/60 transition-colors hover:bg-white/[0.06] disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={acceptMutation.isPending}
              className="inline-flex items-center gap-1.5 rounded-md bg-emerald-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-emerald-500 disabled:opacity-50"
            >
              {acceptMutation.isPending && <Loader2 className="size-3.5 animate-spin" />}
              Accept
            </button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ── Reject dialog ────────────────────────────────────────────────────────

function RejectDialog({
  wastelandId,
  item,
  onClose,
  onSuccess,
}: {
  wastelandId: string;
  item: WantedItem | null;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const trpc = useWastelandTRPC();
  // `reason` maps to `wl reject --reason` — it becomes part of the commit
  // message on the rejection, visible to the contributor on the PR.
  const [reason, setReason] = useState('');

  const rejectMutation = useMutation({
    ...trpc.wasteland.rejectWantedItem.mutationOptions(),
    onSuccess: () => {
      toast.success('Contribution rejected');
      onSuccess();
      handleClose();
    },
    onError: err => toast.error(err.message || 'Failed to reject contribution'),
  });

  useSlowOperationToast(rejectMutation.isPending);

  const handleClose = useCallback(() => {
    setReason('');
    onClose();
  }, [onClose]);

  const handleSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      if (!item || !reason.trim()) return;
      rejectMutation.mutate({
        wastelandId,
        itemId: item.id,
        reason: reason.trim(),
      });
    },
    [rejectMutation, wastelandId, item, reason]
  );

  return (
    <Dialog
      open={item !== null}
      onOpenChange={open => {
        if (!open) handleClose();
      }}
    >
      <DialogContent className="border-white/10 bg-[color:oklch(0.155_0_0)]">
        <DialogHeader>
          <DialogTitle className="text-white/90">Reject contribution</DialogTitle>
          <DialogDescription className="text-white/50">
            Reject this contribution. The reason lands in the commit message so the contributor sees
            it on the PR.
          </DialogDescription>
        </DialogHeader>

        {item && (
          <div className="rounded-md border border-white/[0.08] bg-white/[0.03] p-3">
            <p className="text-sm font-medium text-white/80">{item.title}</p>
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label
              htmlFor="reject-reason"
              className="mb-1.5 block text-xs font-medium text-white/60"
            >
              Reason <span className="text-red-400">*</span>
            </label>
            <textarea
              id="reject-reason"
              required
              rows={3}
              value={reason}
              onChange={e => setReason(e.target.value)}
              placeholder="Explain why you're rejecting this contribution..."
              className="w-full resize-none rounded-md border border-white/[0.08] bg-white/[0.03] px-3 py-2 text-sm text-white/80 outline-none placeholder:text-white/25 focus:border-white/20"
            />
          </div>

          <DialogFooter>
            <button
              type="button"
              onClick={handleClose}
              disabled={rejectMutation.isPending}
              className="rounded-md border border-white/[0.08] bg-white/[0.03] px-4 py-2 text-sm text-white/60 transition-colors hover:bg-white/[0.06] disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={rejectMutation.isPending || !reason.trim()}
              className="inline-flex items-center gap-1.5 rounded-md bg-red-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-red-500 disabled:opacity-50"
            >
              {rejectMutation.isPending && <Loader2 className="size-3.5 animate-spin" />}
              Reject
            </button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ── Close-item dialog ────────────────────────────────────────────────────

function CloseItemDialog({
  wastelandId,
  item,
  onClose,
  onSuccess,
}: {
  wastelandId: string;
  item: WantedItem | null;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const trpc = useWastelandTRPC();

  const closeMutation = useMutation({
    ...trpc.wasteland.closeWantedItem.mutationOptions(),
    onSuccess: () => {
      toast.success('Item closed');
      onSuccess();
      handleClose();
    },
    onError: err => toast.error(err.message || 'Failed to close item'),
  });

  useSlowOperationToast(closeMutation.isPending);

  const handleClose = useCallback(() => {
    onClose();
  }, [onClose]);

  return (
    <Dialog
      open={item !== null}
      onOpenChange={open => {
        if (!open) handleClose();
      }}
    >
      <DialogContent className="border-white/10 bg-[color:oklch(0.155_0_0)]">
        <DialogHeader>
          <DialogTitle className="text-white/90">Close wanted item</DialogTitle>
          <DialogDescription className="text-white/50">
            Close this item without accepting a contribution. No stamp is issued.
          </DialogDescription>
        </DialogHeader>

        {item && (
          <div className="rounded-md border border-white/[0.08] bg-white/[0.03] p-3">
            <p className="text-sm font-medium text-white/80">{item.title}</p>
          </div>
        )}

        <DialogFooter>
          <button
            type="button"
            onClick={handleClose}
            disabled={closeMutation.isPending}
            className="rounded-md border border-white/[0.08] bg-white/[0.03] px-4 py-2 text-sm text-white/60 transition-colors hover:bg-white/[0.06] disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={closeMutation.isPending || !item}
            onClick={() => {
              if (item) closeMutation.mutate({ wastelandId, itemId: item.id });
            }}
            className="inline-flex items-center gap-1.5 rounded-md bg-white/[0.1] px-4 py-2 text-sm font-medium text-white/90 transition-colors hover:bg-white/[0.15] disabled:opacity-50"
          >
            {closeMutation.isPending && <Loader2 className="size-3.5 animate-spin" />}
            Close item
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Unclaim dialog ───────────────────────────────────────────────────────

function UnclaimDialog({
  wastelandId,
  item,
  onClose,
  onSuccess,
}: {
  wastelandId: string;
  item: WantedItem | null;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const trpc = useWastelandTRPC();

  const unclaimMutation = useMutation({
    ...trpc.wasteland.unclaimWantedItem.mutationOptions(),
    onSuccess: () => {
      toast.success('Claim released');
      onSuccess();
      handleClose();
    },
    onError: err => toast.error(err.message || 'Failed to unclaim item'),
  });

  useSlowOperationToast(unclaimMutation.isPending);

  const handleClose = useCallback(() => {
    onClose();
  }, [onClose]);

  return (
    <Dialog
      open={item !== null}
      onOpenChange={open => {
        if (!open) handleClose();
      }}
    >
      <DialogContent className="border-white/10 bg-[color:oklch(0.155_0_0)]">
        <DialogHeader>
          <DialogTitle className="text-white/90">Unclaim item</DialogTitle>
          <DialogDescription className="text-white/50">
            Release this claim. The item returns to the open pool.
          </DialogDescription>
        </DialogHeader>

        {item && (
          <div className="rounded-md border border-white/[0.08] bg-white/[0.03] p-3">
            <p className="text-sm font-medium text-white/80">{item.title}</p>
            {item.claimed_by && (
              <p className="mt-1 font-mono text-xs text-white/40">
                Currently claimed by {item.claimed_by}
              </p>
            )}
          </div>
        )}

        <DialogFooter>
          <button
            type="button"
            onClick={handleClose}
            disabled={unclaimMutation.isPending}
            className="rounded-md border border-white/[0.08] bg-white/[0.03] px-4 py-2 text-sm text-white/60 transition-colors hover:bg-white/[0.06] disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={unclaimMutation.isPending || !item}
            onClick={() => {
              if (item) unclaimMutation.mutate({ wastelandId, itemId: item.id });
            }}
            className="inline-flex items-center gap-1.5 rounded-md bg-amber-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-amber-500 disabled:opacity-50"
          >
            {unclaimMutation.isPending && <Loader2 className="size-3.5 animate-spin" />}
            Unclaim
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Post wanted item dialog ──────────────────────────────────────────────

function PostWantedItemDialog({
  wastelandId,
  open,
  onClose,
  onSuccess,
}: {
  wastelandId: string;
  open: boolean;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const trpc = useWastelandTRPC();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState<'low' | 'medium' | 'high'>('medium');
  const [type, setType] = useState<'feature' | 'bug' | 'docs' | 'other'>('feature');

  const postMutation = useMutation({
    ...trpc.wasteland.postWantedItem.mutationOptions(),
    onSuccess: () => {
      toast.success('Wanted item posted');
      onSuccess();
      handleClose();
    },
    onError: err => {
      toast.error(err.message || 'Failed to post wanted item');
    },
  });

  useSlowOperationToast(postMutation.isPending);

  const handleClose = useCallback(() => {
    setTitle('');
    setDescription('');
    setPriority('medium');
    setType('feature');
    onClose();
  }, [onClose]);

  const handleSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      if (title.trim() && description.trim()) {
        postMutation.mutate({
          wastelandId,
          title: title.trim(),
          description: description.trim(),
          priority,
          type,
        });
      }
    },
    [postMutation, wastelandId, title, description, priority, type]
  );

  return (
    <Dialog
      open={open}
      onOpenChange={openState => {
        if (!openState) handleClose();
      }}
    >
      <DialogContent className="border-white/10 bg-[color:oklch(0.155_0_0)]">
        <DialogHeader>
          <DialogTitle className="text-white/90">Post wanted item</DialogTitle>
          <DialogDescription className="text-white/50">
            Post a new item to the wanted board.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label htmlFor="post-title" className="mb-1.5 block text-xs font-medium text-white/60">
              Title
            </label>
            <input
              id="post-title"
              type="text"
              required
              maxLength={256}
              placeholder="Brief title for the wanted item"
              value={title}
              onChange={e => setTitle(e.target.value)}
              className="w-full rounded-md border border-white/[0.08] bg-white/[0.03] px-3 py-2 text-sm text-white/80 outline-none placeholder:text-white/25 focus:border-white/20"
            />
          </div>

          <div>
            <label
              htmlFor="post-description"
              className="mb-1.5 block text-xs font-medium text-white/60"
            >
              Description
            </label>
            <textarea
              id="post-description"
              required
              maxLength={4096}
              rows={4}
              placeholder="Detailed description of what's needed..."
              value={description}
              onChange={e => setDescription(e.target.value)}
              className="w-full resize-none rounded-md border border-white/[0.08] bg-white/[0.03] px-3 py-2 text-sm text-white/80 outline-none placeholder:text-white/25 focus:border-white/20"
            />
          </div>

          <div className="flex gap-4">
            <div className="flex-1">
              <label
                htmlFor="post-priority"
                className="mb-1.5 block text-xs font-medium text-white/60"
              >
                Priority
              </label>
              <select
                id="post-priority"
                value={priority}
                onChange={e => setPriority(e.target.value as typeof priority)}
                className="w-full rounded-md border border-white/[0.08] bg-white/[0.03] px-3 py-2 text-sm text-white/80 outline-none focus:border-white/20"
              >
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
              </select>
            </div>

            <div className="flex-1">
              <label htmlFor="post-type" className="mb-1.5 block text-xs font-medium text-white/60">
                Type
              </label>
              <select
                id="post-type"
                value={type}
                onChange={e => setType(e.target.value as typeof type)}
                className="w-full rounded-md border border-white/[0.08] bg-white/[0.03] px-3 py-2 text-sm text-white/80 outline-none focus:border-white/20"
              >
                <option value="feature">Feature</option>
                <option value="bug">Bug</option>
                <option value="docs">Docs</option>
                <option value="other">Other</option>
              </select>
            </div>
          </div>

          <DialogFooter>
            <button
              type="button"
              onClick={handleClose}
              disabled={postMutation.isPending}
              className="rounded-md border border-white/[0.08] bg-white/[0.03] px-4 py-2 text-sm text-white/60 transition-colors hover:bg-white/[0.06] disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={postMutation.isPending || !title.trim() || !description.trim()}
              className="inline-flex items-center gap-1.5 rounded-md bg-violet-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-violet-500 disabled:opacity-50"
            >
              {postMutation.isPending && <Loader2 className="size-3.5 animate-spin" />}
              Post
            </button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ── Skeleton ──────────────────────────────────────────────────────────────

function WantedListSkeleton() {
  return (
    <div className="space-y-0">
      {Array.from({ length: 8 }).map((_, i) => (
        <div
          key={i}
          className="flex animate-pulse items-center gap-3 border-b border-white/[0.04] px-6 py-3"
        >
          <div className="size-2 rounded-full bg-white/10" />
          <div className="flex-1 space-y-1.5">
            <div className="h-3 w-48 rounded bg-white/5" />
            <div className="h-2 w-32 rounded bg-white/[0.03]" />
          </div>
          <div className="h-3 w-14 rounded bg-white/5" />
        </div>
      ))}
    </div>
  );
}

// ── Filter chip ───────────────────────────────────────────────────────────

function FilterChip({
  label,
  count,
  active,
  onClick,
  dotColor,
}: {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
  dotColor?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[10px] font-medium capitalize transition-colors ${
        active
          ? 'bg-white/[0.08] text-white/70'
          : 'text-white/30 hover:bg-white/[0.04] hover:text-white/50'
      }`}
    >
      {dotColor && <span className={`size-1.5 rounded-full ${dotColor}`} />}
      {label}
      <span className="font-mono text-[9px] opacity-60">{count}</span>
    </button>
  );
}
