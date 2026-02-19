'use client';

import { useEffect, useState, useRef, useCallback } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Loader2, Terminal, CheckCircle2, XCircle } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc/utils';
import {
  createWebSocketManager,
  type ConnectionState,
} from '@/lib/cloud-agent-next/websocket-manager';
import type { CloudAgentEvent, StreamError } from '@/lib/cloud-agent-next/event-types';
import type { ReviewEvent } from '@/lib/code-reviews/client/code-review-worker-client';
import { CLOUD_AGENT_NEXT_WS_URL } from '@/lib/constants';

type CodeReviewStreamViewProps = {
  reviewId: string;
  onComplete?: () => void;
};

/** Simplified event for display in the code review log */
type DisplayEvent = {
  timestamp: string;
  message: string;
  content?: string;
  eventType: string;
};

// ---------------------------------------------------------------------------
// cloud-agent-next event conversion (WebSocket flow)
// ---------------------------------------------------------------------------

function toDisplayEvent(event: CloudAgentEvent): DisplayEvent | null {
  const { streamEventType, timestamp, data } = event;
  const payload = data as Record<string, unknown> | undefined;

  if (streamEventType === 'started') {
    return { timestamp, message: 'Execution started', eventType: streamEventType };
  }
  if (streamEventType === 'complete') {
    return { timestamp, message: 'Review completed', eventType: streamEventType };
  }
  if (streamEventType === 'interrupted') {
    return { timestamp, message: 'Review interrupted', eventType: streamEventType };
  }
  if (streamEventType === 'error') {
    const errorMsg = typeof payload?.message === 'string' ? payload.message : 'An error occurred';
    return { timestamp, message: `Error: ${errorMsg}`, eventType: streamEventType };
  }
  if (streamEventType === 'kilocode' && payload) {
    return toDisplayEventFromKilocode(timestamp, payload);
  }
  if (streamEventType === 'status') {
    const status = typeof payload?.status === 'string' ? payload.status : '';
    if (status) {
      return { timestamp, message: `Status: ${status}`, eventType: streamEventType };
    }
  }
  return null;
}

function toDisplayEventFromKilocode(
  timestamp: string,
  payload: Record<string, unknown>
): DisplayEvent | null {
  const type = payload.type as string | undefined;
  const properties = payload.properties as Record<string, unknown> | undefined;
  if (!type || !properties) return null;

  if (type === 'message.part.updated') {
    const part = properties.part as Record<string, unknown> | undefined;
    if (!part) return null;
    const partType = part.type as string | undefined;

    if (partType === 'tool') {
      const toolName = part.name as string | undefined;
      const state = part.state as string | undefined;
      if (toolName && state === 'running') {
        const input = part.input as Record<string, unknown> | undefined;
        let detail: string | undefined;
        if (input) {
          const filePath = input.filePath ?? input.file_path ?? input.path;
          const command = input.command;
          const query = input.query ?? input.pattern;
          if (typeof filePath === 'string') detail = filePath;
          else if (typeof command === 'string')
            detail = command.length > 100 ? command.slice(0, 100) + '...' : command;
          else if (typeof query === 'string') detail = query;
        }
        return { timestamp, message: `Tool: ${toolName}`, content: detail, eventType: 'tool' };
      }
      return null;
    }

    if (partType === 'text') {
      const state = part.state as string | undefined;
      if (state && state !== 'complete') return null;
      const text = part.text as string | undefined;
      if (text && text.trim()) {
        const truncated = text.length > 200 ? text.slice(0, 200) + '...' : text;
        return { timestamp, message: truncated, eventType: 'text' };
      }
      return null;
    }
    return null;
  }

  if (type === 'session.status') {
    const status = properties.status as string | undefined;
    if (status === 'idle') return { timestamp, message: 'Agent idle', eventType: 'status' };
    if (status === 'busy') return { timestamp, message: 'Agent working...', eventType: 'status' };
    return null;
  }

  if (type === 'session.error') {
    const error = properties.error as string | undefined;
    return { timestamp, message: `Session error: ${error ?? 'Unknown error'}`, eventType: 'error' };
  }

  return null;
}

// ---------------------------------------------------------------------------
// SSE/cloud-agent event conversion (polling flow)
// ---------------------------------------------------------------------------

