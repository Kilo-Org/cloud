'use client';

import { useMemo } from 'react';
import { useQueries } from '@tanstack/react-query';
import { format, subMinutes } from 'date-fns';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { cn } from '@/lib/utils';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';

type ModelHealthMetrics = {
  healthy: boolean;
  monitored: boolean;
  currentRequests: number;
  previousRequests: number;
  baselineRequests: number;
  percentChange: number;
  absoluteDrop: number;
  uniqueUsersCurrent: number;
  uniqueUsersBaseline: number;
};

type HealthSnapshot = {
  healthy: boolean;
  models: Record<string, ModelHealthMetrics>;
  metadata: {
    timestamp: string;
    queryExecutionTimeMs: number;
  };
};

const SNAPSHOT_INTERVAL_MINUTES = 30;
const SNAPSHOT_COUNT = 25; // now + 24 historical (12 hours)

function buildTimestamps(now: Date): string[] {
  const timestamps: string[] = [];
  for (let i = 0; i < SNAPSHOT_COUNT; i++) {
    timestamps.push(subMinutes(now, i * SNAPSHOT_INTERVAL_MINUTES).toISOString());
  }
  return timestamps;
}

async function fetchSnapshot(at: string | null): Promise<HealthSnapshot> {
  const url = new URL('/api/models/up', window.location.origin);
  url.searchParams.set('key', 'kilo-models-health-check');
  if (at) {
    url.searchParams.set('at', at);
  }
  const res = await fetch(url.toString());
  return res.json();
}

