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

type StreamEntry = {
  id: number;
  kind: 'text' | 'tool' | 'status' | 'error';
  content: string;
  meta?: string;
  timestamp: Date;
};

const MAX_ENTRIES = 500;

/**
 * Extract displayable content from a kilo serve SSE event.
 * Returns null for events that shouldn't produce a visible entry
 * (e.g. session.updated noise, message.created before content arrives).
 */
function toStreamEntry(
  event: string,
  data: Record<string, unknown>,
  nextId: () => number
): StreamEntry | null {
  // The WebSocket frame sends event data directly in `data` (not wrapped in `properties`).
  // Support both: new format (data.part, data.info) and legacy (data.properties.part).
  const props = (data.properties as Record<string, unknown> | undefined) ?? data;
  const ts = new Date();

  // Text / reasoning / tool parts — the main LLM output.
  // kilo serve uses dots: "message.part.updated"; the container Zod schema
  // also accepts "message_part.updated" (underscore). Match both.
  if ((event === 'message.part.updated' || event === 'message_part.updated') && props) {
    const part = props.part as Record<string, unknown> | undefined;
    if (part) {
      const partType = part.type as string | undefined;

      if (partType === 'text' && typeof part.text === 'string' && part.text) {
        return { id: nextId(), kind: 'text', content: part.text, timestamp: ts };
      }

      if (partType === 'reasoning' && typeof part.text === 'string' && part.text) {
        return { id: nextId(), kind: 'text', content: part.text, meta: 'thinking', timestamp: ts };
      }

      if (partType === 'tool') {
        const toolName = (part.tool ?? part.name ?? 'unknown') as string;
        // part.state can be a string enum OR an object like {status, input, raw}
        const rawState = part.state;
        const stateStr =
          typeof rawState === 'string'
            ? rawState
            : typeof rawState === 'object' && rawState !== null && 'status' in rawState
              ? String((rawState as Record<string, unknown>).status)
              : '';
        const stateLabel =
          stateStr === 'running'
            ? 'running...'
            : stateStr === 'completed'
              ? 'done'
              : stateStr === 'error'
                ? 'failed'
                : stateStr || 'pending';
        return {
          id: nextId(),
          kind: 'tool',
          content: toolName,
          meta: stateLabel,
          timestamp: ts,
        };
      }
    }
  }

  // File diffs — the mayor (or any agent) edited files
  if (event === 'session.diff' && props) {
    const diff = props.diff;
    if (Array.isArray(diff) && diff.length > 0) {
      const files = diff
        .map((d: Record<string, unknown>) => {
          const file = d.file as string;
          const adds = d.additions as number | undefined;
          const dels = d.deletions as number | undefined;
          const status = d.status as string | undefined;
          const parts = [file];
          if (status === 'added') parts.push('(new)');
          else if (status === 'deleted') parts.push('(deleted)');
          else if (adds || dels) parts.push(`(+${adds ?? 0}/-${dels ?? 0})`);
          return parts.join(' ');
        })
        .join(', ');
      return { id: nextId(), kind: 'tool', content: 'file changes', meta: files, timestamp: ts };
    }
  }

  // Session lifecycle events
  if (event === 'session.idle') {
    return { id: nextId(), kind: 'status', content: 'Session idle', timestamp: ts };
  }
  if (event === 'session.completed') {
    return { id: nextId(), kind: 'status', content: 'Session completed', timestamp: ts };
  }
  if (event === 'agent.exited') {
    const reason = props && typeof props.reason === 'string' ? props.reason : 'unknown reason';
    return { id: nextId(), kind: 'status', content: `Agent exited: ${reason}`, timestamp: ts };
  }

  // Errors
  if (event === 'error' || event === 'payment_required' || event === 'insufficient_funds') {
    const errorMsg = props && typeof props.error === 'string' ? props.error : event;
    return { id: nextId(), kind: 'error', content: errorMsg, timestamp: ts };
  }
  if (event === 'session.error') {
    const errData = props?.error as Record<string, unknown> | undefined;
    const errMsg =
      errData && typeof errData.data === 'object' && errData.data
        ? String((errData.data as Record<string, unknown>).message ?? 'Unknown error')
        : typeof errData?.name === 'string'
          ? errData.name
          : 'Session error';
    return { id: nextId(), kind: 'error', content: errMsg, timestamp: ts };
  }

  return null;
}