function reviewEventToDisplayEvent(event: ReviewEvent): DisplayEvent {
  return {
    timestamp: event.timestamp,
    message: event.message || 'Event received',
    content: event.content,
    eventType: event.eventType,
  };
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const formatTimestamp = (timestamp: string): string => {
  const date = new Date(timestamp);
  return date.toLocaleTimeString('en-US', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function CodeReviewStreamView({ reviewId, onComplete }: CodeReviewStreamViewProps) {
  const trpc = useTRPC();
  const [events, setEvents] = useState<DisplayEvent[]>([]);
  const [isComplete, setIsComplete] = useState(false);
  const [connectionState, setConnectionState] = useState<ConnectionState>({
    status: 'disconnected',
  });
  const [wsError, setWsError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const wsManagerRef = useRef<ReturnType<typeof createWebSocketManager> | null>(null);

  // ---------------------------------------------------------------------------
  // Step 1: Get stream info to determine which mode to use
  // ---------------------------------------------------------------------------

  const { data: streamInfo } = useQuery({
    ...trpc.codeReviews.getReviewStreamInfo.queryOptions({ reviewId }),
    refetchInterval: query => {
      const data = query.state.data;
      if (!data?.success) return 2000;
      // Terminal state — stop polling
      if (['completed', 'failed', 'cancelled'].includes(data.status)) return false;
      // cloud-agent-next mode: stop once we have the cloudAgentSessionId for WebSocket
      if (data.useCloudAgentNext && data.cloudAgentSessionId) return false;
      // cloud-agent mode: stop once we have stream info (polling handles the rest)
      if (!data.useCloudAgentNext) return false;
      return 2000;
    },
    enabled: !!reviewId,
  });

  const cloudAgentSessionId = streamInfo?.success ? streamInfo.cloudAgentSessionId : null;
  const organizationId = streamInfo?.success ? streamInfo.organizationId : undefined;
  const reviewStatus = streamInfo?.success ? streamInfo.status : undefined;

  // Determine mode from the explicit DB flag (set at dispatch time from PostHog feature flag)
  const useWebSocket = streamInfo?.success ? streamInfo.useCloudAgentNext : false;

  // Mark as complete if the review is already in a terminal state
  useEffect(() => {
    if (reviewStatus === 'completed' || reviewStatus === 'failed' || reviewStatus === 'cancelled') {
      setIsComplete(true);
      if (reviewStatus === 'completed') {
        onComplete?.();
      }
    }
  }, [reviewStatus, onComplete]);

  // ---------------------------------------------------------------------------
  // Mode A: WebSocket streaming (cloud-agent-next)
  // ---------------------------------------------------------------------------

  const getTicket = useCallback(
    async (sessionId: string): Promise<string> => {
      const body: { cloudAgentSessionId: string; organizationId?: string } = {
        cloudAgentSessionId: sessionId,
      };
      if (organizationId) {
        body.organizationId = organizationId;
      }
      const response = await fetch('/api/cloud-agent-next/sessions/stream-ticket', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        const errorData = (await response.json()) as { error?: string };
        throw new Error(errorData.error ?? 'Failed to get stream ticket');
      }
      const result = (await response.json()) as { ticket: string };
      return result.ticket;
    },
    [organizationId]
  );

  const handleEvent = useCallback(
    (event: CloudAgentEvent) => {
      const displayEvent = toDisplayEvent(event);
      if (displayEvent) {
        setEvents(prev => [...prev, displayEvent]);
      }
      if (event.streamEventType === 'complete' || event.streamEventType === 'interrupted') {
        setIsComplete(true);
        onComplete?.();
      }
    },
    [onComplete]
  );

  const handleWsError = useCallback((error: StreamError) => {
    setWsError(`${error.code}: ${error.message}`);
    if (
      error.code === 'WS_SESSION_NOT_FOUND' ||
      error.code === 'WS_EXECUTION_NOT_FOUND' ||
      error.code === 'WS_AUTH_ERROR'
    ) {
      setIsComplete(true);
    }
  }, []);

  // Connect WebSocket when cloudAgentSessionId becomes available
  useEffect(() => {
    if (!useWebSocket || !cloudAgentSessionId || isComplete) return;
    if (!CLOUD_AGENT_NEXT_WS_URL) return;

    let cancelled = false;

    async function connect() {
      if (cancelled || !cloudAgentSessionId) return;
      try {
        const ticket = await getTicket(cloudAgentSessionId);
        if (cancelled) return;

        const url = new URL('/stream', CLOUD_AGENT_NEXT_WS_URL);
        url.searchParams.set('cloudAgentSessionId', cloudAgentSessionId);

        const manager = createWebSocketManager({
          url: url.toString(),
          ticket,
          onEvent: handleEvent,
          onError: handleWsError,
          onStateChange: setConnectionState,
          onRefreshTicket: async () => getTicket(cloudAgentSessionId),
        });

        wsManagerRef.current = manager;
        manager.connect();
      } catch (err) {
        if (!cancelled) {
          setWsError(err instanceof Error ? err.message : 'Failed to connect');
        }
      }
    }

    void connect();

    return () => {
      cancelled = true;
      wsManagerRef.current?.disconnect();
      wsManagerRef.current = null;
    };
  }, [useWebSocket, cloudAgentSessionId, isComplete, getTicket, handleEvent, handleWsError]);

  // ---------------------------------------------------------------------------
  // Mode B: Polling (SSE/cloud-agent flow)
  // ---------------------------------------------------------------------------

  const { data: polledEvents } = useQuery({
    ...trpc.codeReviews.getReviewEvents.queryOptions({ reviewId }),
    refetchInterval: isComplete ? false : 2000,
    // Only poll when NOT using WebSocket mode and the review exists
    enabled: !!reviewId && !useWebSocket && !!streamInfo?.success,
  });

  // Sync polled events into display events
  useEffect(() => {
    if (useWebSocket) return; // WebSocket mode handles its own events
    if (!polledEvents?.success) return;

    const displayEvents = polledEvents.events.map(reviewEventToDisplayEvent);
    setEvents(displayEvents);

    // Check for completion in polled events
    const lastEvent = polledEvents.events[polledEvents.events.length - 1];
    if (lastEvent?.eventType === 'complete') {
      setIsComplete(true);
      onComplete?.();
    }
  }, [useWebSocket, polledEvents, onComplete]);

  // ---------------------------------------------------------------------------
  // Auto-scroll
  // ---------------------------------------------------------------------------

  useEffect(() => {
    if (autoScroll && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [events, autoScroll]);

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  // Waiting for stream info
  if (!streamInfo?.success) {
    return (
      <Card className="border-l-4 border-l-blue-500">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading...
          </CardTitle>
        </CardHeader>
      </Card>
    );
  }

  // Error state (WebSocket only)
  if (wsError && isComplete) {
    return (
      <Card className="border-l-4 border-l-red-500">
        <CardHeader className="pb-3">
          <div className="flex items-center gap-2">
            <XCircle className="h-4 w-4 text-red-500" />
            <CardTitle className="text-sm font-medium text-red-500">Stream error</CardTitle>
          </div>
        </CardHeader>
        <CardContent className="pt-0">
          <div className="rounded-md bg-slate-950 p-4 font-mono text-xs text-red-400">
            {wsError}
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="border-l-4 border-l-blue-500">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Terminal className="h-4 w-4" />
            <CardTitle className="text-sm font-medium">Code Review Progress</CardTitle>
          </div>
          {isComplete ? (
            reviewStatus === 'failed' ? (
              <Badge variant="destructive" className="gap-1.5">
                <XCircle className="h-3 w-3" />
                Failed
              </Badge>
            ) : reviewStatus === 'cancelled' ? (
              <Badge variant="secondary" className="gap-1.5">
                <XCircle className="h-3 w-3" />
                Cancelled
              </Badge>
            ) : (
              <Badge variant="default" className="gap-1.5 bg-emerald-500 hover:bg-emerald-600">
                <CheckCircle2 className="h-3 w-3" />
                Complete
              </Badge>
            )
          ) : (
            <Badge variant="secondary" className="gap-1.5">
              <Loader2 className="h-3 w-3 animate-spin" />
              {useWebSocket
                ? connectionState.status === 'connecting' ||
                  connectionState.status === 'reconnecting'
                  ? 'Connecting...'
                  : 'Running'
                : 'Running'}
            </Badge>
          )}
        </div>
      </CardHeader>
      <CardContent className="pt-0">
        <div
          ref={scrollRef}
          className="max-h-[500px] overflow-y-auto rounded-md bg-slate-950 p-4 font-mono text-xs dark:bg-slate-950"
          onScroll={e => {
            const element = e.currentTarget;
            const isAtBottom =
              Math.abs(element.scrollHeight - element.scrollTop - element.clientHeight) < 1;
            setAutoScroll(isAtBottom);
          }}
        >
          {events.length === 0 && !isComplete ? (
            <div className="flex items-center gap-2 text-slate-400">
              <Loader2 className="h-4 w-4 animate-spin" />
              <span>Waiting for events...</span>
            </div>
          ) : (
            <div className="space-y-1">
              {events.map((event, index) => (
                <div
                  key={index}
                  className="rounded px-2 py-1 transition-colors hover:bg-slate-900/50"
                >
                  <div className="flex gap-3 text-slate-300">
                    <span className="shrink-0 text-slate-500 select-none">
                      {formatTimestamp(event.timestamp)}
                    </span>
                    <span className="break-all">{event.message}</span>
                  </div>
                  {event.content && (
                    <div className="mt-1 ml-[72px] font-mono text-[11px] break-all whitespace-pre-wrap text-slate-400">
                      {event.content}
                    </div>
                  )}
                </div>
              ))}
              {!isComplete && (
                <div className="flex items-center gap-2 px-2 py-1 text-slate-500">
                  <div className="h-1.5 w-1.5 animate-pulse rounded-full bg-blue-500" />
                  <span>Live</span>
                </div>
              )}
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
