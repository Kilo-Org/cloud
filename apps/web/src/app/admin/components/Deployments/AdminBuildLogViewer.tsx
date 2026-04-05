'use client';

import { useEffect, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { format } from 'date-fns';
import { Loader2, AlertCircle } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useTRPC } from '@/lib/trpc/utils';

type BuildEvent = {
  id: number;
  ts: string;
  type: string;
  payload?: unknown;
};

type BuildEventPayload = {
  message?: string;
  status?: string;
};

function formatEventMessage(event: BuildEvent): string {
  const payload = event.payload as BuildEventPayload | null;

  if (event.type === 'status_change') {
    return `Status changed to: ${payload?.status ?? 'unknown'}`;
  }

  return payload?.message || '';
}

function isErrorMessage(message: string): boolean {
  const lowerMessage = message.toLowerCase();
  return (
    lowerMessage.includes('error') ||
    lowerMessage.includes('failed') ||
    lowerMessage.includes('fatal')
  );
}

export function AdminBuildLogViewer({ buildId }: { buildId: string }) {
  const trpc = useTRPC();
  const scrollRef = useRef<HTMLPreElement>(null);

  const {
    data: eventsData,
    isLoading,
    error,
  } = useQuery({
    ...trpc.admin.deployments.getBuildEvents.queryOptions({
      buildId,
      limit: 2000,
    }),
  });

  const events = eventsData?.events ?? [];

  // Auto-scroll to bottom when events load
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [events]);

  if (error) {
    return (
      <LogContainer>
        <div className="flex items-center gap-2 text-red-400">
          <AlertCircle className="size-5" />
          <span>Failed to load logs: {error.message}</span>
        </div>
      </LogContainer>
    );
  }

  if (isLoading) {
    return (
      <LogContainer>
        <div className="flex items-center gap-2 text-gray-400">
          <Loader2 className="size-5 animate-spin" />
          <span>Loading logs...</span>
        </div>
      </LogContainer>
    );
  }

  if (events.length === 0) {
    return (
      <LogContainer>
        <p className="text-gray-500">No logs available</p>
      </LogContainer>
    );
  }

  return (
    <div className="relative">
      <pre
        ref={scrollRef}
        className="max-h-96 overflow-auto rounded-lg bg-gray-950 p-4 font-mono text-sm break-words whitespace-pre-wrap text-gray-300"
      >
        {events.map(event => (
          <LogLine key={event.id} event={event} />
        ))}
      </pre>
    </div>
  );
}

function LogContainer({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-center rounded-lg bg-gray-950 p-8">{children}</div>
  );
}

function LogLine({ event }: { event: BuildEvent }) {
  const message = formatEventMessage(event);
  const isStatusChange = event.type === 'status_change';
  const isError = isErrorMessage(message);
  const timestamp = format(new Date(event.ts), 'HH:mm:ss');

  return (
    <div className={cn(isError && 'text-red-400', isStatusChange && 'font-semibold text-blue-400')}>
      <span className="font-mono font-normal text-gray-500">{timestamp}</span>
      <span className="ml-2">{message}</span>
    </div>
  );
}