function StatusDot({
  metrics,
  timestamp,
}: {
  metrics: ModelHealthMetrics | undefined;
  timestamp: string;
}) {
  if (!metrics) {
    return (
      <TooltipProvider delayDuration={100}>
        <Tooltip>
          <TooltipTrigger asChild>
            <div className="flex justify-center">
              <div className="size-3 rounded-full border border-dashed border-gray-400" />
            </div>
          </TooltipTrigger>
          <TooltipContent side="top" className="text-xs">
            <div className="space-y-0.5">
              <div className="font-medium">{format(new Date(timestamp), 'HH:mm')}</div>
              <div>No data (query failed)</div>
            </div>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  }

  const noTraffic = metrics.currentRequests === 0 && metrics.baselineRequests === 0;
  const color = noTraffic ? 'bg-gray-400' : metrics.healthy ? 'bg-green-500' : 'bg-red-500';

  const time = format(new Date(timestamp), 'HH:mm');

  return (
    <TooltipProvider delayDuration={100}>
      <Tooltip>
        <TooltipTrigger asChild>
          <div className="flex justify-center">
            <div className={cn('size-3 rounded-full', color)} />
          </div>
        </TooltipTrigger>
        <TooltipContent side="top" className="text-xs">
          <div className="space-y-0.5">
            <div className="font-medium">{time}</div>
            {noTraffic ? (
              <div>No traffic in this window</div>
            ) : (
              <>
                <div>Current: {metrics.currentRequests} reqs</div>
                <div>Baseline: {metrics.baselineRequests} reqs</div>
                <div>Change: {metrics.percentChange}%</div>
                <div>Users (current): {metrics.uniqueUsersCurrent}</div>
              </>
            )}
          </div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

export function ModelStatusContent() {
  const now = useMemo(() => new Date(), []);
  const timestamps = useMemo(() => buildTimestamps(now), [now]);

  const queries = useQueries({
    queries: timestamps.map((ts, i) => ({
      queryKey: ['model-status', ts],
      queryFn: () => fetchSnapshot(i === 0 ? null : ts),
      staleTime: i === 0 ? 60_000 : Infinity,
      retry: 1,
    })),
  });

  const { monitoredModels, nonMonitoredModels } = useMemo(() => {
    const monitored = new Set<string>();
    const nonMonitored = new Set<string>();
    for (const q of queries) {
      if (q.data?.models) {
        for (const [model, metrics] of Object.entries(q.data.models)) {
          if (metrics.monitored === false) {
            nonMonitored.add(model);
          } else {
            monitored.add(model);
          }
        }
      }
    }
    return {
      monitoredModels: [...monitored].sort(),
      nonMonitoredModels: [...nonMonitored].sort(),
    };
  }, [queries]);

  const isLoading = queries.some(q => q.isLoading);
  const anyError = queries.some(q => q.isError);

  // Reversed so oldest is first (left to right = past to present)
  const snapshotsReversed = [...timestamps].reverse();
  const queriesReversed = [...queries].reverse();

  return (
    <div className="flex w-full flex-col gap-y-4">
      <p className="text-muted-foreground">
        Model health status over the last 12 hours, sampled every 30 minutes. Each dot shows whether
        the model had healthy traffic at that point in time.
      </p>

      <div className="flex items-center gap-4 text-sm">
        <div className="flex items-center gap-1.5">
          <div className="size-3 rounded-full bg-green-500" />
          <span className="text-muted-foreground">Healthy</span>
        </div>
        <div className="flex items-center gap-1.5">
          <div className="size-3 rounded-full bg-red-500" />
          <span className="text-muted-foreground">Unhealthy</span>
        </div>
        <div className="flex items-center gap-1.5">
          <div className="size-3 rounded-full bg-gray-400" />
          <span className="text-muted-foreground">No traffic</span>
        </div>
        <div className="flex items-center gap-1.5">
          <div className="size-3 rounded-full border border-dashed border-gray-400" />
          <span className="text-muted-foreground">No data</span>
        </div>
      </div>

      {anyError && (
        <p className="text-sm text-red-500">
          Some snapshots failed to load. Partial data is shown.
        </p>
      )}

      {isLoading ? (
        <div className="text-muted-foreground py-8 text-center">Loading model status...</div>
      ) : monitoredModels.length === 0 && nonMonitoredModels.length === 0 ? (
        <div className="text-muted-foreground py-8 text-center">No monitored models found.</div>
      ) : (
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="sticky left-0 z-10 bg-background min-w-[200px]">
                  Model
                </TableHead>
                {snapshotsReversed.map(ts => (
                  <TableHead key={ts} className="text-center min-w-[50px] px-1">
                    <span className="text-xs">{format(new Date(ts), 'HH:mm')}</span>
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {monitoredModels.map(model => (
                <TableRow key={model}>
                  <TableCell className="sticky left-0 z-10 bg-background font-mono text-xs">
                    {model}
                  </TableCell>
                  {queriesReversed.map((q, i) => (
                    <TableCell key={snapshotsReversed[i]} className="px-1">
                      <StatusDot metrics={q.data?.models[model]} timestamp={snapshotsReversed[i]} />
                    </TableCell>
                  ))}
                </TableRow>
              ))}

              {nonMonitoredModels.length > 0 && (
                <>
                  <TableRow>
                    <TableCell
                      colSpan={snapshotsReversed.length + 1}
                      className="sticky left-0 z-10 bg-background pt-6 pb-2"
                    >
                      <div className="flex items-center gap-2">
                        <span className="text-muted-foreground text-sm font-medium">
                          Non-Monitored
                        </span>
                        <span className="text-muted-foreground/60 text-xs">
                          Traffic data shown but excluded from health alerting
                        </span>
                      </div>
                    </TableCell>
                  </TableRow>
                  {nonMonitoredModels.map(model => (
                    <TableRow key={model} className="opacity-75">
                      <TableCell className="sticky left-0 z-10 bg-background font-mono text-xs">
                        {model}
                      </TableCell>
                      {queriesReversed.map((q, i) => (
                        <TableCell key={snapshotsReversed[i]} className="px-1">
                          <StatusDot
                            metrics={q.data?.models[model]}
                            timestamp={snapshotsReversed[i]}
                          />
                        </TableCell>
                      ))}
                    </TableRow>
                  ))}
                </>
              )}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
