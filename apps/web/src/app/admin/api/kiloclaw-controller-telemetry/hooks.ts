'use client';

import { useQuery } from '@tanstack/react-query';

export type ControllerTelemetryRow = {
  timestamp: string;
  sandbox_id: string;
  machine_id: string;
  disk_used_bytes: number;
  disk_total_bytes: number;
};

type AnalyticsEngineResponse<T> = {
  data: T[];
  meta: { name: string; type: string }[];
  rows: number;
};

export function useControllerTelemetryDiskUsage(sandboxId: string) {
  return useQuery<AnalyticsEngineResponse<ControllerTelemetryRow>>({
    queryKey: ['kiloclaw-controller-telemetry', 'disk-usage', sandboxId],
    queryFn: async () => {
      const response = await fetch(
        `/admin/api/kiloclaw-controller-telemetry?sandboxId=${encodeURIComponent(sandboxId)}`
      );
      if (!response.ok) {
        throw new Error('Failed to fetch controller telemetry disk usage');
      }
      return response.json() as Promise<AnalyticsEngineResponse<ControllerTelemetryRow>>;
    },
    enabled: !!sandboxId,
    refetchInterval: 60_000,
  });
}
