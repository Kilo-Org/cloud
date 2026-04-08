'use client';

import { useQuery } from '@tanstack/react-query';

export type ControllerTelemetryRow = {
  timestamp: string;
  sandbox_id: string;
  machine_id: string;
  disk_used_bytes: number;
  disk_total_bytes: number;
};

type ControllerTelemetryResponse = {
  data: ControllerTelemetryRow[];
};

export function useControllerTelemetryDiskUsage(sandboxId: string) {
  return useQuery<ControllerTelemetryResponse>({
    queryKey: ['kiloclaw-controller-telemetry', 'disk-usage', sandboxId],
    queryFn: async () => {
      const response = await fetch(
        `/admin/api/kiloclaw-controller-telemetry?sandboxId=${encodeURIComponent(sandboxId)}`
      );
      if (!response.ok) {
        throw new Error('Failed to fetch controller telemetry disk usage');
      }
      return response.json() as Promise<ControllerTelemetryResponse>;
    },
    enabled: !!sandboxId,
    staleTime: 60_000,
  });
}
