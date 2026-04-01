'use client';

import { useState, useMemo, useCallback } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useWastelandTRPC } from '@/lib/wasteland/trpc';
import type { WastelandOutputs } from '@/lib/wasteland/trpc';
import { Badge } from '@/components/ui/badge';
import { ScrollText, Search, RefreshCw, X, ArrowUpDown } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { motion, AnimatePresence } from 'motion/react';

type WantedItem = WastelandOutputs['wasteland']['browseWantedBoard'][number];

type SortField = 'priority' | 'date';

const STATUS_COLORS: Record<string, string> = {
  open: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20',
  claimed: 'bg-amber-500/10 text-amber-400 border-amber-500/20',
  done: 'bg-sky-500/10 text-sky-400 border-sky-500/20',
};

const STATUS_DOT: Record<string, string> = {
  open: 'bg-emerald-400',
  claimed: 'bg-amber-400',
  done: 'bg-sky-400',
};

const PRIORITY_COLORS: Record<string, string> = {
  low: 'text-white/55',
  medium: 'text-sky-300',
  high: 'text-amber-300',
  critical: 'text-red-300',
};

const PRIORITY_ORDER: Record<string, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

const TYPE_COLORS: Record<string, string> = {
  feature: 'bg-violet-500/10 text-violet-400 border-violet-500/20',
  bug: 'bg-red-500/10 text-red-400 border-red-500/20',
  docs: 'bg-blue-500/10 text-blue-400 border-blue-500/20',
  other: 'bg-white/[0.04] text-white/40 border-white/10',
};

type WantedBoardClientProps = {
  wastelandId: string;
};

export function WantedBoardClient({ wastelandId }: WantedBoardClientProps) {
  const trpc = useWastelandTRPC();
  const queryClient = useQueryClient();

  const [statusFilter, setStatusFilter] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [sortField, setSortField] = useState<SortField>('priority');
  const [selectedItem, setSelectedItem] = useState<WantedItem | null>(null);

  const wantedQuery = useQuery({
    ...trpc.wasteland.browseWantedBoard.queryOptions({ wastelandId }),
    refetchInterval: 30_000,
  });

  const refreshMutation = useMutation({
    ...trpc.wasteland.refreshWantedBoard.mutationOptions(),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: trpc.wasteland.browseWantedBoard.queryKey({ wastelandId }),
      });
    },
  });

  const items = wantedQuery.data ?? [];

  const statusCounts = useMemo(() => {
    const counts: Record<string, number> = { open: 0, claimed: 0, done: 0 };
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
        return (PRIORITY_ORDER[a.priority] ?? 3) - (PRIORITY_ORDER[b.priority] ?? 3);
      }
      return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
    });

    return result;
  }, [items, statusFilter, search, sortField]);

  const handleRefresh = useCallback(() => {
    refreshMutation.mutate({ wastelandId });
  }, [refreshMutation, wastelandId]);

  const toggleSort = useCallback(() => {
    setSortField(prev => (prev === 'priority' ? 'date' : 'priority'));
  }, []);

  return (
    <div className="flex h-full">
      {/* Main list */}
      <div className="flex flex-1 flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-white/[0.06] px-6 py-3">
          <div className="flex items-center gap-2">
            <ScrollText className="size-4 text-[color:oklch(70%_0.15_30_/_0.6)]" />
            <h2 className="text-lg font-semibold tracking-tight text-white/90">Wanted Board</h2>
            <span className="ml-1 font-mono text-xs text-white/30">{items.length}</span>
          </div>
          <button
            type="button"
            onClick={handleRefresh}
            disabled={refreshMutation.isPending}
            className="inline-flex items-center gap-1.5 rounded-md border border-white/[0.08] bg-white/[0.03] px-2.5 py-1.5 text-xs text-white/60 transition-colors hover:bg-white/[0.06] hover:text-white/80 disabled:opacity-50"
          >
            <RefreshCw
              className={`size-3 ${refreshMutation.isPending ? 'animate-spin' : ''}`}
            />
            Refresh
          </button>
        </div>

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
            {(['open', 'claimed', 'done'] as const).map(status => (
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
            {sortField === 'priority' ? 'Priority' : 'Date'}
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
                key={item.item_id}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ delay: Math.min(i * 0.02, 0.3), duration: 0.15 }}
                onClick={() => setSelectedItem(item)}
                className={`group flex cursor-pointer items-center gap-3 border-b border-white/[0.04] px-6 py-2.5 transition-colors hover:bg-white/[0.02] ${
                  selectedItem?.item_id === item.item_id ? 'bg-white/[0.03]' : ''
                }`}
              >
                <span
                  className={`size-2 shrink-0 rounded-full ${STATUS_DOT[item.status] ?? 'bg-white/20'}`}
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm text-white/80">{item.title}</span>
                    <Badge
                      variant="outline"
                      className={`text-[9px] ${TYPE_COLORS[item.type] ?? TYPE_COLORS.other}`}
                    >
                      {item.type}
                    </Badge>
                    <Badge
                      variant="outline"
                      className={`text-[9px] ${STATUS_COLORS[item.status] ?? ''}`}
                    >
                      {item.status}
                    </Badge>
                  </div>
                  <div className="mt-0.5 flex items-center gap-2 text-[10px] text-white/30">
                    <span className="line-clamp-1 max-w-xs">{item.description}</span>
                    <span className="text-white/15">|</span>
                    <span>
                      {formatDistanceToNow(new Date(item.created_at), { addSuffix: true })}
                    </span>
                  </div>
                </div>
                <span
                  className={`shrink-0 text-[10px] font-medium ${PRIORITY_COLORS[item.priority] ?? 'text-white/40'}`}
                >
                  {item.priority}
                </span>
              </motion.div>
            ))}
          </AnimatePresence>
        </div>
      </div>

      {/* Detail panel (slide-over) */}
      <AnimatePresence>
        {selectedItem && (
          <WantedDetailPanel item={selectedItem} onClose={() => setSelectedItem(null)} />
        )}
      </AnimatePresence>
    </div>
  );
}

