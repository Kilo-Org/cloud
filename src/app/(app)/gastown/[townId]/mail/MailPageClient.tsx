'use client';

import { useQuery } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc/utils';
import { Mail } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';

export function MailPageClient({ townId }: { townId: string }) {
  const trpc = useTRPC();

  const eventsQuery = useQuery({
    ...trpc.gastown.getTownEvents.queryOptions({ townId, limit: 200 }),
    refetchInterval: 5_000,
  });

  const mailEvents = (eventsQuery.data ?? []).filter(e => e.event_type === 'mail_sent');

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-white/[0.06] px-6 py-3">
        <div className="flex items-center gap-2">
          <Mail className="size-4 text-[color:oklch(95%_0.15_108_/_0.6)]" />
          <h1 className="text-lg font-semibold tracking-tight text-white/90">Mail</h1>
          <span className="ml-1 font-mono text-xs text-white/30">{mailEvents.length}</span>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        {mailEvents.length === 0 && (
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <Mail className="mb-3 size-8 text-white/10" />
            <p className="text-sm text-white/30">No mail events yet.</p>
            <p className="mt-1 text-xs text-white/20">
              Protocol mail flows between agents will appear here.
            </p>
          </div>
        )}

        {mailEvents
          .slice()
          .reverse()
          .map(event => (
            <div
              key={event.bead_event_id}
              className="flex items-start gap-3 border-b border-white/[0.04] px-6 py-3 transition-colors hover:bg-white/[0.02]"
            >
              <Mail className="mt-0.5 size-3.5 shrink-0 text-sky-400/60" />
              <div className="min-w-0 flex-1">
                <div className="text-sm text-white/75">{event.new_value ?? 'Mail sent'}</div>
                <div className="mt-0.5 flex items-center gap-2 text-[10px] text-white/30">
                  {event.rig_name && <span>{event.rig_name}</span>}
                  <span>
                    {formatDistanceToNow(new Date(event.created_at), { addSuffix: true })}
                  </span>
                </div>
              </div>
            </div>
          ))}
      </div>
    </div>
  );
}
