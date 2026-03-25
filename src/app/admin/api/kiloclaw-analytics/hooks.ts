'use client';

import { useQuery } from '@tanstack/react-query';

export type KiloclawEventRow = {
  timestamp: string;
  event: string;
  delivery: string;
  route: string;
  error: string;
  fly_app_name: string;
  fly_machine_id: string;
  status: string;
  openclaw_version: string;
  image_tag: string;
  fly_region: string;
  label: string;
  duration_ms: number;
  value: number;
};

type AnalyticsEngineResponse<T> = {
  data: T[];
  meta: { name: string; type: string }[];
  rows: number;
};

export function useKiloclawInstanceEvents(sandboxId: string) {
  return useQuery<AnalyticsEngineResponse<KiloclawEventRow>>({
    queryKey: ['kiloclaw-analytics', 'instance-events', sandboxId],
    queryFn: async () => {
      const response = await fetch(
        `/admin/api/kiloclaw-analytics?query=instance-events&sandboxId=${encodeURIComponent(sandboxId)}`
      );
      if (!response.ok) {
        throw new Error('Failed to fetch kiloclaw instance events');
      }
      return response.json() as Promise<AnalyticsEngineResponse<KiloclawEventRow>>;
    },
    enabled: !!sandboxId,
    refetchInterval: 60000,
  });
}