// ── Detail panel ──────────────────────────────────────────────────────────

function WantedDetailPanel({
  item,
  onClose,
}: {
  item: WantedItem;
  onClose: () => void;
}) {
  return (
    <motion.div
      initial={{ width: 0, opacity: 0 }}
      animate={{ width: 400, opacity: 1 }}
      exit={{ width: 0, opacity: 0 }}
      transition={{ type: 'spring', damping: 25, stiffness: 300 }}
      className="flex h-full shrink-0 flex-col overflow-hidden border-l border-white/[0.06]"
    >
      <div className="flex min-w-[400px] flex-col overflow-y-auto">
        {/* Panel header */}
        <div className="flex items-center justify-between border-b border-white/[0.06] px-4 py-3">
          <h3 className="text-sm font-semibold text-white/90">Item Detail</h3>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-white/40 transition-colors hover:bg-white/[0.06] hover:text-white/70"
          >
            <X className="size-4" />
          </button>
        </div>

        {/* Content */}
        <div className="space-y-4 p-4">
          {/* Title */}
          <h4 className="text-base font-semibold text-white/90">{item.title}</h4>

          {/* Status + priority + type row */}
          <div className="flex flex-wrap items-center gap-2">
            <Badge
              variant="outline"
              className={STATUS_COLORS[item.status] ?? ''}
            >
              {item.status}
            </Badge>
            <Badge
              variant="outline"
              className={TYPE_COLORS[item.type] ?? TYPE_COLORS.other}
            >
              {item.type}
            </Badge>
            <span
              className={`text-xs font-medium ${PRIORITY_COLORS[item.priority] ?? 'text-white/40'}`}
            >
              {item.priority} priority
            </span>
          </div>

          {/* Description */}
          <div>
            <label className="mb-1 block text-[10px] font-semibold tracking-[0.08em] text-white/30 uppercase">
              Description
            </label>
            <p className="whitespace-pre-wrap text-sm text-white/70 leading-relaxed">
              {item.description || 'No description provided.'}
            </p>
          </div>

          {/* Claimed by */}
          {item.claimed_by && (
            <div>
              <label className="mb-1 block text-[10px] font-semibold tracking-[0.08em] text-white/30 uppercase">
                Claimed by
              </label>
              <span className="font-mono text-xs text-white/60">{item.claimed_by}</span>
            </div>
          )}

          {/* Evidence (if done) */}
          {item.evidence && (
            <div>
              <label className="mb-1 block text-[10px] font-semibold tracking-[0.08em] text-white/30 uppercase">
                Evidence
              </label>
              <a
                href={item.evidence}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs text-sky-400 underline underline-offset-2 hover:text-sky-300"
              >
                {item.evidence}
              </a>
            </div>
          )}

          {/* Timestamps */}
          <div className="space-y-1.5 border-t border-white/[0.06] pt-3">
            <DetailRow label="Created" value={formatTimestamp(item.created_at)} />
            <DetailRow label="Updated" value={formatTimestamp(item.updated_at)} />
          </div>

          {/* ID */}
          <div className="border-t border-white/[0.06] pt-3">
            <DetailRow label="Item ID" value={item.item_id} mono />
          </div>
        </div>
      </div>
    </motion.div>
  );
}

function DetailRow({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="flex items-center justify-between text-xs">
      <span className="text-white/30">{label}</span>
      <span className={`text-white/60 ${mono ? 'font-mono text-[10px]' : ''}`}>{value}</span>
    </div>
  );
}

function formatTimestamp(iso: string): string {
  try {
    return formatDistanceToNow(new Date(iso), { addSuffix: true });
  } catch {
    return iso;
  }
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
