'use client';

import { useEffect, useRef, useState } from 'react';
import { Loader2, AlertCircle } from 'lucide-react';
import { format } from 'date-fns';
import { cn } from '@/lib/utils';
import { useDeploymentQueries } from '@/components/deployments/DeploymentContext';
import { isDeploymentInProgress, type BuildStatus, type Event } from '@/lib/user-deployments/types';

type BuildLogViewerProps = {
  deploymentId: string;
  buildId: string;
  status: BuildStatus;
  className?: string;
};

export function BuildLogViewer({ deploymentId, buildId, status, className }: BuildLogViewerProps) {
  const scrollRef = useRef<HTMLPreElement>(null);
  const { queries } = useDeploymentQueries();
  const [allEvents, setAllEvents] = useState<Event[]>([]);
  const [latestEventId, setLatestEventId] = useState<number | undefined>(undefined);
  const prevBuildIdRef = useRef(buildId);

  // Determine if build is active
  const isActiveBuild = isDeploymentInProgress(status);

  // Reset state when component mounts or buildId changes
  useEffect(() => {
    setAllEvents([]);
    setLatestEventId(undefined);
    prevBuildIdRef.current = buildId;
  }, [buildId]);

  const {
    data: partialEvents,
    isLoading,
    error,
  } = queries.getBuildEvents({
    deploymentId,
    buildId,
    limit: 1000,
    afterEventId: latestEventId,
    status,
  });

  // Update allEvents when new events arrive
  useEffect(() => {
    if (!partialEvents || partialEvents.length === 0) return;
    setAllEvents(prev => [...prev, ...partialEvents]);
    setLatestEventId(partialEvents[partialEvents.length - 1].id);
  }, [partialEvents]);

  // Auto-scroll to bottom when allEvents change
  useEffect(() => {
    if (!scrollRef.current) return;

    scrollRef.current.scrollTo({
      top: scrollRef.current.scrollHeight,
    });
  }, [allEvents]);

  if (error) {
    return (
      <div className={cn('flex items-center justify-center rounded-lg bg-gray-950 p-8', className)}>
        <div className="flex items-center gap-2 text-red-400">
          <AlertCircle className="size-5" />
          <span>Failed to load logs: {error.message}</span>
        </div>
      </div>
    );
  }

  if (allEvents.length === 0) {
    if (isDeploymentInProgress(status)) {
      return (
        <div
          className={cn('flex items-center justify-center rounded-lg bg-gray-950 p-8', className)}
        >
          <div className="flex items-center gap-2 text-gray-400">
            <Loader2 className="size-5 animate-spin" />
            <span>Build in progress...</span>
          </div>
        </div>
      );
    }

    if (isLoading) {
      return (
        <div
          className={cn('flex items-center justify-center rounded-lg bg-gray-950 p-8', className)}
        >
          <div className="flex items-center gap-2 text-gray-400">
            <Loader2 className="size-5 animate-spin" />
            <span>Loading logs...</span>
          </div>
        </div>
      );
    }

    return (
      <div className={cn('flex items-center justify-center rounded-lg bg-gray-950 p-8', className)}>
        <p className="text-gray-500">No logs available</p>
      </div>
    );
  }

  return (
    <div className="relative overflow-hidden">
      {isActiveBuild && (
        <div className="absolute top-4 right-4 z-10 flex items-center gap-2 rounded-md bg-gray-900/90 px-3 py-1.5 text-xs text-gray-400 backdrop-blur-sm">
          <Loader2 className="size-3 animate-spin" />
          <span>Build in progress...</span>
        </div>
      )}
      <pre
        ref={scrollRef}
        className={cn(
          'max-h-96 min-w-0 overflow-auto rounded-lg bg-gray-950 p-4 font-mono text-sm break-all whitespace-pre-wrap text-gray-300',
          className
        )}
      >
        {allEvents.map(event => {
          const isStatusChange = event.type === 'status_change';

          // Generate message for status change events
          const message = isStatusChange
            ? `Status changed to: ${event.payload.status}`
            : event.payload.message || '';

          const isError =
            message.toLowerCase().includes('error') ||
            message.toLowerCase().includes('failed') ||
            message.toLowerCase().includes('fatal');

          // Format timestamp
          const timestamp = format(new Date(event.ts), 'HH:mm:ss');

          return (
            <div
              key={event.id}
              className={cn(
                isError && 'text-red-400',
                isStatusChange && 'font-semibold text-blue-400'
              )}
            >
              <span className="font-mono font-normal text-gray-500">{timestamp}</span>
              <span className="ml-2">{message}</span>
            </div>
          );
        })}
      </pre>
    </div>
  );
}
