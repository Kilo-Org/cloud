'use client';

import { useState, useMemo, useCallback } from 'react';
import { useQuery, useQueries, useMutation, useQueryClient } from '@tanstack/react-query';
import { useGastownTRPC } from '@/lib/gastown/trpc';
import { useDrawerStack } from '@/components/gastown/DrawerStack';
import { Hexagon, Search, Trash2, X } from 'lucide-react';
import { SidebarTrigger } from '@/components/ui/sidebar';
import { formatDistanceToNow } from 'date-fns';
import { motion, AnimatePresence } from 'motion/react';
import type { GastownOutputs } from '@/lib/gastown/trpc';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';

type Bead = GastownOutputs['gastown']['listBeads'][number];

type BeadsPageClientProps = {
  townId: string;
};

const STATUS_DOT: Record<string, string> = {
  open: 'bg-sky-400',
  in_progress: 'bg-amber-400',
  closed: 'bg-emerald-400',
  failed: 'bg-red-400',
};

type DeleteConfirm =
  | { kind: 'selected'; ids: string[]; rigId: string }
  | { kind: 'all-failed'; count: number; rigIds: string[] };

export function BeadsPageClient({ townId }: BeadsPageClientProps) {
  const trpc = useGastownTRPC();
  const queryClient = useQueryClient();
  const { open: openDrawer } = useDrawerStack();
  const [statusFilter, setStatusFilter] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [deleteConfirm, setDeleteConfirm] = useState<DeleteConfirm | null>(null);

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

  const failedBeads = useMemo(() => allBeads.filter(b => b.status === 'failed'), [allBeads]);

  const isLoading = rigsQuery.isLoading || rigBeadQueries.some(q => q.isLoading);

  const invalidateBeads = useCallback(() => {
    for (const rig of rigs) {
      void queryClient.invalidateQueries(trpc.gastown.listBeads.queryFilter({ rigId: rig.id }));
    }
  }, [queryClient, rigs, trpc.gastown.listBeads]);

  const deleteBeadMutation = useMutation(
    trpc.gastown.deleteBead.mutationOptions({
      onSuccess: () => {
        invalidateBeads();
        setSelectedIds(new Set());
        setDeleteConfirm(null);
      },
    })
  );

  const isDeleting = deleteBeadMutation.isPending;

  // Build a map from bead_id -> rigId for lookups
  const beadRigMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const bead of allBeads) {
      map.set(bead.bead_id, bead.rigId);
    }
    return map;
  }, [allBeads]);

  const allFilteredSelected =
    filteredBeads.length > 0 && filteredBeads.every(b => selectedIds.has(b.bead_id));

  const toggleSelectAll = () => {
    if (allFilteredSelected) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(filteredBeads.map(b => b.bead_id)));
    }
  };

  const toggleSelect = (beadId: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(beadId)) {
        next.delete(beadId);
      } else {
        next.add(beadId);
      }
      return next;
    });
  };

  const handleDeleteSelected = () => {
    if (selectedIds.size === 0) return;
    // Group by rigId — pick the first rig for simplicity (all selected beads share the same rig
    // in most cases; if mixed, we use the first one and the mutation handles array input)
    const selectedArr = [...selectedIds];
    const firstRigId = beadRigMap.get(selectedArr[0] ?? '') ?? '';
    setDeleteConfirm({ kind: 'selected', ids: selectedArr, rigId: firstRigId });
  };

  const handleDeleteAllFailed = () => {
    if (failedBeads.length === 0) return;
    const rigIds = [...new Set(failedBeads.map(b => b.rigId))];
    setDeleteConfirm({ kind: 'all-failed', count: failedBeads.length, rigIds });
  };

  const handleConfirmDelete = () => {
    if (!deleteConfirm) return;

    if (deleteConfirm.kind === 'selected') {
      const { ids } = deleteConfirm;
      for (const id of ids) {
        const rigId = beadRigMap.get(id) ?? '';
        deleteBeadMutation.mutate({ rigId, beadId: id, townId });
      }
    } else {
      // Delete all failed beads one by one (no bulk endpoint).
      for (const bead of failedBeads) {
        deleteBeadMutation.mutate({ rigId: bead.rigId, beadId: bead.bead_id, townId });
      }
    }
  };

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="sticky top-0 z-10 flex items-center justify-between border-b border-white/[0.06] bg-[oklch(0.1_0_0)] px-6 py-3">
        <div className="flex items-center gap-2">
          <SidebarTrigger className="-ml-3" />
          <Hexagon className="size-4 text-[color:oklch(95%_0.15_108_/_0.6)]" />
          <h1 className="text-lg font-semibold tracking-tight text-white/90">Beads</h1>
          <span className="ml-1 font-mono text-xs text-white/30">{allBeads.length}</span>
        </div>

        {/* Delete all failed shortcut */}
        {failedBeads.length > 0 && (
          <button
            onClick={handleDeleteAllFailed}
            className="flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium text-red-400/70 transition-colors hover:bg-red-500/10 hover:text-red-400"
          >
            <Trash2 className="size-3" />
            Delete all failed ({failedBeads.length})
          </button>
        )}
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

      {/* Bulk action bar */}
      <AnimatePresence>
        {selectedIds.size > 0 && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="overflow-hidden"
          >
            <div className="flex items-center gap-3 border-b border-white/[0.06] bg-red-500/[0.04] px-6 py-2">
              <span className="text-xs text-white/50">{selectedIds.size} selected</span>
              <button
                onClick={handleDeleteSelected}
                className="flex items-center gap-1.5 rounded-md bg-red-500/10 px-2.5 py-1.5 text-xs font-medium text-red-400 transition-colors hover:bg-red-500/20"
              >
                <Trash2 className="size-3" />
                Delete selected
              </button>
              <button
                onClick={() => setSelectedIds(new Set())}
                className="flex items-center gap-1 rounded-md px-2 py-1.5 text-xs text-white/30 transition-colors hover:text-white/50"
              >
                <X className="size-3" />
                Clear
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

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

        {/* Select-all header row */}
        {!isLoading && filteredBeads.length > 0 && (
          <div className="flex items-center gap-3 border-b border-white/[0.04] px-6 py-1.5">
            <input
              type="checkbox"
              checked={allFilteredSelected}
              onChange={toggleSelectAll}
              className="size-3.5 cursor-pointer accent-[oklch(95%_0.15_108)]"
              aria-label="Select all beads"
            />
            <span className="text-[10px] text-white/20">Select all ({filteredBeads.length})</span>
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
              className={`group flex cursor-pointer items-center gap-3 border-b border-white/[0.04] px-6 py-2.5 transition-colors hover:bg-white/[0.02] ${
                selectedIds.has(bead.bead_id) ? 'bg-white/[0.03]' : ''
              }`}
            >
              {/* Checkbox — stop propagation so clicking it doesn't open drawer */}
              <input
                type="checkbox"
                checked={selectedIds.has(bead.bead_id)}
                onChange={() => toggleSelect(bead.bead_id)}
                onClick={e => e.stopPropagation()}
                className="size-3.5 shrink-0 cursor-pointer accent-[oklch(95%_0.15_108)]"
                aria-label={`Select bead ${bead.bead_id}`}
              />
              <span
                className={`size-2 shrink-0 rounded-full ${STATUS_DOT[bead.status] ?? 'bg-white/20'}`}
              />
              <div
                className="min-w-0 flex-1"
                onClick={() => {
                  openDrawer({ type: 'bead', beadId: bead.bead_id, rigId: bead.rigId });
                }}
              >
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
            </motion.div>
          ))}
        </AnimatePresence>
      </div>

      {/* Delete confirmation dialog */}
      <Dialog
        open={!!deleteConfirm}
        onOpenChange={open => {
          if (!open) setDeleteConfirm(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {deleteConfirm?.kind === 'all-failed' ? 'Delete all failed beads' : 'Delete beads'}
            </DialogTitle>
            <DialogDescription>
              {deleteConfirm?.kind === 'all-failed'
                ? `Delete ${deleteConfirm.count} failed bead${deleteConfirm.count === 1 ? '' : 's'}? This cannot be undone.`
                : `Delete ${deleteConfirm?.ids.length ?? 0} selected bead${(deleteConfirm?.ids.length ?? 0) === 1 ? '' : 's'}? This cannot be undone.`}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteConfirm(null)} disabled={isDeleting}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={handleConfirmDelete} disabled={isDeleting}>
              {isDeleting ? 'Deleting…' : 'Delete'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

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
