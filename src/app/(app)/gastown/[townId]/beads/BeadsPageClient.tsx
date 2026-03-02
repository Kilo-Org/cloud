'use client';

import { useState, useMemo } from 'react';
import { useQuery, useQueries } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc/utils';
import { useDrawerStack } from '@/components/gastown/DrawerStack';
import { Hexagon, Search } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import type { inferRouterOutputs } from '@trpc/server';
import type { RootRouter } from '@/routers/root-router';
import { motion, AnimatePresence } from 'motion/react';

type RouterOutputs = inferRouterOutputs<RootRouter>;
type Bead = RouterOutputs['gastown']['listBeads'][number];

type BeadsPageClientProps = {
  townId: string;
};

const STATUS_DOT: Record<string, string> = {
  open: 'bg-sky-400',
  in_progress: 'bg-amber-400',
  closed: 'bg-emerald-400',
  failed: 'bg-red-400',
};

export function BeadsPageClient({ townId }: BeadsPageClientProps) {
  const trpc = useTRPC();
  const { open: openDrawer } = useDrawerStack();
  const [statusFilter, setStatusFilter] = useState<string | null>(null);
  const [search, setSearch] = useState('');

  const rigsQuery = useQuery(trpc.gastown.listRigs.queryOptions({ townId }));
  const rigs = rigsQuery.data ?? [];

  // Fetch beads for each rig — useQueries handles dynamic-length arrays safely
  const rigBeadQueries = useQueries({
    queries: rigs.map(rig => ({
      ...trpc.gastown.listBeads.queryOptions({ rigId: rig.id }),
      refetchInterval: 8_000,
    })),
  });

  const rigBeadData = rigBeadQueries.map(q => q.data);
  const allBeads = useMemo(() => {
    const beads: Array<Bead & { rigName: string; rigId: string }> = [];
    rigBeadData.forEach((data, i) => {
      const rig = rigs[i];
      if (data && rig) {
        for (const bead of data) {
          beads.push({ ...bead, rigName: rig.name, rigId: rig.id });
        }
      }
    });
    // Sort newest first
    beads.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
    return beads;
  }, [rigBeadData, rigs]);

  const filteredBeads = useMemo(() => {
    let beads = allBeads;
    if (statusFilter) {
      beads = beads.filter(b => b.status === statusFilter);
    }
    if (search.trim()) {
      const q = search.toLowerCase();
      beads = beads.filter(
        b => b.title.toLowerCase().includes(q) || b.bead_id.toLowerCase().includes(q)
      );
    }
    return beads;
  }, [allBeads, statusFilter, search]);

  const statusCounts = useMemo(() => {
    const counts: Record<string, number> = { open: 0, in_progress: 0, closed: 0, failed: 0 };
    for (const bead of allBeads) {
      counts[bead.status] = (counts[bead.status] ?? 0) + 1;
    }
    return counts;
  }, [allBeads]);

  const isLoading = rigsQuery.isLoading || rigBeadQueries.some(q => q.isLoading);

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-white/[0.06] px-6 py-3">
        <div className="flex items-center gap-2">
          <Hexagon className="size-4 text-[color:oklch(95%_0.15_108_/_0.6)]" />
          <h1 className="text-lg font-semibold tracking-tight text-white/90">Beads</h1>
          <span className="ml-1 font-mono text-xs text-white/30">{allBeads.length}</span>
        </div>
      </div>

      {/* Filter bar */}
      <div className="flex items-center gap-3 border-b border-white/[0.06] px-6 py-2">
        {/* Search */}
        <div className="flex items-center gap-1.5 rounded-md border border-white/[0.08] bg-white/[0.03] px-2.5 py-1.5">
          <Search className="size-3 text-white/30" />
          <input
            type="text"
            placeholder="Search beads..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="w-48 bg-transparent text-xs text-white/80 outline-none placeholder:text-white/25"
          />
        </div>

        {/* Status filter chips */}
        <div className="flex items-center gap-1">
          <FilterChip
            label="All"
            count={allBeads.length}
            active={statusFilter === null}
            onClick={() => setStatusFilter(null)}
          />
          {Object.entries(statusCounts).map(([status, count]) => (
            <FilterChip
              key={status}
              label={status.replace('_', ' ')}
              count={count}
              active={statusFilter === status}
              onClick={() => setStatusFilter(statusFilter === status ? null : status)}
              dotColor={STATUS_DOT[status]}
            />
          ))}
        </div>
      </div>

      {/* Bead list */}
      <div className="flex-1 overflow-y-auto">
        {isLoading && (
          <div className="space-y-0">
            {Array.from({ length: 8 }).map((_, i) => (
              <div
                key={i}
                className="flex animate-pulse items-center gap-3 border-b border-white/[0.04] px-6 py-3"
              >
                <div className="size-2 rounded-full bg-white/10" />
                <div className="h-3 w-40 rounded bg-white/5" />
                <div className="ml-auto h-3 w-20 rounded bg-white/5" />
              </div>
            ))}
          </div>
        )}

        {!isLoading && filteredBeads.length === 0 && (
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <Hexagon className="mb-3 size-8 text-white/10" />
            <p className="text-sm text-white/30">
              {search || statusFilter ? 'No beads match your filters.' : 'No beads yet.'}
            </p>
          </div>
        )}

        <AnimatePresence mode="popLayout">
          {filteredBeads.map((bead, i) => (
            <motion.div
              key={bead.bead_id}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ delay: Math.min(i * 0.02, 0.3), duration: 0.15 }}
              onClick={() => {
                const rigId = (bead as Bead & { rigId: string }).rigId;
                openDrawer({ type: 'bead', beadId: bead.bead_id, rigId });
              }}
              className="group flex cursor-pointer items-center gap-3 border-b border-white/[0.04] px-6 py-2.5 transition-colors hover:bg-white/[0.02]"
            >
              <span
                className={`size-2 shrink-0 rounded-full ${STATUS_DOT[bead.status] ?? 'bg-white/20'}`}
              />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm text-white/80">{bead.title}</span>
                  <span className="shrink-0 rounded bg-white/[0.04] px-1.5 py-0.5 text-[9px] font-medium text-white/30">
                    {bead.type}
                  </span>
                </div>
                <div className="mt-0.5 flex items-center gap-2 text-[10px] text-white/30">
                  <span className="font-mono">{bead.bead_id.slice(0, 8)}</span>
                  <span className="text-white/15">|</span>
                  <span>{(bead as Bead & { rigName: string }).rigName}</span>
                  <span className="text-white/15">|</span>
                  <span>{formatDistanceToNow(new Date(bead.created_at), { addSuffix: true })}</span>
                </div>
              </div>
              <span className="shrink-0 text-[10px] text-white/25 capitalize">{bead.priority}</span>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>

      {/* Drawers are rendered by the layout-level DrawerStackProvider */}
    </div>
  );
}

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
