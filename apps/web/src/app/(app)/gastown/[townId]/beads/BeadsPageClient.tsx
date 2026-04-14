'use client';

import { useState, useMemo, useCallback } from 'react';
import { useQuery, useQueries, useQueryClient } from '@tanstack/react-query';
import { useGastownTRPC, useGastownTRPCClient } from '@/lib/gastown/trpc';
import { useDrawerStack } from '@/components/gastown/DrawerStack';
import { Hexagon, Search, Trash2, X } from 'lucide-react';
import { SidebarTrigger } from '@/components/ui/sidebar';
import { formatDistanceToNow } from 'date-fns';
import { motion, AnimatePresence } from 'motion/react';
import type { GastownOutputs } from '@/lib/gastown/trpc';

type Bead = GastownOutputs['gastown']['listBeads'][number];

type BeadWithRig = Bead & { rigName: string; rigId: string };

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
  const trpc = useGastownTRPC();
  const trpcClient = useGastownTRPCClient();
  const queryClient = useQueryClient();
  const { open: openDrawer } = useDrawerStack();
  const [statusFilter, setStatusFilter] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [confirmDelete, setConfirmDelete] = useState<'selected' | 'allFailed' | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);

  const rigsQuery = useQuery(trpc.gastown.listRigs.queryOptions({ townId }));
  const rigs = rigsQuery.data ?? [];

  const rigBeadQueries = useQueries({
    queries: rigs.map(rig => ({
      ...trpc.gastown.listBeads.queryOptions({ rigId: rig.id }),
      refetchInterval: 8_000,
    })),
  });

  const rigBeadData = rigBeadQueries.map(q => q.data);
  const allBeads = useMemo(() => {
    const beads: BeadWithRig[] = [];
    rigBeadData.forEach((data, i) => {
      const rig = rigs[i];
      if (data && rig) {
        for (const bead of data) {
          beads.push({ ...bead, rigName: rig.name, rigId: rig.id });
        }
      }
    });
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

  const failedBeadCount = statusCounts.failed ?? 0;

  const isLoading = rigsQuery.isLoading || rigBeadQueries.some(q => q.isLoading);

  const toggleSelect = useCallback((beadId: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(beadId)) next.delete(beadId);
      else next.add(beadId);
      return next;
    });
  }, []);

  const toggleSelectAll = useCallback(() => {
    if (selectedIds.size === filteredBeads.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(filteredBeads.map(b => b.bead_id)));
    }
  }, [selectedIds.size, filteredBeads]);

  const invalidateBeadQueries = useCallback(async () => {
    for (const rig of rigs) {
      await queryClient.invalidateQueries({
        queryKey: trpc.gastown.listBeads.queryKey({ rigId: rig.id }),
      });
    }
    await queryClient.invalidateQueries({
      queryKey: trpc.gastown.listRigs.queryKey({ townId }),
    });
  }, [queryClient, trpc, rigs, townId]);

  const deleteBeadsByRig = useCallback(
    async (beadIds: string[]) => {
      const byRig = new Map<string, string[]>();
      for (const bead of allBeads) {
        if (beadIds.includes(bead.bead_id)) {
          const existing = byRig.get(bead.rigId) ?? [];
          existing.push(bead.bead_id);
          byRig.set(bead.rigId, existing);
        }
      }
      await Promise.all(
        [...byRig.entries()].map(([rigId, ids]) =>
          trpcClient.gastown.deleteBead.mutate({ rigId, beadId: ids, townId })
        )
      );
    },
    [allBeads, trpcClient, townId]
  );

  const handleDeleteSelected = useCallback(async () => {
    setIsDeleting(true);
    try {
      await deleteBeadsByRig([...selectedIds]);
      await invalidateBeadQueries();
      setSelectedIds(new Set());
      setConfirmDelete(null);
    } finally {
      setIsDeleting(false);
    }
  }, [selectedIds, deleteBeadsByRig, invalidateBeadQueries]);

  const handleDeleteAllFailed = useCallback(async () => {
    const failedIds = allBeads.filter(b => b.status === 'failed').map(b => b.bead_id);
    if (failedIds.length === 0) return;
    setIsDeleting(true);
    try {
      await deleteBeadsByRig(failedIds);
      await invalidateBeadQueries();
      setSelectedIds(new Set());
      setConfirmDelete(null);
    } finally {
      setIsDeleting(false);
    }
  }, [allBeads, deleteBeadsByRig, invalidateBeadQueries]);

  const allFilteredSelected = filteredBeads.length > 0 && selectedIds.size === filteredBeads.length;

  return (
    <div className="flex h-full flex-col">
      <div className="sticky top-0 z-10 flex items-center justify-between border-b border-white/[0.06] bg-[oklch(0.1_0_0)] px-6 py-3">
        <div className="flex items-center gap-2">
          <SidebarTrigger className="-ml-3" />
          <Hexagon className="size-4 text-[color:oklch(95%_0.15_108_/_0.6)]" />
          <h1 className="text-lg font-semibold tracking-tight text-white/90">Beads</h1>
          <span className="ml-1 font-mono text-xs text-white/30">{allBeads.length}</span>
        </div>
        {failedBeadCount > 0 && (
          <button
            onClick={() => setConfirmDelete('allFailed')}
            className="flex items-center gap-1.5 rounded-md border border-red-500/20 bg-red-500/10 px-2.5 py-1 text-[10px] font-medium text-red-400 transition-colors hover:bg-red-500/20"
          >
            <Trash2 className="size-3" />
            Delete all failed ({failedBeadCount})
          </button>
        )}
      </div>

      <div className="flex items-center gap-3 border-b border-white/[0.06] px-6 py-2">
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

      {selectedIds.size > 0 && (
        <div className="flex items-center gap-3 border-b border-white/[0.06] bg-white/[0.02] px-6 py-2">
          <span className="text-xs text-white/50">{selectedIds.size} selected</span>
          <button
            onClick={() => setSelectedIds(new Set())}
            className="flex items-center gap-1 text-[10px] text-white/30 hover:text-white/50"
          >
            <X className="size-3" />
            Clear
          </button>
          <button
            onClick={() => setConfirmDelete('selected')}
            className="ml-auto flex items-center gap-1.5 rounded-md border border-red-500/20 bg-red-500/10 px-2.5 py-1 text-[10px] font-medium text-red-400 transition-colors hover:bg-red-500/20"
          >
            <Trash2 className="size-3" />
            Delete selected
          </button>
        </div>
      )}

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
          {filteredBeads.length > 0 && (
            <div
              className="flex items-center gap-3 border-b border-white/[0.04] px-6 py-1.5"
              onClick={toggleSelectAll}
            >
              <input
                type="checkbox"
                checked={allFilteredSelected}
                onChange={toggleSelectAll}
                className="size-3.5 shrink-0 accent-white/50"
              />
              <span className="text-[9px] text-white/20">
                {allFilteredSelected ? 'Deselect all' : 'Select all'}
              </span>
            </div>
          )}
          {filteredBeads.map((bead, i) => (
            <motion.div
              key={bead.bead_id}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ delay: Math.min(i * 0.02, 0.3), duration: 0.15 }}
              className="group flex cursor-pointer items-center gap-3 border-b border-white/[0.04] px-6 py-2.5 transition-colors hover:bg-white/[0.02]"
            >
              <input
                type="checkbox"
                checked={selectedIds.has(bead.bead_id)}
                onChange={e => {
                  e.stopPropagation();
                  toggleSelect(bead.bead_id);
                }}
                onClick={e => e.stopPropagation()}
                className="size-3.5 shrink-0 accent-white/50"
              />
              <span
                onClick={() => openDrawer({ type: 'bead', beadId: bead.bead_id, rigId: bead.rigId })}
                className="flex flex-1 cursor-pointer items-center gap-3 min-w-0"
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
                    <span>{bead.rigName}</span>
                    <span className="text-white/15">|</span>
                    <span>{formatDistanceToNow(new Date(bead.created_at), { addSuffix: true })}</span>
                  </div>
                </div>
                <span className="shrink-0 text-[10px] text-white/25 capitalize">{bead.priority}</span>
              </span>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>

      {confirmDelete && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="w-full max-w-sm rounded-lg border border-white/[0.08] bg-[oklch(0.14_0_0)] p-6">
            <h3 className="text-sm font-semibold text-white/90">
              {confirmDelete === 'allFailed'
                ? `Delete all failed beads?`
                : `Delete ${selectedIds.size} selected bead${selectedIds.size !== 1 ? 's' : ''}?`}
            </h3>
            <p className="mt-2 text-xs text-white/50">
              {confirmDelete === 'allFailed'
                ? `This will permanently delete ${failedBeadCount} failed bead${failedBeadCount !== 1 ? 's' : ''}. This action cannot be undone.`
                : `This will permanently delete ${selectedIds.size} bead${selectedIds.size !== 1 ? 's' : ''}. This action cannot be undone.`}
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <button
                onClick={() => setConfirmDelete(null)}
                disabled={isDeleting}
                className="rounded-md border border-white/[0.08] px-3 py-1.5 text-xs text-white/60 hover:bg-white/[0.04]"
              >
                Cancel
              </button>
              <button
                onClick={confirmDelete === 'allFailed' ? handleDeleteAllFailed : handleDeleteSelected}
                disabled={isDeleting}
                className="rounded-md bg-red-500/20 px-3 py-1.5 text-xs font-medium text-red-400 hover:bg-red-500/30"
              >
                {isDeleting ? 'Deleting…' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}
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
