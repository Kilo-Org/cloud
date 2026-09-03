'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Box,
  ChevronRight,
  Circle,
  CircleQuestionMark,
  Clock3,
  Moon,
  Power,
  PowerOff,
  TriangleAlert,
  Unplug,
  type LucideIcon,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useTRPC } from '@/lib/trpc/utils';
import { cn } from '@/lib/utils';
import {
  SANDBOX_STATUS_POLL_INTERVAL_MS,
  sandboxStatusPresentation,
  type SandboxStatusPresentation,
} from './sandbox-status';

const statusBadgeIcons = {
  active: Circle,
  sleeping: Moon,
  'sleeping-soon': Clock3,
  starting: Power,
  stopping: PowerOff,
  error: TriangleAlert,
  unreachable: Unplug,
  unknown: CircleQuestionMark,
} satisfies Record<SandboxStatusPresentation['status'], LucideIcon>;

function SandboxStatusDetails({ view }: { view: SandboxStatusPresentation }) {
  const hasLifecycleDates = view.startedAt !== null || view.stoppedAt !== null;
  const hasTiming = hasLifecycleDates || view.estimatedSleepAt !== null;

  return (
    <div className="space-y-3 text-xs">
      <div className="space-y-1.5">
        <div className="text-foreground flex items-baseline justify-between gap-4 font-medium">
          <span>Sandbox</span>
          <span>{view.label}</span>
        </div>
        {view.status !== 'active' && <p className="text-muted-foreground">{view.detail}</p>}
      </div>
      <section className="space-y-2 border-t pt-3">
        <h3 className="text-foreground font-medium">Runtime</h3>
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] items-baseline gap-x-4 gap-y-1.5">
          <dt className="text-muted-foreground">Provider</dt>
          <dd className="text-right">{view.provider}</dd>
          <dt className="text-muted-foreground">Sandbox type</dt>
          <dd className="text-right">{view.sandboxType}</dd>
        </dl>
      </section>
      {hasTiming && (
        <section className="space-y-2 border-t pt-3">
          <div className="flex items-baseline justify-between gap-4">
            <h3 className="text-foreground font-medium">Timing</h3>
            {hasLifecycleDates && <span className="text-muted-foreground">Local time</span>}
          </div>
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] items-baseline gap-x-4 gap-y-1.5">
            {view.startedAt !== null && (
              <>
                <dt className="text-muted-foreground">Started</dt>
                <dd className="text-right tabular-nums">
                  <time dateTime={new Date(view.startedAt).toISOString()}>
                    {new Date(view.startedAt).toLocaleString([], {
                      dateStyle: 'medium',
                      timeStyle: 'short',
                    })}
                  </time>
                </dd>
              </>
            )}
            {view.stoppedAt !== null && (
              <>
                <dt className="text-muted-foreground">Stopped</dt>
                <dd className="text-right tabular-nums">
                  <time dateTime={new Date(view.stoppedAt).toISOString()}>
                    {new Date(view.stoppedAt).toLocaleString([], {
                      dateStyle: 'medium',
                      timeStyle: 'short',
                    })}
                  </time>
                </dd>
              </>
            )}
            {view.estimatedSleepAt !== null && (
              <>
                <dt className="text-muted-foreground">Sleeps in</dt>
                <dd className="text-right tabular-nums">
                  <time dateTime={new Date(view.estimatedSleepAt).toISOString()}>
                    About {view.sleepMinutesRemaining} min if inactive
                  </time>
                </dd>
              </>
            )}
          </dl>
        </section>
      )}
    </div>
  );
}

