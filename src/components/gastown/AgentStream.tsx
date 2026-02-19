'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
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
  data: Record<string, unknown>;
  timestamp: Date;
};

const MAX_EVENTS = 500;

export function AgentStream({ townId, agentId, onClose }: AgentStreamProps) {
  const trpc = useTRPC();
  const [events, setEvents] = useState<StreamEvent[]>([]);
  const [connected, setConnected] = useState(false);
  const [status, setStatus] = useState<string>('Fetching ticket...');
  const wsRef = useRef<WebSocket | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const eventIdRef = useRef(0);
  // Track whether the component is still mounted to avoid state updates after unmount
  const mountedRef = useRef(true);

  const ticketQuery = useQuery(trpc.gastown.getAgentStreamUrl.queryOptions({ agentId, townId }));

  const appendEvent = useCallback((type: string, data: Record<string, unknown>) => {
    if (!mountedRef.current) return;
    setEvents(prev => [
      ...prev.slice(-(MAX_EVENTS - 1)),
      {
        id: eventIdRef.current++,
        type,
        data,
        timestamp: new Date(),
      },
    ]);
  }, []);

  // Connect the WebSocket once we have a ticket. This effect runs exactly
  // once per successful ticket fetch. Reconnection is NOT automatic — the
  // user can refetch manually or we accept that the stream is done.
  useEffect(() => {
    mountedRef.current = true;
    const url = ticketQuery.data?.url;
    const ticket = ticketQuery.data?.ticket;

    if (!url || !ticket) return;

    setStatus('Connecting...');

    const wsUrl = new URL(url);
    wsUrl.searchParams.set('ticket', ticket);

    const ws = new WebSocket(wsUrl.toString());
    wsRef.current = ws;

    ws.onopen = () => {
      if (!mountedRef.current) return;
      setConnected(true);
      setStatus('Connected');
    };

    ws.onmessage = e => {
      try {
        const msg = JSON.parse(e.data as string) as {
          event: string;
          data: Record<string, unknown>;
        };
        appendEvent(msg.event, msg.data);

        if (msg.event === 'agent.exited') {
          if (!mountedRef.current) return;
          setConnected(false);
          setStatus('Agent exited');
        }
      } catch {
        // Non-JSON messages (e.g. keepalive) are ignored
      }
    };

    ws.onclose = () => {
      if (!mountedRef.current) return;
      setConnected(false);
      // Don't try to reconnect — the ticket is consumed. If the user
      // wants to reconnect they can re-open the stream panel.
      setStatus(prev => (prev === 'Agent exited' ? prev : 'Disconnected'));
    };

    ws.onerror = () => {
      if (!mountedRef.current) return;
      setStatus('Connection error');
    };

    return () => {
      mountedRef.current = false;
      ws.onclose = null;
      ws.onmessage = null;
      ws.onerror = null;
      ws.close(1000, 'Component unmount');
      wsRef.current = null;
    };
  }, [ticketQuery.data?.url, ticketQuery.data?.ticket, appendEvent]);

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
            <span className="text-xs text-gray-500">{status}</span>
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
              <span className="text-blue-400">[{event.type}]</span>{' '}
              <span className="text-gray-300">{formatEventData(event.data)}</span>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

/** Format event data for display — show a concise summary of relevant fields. */
function formatEventData(data: Record<string, unknown>): string {
  const type = data.type;
  const props = data.properties;

  if (typeof props === 'object' && props !== null) {
    const p = props as Record<string, unknown>;
    if (Array.isArray(p.activeTools) && p.activeTools.length > 0) {
      return `tools: ${p.activeTools.join(', ')}`;
    }
    if (typeof p.reason === 'string') {
      return p.reason;
    }
    if (typeof p.error === 'string') {
      return `error: ${p.error}`;
    }
  }

  if (typeof type === 'string') {
    return type;
  }
  return JSON.stringify(data).slice(0, 200);
}
