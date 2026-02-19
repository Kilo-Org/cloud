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
const RECONNECT_BASE_DELAY_MS = 1000;
const MAX_RECONNECT_ATTEMPTS = 5;

export function AgentStream({ townId, agentId, onClose }: AgentStreamProps) {
  const trpc = useTRPC();
  const [events, setEvents] = useState<StreamEvent[]>([]);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const eventIdRef = useRef(0);
  const reconnectAttemptRef = useRef(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const ticketQuery = useQuery(trpc.gastown.getAgentStreamUrl.queryOptions({ agentId, townId }));

  const appendEvent = useCallback((type: string, data: Record<string, unknown>) => {
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

  useEffect(() => {
    if (!ticketQuery.data?.url || !ticketQuery.data?.ticket) return;

    // Reset state when switching agents
    setEvents([]);
    eventIdRef.current = 0;
    reconnectAttemptRef.current = 0;

    function connect() {
      const url = new URL(ticketQuery.data!.url);
      url.searchParams.set('ticket', ticketQuery.data!.ticket!);

      const ws = new WebSocket(url.toString());
      wsRef.current = ws;

      ws.onopen = () => {
        setConnected(true);
        setError(null);
        reconnectAttemptRef.current = 0;
      };

      ws.onmessage = e => {
        try {
          const msg = JSON.parse(e.data as string) as {
            event: string;
            data: Record<string, unknown>;
          };
          appendEvent(msg.event, msg.data);

          // If the agent has exited, no need to keep the connection open
          if (msg.event === 'agent.exited') {
            setConnected(false);
            setError('Agent exited');
          }
        } catch {
          // Non-JSON messages (e.g. keepalive) are ignored
        }
      };

      ws.onclose = e => {
        setConnected(false);
        wsRef.current = null;

        // Don't reconnect on normal closure or if the agent exited
        if (e.code === 1000) {
          setError('Stream closed');
          return;
        }

        // Attempt reconnect with exponential backoff
        if (reconnectAttemptRef.current < MAX_RECONNECT_ATTEMPTS) {
          const delay = RECONNECT_BASE_DELAY_MS * 2 ** reconnectAttemptRef.current;
          reconnectAttemptRef.current++;
          setError(`Reconnecting (${reconnectAttemptRef.current}/${MAX_RECONNECT_ATTEMPTS})...`);

          // Refetch ticket before reconnecting since tickets are one-time-use
          ticketQuery
            .refetch()
            .then(() => {
              reconnectTimerRef.current = setTimeout(connect, delay);
            })
            .catch(() => {
              setError('Failed to get new stream ticket');
            });
        } else {
          setError('Stream disconnected');
        }
      };

      ws.onerror = () => {
        // onclose will fire after this, so we just set the error state
        setError('Connection error');
      };
    }

    connect();

    return () => {
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      const ws = wsRef.current;
      if (ws) {
        ws.onclose = null; // Prevent reconnect on intentional close
        ws.close(1000, 'Component unmount');
        wsRef.current = null;
      }
    };
    // ticketQuery.refetch is stable; we depend on the initial URL/ticket values
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
  // Show the event type from the nested data if present
  const type = data.type;
  const props = data.properties;

  if (typeof props === 'object' && props !== null) {
    const p = props as Record<string, unknown>;
    // Show active tools if present
    if (Array.isArray(p.activeTools) && p.activeTools.length > 0) {
      return `tools: ${p.activeTools.join(', ')}`;
    }
    // Show reason for exit events
    if (typeof p.reason === 'string') {
      return p.reason;
    }
    // Show error if present
    if (typeof p.error === 'string') {
      return `error: ${p.error}`;
    }
  }

  // Fallback: show the type if available, otherwise stringify
  if (typeof type === 'string') {
    return type;
  }
  return JSON.stringify(data).slice(0, 200);
}
