'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
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
import {
  ArrowUpDown,
  ArrowUpRight,
  Hourglass,
  Loader2,
  Plus,
  RefreshCw,
  ScrollText,
  Search,
} from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { AnimatePresence, motion } from 'motion/react';
import { toast } from 'sonner';
import { lastActivityMs, parseDoltDate } from '@/lib/wasteland/date';

type WantedItem = WastelandOutputs['wasteland']['browseWantedBoard'][number];

type SortField = 'priority' | 'activity';

const STATUS_FILTERS = ['open', 'claimed', 'in_review', 'completed'] as const;
type StatusFilter = (typeof STATUS_FILTERS)[number];

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

function parseStatusFilter(value: string | null | undefined): StatusFilter | 'all' {
  if (value === 'all') return 'all';
  if (value && STATUS_FILTERS.includes(value as StatusFilter)) return value as StatusFilter;
  return 'open';
}

function parseSortField(value: string | null | undefined): SortField {
  return value === 'priority' ? 'priority' : 'activity';
}

// ── Slow operation toast helper ──────────────────────────────────────────

const COLD_START_DELAY_MS = 3000;

/**
 * Shows a "Starting wasteland container..." toast if an operation takes
 * longer than 3 seconds (likely a cold start).
 */
export function useSlowOperationToast(isPending: boolean) {
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

/**
 * Render mode for the board.
 *
 * - `fork` (default): the existing behavior — claim/post/done/accept/reject
 *   actions, full drawer with action callbacks. Used by the legacy
 *   /wasteland/[wastelandId]/wanted route and the new
 *   /wasteland/[owner]/[repo]/fork route once it lands (M2.3).
 * - `upstream`: the M2.2 read-only "Upstream" view used by
 *   /wasteland/[owner]/[repo]. Mutations are hidden, the drawer opens
 *   with no action callbacks (read-only), and each row gets a
 *   "Take to my workshop" link that hands the item off to the fork.
 */
export type WantedBoardMode = 'fork' | 'upstream';

type WantedBoardClientProps = {
  wastelandId: string;
  /** Defaults to `fork` for backwards compat with the legacy route. */
  mode?: WantedBoardMode;
  /** Required when `mode === 'upstream'`. Used to build per-row hand-off links. */
  workshopBasePath?: string;
  /** Header title shown in the dashboard chrome. Defaults vary by mode. */
  headerTitle?: string;
};

export function WantedBoardClient({
  wastelandId,
  mode = 'fork',
  workshopBasePath,
  headerTitle,
}: WantedBoardClientProps) {
  const isUpstream = mode === 'upstream';
  const trpc = useWastelandTRPC();
  const queryClient = useQueryClient();
  const { open: openDrawer } = useDrawerStack();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const statusFilter = parseStatusFilter(searchParams?.get('status'));
  const search = searchParams?.get('q') ?? '';
  const sortField = parseSortField(searchParams?.get('sort'));

  const [localSearch, setLocalSearch] = useState(search);
  const debounceTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setLocalSearch(search);
  }, [search]);

  useEffect(() => {
    return () => {
      if (debounceTimeoutRef.current) {
        clearTimeout(debounceTimeoutRef.current);
      }
    };
  }, []);

  const updateFilterParams = useCallback(
    (updates: { status?: StatusFilter | 'all'; q?: string; sort?: SortField }) => {
      const next = new URLSearchParams(searchParams?.toString());
      if (updates.status !== undefined) {
        if (updates.status === 'all') next.set('status', 'all');
        else if (updates.status === 'open') next.delete('status');
        else next.set('status', updates.status);
      }
      if (updates.q !== undefined) {
        const trimmed = updates.q.trim();
        if (trimmed) next.set('q', trimmed);
        else next.delete('q');
      }
      if (updates.sort !== undefined) {
        if (updates.sort === 'activity') next.delete('sort');
        else next.set('sort', updates.sort);
      }
      const query = next.toString();
      router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
    },
    [pathname, router, searchParams]
  );

  const handleSearchChange = useCallback(
    (val: string) => {
      setLocalSearch(val);

      if (debounceTimeoutRef.current) {
        clearTimeout(debounceTimeoutRef.current);
      }

      if (val === '') {
        updateFilterParams({ q: '' });
      } else {
        debounceTimeoutRef.current = setTimeout(() => {
          updateFilterParams({ q: val });
        }, 250);
      }
    },
    [updateFilterParams]
  );

  // Dialog state
  const [doneItem, setDoneItem] = useState<WantedItem | null>(null);
  const [acceptItem, setAcceptItem] = useState<WantedItem | null>(null);
  const [rejectItem, setRejectItem] = useState<WantedItem | null>(null);
  const [closeItem, setCloseItem] = useState<WantedItem | null>(null);
  const [unclaimItem, setUnclaimItem] = useState<WantedItem | null>(null);

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

  // Auto-open the wanted-item drawer when the page is loaded with
  // `?itemId=...` (e.g. from a deep link in the gastown bead drawer).
  // The `wanted-item-by-id` entry fetches the item directly so we don't
  // have to wait for the board query before opening.
  const autoOpenedItemRef = useRef<string | null>(null);
  useEffect(() => {
    const itemId = searchParams?.get('itemId');
    if (!itemId) return;
    if (autoOpenedItemRef.current === itemId) return;
    autoOpenedItemRef.current = itemId;
    openDrawer({
      type: 'wanted-item-by-id',
      wastelandId,
      itemId,
      actions: isUpstream
        ? null
        : {
            isAdmin,
            onDone: setDoneItem,
            onAccept: setAcceptItem,
            onReject: setRejectItem,
            onCloseItem: setCloseItem,
            onUnclaim: setUnclaimItem,
          },
    });
  }, [searchParams, openDrawer, wastelandId, isUpstream, isAdmin]);

  // This user's open claim/done/edit PRs on upstream. Used to decorate
  // rows with a "Pending review" badge between submit-click and admin-
  // merge. Polls at 30s; the drawer's panel polls faster (15s) since the
  // user is actively watching that row. Degrades to empty on error.
  const pendingClaimsQuery = useQuery({
    ...trpc.wasteland.listMyPendingClaims.queryOptions({ wastelandId }),
    refetchInterval: 30_000,
  });
  const pendingByItemId = useMemo(() => {
    const map = new Map<string, { pullId: string; prUrl: string }>();
    for (const p of pendingClaimsQuery.data?.items ?? []) {
      map.set(p.item_id, { pullId: p.pull_id, prUrl: p.pr_url });
    }
    return map;
  }, [pendingClaimsQuery.data]);

  // When a previously-tracked pending claim drops out of the set, the
  // admin merged (or closed) the PR upstream. Kick the board so the row
  // picks up the new upstream state without waiting for its own 30s
  // poll — otherwise the user sees `open` + empty pending-review for a
  // moment before the board catches up.
  const prevPendingIdsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const current = new Set(pendingByItemId.keys());
    const prev = prevPendingIdsRef.current;
    let disappeared = false;
    for (const id of prev) {
      if (!current.has(id)) {
        disappeared = true;
        break;
      }
    }
    prevPendingIdsRef.current = current;
    if (disappeared) {
      void queryClient.invalidateQueries({
        queryKey: trpc.wasteland.browseWantedBoard.queryKey({ wastelandId }),
      });
    }
  }, [pendingByItemId, queryClient, trpc, wastelandId]);

  const refreshMutation = {
    isPending: false,
    mutate: () => {
      void queryClient.invalidateQueries({
        queryKey: trpc.wasteland.browseWantedBoard.queryKey({ wastelandId }),
      });
      void queryClient.invalidateQueries({
        queryKey: trpc.wasteland.listMyPendingClaims.queryKey({ wastelandId }),
      });
    },
  };

  const invalidateBoard = useCallback(() => {
    void queryClient.invalidateQueries({
      queryKey: trpc.wasteland.browseWantedBoard.queryKey({ wastelandId }),
    });
    void queryClient.invalidateQueries({
      queryKey: trpc.wasteland.listMyPendingClaims.queryKey({ wastelandId }),
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

    if (statusFilter !== 'all') {
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
      return (
        lastActivityMs(b.updated_at, b.created_at) - lastActivityMs(a.updated_at, a.created_at)
      );
    });

    return result;
  }, [items, statusFilter, search, sortField]);

  const handleRefresh = useCallback(() => {
    refreshMutation.mutate();
  }, [refreshMutation, wastelandId]);

  const toggleSort = useCallback(() => {
    updateFilterParams({ sort: sortField === 'priority' ? 'activity' : 'priority' });
  }, [sortField, updateFilterParams]);

  const handleOpenItem = useCallback(
    (item: WantedItem) => {
      openDrawer({
        type: 'wanted-item',
        wastelandId,
        item,
        // Upstream mode is read-only — passing `actions: null` makes the
        // drawer panel hide every mutation affordance (see WantedItemPanel).
        actions: isUpstream
          ? null
          : {
              isAdmin,
              onDone: setDoneItem,
              onAccept: setAcceptItem,
              onReject: setRejectItem,
              onCloseItem: setCloseItem,
              onUnclaim: setUnclaimItem,
            },
        links:
          isUpstream && workshopBasePath
            ? { workshopHref: `${workshopBasePath}/fork?wantedId=${encodeURIComponent(item.id)}` }
            : undefined,
        // Default-tab selection: the upstream view opens on Upstream
        // (read-only), the legacy fork view opens on My branch so the
        // user lands on actionable affordances. The drawer falls back
        // to Upstream when a requested tab isn't available.
        initialTab: isUpstream ? 'upstream' : 'branch',
      });
    },
    [openDrawer, wastelandId, isAdmin, isUpstream]
  );

  // Contribute page title, item count, and CTAs into the wasteland navbar.
  useSetWastelandPageHeader({
    title: headerTitle ?? (isUpstream ? 'Upstream' : 'Wanted Board'),
    icon: <ScrollText className="size-4 text-[color:oklch(70%_0.15_30_/_0.6)]" />,
    count: items.length,
    actions: (
      <>
        <button
          type="button"
          onClick={() =>
            openDrawer({
              type: 'post-wanted-item',
              wastelandId,
              onSuccess: invalidateBoard,
            })
          }
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
              value={localSearch}
              onChange={e => handleSearchChange(e.target.value)}
              className="w-48 bg-transparent text-xs text-white/80 outline-none placeholder:text-white/25"
            />
          </div>

          {/* Status filter chips */}
          <div className="flex items-center gap-1">
            <FilterChip
              label="All"
              count={items.length}
              active={statusFilter === 'all'}
              onClick={() => updateFilterParams({ status: 'all' })}
            />
            {STATUS_FILTERS.map(status => (
              <FilterChip
                key={status}
                label={status}
                count={statusCounts[status] ?? 0}
                active={statusFilter === status}
                onClick={() =>
                  updateFilterParams({ status: statusFilter === status ? 'all' : status })
                }
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
                {search || statusFilter !== 'all'
                  ? 'No wanted items match your filters.'
                  : 'No wanted items yet.'}
              </p>
            </div>
          )}

          <AnimatePresence mode="popLayout">
            {filteredItems.map((item, i) => {
              const pending = pendingByItemId.get(item.id);
              return (
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
                      {pending && (
                        <Badge
                          variant="outline"
                          className="gap-1 border-amber-500/20 bg-amber-500/10 text-[9px] text-amber-300"
                          title={`You have an open PR (#${pending.pullId}) for this item awaiting review.`}
                        >
                          <Hourglass className="size-2.5" />
                          pending review
                        </Badge>
                      )}
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
                  {isUpstream && workshopBasePath && (
                    <Link
                      href={`${workshopBasePath}/fork?wantedId=${encodeURIComponent(item.id)}`}
                      onClick={e => e.stopPropagation()}
                      className="inline-flex shrink-0 items-center gap-1 rounded-md border border-white/[0.08] bg-white/[0.03] px-2 py-1 text-[10px] font-medium text-white/55 opacity-0 transition-all group-hover:opacity-100 hover:bg-white/[0.06] hover:text-white/85 focus-visible:opacity-100"
                    >
                      Take to my workshop
                      <ArrowUpRight className="size-3" />
                    </Link>
                  )}
                </motion.div>
              );
            })}
          </AnimatePresence>
        </div>
      </div>

      {/* Drawer item actions are fork/workshop-only, but posting a wanted
          item should be available from the upstream board too. */}
      {!isUpstream && (
        <>
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
        </>
      )}
    </div>
  );
}

// ── Mark done dialog ─────────────────────────────────────────────────────

export function MarkDoneDialog({
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
    onSuccess: result => {
      toast.success(
        result.pr_url ? 'Item marked as done — PR opened' : 'Item marked as done',
        result.pr_url
          ? {
              description: result.pr_url,
              action: {
                label: 'Open',
                onClick: () => window.open(result.pr_url ?? '', '_blank', 'noopener,noreferrer'),
              },
            }
          : undefined
      );
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

export function AcceptDialog({
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
  const [reliability, setReliability] = useState<'excellent' | 'good' | 'fair' | 'poor'>('good');
  const [severity, setSeverity] = useState<'leaf' | 'branch' | 'root'>('leaf');
  const [skillTags, setSkillTags] = useState('');
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
    setReliability('good');
    setSeverity('leaf');
    setSkillTags('');
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
        reliability,
        severity,
        skillTags: splitSkillTags(skillTags),
        message: message.trim() || undefined,
      });
    },
    [acceptMutation, wastelandId, item, quality, reliability, severity, skillTags, message]
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

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label
                htmlFor="accept-reliability"
                className="mb-1.5 block text-xs font-medium text-white/60"
              >
                Reliability
              </label>
              <select
                id="accept-reliability"
                value={reliability}
                onChange={e => setReliability(e.target.value as typeof reliability)}
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
                htmlFor="accept-severity"
                className="mb-1.5 block text-xs font-medium text-white/60"
              >
                Severity
              </label>
              <select
                id="accept-severity"
                value={severity}
                onChange={e => setSeverity(e.target.value as typeof severity)}
                className="w-full rounded-md border border-white/[0.08] bg-white/[0.03] px-3 py-2 text-sm text-white/80 outline-none focus:border-white/20"
              >
                <option value="leaf">Leaf</option>
                <option value="branch">Branch</option>
                <option value="root">Root</option>
              </select>
            </div>
          </div>

          <div>
            <label
              htmlFor="accept-skills"
              className="mb-1.5 block text-xs font-medium text-white/60"
            >
              Skill tags (optional)
            </label>
            <input
              id="accept-skills"
              value={skillTags}
              onChange={e => setSkillTags(e.target.value)}
              placeholder="go, federation"
              className="w-full rounded-md border border-white/[0.08] bg-white/[0.03] px-3 py-2 text-sm text-white/80 outline-none placeholder:text-white/25 focus:border-white/20"
            />
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

function splitSkillTags(value: string): string[] | undefined {
  const tags = value
    .split(',')
    .map(tag => tag.trim())
    .filter(Boolean);
  return tags.length > 0 ? tags : undefined;
}

// ── Reject dialog ────────────────────────────────────────────────────────

export function RejectDialog({
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

export function CloseItemDialog({
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

export function UnclaimDialog({
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
