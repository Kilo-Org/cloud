'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useGastownTRPC } from '@/lib/gastown/trpc';
import { GitMerge, AlertCircle, Loader2, Activity, Server } from 'lucide-react';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { NeedsAttention } from './NeedsAttention';
import { RefineryActivityLog } from './RefineryActivityLog';

const ALL_RIGS = '__all__';

export function MergesPageClient({ townId }: { townId: string }) {
  const trpc = useGastownTRPC();
  const [selectedRigId, setSelectedRigId] = useState(ALL_RIGS);

  const rigIdParam = selectedRigId === ALL_RIGS ? undefined : selectedRigId;

  const rigsQuery = useQuery(trpc.gastown.listRigs.queryOptions({ townId }));
  const rigs = rigsQuery.data ?? [];

  const mergeQueueQuery = useQuery({
    ...trpc.gastown.getMergeQueueData.queryOptions({
      townId,
      rigId: rigIdParam,
      limit: 200,
    }),
    refetchInterval: 5_000,
  });

  const needsAttention = mergeQueueQuery.data?.needsAttention;
  const totalAttention = needsAttention
    ? needsAttention.openPRs.length +
      needsAttention.failedReviews.length +
      needsAttention.stalePRs.length
    : 0;

  return (
    <div className="flex h-full flex-col">
      {/* Page header */}
      <div className="flex items-center justify-between border-b border-white/[0.06] px-6 py-3">
        <div className="flex items-center gap-2">
          <GitMerge className="size-4 text-[color:oklch(95%_0.15_108_/_0.6)]" />
          <h1 className="text-lg font-semibold tracking-tight text-white/90">Merge Queue</h1>
          {totalAttention > 0 && (
            <span className="ml-1 rounded-full bg-amber-500/15 px-2 py-0.5 font-mono text-[10px] font-medium text-amber-400">
              {totalAttention}
            </span>
          )}
        </div>

        {/* Rig filter */}
        <div className="flex items-center gap-2">
          <Server className="size-3.5 text-white/25" />
          <Select value={selectedRigId} onValueChange={setSelectedRigId}>
            <SelectTrigger
              size="sm"
              className="h-7 min-w-[140px] border-white/10 bg-white/[0.04] text-xs text-white/60"
            >
              <SelectValue placeholder="All Rigs" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL_RIGS}>All Rigs</SelectItem>
              {rigs.map(rig => (
                <SelectItem key={rig.id} value={rig.id}>
                  {rig.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-4xl space-y-6 p-6">
          {/* Loading state */}
          {mergeQueueQuery.isLoading && (
            <div className="flex flex-col items-center justify-center py-16 text-center">
              <Loader2 className="mb-3 size-6 animate-spin text-white/20" />
              <p className="text-sm text-white/30">Loading merge queue…</p>
            </div>
          )}

          {/* Error state */}
          {mergeQueueQuery.isError && (
            <div className="flex flex-col items-center justify-center py-16 text-center">
              <AlertCircle className="mb-3 size-6 text-red-400/40" />
              <p className="text-sm text-red-400/60">Failed to load merge queue data.</p>
              <p className="mt-1 text-xs text-white/20">{mergeQueueQuery.error.message}</p>
            </div>
          )}

          {/* Needs Your Attention section */}
          {needsAttention && (
            <section>
              <div className="mb-3 flex items-center gap-2">
                <AlertCircle className="size-3.5 text-white/30" />
                <h2 className="text-[11px] font-medium uppercase tracking-wide text-white/40">
                  Needs Your Attention
                </h2>
                {totalAttention > 0 && (
                  <span className="rounded-full bg-amber-500/15 px-1.5 py-0.5 font-mono text-[10px] text-amber-400/70">
                    {totalAttention}
                  </span>
                )}
              </div>
              <NeedsAttention data={needsAttention} townId={townId} />
            </section>
          )}

          {/* Refinery Activity Log section */}
          {mergeQueueQuery.data && (
            <section>
              <div className="mb-3 flex items-center gap-2">
                <Activity className="size-3.5 text-white/30" />
                <h2 className="text-[11px] font-medium uppercase tracking-wide text-white/40">
                  Refinery Activity Log
                </h2>
              </div>
              <RefineryActivityLog
                activityLog={mergeQueueQuery.data.activityLog}
                isLoading={false}
                townId={townId}
              />
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
