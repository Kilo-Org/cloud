'use client';

import { useEffect, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { TRPCClientError } from '@trpc/client';
import { Loader2, RefreshCw, Terminal } from 'lucide-react';
import { Button } from '@/components/ui/button';
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
  const { data, error, isLoading, isFetching, refetch } = useQuery({
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

  return (
    <section aria-label="Execution logs" className="min-w-0 space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="flex items-center gap-2 text-sm font-medium">
          <Terminal className="h-4 w-4" />
          Execution Logs
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
        aria-label="Cloud agent execution output"
        className="bg-background max-h-[500px] overflow-auto rounded-md border p-3 font-mono text-xs"
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
        ) : !isAccessError(error) && data?.logs.length ? (
          <div className="space-y-1">
            {data.logs.map((entry, index) => (
              <div key={index} className="rounded px-2 py-1">
                <div className="flex gap-3">
                  <span className="text-muted-foreground shrink-0 tabular-nums">
                    {entry.timestamp
                      ? new Date(entry.timestamp).toLocaleTimeString('en-US', { hour12: false })
                      : '--:--:--'}
                  </span>
                  <span
                    className={`min-w-0 break-all whitespace-pre-wrap ${entry.eventType === 'error' ? 'text-destructive' : ''}`}
                  >
                    {entry.message}
                  </span>
                </div>
                {entry.content && (
                  <div className="text-muted-foreground mt-1 pl-2 break-all whitespace-pre-wrap sm:pl-[84px]">
                    {entry.content}
                  </div>
                )}
              </div>
            ))}
          </div>
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
