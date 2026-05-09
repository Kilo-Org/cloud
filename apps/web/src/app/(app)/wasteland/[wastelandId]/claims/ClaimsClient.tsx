'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useWastelandTRPC } from '@/lib/wasteland/trpc';
import type { WastelandOutputs } from '@/lib/wasteland/trpc';
import { useSetWastelandPageHeader } from '../WastelandPageHeaderContext';
import { useDrawerStack } from '@/components/wasteland/drawer/WastelandDrawerStack';
import { Badge } from '@/components/ui/badge';
import {
  ArrowUpDown,
  ExternalLink,
  Hourglass,
  MoreHorizontal,
  RefreshCw,
  Search,
  ShieldAlert,
  ScrollText,
} from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { AnimatePresence, motion } from 'motion/react';
import { toast } from 'sonner';
import { parseDoltDate } from '@/lib/wasteland/date';
import { STATUS_DOT, PRIORITY_COLORS, TYPE_COLORS } from '@/lib/wasteland/status-colors';
import Link from 'next/link';

type ClaimRow = WastelandOutputs['wasteland']['listClaims'][number];
type ClaimItem = ClaimRow['item'];

type SortMode = 'recent' | 'priority' | 'stale';

const PR_KIND_LABELS: Record<string, string> = {
  claim: 'claim PR',
  done: 'done PR',
  unclaim: 'unclaim PR',
};

const COLD_START_DELAY_MS = 3000;

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

