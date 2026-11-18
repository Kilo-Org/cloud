'use client';

import { useEffect, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { TRPCClientError } from '@trpc/client';
import { Loader2, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { SharedSessionTranscript } from '@/app/s/[sessionId]/shared-session-transcript';
import { LegacyMessageBubble } from '@/components/cloud-agent-next/LegacyMessageBubble';
import { MessageErrorBoundary } from '@/components/cloud-agent-next/MessageErrorBoundary';
import { useTRPC } from '@/lib/trpc/utils';

type WebhookRequestLogsProps = {
  triggerId: string;
  requestId: string;
  organizationId?: string;
  adminScope?:
    | { scope: 'organization'; organizationId: string }
    | { scope: 'user'; userId: string };
};

function isAccessError(error: unknown): boolean {
  return (
    error instanceof TRPCClientError &&
    ['UNAUTHORIZED', 'FORBIDDEN', 'NOT_FOUND'].includes(error.data?.code)
  );
}

export function WebhookRequestLogs({
  triggerId,
  requestId,
  organizationId,
  adminScope,
}: WebhookRequestLogsProps) {
  const trpc = useTRPC();
  const reconcileUntil = useRef(Date.now() + 30_000);
  const scrollRef = useRef<HTMLDivElement>(null);
  const autoScroll = useRef(true);
  const { data, dataUpdatedAt, error, isLoading, isFetching, refetch } = useQuery({
    ...(adminScope
      ? trpc.admin.webhookTriggers.getRequestLogs.queryOptions({
          ...adminScope,
          triggerId,
          requestId,
        })
      : trpc.webhookTriggers.getRequestLogs.queryOptions({
          triggerId,
          requestId,
          organizationId,
        })),
    refetchOnMount: 'always',
    refetchInterval: query => {
      if (isAccessError(query.state.error)) return false;
      const status = query.state.data?.processStatus;
      if (status === 'captured' || status === 'inprogress') {
        reconcileUntil.current = Date.now() + 30_000;
        return 3000;
      }
      return Date.now() < reconcileUntil.current ? 3000 : false;
    },
    retry: (failureCount, queryError) => !isAccessError(queryError) && failureCount < 3,
  });

  useEffect(() => {
    if (autoScroll.current && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [data]);

  const isActive = data?.processStatus === 'captured' || data?.processStatus === 'inprogress';
  const errorLogs = data?.logs?.filter(entry => entry.eventType === 'error') ?? [];
  const hasTranscript = Boolean(data?.transcript?.messages.length);

  return (
    <section aria-label="Execution logs" className="flex min-h-0 min-w-0 flex-1 flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="flex items-center gap-2 text-sm font-medium">
          Conversation
          {isActive && <span className="text-muted-foreground text-xs">Auto-refreshing</span>}
        </h3>
        <Button
          variant="ghost"
          size="sm"
          disabled={isFetching || isAccessError(error)}
          onClick={() => {
            reconcileUntil.current = Date.now() + 30_000;
            void refetch();
          }}
        >
          <RefreshCw className={`mr-1 h-3 w-3 ${isFetching ? 'animate-spin' : ''}`} />
          Refresh logs
        </Button>
      </div>
      <div
        ref={scrollRef}
        tabIndex={0}
        role="region"
        aria-label="Cloud agent execution output"
        className="bg-background min-h-0 flex-1 overflow-auto overscroll-contain rounded-md border px-4 py-3 text-sm max-sm:[&_pre]:break-all max-sm:[&_pre]:whitespace-pre-wrap sm:px-6"
        onScroll={event => {
          const element = event.currentTarget;
          autoScroll.current = element.scrollHeight - element.scrollTop - element.clientHeight < 20;
        }}
      >
        {error && (
          <p role="alert" className="text-destructive mb-2">
            {isAccessError(error)
              ? 'Execution logs are unavailable or you do not have access to this run.'
              : 'Failed to load execution logs. Try refreshing logs.'}
          </p>
        )}
        {isLoading ? (
          <p role="status" className="text-muted-foreground flex items-center gap-2">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading execution logs...
          </p>
        ) : !isAccessError(error) && data ? (
          <>
            {hasTranscript && data.transcript ? (
              <div className="mx-auto max-w-3xl break-words">
                <MessageErrorBoundary resetKey={dataUpdatedAt}>
                  {data.transcript.version === 'v2' ? (
                    <SharedSessionTranscript messages={data.transcript.messages} />
                  ) : (
                    data.transcript.messages.map((message, index) => (
                      <LegacyMessageBubble key={`${message.ts}-${index}`} message={message} />
                    ))
                  )}
                </MessageErrorBoundary>
              </div>
            ) : null}
            {errorLogs.length > 0 ? (
              <div className="mx-auto max-w-3xl break-words">
                {errorLogs.map((entry, index) => (
                  <p key={index} role="alert" className="text-destructive mt-3 whitespace-pre-wrap">
                    {entry.message}
                    {entry.content ? `: ${entry.content}` : ''}
                  </p>
                ))}
              </div>
            ) : null}
            {!hasTranscript && errorLogs.length === 0 ? (
              <p role="status" className="text-muted-foreground">
                {isActive
                  ? 'Waiting for cloud agent logs...'
                  : 'No execution logs available for this run.'}
              </p>
            ) : null}
          </>
        ) : !error ? (
          <p role="status" className="text-muted-foreground">
            {isActive
              ? 'Waiting for cloud agent logs...'
              : 'No execution logs available for this run.'}
          </p>
        ) : null}
      </div>
    </section>
  );
}
