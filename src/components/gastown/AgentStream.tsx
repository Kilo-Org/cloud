'use client';

import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc/utils';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/Button';
import { X, Radio } from 'lucide-react';

type AgentStreamProps = {
  townId: string;
  agentId: string;
  onClose: () => void;
};

type StreamEvent = {
  id: number;
  type: string;
  data: string;
  timestamp: Date;
};

export function AgentStream({ townId, agentId, onClose }: AgentStreamProps) {
  const trpc = useTRPC();
  const [events, setEvents] = useState<StreamEvent[]>([]);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const eventSourceRef = useRef<EventSource | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const eventIdRef = useRef(0);

  const ticketQuery = useQuery(trpc.gastown.getAgentStreamUrl.queryOptions({ agentId, townId }));

  useEffect(() => {
    if (!ticketQuery.data?.url) return;

    const url = new URL(ticketQuery.data.url);
    if (ticketQuery.data.ticket) {
      url.searchParams.set('ticket', ticketQuery.data.ticket);
    }

    const es = new EventSource(url.toString());
    eventSourceRef.current = es;

    es.onopen = () => {
      setConnected(true);
      setError(null);
    };

    es.onmessage = e => {
      setEvents(prev => [
        ...prev,
        {
          id: eventIdRef.current++,
          type: 'message',
          data: e.data,
          timestamp: new Date(),
        },
      ]);
    };

    es.onerror = () => {
      setConnected(false);
      setError('Stream disconnected');
    };

    return () => {
      es.close();
      eventSourceRef.current = null;
    };
  }, [ticketQuery.data?.url, ticketQuery.data?.ticket]);

  // Auto-scroll to bottom
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [events]);

  return (
    <Card className="border-gray-700">
      <CardHeader className="flex flex-row items-center justify-between pb-3">
        <div className="flex items-center gap-2">
          <CardTitle className="text-sm">Agent Stream</CardTitle>
          <div className="flex items-center gap-1">
            <Radio className={`size-3 ${connected ? 'text-green-400' : 'text-gray-500'}`} />
            <span className="text-xs text-gray-500">
              {connected ? 'Connected' : (error ?? 'Connecting...')}
            </span>
          </div>
        </div>
        <Button variant="secondary" size="icon" onClick={onClose}>
          <X className="size-4" />
        </Button>
      </CardHeader>
      <CardContent>
        <div
          ref={scrollRef}
          className="h-64 overflow-y-auto rounded-md bg-gray-900 p-3 font-mono text-xs"
        >
          {events.length === 0 && <p className="text-gray-600">Waiting for events...</p>}
          {events.map(event => (
            <div key={event.id} className="mb-1">
              <span className="text-gray-600">{event.timestamp.toLocaleTimeString()}</span>{' '}
              <span className="text-gray-300">{event.data}</span>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
