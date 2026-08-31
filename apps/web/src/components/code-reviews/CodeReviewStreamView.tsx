'use client';

import { useEffect, useState, useRef, useCallback } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { AlertCircle, Loader2, Terminal, CheckCircle2, XCircle } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { TRPCClientError } from '@trpc/client';
import { useTRPC } from '@/lib/trpc/utils';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import {
  createWebSocketManager,
  type ConnectionState,
} from '@/lib/cloud-agent-next/websocket-manager';
import type { CloudAgentEvent, StreamError } from '@/lib/cloud-agent-next/event-types';
import { CLOUD_AGENT_NEXT_WS_URL } from '@/lib/constants';
import { isInFlightReviewStatus } from '@kilocode/app-shared/code-review';
import { getCodeReviewDisplayBehavior } from './code-review-stream-behavior';
import { fetchStreamTicket } from './fetch-stream-ticket';
import {
  appendCodeReviewDisplayEvent,
  toCodeReviewDisplayEvent,
  type CodeReviewDisplayEvent,
} from './code-review-stream-events';

type CodeReviewStreamViewProps = {
  reviewId: string;
  onComplete?: () => void;
  attempts?: CodeReviewAttemptSummary[];
};

type CodeReviewAttemptSummary = {
  id: string;
  attempt_number: number;
  retry_reason: string | null;
  session_id: string | null;
  cli_session_id: string | null;
  status: string;
  error_message: string | null;
  terminal_reason: string | null;
};

type DisplayEvent = CodeReviewDisplayEvent;

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

function formatStatusLabel(status: string): string {
  return status.slice(0, 1).toUpperCase() + status.slice(1);
}

function isAccessDeniedError(error: unknown): boolean {
  return (
    error instanceof TRPCClientError &&
    (error.data?.code === 'UNAUTHORIZED' ||
      error.data?.code === 'FORBIDDEN' ||
      error.data?.code === 'NOT_FOUND')
  );
}