export function SandboxStatusIndicator({
  cloudAgentSessionId,
  organizationId,
  sessionActive,
}: {
  cloudAgentSessionId: string;
  organizationId?: string;
  sessionActive: boolean;
}) {
  const trpc = useTRPC();
  const [observation, setObservation] = useState({
    enabled: false,
    initialized: false,
    freshAfter: 0,
  });
  const [clock, setClock] = useState(0);
  const [activity, setActivity] = useState({ active: sessionActive, changedAt: 0 });
  const [popoverOpen, setPopoverOpen] = useState(false);
  const [tooltipOpen, setTooltipOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const detailsId = useId();

  if (activity.active !== sessionActive) {
    setActivity({ active: sessionActive, changedAt: Date.now() });
  }

  useEffect(() => {
    const update = () => {
      setObservation({
        enabled: document.visibilityState === 'visible' && navigator.onLine,
        initialized: true,
        freshAfter: Date.now(),
      });
    };
    update();
    document.addEventListener('visibilitychange', update);
    window.addEventListener('offline', update);
    window.addEventListener('online', update);
    return () => {
      document.removeEventListener('visibilitychange', update);
      window.removeEventListener('offline', update);
      window.removeEventListener('online', update);
    };
  }, []);

  const query = useQuery({
    ...(organizationId
      ? trpc.organizations.cloudAgentNext.getSandboxStatus.queryOptions({
          organizationId,
          cloudAgentSessionId,
        })
      : trpc.cloudAgentNext.getSandboxStatus.queryOptions({ cloudAgentSessionId })),
    enabled: observation.enabled,
    refetchInterval: observation.enabled ? SANDBOX_STATUS_POLL_INTERVAL_MS : false,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: 'always',
    refetchOnReconnect: 'always',
    refetchOnMount: 'always',
    staleTime: 0,
    gcTime: 0,
    retry: false,
    throwOnError: false,
    placeholderData: undefined,
  });

  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState === 'visible' && navigator.onLine) {
        void query.refetch({ cancelRefetch: false });
      }
    };
    window.addEventListener('focus', refresh);
    return () => window.removeEventListener('focus', refresh);
  }, [query.refetch]);

  const now = Math.max(clock, Date.now());
  const view = sandboxStatusPresentation({
    data: query.data,
    observation: !observation.initialized
      ? 'checking'
      : !observation.enabled || query.fetchStatus === 'paused'
        ? 'paused'
        : query.isError
          ? 'unavailable'
          : !query.isFetchedAfterMount || query.isPending
            ? 'checking'
            : 'observing',
    dataUpdatedAt: query.dataUpdatedAt,
    freshAfter: observation.freshAfter,
    estimateAfter: activity.changedAt,
    sessionActive,
    now,
  });

  useEffect(() => {
    const deadline = view.nextChangeAt;
    if (deadline === null) return;
    const timer = setTimeout(
      () => setClock(current => Math.max(current, deadline, Date.now())),
      Math.max(0, deadline - Date.now())
    );
    return () => clearTimeout(timer);
  }, [view.nextChangeAt]);

  const StatusBadgeIcon = statusBadgeIcons[view.status];

  return (
    <Popover
      open={popoverOpen}
      onOpenChange={open => {
        setTooltipOpen(false);
        setPopoverOpen(open);
      }}
    >
      <Tooltip open={tooltipOpen && !popoverOpen} onOpenChange={setTooltipOpen}>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button
              ref={triggerRef}
              type="button"
              variant="ghost"
              size="icon"
              className="text-muted-foreground size-11 min-h-11 min-w-11 shrink-0"
              aria-label={`Sandbox status: ${view.label}`}
              {...(popoverOpen ? { 'aria-describedby': detailsId } : {})}
            >
              <span className="relative size-6">
                <Box aria-hidden="true" className="size-5" />
                <span className="bg-background absolute right-0 bottom-0 flex size-3.5 items-center justify-center rounded-full">
                  <StatusBadgeIcon
                    aria-hidden="true"
                    className={cn(
                      'size-3',
                      view.status === 'active' && 'text-status-success-icon size-1.5 fill-current',
                      view.status === 'error' && 'text-status-destructive-icon',
                      (view.status === 'sleeping-soon' ||
                        view.status === 'starting' ||
                        view.status === 'stopping' ||
                        view.status === 'unreachable') &&
                        'text-status-warning-icon'
                    )}
                  />
                </span>
              </span>
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        {!popoverOpen && (
          <TooltipContent
            side="bottom"
            align="end"
            className="w-80 max-w-[calc(100vw-2rem)] p-4 text-left"
          >
            <SandboxStatusDetails view={view} />
          </TooltipContent>
        )}
      </Tooltip>
      {popoverOpen && (
        <PopoverContent
          side="bottom"
          align="end"
          className="w-80 max-w-[calc(100vw-2rem)] p-4"
          aria-label="Sandbox status details"
          onEscapeKeyDown={() => triggerRef.current?.focus()}
          onKeyDown={event => {
            if (
              event.key === 'Tab' &&
              !event.altKey &&
              !event.ctrlKey &&
              !event.metaKey &&
              (event.shiftKey || event.target !== event.currentTarget)
            ) {
              triggerRef.current?.focus();
              setPopoverOpen(false);
            }
          }}
        >
          <div id={detailsId}>
            <SandboxStatusDetails view={view} />
          </div>
          <details className="group mt-3 border-t text-xs">
            <summary className="text-muted-foreground hover:text-foreground focus-visible:ring-ring flex min-h-11 cursor-pointer list-none items-center gap-2 rounded-sm outline-none focus-visible:ring-2 [&::-webkit-details-marker]:hidden">
              <ChevronRight aria-hidden="true" className="size-3 group-open:rotate-90" />
              Debug
            </summary>
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] items-baseline gap-x-4 gap-y-1.5">
              <dt className="text-muted-foreground">Execution</dt>
              <dd className="text-right">Control plane</dd>
              <dt className="text-muted-foreground">Kilo CLI</dt>
              <dd className="text-right font-mono wrap-anywhere">
                {view.kiloCliVersion ?? 'Unknown'}
              </dd>
              <dt className="text-muted-foreground">Wrapper</dt>
              <dd className="text-right font-mono wrap-anywhere">
                {view.wrapperVersion ?? 'Unknown'}
              </dd>
            </dl>
          </details>
        </PopoverContent>
      )}
    </Popover>
  );
}
