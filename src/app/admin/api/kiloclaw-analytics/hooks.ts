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

export type KiloclawAllEventRow = KiloclawEventRow & {
  user_id: string;
  sandbox_id: string;
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

type AllEventsParams = {
  sandboxId: string;
  userId: string;
  flyAppName?: string | null;
  flyMachineId?: string | null;
  offset: number;
};

export function useKiloclawAllEvents(params: AllEventsParams) {
  const { sandboxId, userId, flyAppName, flyMachineId, offset } = params;
  return useQuery<AnalyticsEngineResponse<KiloclawAllEventRow>>({
    queryKey: [
      'kiloclaw-analytics',
      'all-events',
      sandboxId,
      userId,
      flyAppName,
      flyMachineId,
      offset,
    ],
    queryFn: async () => {
      const searchParams = new URLSearchParams({
        query: 'all-events',
        sandboxId,
        userId,
        offset: String(offset),
      });
      if (flyAppName) searchParams.set('flyAppName', flyAppName);
      if (flyMachineId) searchParams.set('flyMachineId', flyMachineId);
      const response = await fetch(`/admin/api/kiloclaw-analytics?${searchParams.toString()}`);
      if (!response.ok) {
        throw new Error('Failed to fetch kiloclaw all events');
      }
      return response.json() as Promise<AnalyticsEngineResponse<KiloclawAllEventRow>>;
    },
    enabled: !!sandboxId && !!userId,
  });
}
