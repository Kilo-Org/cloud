'use client';

import { useQuery } from '@tanstack/react-query';
import { useGastownTRPC } from '@/lib/gastown/trpc';
import { GitMerge, CheckCircle } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';

export function MergesPageClient({ townId }: { townId: string }) {
  const trpc = useGastownTRPC();

  const eventsQuery = useQuery({
    ...trpc.gastown.getTownEvents.queryOptions({ townId, limit: 200 }),
    refetchInterval: 5_000,
  });

  const mergeEvents = (eventsQuery.data ?? []).filter(
    e => e.event_type === 'review_submitted' || e.event_type === 'review_completed'
  );

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-white/[0.06] px-6 py-3">
        <div className="flex items-center gap-2">
          <GitMerge className="size-4 text-[color:oklch(95%_0.15_108_/_0.6)]" />
          <h1 className="text-lg font-semibold tracking-tight text-white/90">Merge Queue</h1>
          <span className="ml-1 font-mono text-xs text-white/30">{mergeEvents.length}</span>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        {mergeEvents.length === 0 && (
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <GitMerge className="mb-3 size-8 text-white/10" />
            <p className="text-sm text-white/30">No merge activity yet.</p>
            <p className="mt-1 text-xs text-white/20">
              Review submissions and merge completions will appear here.
            </p>
          </div>
        )}

        {mergeEvents
          .slice()
          .reverse()
          .map(event => {
            const isCompleted = event.event_type === 'review_completed';
            return (
              <div
                key={event.bead_event_id}
                className="flex items-start gap-3 border-b border-white/[0.04] px-6 py-3 transition-colors hover:bg-white/[0.02]"
              >
                {isCompleted ? (
                  <CheckCircle className="mt-0.5 size-3.5 shrink-0 text-emerald-400/60" />
                ) : (
                  <GitMerge className="mt-0.5 size-3.5 shrink-0 text-indigo-400/60" />
                )}
                <div className="min-w-0 flex-1">
                  <div className="text-sm text-white/75">
                    {isCompleted ? 'Review completed' : 'Submitted for review'}
                    {event.new_value ? `: ${event.new_value}` : ''}
                  </div>
                  <div className="mt-0.5 flex items-center gap-2 text-[10px] text-white/30">
                    {event.rig_name && <span>{event.rig_name}</span>}
                    <span>
                      {formatDistanceToNow(new Date(event.created_at), { addSuffix: true })}
                    </span>
                  </div>
                </div>
              </div>
            );
          })}
      </div>
    </div>
  );
}
