'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc/utils';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import Link from 'next/link';
import { formatDistanceToNow, format } from 'date-fns';
import { ChevronDown, ChevronUp } from 'lucide-react';

type SortDir = 'asc' | 'desc';

export function EventsTab({ townId }: { townId: string }) {
  const trpc = useTRPC();

  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const [beadFilter, setBeadFilter] = useState('');
  const [agentFilter, setAgentFilter] = useState('');
  const [limit, setLimit] = useState(100);

  const eventsQuery = useQuery(trpc.admin.gastown.getBeadEvents.queryOptions({ townId, limit }));

  const events = eventsQuery.data ?? [];

  const filtered = events.filter(e => {
    if (beadFilter && !e.bead_id.toLowerCase().includes(beadFilter.toLowerCase())) return false;
    if (agentFilter && e.agent_id && !e.agent_id.toLowerCase().includes(agentFilter.toLowerCase()))
      return false;
    return true;
  });

  const sorted = [...filtered].sort((a, b) => {
    const diff = new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
    return sortDir === 'desc' ? -diff : diff;
  });

  const toggleSort = () => setSortDir(d => (d === 'desc' ? 'asc' : 'desc'));

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle>Events Timeline</CardTitle>
          <div className="flex flex-wrap items-center gap-2">
            <Input
              placeholder="Filter by bead ID…"
              value={beadFilter}
              onChange={e => setBeadFilter(e.target.value)}
              className="h-8 w-48 text-xs"
            />
            <Input
              placeholder="Filter by agent ID…"
              value={agentFilter}
              onChange={e => setAgentFilter(e.target.value)}
              className="h-8 w-48 text-xs"
            />
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {eventsQuery.isLoading && (
          <p className="text-muted-foreground py-8 text-center text-sm">Loading events…</p>
        )}
        {eventsQuery.isError && (
          <p className="py-8 text-center text-sm text-red-400">
            Failed to load events: {eventsQuery.error.message}
          </p>
        )}
        {!eventsQuery.isLoading && sorted.length === 0 && (
          <p className="text-muted-foreground py-8 text-center text-sm">
            {events.length === 0
              ? 'No events found for this town.'
              : 'No events match the current filters.'}
          </p>
        )}
        {sorted.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b">
                  <th className="text-muted-foreground pb-2 text-left font-medium">
                    <button
                      className="hover:text-foreground flex items-center gap-1 transition-colors"
                      onClick={toggleSort}
                    >
                      Time
                      {sortDir === 'desc' ? (
                        <ChevronDown className="h-3 w-3" />
                      ) : (
                        <ChevronUp className="h-3 w-3" />
                      )}
                    </button>
                  </th>
                  <th className="text-muted-foreground pb-2 text-left font-medium">Event</th>
                  <th className="text-muted-foreground pb-2 text-left font-medium">Bead</th>
                  <th className="text-muted-foreground pb-2 text-left font-medium">Agent</th>
                  <th className="text-muted-foreground pb-2 text-left font-medium">Change</th>
                </tr>
              </thead>
              <tbody>
                {sorted.map(event => (
                  <tr
                    key={event.bead_event_id}
                    className="hover:bg-muted/40 border-b transition-colors"
                  >
                    <td className="text-muted-foreground py-2 pr-4 text-xs">
                      <span title={format(new Date(event.created_at), 'PPpp')}>
                        {formatDistanceToNow(new Date(event.created_at), { addSuffix: true })}
                      </span>
                    </td>
                    <td className="py-2 pr-4">
                      <span className="rounded bg-gray-500/10 px-1.5 py-0.5 font-mono text-xs">
                        {event.event_type}
                      </span>
                    </td>
                    <td className="py-2 pr-4">
                      <Link
                        href={`/admin/gastown/towns/${townId}/beads/${event.bead_id}`}
                        className="hover:text-foreground font-mono text-xs text-blue-400 transition-colors"
                      >
                        {event.bead_id.slice(0, 8)}…
                      </Link>
                      {event.rig_name && (
                        <span className="text-muted-foreground ml-1 text-xs">
                          ({event.rig_name})
                        </span>
                      )}
                    </td>
                    <td className="py-2 pr-4">
                      {event.agent_id ? (
                        <Link
                          href={`/admin/gastown/towns/${townId}/agents/${event.agent_id}`}
                          className="hover:text-foreground font-mono text-xs text-blue-400 transition-colors"
                        >
                          {event.agent_id.slice(0, 8)}…
                        </Link>
                      ) : (
                        <span className="text-muted-foreground text-xs">—</span>
                      )}
                    </td>
                    <td className="py-2 text-xs">
                      {(event.old_value ?? event.new_value) ? (
                        <div className="flex items-center gap-1">
                          {event.old_value && (
                            <span className="rounded bg-red-500/10 px-1 py-0.5 font-mono text-red-400 line-through">
                              {event.old_value.length > 30
                                ? `${event.old_value.slice(0, 30)}…`
                                : event.old_value}
                            </span>
                          )}
                          {event.old_value && event.new_value && (
                            <span className="text-muted-foreground">→</span>
                          )}
                          {event.new_value && (
                            <span className="rounded bg-green-500/10 px-1 py-0.5 font-mono text-green-400">
                              {event.new_value.length > 30
                                ? `${event.new_value.slice(0, 30)}…`
                                : event.new_value}
                            </span>
                          )}
                        </div>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {events.length >= limit && (
          <div className="mt-4 flex justify-center">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setLimit(l => l + 100)}
              disabled={eventsQuery.isFetching}
            >
              {eventsQuery.isFetching ? 'Loading…' : `Load more (showing ${events.length})`}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