export function ClaimsClient({ wastelandId }: { wastelandId: string }) {
  const trpc = useWastelandTRPC();
  const queryClient = useQueryClient();
  const { open: openDrawer } = useDrawerStack();

  const [search, setSearch] = useState('');
  const [sortMode, setSortMode] = useState<SortMode>('recent');
  const [rigHandleFilter, setRigHandleFilter] = useState<string | null>(null);
  const [pendingPrOnly, setPendingPrOnly] = useState(false);
  const [activeMenuItemId, setActiveMenuItemId] = useState<string | null>(null);

  useEffect(() => {
    if (!activeMenuItemId) return;
    const handler = () => setActiveMenuItemId(null);
    document.addEventListener('click', handler);
    return () => document.removeEventListener('click', handler);
  }, [activeMenuItemId]);

  const claimsQuery = useQuery({
    ...trpc.wasteland.listClaims.queryOptions({
      wastelandId,
      ...(rigHandleFilter ? { rigHandle: rigHandleFilter } : {}),
    }),
    refetchInterval: 30_000,
  });

  const credentialQuery = useQuery(
    trpc.wasteland.getCredentialStatus.queryOptions({ wastelandId })
  );
  const isAdmin = credentialQuery.data?.is_upstream_admin ?? false;

  useSlowOperationToast(claimsQuery.isLoading && !claimsQuery.data);

  const claims = claimsQuery.data ?? [];

  const rigHandles = useMemo(
    () => Array.from(new Set(claims.map(c => c.item.claimed_by).filter(Boolean))) as string[],
    [claims]
  );

  const filteredClaims = useMemo(() => {
    let result = claims;

    if (search.trim()) {
      const q = search.toLowerCase();
      result = result.filter(
        c =>
          c.item.title.toLowerCase().includes(q) ||
          c.item.id.toLowerCase().includes(q) ||
          (c.item.claimed_by ?? '').toLowerCase().includes(q)
      );
    }

    if (pendingPrOnly) {
      result = result.filter(c => c.pending_pr !== null);
    }

    result = [...result].sort((a, b) => {
      if (sortMode === 'priority') {
        const priorityOrder: Record<string, number> = {
          critical: 0,
          high: 1,
          medium: 2,
          low: 3,
        };
        const aP = priorityOrder[String(a.item.priority ?? 'medium')] ?? 2;
        const bP = priorityOrder[String(b.item.priority ?? 'medium')] ?? 2;
        return aP - bP;
      }
      if (sortMode === 'stale') {
        const aTime = parseDoltDate(a.item.updated_at)?.getTime() ?? 0;
        const bTime = parseDoltDate(b.item.updated_at)?.getTime() ?? 0;
        return aTime - bTime;
      }
      const aTime = parseDoltDate(a.item.updated_at)?.getTime() ?? 0;
      const bTime = parseDoltDate(b.item.updated_at)?.getTime() ?? 0;
      return bTime - aTime;
    });

    return result;
  }, [claims, search, sortMode, pendingPrOnly]);

  const stats = useMemo(() => {
    const total = claims.length;
    const pendingPr = claims.filter(c => c.pending_pr !== null).length;
    const staleThreshold = Date.now() - 24 * 60 * 60 * 1000;
    const stale = claims.filter(c => {
      const updated = parseDoltDate(c.item.updated_at)?.getTime() ?? 0;
      return updated > 0 && updated < staleThreshold;
    }).length;
    return { total, pendingPr, stale };
  }, [claims]);

  const handleRefresh = useCallback(() => {
    void queryClient.invalidateQueries({
      queryKey: trpc.wasteland.listClaims.queryKey({
        wastelandId,
        ...(rigHandleFilter ? { rigHandle: rigHandleFilter } : {}),
      }),
    });
  }, [queryClient, trpc, wastelandId, rigHandleFilter]);

  const handleOpenItem = useCallback(
    (item: ClaimItem) => {
      openDrawer({
        type: 'wanted-item',
        wastelandId,
        item,
        actions: {
          isAdmin,
          onDone: () => {},
          onAccept: () => {},
          onReject: () => {},
          onCloseItem: () => {},
          onUnclaim: () => {},
        },
      });
    },
    [openDrawer, wastelandId, isAdmin]
  );

  const cycleSort = useCallback(() => {
    setSortMode(prev => {
      if (prev === 'recent') return 'priority';
      if (prev === 'priority') return 'stale';
      return 'recent';
    });
  }, []);

  const sortLabel: Record<SortMode, string> = {
    recent: 'Recently claimed',
    priority: 'Priority',
    stale: 'Stale (oldest first)',
  };

  useSetWastelandPageHeader({
    title: 'Claims',
    icon: <ShieldAlert className="size-4 text-[color:oklch(70%_0.15_30_/_0.6)]" />,
    count: claims.length,
    actions: (
      <>
        <span className="inline-flex items-center gap-1 rounded-md border border-white/[0.08] bg-white/[0.03] px-2.5 py-1.5 text-xs text-white/40">
          {claims.length} active claim{claims.length !== 1 ? 's' : ''}
        </span>
        <button
          type="button"
          onClick={handleRefresh}
          disabled={claimsQuery.isLoading}
          className="inline-flex items-center gap-1.5 rounded-md border border-white/[0.08] bg-white/[0.03] px-2.5 py-1.5 text-xs text-white/60 transition-colors hover:bg-white/[0.06] hover:text-white/80 disabled:opacity-50"
        >
          <RefreshCw className={`size-3 ${claimsQuery.isFetching ? 'animate-spin' : ''}`} />
          Refresh
        </button>
      </>
    ),
  });

  return (
    <div className="flex h-full">
      <div className="flex flex-1 flex-col overflow-hidden">
        {/* Filter bar */}
        <div className="flex items-center gap-3 border-b border-white/[0.06] px-6 py-2">
          <div className="flex items-center gap-1.5 rounded-md border border-white/[0.08] bg-white/[0.03] px-2.5 py-1.5">
            <Search className="size-3 text-white/30" />
            <input
              type="text"
              placeholder="Search claims..."
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="w-48 bg-transparent text-xs text-white/80 outline-none placeholder:text-white/25"
            />
          </div>

          {/* Rig handle filter */}
          <select
            value={rigHandleFilter ?? ''}
            onChange={e => setRigHandleFilter(e.target.value || null)}
            className="rounded-md border border-white/[0.08] bg-white/[0.03] px-2.5 py-1.5 text-xs text-white/60 outline-none focus:border-white/20"
          >
            <option value="">All rigs</option>
            {rigHandles.map(handle => (
              <option key={handle} value={handle}>
                {handle}
              </option>
            ))}
          </select>

          {/* Pending PR only toggle */}
          <label className="inline-flex cursor-pointer items-center gap-1.5 text-[10px] text-white/40">
            <input
              type="checkbox"
              checked={pendingPrOnly}
              onChange={e => setPendingPrOnly(e.target.checked)}
              className="accent-amber-400"
            />
            Pending PR only
          </label>

          {/* Sort */}
          <button
            type="button"
            onClick={cycleSort}
            className="ml-auto inline-flex items-center gap-1 rounded-md px-2 py-1 text-[10px] font-medium text-white/30 transition-colors hover:bg-white/[0.04] hover:text-white/50"
          >
            <ArrowUpDown className="size-3" />
            {sortLabel[sortMode]}
          </button>
        </div>

        {/* Stats strip */}
        <div className="flex gap-3 border-b border-white/[0.06] px-6 py-2">
          <StatsCard label="Total claims" value={stats.total} />
          <StatsCard label="Pending PR" value={stats.pendingPr} />
          <StatsCard label="Stale claims" value={stats.stale} highlight={stats.stale > 0} />
        </div>

        {/* Claims table */}
        <div className="flex-1 overflow-y-auto">
          {claimsQuery.isLoading && <ClaimsTableSkeleton />}

          {!claimsQuery.isLoading && claimsQuery.isError && (
            <div className="flex flex-col items-center justify-center py-16 text-center">
              <p className="mb-2 text-sm text-red-400">Failed to load claims</p>
              <button
                type="button"
                onClick={handleRefresh}
                className="text-xs text-white/50 underline underline-offset-2 hover:text-white/70"
              >
                Retry
              </button>
            </div>
          )}

          {!claimsQuery.isLoading && !claimsQuery.isError && filteredClaims.length === 0 && (
            <div className="flex flex-col items-center justify-center py-16 text-center">
              <ScrollText className="mb-3 size-8 text-white/10" />
              <p className="text-sm text-white/30">
                {search || rigHandleFilter || pendingPrOnly
                  ? 'No claims match your filters.'
                  : 'No active claims right now'}
              </p>
              {!search && !rigHandleFilter && !pendingPrOnly && (
                <>
                  <p className="mt-1 text-xs text-white/20">
                    When a rig claims a wanted item, it&apos;ll appear here
                  </p>
                  <Link
                    href="../wanted"
                    className="mt-4 inline-flex items-center gap-1.5 rounded-md border border-white/[0.08] bg-white/[0.03] px-3 py-1.5 text-xs text-white/60 transition-colors hover:bg-white/[0.06] hover:text-white/80"
                  >
                    Browse the wanted board
                  </Link>
                </>
              )}
            </div>
          )}

          <AnimatePresence mode="popLayout">
            {filteredClaims.map((claim, i) => (
              <ClaimRowComponent
                key={claim.item.id}
                claim={claim}
                wastelandId={wastelandId}
                isAdmin={isAdmin}
                onClick={() => handleOpenItem(claim.item)}
                activeMenuItemId={activeMenuItemId}
                setActiveMenuItemId={setActiveMenuItemId}
                delay={Math.min(i * 0.02, 0.3)}
              />
            ))}
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
}

function ClaimRowComponent({
  claim,
  wastelandId,
  isAdmin,
  onClick,
  activeMenuItemId,
  setActiveMenuItemId,
  delay,
}: {
  claim: ClaimRow;
  wastelandId: string;
  isAdmin: boolean;
  onClick: () => void;
  activeMenuItemId: string | null;
  setActiveMenuItemId: (id: string | null) => void;
  delay: number;
}) {
  const { item, pending_pr: pendingPr } = claim;
  const menuOpen = activeMenuItemId === item.id;

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ delay, duration: 0.15 }}
      className="group flex cursor-pointer items-center gap-3 border-b border-white/[0.04] px-6 py-2.5 transition-colors hover:bg-white/[0.02]"
      onClick={e => {
        if ((e.target as HTMLElement).closest('[data-claim-action]')) return;
        onClick();
      }}
    >
      <span className={`size-2 shrink-0 rounded-full ${STATUS_DOT.claimed}`} />
      <span className="shrink-0 text-[10px] text-amber-400/60">claimed</span>

      <button
        type="button"
        onClick={onClick}
        className="shrink-0 font-mono text-[10px] text-white/40 underline decoration-white/10 decoration-dotted underline-offset-2 transition-colors hover:text-white/70 hover:decoration-white/40"
      >
        {item.id}
      </button>

      <span className="min-w-0 max-w-[240px] truncate text-sm text-white/80">
        {item.title.length > 60 ? `${item.title.slice(0, 60)}…` : item.title}
      </span>

      <span
        className={`shrink-0 text-[10px] font-medium ${PRIORITY_COLORS[String(item.priority ?? 'medium')] ?? 'text-white/40'}`}
      >
        {String(item.priority ?? 'medium')}
      </span>

      <Badge
        variant="outline"
        className={`shrink-0 text-[9px] ${TYPE_COLORS[item.type ?? 'other'] ?? TYPE_COLORS.other}`}
      >
        {item.type ?? 'other'}
      </Badge>

      <Link
        href={`/wasteland/${wastelandId}/rigs/${item.claimed_by}`}
        className="shrink-0 font-mono text-[10px] text-white/50 underline decoration-white/10 decoration-dotted underline-offset-2 transition-colors hover:text-white/80 hover:decoration-white/40"
        onClick={e => e.stopPropagation()}
        data-claim-action
      >
        {item.claimed_by}
      </Link>

      {(() => {
        const ts = parseDoltDate(item.updated_at);
        if (!ts) return <span className="shrink-0 text-[10px] text-white/25">—</span>;
        return (
          <span className="shrink-0 text-[10px] text-white/30">
            {formatDistanceToNow(ts, { addSuffix: true })}
          </span>
        );
      })()}

      {pendingPr && (
        <Badge
          variant="outline"
          className="shrink-0 gap-1 border-amber-500/20 bg-amber-500/10 text-[9px] text-amber-300"
        >
          <Hourglass className="size-2.5" />
          {PR_KIND_LABELS[pendingPr.kind] ?? 'PR'}
        </Badge>
      )}

      {/* Kebab menu */}
      <div className="relative ml-auto shrink-0" data-claim-action>
        <button
          type="button"
          onClick={e => {
            e.stopPropagation();
            setActiveMenuItemId(menuOpen ? null : item.id);
          }}
          className="rounded p-0.5 text-white/20 transition-colors hover:bg-white/[0.06] hover:text-white/50"
        >
          <MoreHorizontal className="size-3.5" />
        </button>

        {menuOpen && (
          <div className="absolute right-0 top-full z-10 mt-1 min-w-[160px] rounded-md border border-white/[0.08] bg-[color:oklch(0.18_0_0)] p-1 shadow-lg">
            {pendingPr && (
              <a
                href={pendingPr.pr_url}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-2 rounded px-2.5 py-1.5 text-xs text-white/60 transition-colors hover:bg-white/[0.06] hover:text-white/80"
                onClick={e => e.stopPropagation()}
              >
                <ExternalLink className="size-3" />
                View on DoltHub
              </a>
            )}
            {isAdmin && (
              <button
                type="button"
                className="flex w-full items-center gap-2 rounded px-2.5 py-1.5 text-xs text-red-400/70 transition-colors hover:bg-red-500/10 hover:text-red-400"
                onClick={e => {
                  e.stopPropagation();
                  setActiveMenuItemId(null);
                  toast.info('Force unclaim will be available in a future update');
                }}
              >
                <ShieldAlert className="size-3" />
                Force unclaim
              </button>
            )}
            <button
              type="button"
              className="flex w-full items-center gap-2 rounded px-2.5 py-1.5 text-xs text-white/60 transition-colors hover:bg-white/[0.06] hover:text-white/80"
              onClick={e => {
                e.stopPropagation();
                setActiveMenuItemId(null);
                onClick();
              }}
            >
              <ScrollText className="size-3" />
              Open drawer
            </button>
          </div>
        )}
      </div>
    </motion.div>
  );
}