export function AgentStream({ townId, agentId, onClose }: AgentStreamProps) {
  const trpc = useTRPC();
  const [entries, setEntries] = useState<StreamEntry[]>([]);
  const [connected, setConnected] = useState(false);
  const [status, setStatus] = useState<string>('Fetching ticket...');
  const wsRef = useRef<WebSocket | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const entryIdRef = useRef(0);
  const mountedRef = useRef(true);

  const ticketQuery = useQuery(trpc.gastown.getAgentStreamUrl.queryOptions({ agentId, townId }));

  const nextId = useCallback(() => entryIdRef.current++, []);

  const handleMessage = useCallback(
    (event: string, data: Record<string, unknown>) => {
      if (!mountedRef.current) return;

      // For text parts, merge into the last text entry if it's from the same
      // streaming burst (avoids one entry per delta). We detect "same burst"
      // by checking if the last entry is also text with no tool/status in between.
      const entry = toStreamEntry(event, data, nextId);
      if (!entry) return;

      if (entry.kind === 'text' && !entry.meta) {
        setEntries(prev => {
          const last = prev[prev.length - 1];
          if (last && last.kind === 'text' && !last.meta) {
            // Merge: replace last entry with accumulated text
            const merged = { ...last, content: entry.content, timestamp: entry.timestamp };
            return [...prev.slice(0, -1), merged];
          }
          return [...prev.slice(-(MAX_ENTRIES - 1)), entry];
        });
      } else {
        setEntries(prev => [...prev.slice(-(MAX_ENTRIES - 1)), entry]);
      }
    },
    [nextId]
  );

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
        handleMessage(msg.event, msg.data);

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
  }, [ticketQuery.data?.url, ticketQuery.data?.ticket, handleMessage]);

  // Auto-scroll to bottom
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [entries]);

  return (
    <Card className="border-white/10 bg-white/[0.02]">
      <CardHeader className="flex flex-row items-center justify-between pb-3">
        <div className="flex items-center gap-2">
          <CardTitle className="text-sm">Agent Stream</CardTitle>
          <div className="flex items-center gap-1">
            <Radio className={`size-3 ${connected ? 'text-emerald-300' : 'text-white/35'}`} />
            <span className="text-xs text-white/45">{status}</span>
          </div>
        </div>
        <Button variant="secondary" size="icon" onClick={onClose}>
          <X className="size-4" />
        </Button>
      </CardHeader>
      <CardContent>
        <div
          ref={scrollRef}
          className="h-80 overflow-y-auto rounded-xl border border-white/10 bg-black/40 p-3 text-sm leading-relaxed"
        >
          {entries.length === 0 && <p className="text-xs text-white/35">Waiting for events...</p>}
          {entries.map(entry => (
            <EntryLine key={entry.id} entry={entry} />
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

function EntryLine({ entry }: { entry: StreamEntry }) {
  switch (entry.kind) {
    case 'text':
      return (
        <div className="mb-2">
          {entry.meta === 'thinking' && (
            <span className="text-xs text-purple-400 italic">thinking: </span>
          )}
          <span className="whitespace-pre-wrap text-white/85">{entry.content}</span>
        </div>
      );

    case 'tool':
      return (
        <div className="mb-1 flex items-center gap-2 text-xs">
          <span className="rounded bg-blue-900/50 px-1.5 py-0.5 text-blue-300">
            {entry.content}
          </span>
          <span className="text-white/45">{entry.meta}</span>
        </div>
      );

    case 'status':
      return <div className="my-2 text-center text-xs text-white/35">— {entry.content} —</div>;

    case 'error':
      return <div className="mb-1 text-xs text-red-400">Error: {entry.content}</div>;
  }
}
