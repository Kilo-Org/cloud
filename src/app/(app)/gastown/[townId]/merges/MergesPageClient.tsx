'use client';

import { useQuery } from '@tanstack/react-query';
import { useGastownTRPC } from '@/lib/gastown/trpc';
import { GitMerge } from 'lucide-react';
import { RefineryActivityLog } from './RefineryActivityLog';

export function MergesPageClient({ townId }: { townId: string }) {
  const trpc = useGastownTRPC();

  const eventsQuery = useQuery({
    ...trpc.gastown.getTownEvents.queryOptions({ townId, limit: 200 }),
    refetchInterval: 5_000,
  });

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-white/[0.06] px-6 py-3">
        <div className="flex items-center gap-2">
          <GitMerge className="size-4 text-[color:oklch(95%_0.15_108_/_0.6)]" />
          <h1 className="text-lg font-semibold tracking-tight text-white/90">Merge Queue</h1>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        {/* Refinery Activity Log */}
        <div className="border-b border-white/[0.04]">
          <div className="flex items-center gap-2 px-6 pt-5 pb-2">
            <h2 className="text-sm font-medium text-white/50">Refinery Activity Log</h2>
          </div>
          <RefineryActivityLog events={eventsQuery.data} isLoading={eventsQuery.isLoading} />
        </div>
      </div>
    </div>
  );
}