function StatsCard({
  label,
  value,
  highlight,
}: {
  label: string;
  value: number;
  highlight?: boolean;
}) {
  return (
    <div
      className={`flex items-center gap-2 rounded-md border px-3 py-1.5 ${
        highlight
          ? 'border-amber-500/20 bg-amber-500/[0.04]'
          : 'border-white/[0.06] bg-white/[0.02]'
      }`}
    >
      <span className={`text-[10px] ${highlight ? 'text-amber-300/60' : 'text-white/30'}`}>
        {label}
      </span>
      <span
        className={`font-mono text-xs font-medium ${highlight ? 'text-amber-300' : 'text-white/60'}`}
      >
        {value}
      </span>
    </div>
  );
}

function ClaimsTableSkeleton() {
  return (
    <div className="space-y-0">
      {Array.from({ length: 8 }).map((_, i) => (
        <div
          key={i}
          className="flex animate-pulse items-center gap-3 border-b border-white/[0.04] px-6 py-3"
        >
          <div className="size-2 rounded-full bg-white/10" />
          <div className="h-2.5 w-12 rounded bg-white/5" />
          <div className="h-2.5 w-16 rounded bg-white/5" />
          <div className="flex-1 space-y-1.5">
            <div className="h-3 w-48 rounded bg-white/5" />
          </div>
          <div className="h-3 w-10 rounded bg-white/5" />
          <div className="h-3 w-14 rounded bg-white/5" />
        </div>
      ))}
    </div>
  );
}