function formatAttemptLabel(attempt: CodeReviewAttemptSummary): string {
  const parts = [`Attempt ${attempt.attempt_number}`, formatStatusLabel(attempt.status)];
  const sessionId = attempt.session_id ?? attempt.cli_session_id;
  if (sessionId) {
    parts.push(sessionId.length > 12 ? `${sessionId.slice(0, 12)}...` : sessionId);
  } else if (attempt.terminal_reason) {
    parts.push(attempt.terminal_reason);
  } else if (attempt.retry_reason) {
    parts.push(attempt.retry_reason.replace(/_/g, ' '));
  }
  return parts.join(' · ');
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function CodeReviewStreamView({
  reviewId,
  onComplete,
  attempts = [],
}: CodeReviewStreamViewProps) {
  const trpc = useTRPC();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [events, setEvents] = useState<DisplayEvent[]>([]);
  const [accessDenied, setAccessDenied] = useState(false);
  const [connectionState, setConnectionState] = useState<ConnectionState>({
    status: 'disconnected',
  });
  const [wsError, setWsError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const wsManagerRef = useRef<ReturnType<typeof createWebSocketManager> | null>(null);
  const wasRunningRef = useRef(false);
  const reconcileUntilRef = useRef(0);

  const orderedAttempts = [...attempts].sort((a, b) => a.attempt_number - b.attempt_number);
  const attemptIds = orderedAttempts.map(attempt => attempt.id).join('|');
  const latestAttempt = orderedAttempts.at(-1);
  const latestCompletedAttempt = [...orderedAttempts]
    .reverse()
    .find(attempt => attempt.status === 'completed');
  const defaultAttemptId =
    latestAttempt && isInFlightReviewStatus(latestAttempt.status)
      ? latestAttempt.id
      : (latestCompletedAttempt?.id ?? latestAttempt?.id);
  const queryAttemptId = searchParams.get('attemptId');
  const queryAttemptExists = orderedAttempts.some(attempt => attempt.id === queryAttemptId);
  const effectiveAttemptId = queryAttemptExists ? (queryAttemptId ?? undefined) : defaultAttemptId;
  const selectedAttempt = orderedAttempts.find(attempt => attempt.id === effectiveAttemptId);
  const isSelectedLatestAttempt = !selectedAttempt || selectedAttempt.id === latestAttempt?.id;

  const updateAttemptParam = useCallback(
    (attemptId: string | undefined) => {
      const nextParams = new URLSearchParams(searchParams.toString());
      if (attemptId) {
        nextParams.set('attemptId', attemptId);
      } else {
        nextParams.delete('attemptId');
      }
      const queryString = nextParams.toString();
      router.replace(queryString ? `${pathname}?${queryString}` : pathname, { scroll: false });
    },
    [pathname, router, searchParams]
  );

  useEffect(() => {
    if (orderedAttempts.length > 1 && effectiveAttemptId && queryAttemptId !== effectiveAttemptId) {
      updateAttemptParam(effectiveAttemptId);
    }
    if (orderedAttempts.length <= 1 && queryAttemptId) {
      updateAttemptParam(undefined);
    }
  }, [attemptIds, effectiveAttemptId, orderedAttempts.length, queryAttemptId, updateAttemptParam]);

  useEffect(() => {
    setEvents([]);
    setAccessDenied(false);
    setConnectionState({ status: 'disconnected' });
    setWsError(null);
    setAutoScroll(true);
    wasRunningRef.current = false;
    reconcileUntilRef.current = 0;
    wsManagerRef.current?.disconnect();
    wsManagerRef.current = null;
  }, [reviewId, effectiveAttemptId]);

  // ---------------------------------------------------------------------------
  // Step 1: Get stream info to determine which mode to use
  // ---------------------------------------------------------------------------

  const {
    data: streamInfo,
    error: streamInfoError,
    refetch: refetchStreamInfo,
  } = useQuery({
    ...trpc.codeReviews.getReviewStreamInfo.queryOptions({
      reviewId,
      attemptId: effectiveAttemptId,
    }),
    refetchInterval: query => {
      if (isAccessDeniedError(query.state.error)) return false;
      const data = query.state.data;
      if (!data?.success) return 2000;

      return getCodeReviewDisplayBehavior(data).shouldPollStatus ? 2000 : false;
    },
    retry: (failureCount, error) => !isAccessDeniedError(error) && failureCount < 3,
    enabled: !!reviewId && !accessDenied,
  });

  const cloudAgentSessionId = streamInfo?.success ? streamInfo.cloudAgentSessionId : null;
  const organizationId = streamInfo?.success ? streamInfo.organizationId : undefined;
  const reviewStatus = streamInfo?.success ? streamInfo.status : undefined;
  const displayBehavior = streamInfo?.success ? getCodeReviewDisplayBehavior(streamInfo) : null;
  const isHistoricalReview = displayBehavior?.isHistorical ?? false;
  const isComplete = displayBehavior?.isTerminal ?? false;
  const shouldLoadMessages = displayBehavior?.shouldLoadMessages ?? false;
  const shouldPollMessages = displayBehavior?.shouldPollMessages ?? false;
  const useWebSocket =
    !!displayBehavior && !shouldLoadMessages && isSelectedLatestAttempt && !accessDenied;

  useEffect(() => {
    if (reviewStatus === 'completed') {
      onComplete?.();
    }
  }, [reviewStatus, onComplete]);

  // ---------------------------------------------------------------------------
  // Mode A: WebSocket streaming (cloud-agent-next)
  // ---------------------------------------------------------------------------

  const getTicket = useCallback(
    async (sessionId: string): Promise<{ ticket: string; expiresAt: number }> => {
      return fetchStreamTicket(sessionId, organizationId);
    },
    [organizationId]
  );

  const handleEvent = useCallback(
    (event: CloudAgentEvent) => {
      setWsError(null);
      const displayEvent = toCodeReviewDisplayEvent(event);
      if (displayEvent) {
        setEvents(prev => appendCodeReviewDisplayEvent(prev, displayEvent));
      }
      if (event.streamEventType === 'complete' || event.streamEventType === 'interrupted') {
        void refetchStreamInfo();
      }
    },
    [refetchStreamInfo]
  );

  const handleWsError = useCallback((error: StreamError) => {
    setWsError(`${error.code}: ${error.message}`);
  }, []);

  // Connect WebSocket when cloudAgentSessionId becomes available
  useEffect(() => {
    if (!useWebSocket || !cloudAgentSessionId) return;
    if (!CLOUD_AGENT_NEXT_WS_URL) {
      setWsError('Live stream is unavailable.');
      return;
    }

    let cancelled = false;
    setWsError(null);

    async function connect() {
      if (cancelled || !cloudAgentSessionId) return;
      try {
        const result = await getTicket(cloudAgentSessionId);
        if (cancelled) return;

        const url = new URL('/stream', CLOUD_AGENT_NEXT_WS_URL);
        url.searchParams.set('cloudAgentSessionId', cloudAgentSessionId);

        const manager = createWebSocketManager({
          url: url.toString(),
          ticket: result.ticket,
          onEvent: event => {
            if (!cancelled) handleEvent(event);
          },
          onError: error => {
            if (!cancelled) handleWsError(error);
          },
          onStateChange: state => {
            if (!cancelled) setConnectionState(state);
          },
          onRefreshTicket: async () => {
            const refreshed = await getTicket(cloudAgentSessionId);
            if (cancelled) throw new Error('Review stream disconnected');
            return refreshed.ticket;
          },
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
  }, [
    reviewId,
    effectiveAttemptId,
    useWebSocket,
    cloudAgentSessionId,
    getTicket,
    handleEvent,
    handleWsError,
  ]);

  const {
    data: sessionMessages,
    error: sessionMessagesError,
    isLoading: isLoadingMessages,
    refetch: refetchSessionMessages,
  } = useQuery({
    ...trpc.codeReviews.getSessionMessages.queryOptions({
      reviewId,
      attemptId: effectiveAttemptId,
    }),
    enabled: !!reviewId && shouldLoadMessages && !accessDenied,
    refetchInterval: query => {
      if (isAccessDeniedError(query.state.error)) return false;
      return shouldPollMessages || (isComplete && Date.now() < reconcileUntilRef.current)
        ? 2000
        : false;
    },
    retry: (failureCount, error) => !isAccessDeniedError(error) && failureCount < 3,
  });

  useEffect(() => {
    if (displayBehavior?.shouldPollStatus) {
      wasRunningRef.current = true;
    } else if (isComplete && wasRunningRef.current && !accessDenied) {
      wasRunningRef.current = false;
      reconcileUntilRef.current = Date.now() + 10_000;
      void refetchSessionMessages();
    }
  }, [
    reviewId,
    effectiveAttemptId,
    displayBehavior?.shouldPollStatus,
    isComplete,
    accessDenied,
    refetchSessionMessages,
  ]);

  useEffect(() => {
    if (isAccessDeniedError(streamInfoError) || isAccessDeniedError(sessionMessagesError)) {
      setAccessDenied(true);
    }
  }, [streamInfoError, sessionMessagesError]);

  const displayEvents: DisplayEvent[] =
    shouldLoadMessages && sessionMessages?.success ? sessionMessages.entries : events;
  const displayError =
    streamInfoError?.message ??
    (streamInfo && !streamInfo.success ? streamInfo.error : null) ??
    (shouldLoadMessages
      ? (sessionMessagesError?.message ??
        (sessionMessages && !sessionMessages.success ? sessionMessages.error : null))
      : (wsError ?? (connectionState.status === 'error' ? connectionState.error : null)));

  // ---------------------------------------------------------------------------
  // Auto-scroll
  // ---------------------------------------------------------------------------

  useEffect(() => {
    if (autoScroll && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [displayEvents, autoScroll]);

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  // Waiting for stream info
  if (!streamInfo?.success && !displayError) {
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

  if (
    displayError &&
    (accessDenied ||
      isAccessDeniedError(streamInfoError) ||
      isAccessDeniedError(sessionMessagesError))
  ) {
    return (
      <Card className="border-l-4 border-l-red-500">
        <CardHeader className="pb-3">
          <div className="flex items-center gap-2">
            <XCircle className="h-4 w-4 text-red-500" />
            <CardTitle className="text-sm font-medium text-red-500">Stream error</CardTitle>
          </div>
        </CardHeader>
        <CardContent className="pt-0">
          <div role="alert" className="rounded-md bg-slate-950 p-4 font-mono text-xs text-red-400">
            {displayError}
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="border-l-4 border-l-blue-500">
      <CardHeader className="pb-3">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <Terminal className="h-4 w-4" />
            <CardTitle className="shrink-0 text-sm font-medium">
              {isHistoricalReview || isComplete ? 'Session Log' : 'Code Review Progress'}
            </CardTitle>
            {cloudAgentSessionId && (
              <span
                title={cloudAgentSessionId}
                className="bg-muted text-muted-foreground max-w-[min(20rem,50vw)] truncate rounded px-2 py-0.5 font-mono text-xs font-normal"
              >
                {cloudAgentSessionId}
              </span>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2 sm:justify-end">
            {orderedAttempts.length > 1 && effectiveAttemptId && (
              <div className="flex items-center gap-2">
                <span className="sr-only">Select session attempt</span>
                <Select value={effectiveAttemptId} onValueChange={updateAttemptParam}>
                  <SelectTrigger size="sm" className="h-8 w-full min-w-56 sm:w-64">
                    <SelectValue placeholder="Select attempt" />
                  </SelectTrigger>
                  <SelectContent>
                    {orderedAttempts.map(attempt => (
                      <SelectItem key={attempt.id} value={attempt.id}>
                        {formatAttemptLabel(attempt)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
            {isHistoricalReview && !isComplete ? (
              <Badge variant="secondary" className="gap-1.5">
                <AlertCircle className="h-3 w-3" />
                Historical
              </Badge>
            ) : isComplete ? (
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
              ) : reviewStatus === 'interrupted' ? (
                <Badge variant="secondary" className="gap-1.5">
                  <AlertCircle className="h-3 w-3" />
                  Interrupted
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
          {displayError ? (
            <div role="alert" className="text-red-400">
              {displayError}
            </div>
          ) : displayEvents.length === 0 && !isHistoricalReview && !isComplete ? (
            <div className="flex items-center gap-2 text-slate-400">
              <Loader2 className="h-4 w-4 animate-spin" />
              <span>Waiting for events...</span>
            </div>
          ) : displayEvents.length === 0 ? (
            <div className="text-slate-500">
              {isLoadingMessages ? (
                <div className="flex items-center gap-2">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  <span>Loading session log...</span>
                </div>
              ) : (
                <span>No session logs available.</span>
              )}
            </div>
          ) : (
            <div className="space-y-1">
              {displayEvents.map((event, index) => (
                <div
                  key={event.key ?? index}
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
              {!isComplete && !isHistoricalReview && (
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
