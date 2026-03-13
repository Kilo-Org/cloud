'use client';

import { useQuery } from '@tanstack/react-query';

export type OverviewData = {
  total_events: number;
  unique_users: number;
  avg_latency_ms: number;
  error_count: number;
};

export type EventTimeseriesRow = {
  hour: string;
  event: string;
  count: number;
};

export type ErrorRateRow = {
  event: string;
  total: number;
  success_count: number;
  error_count: number;
};

export type TopUserRow = {
  user_id: string;
  total_events: number;
  error_count: number;
  avg_latency_ms: number;
};

export type LatencyRow = {
  event: string;
  delivery: string;
  avg_latency_ms: number;
  count: number;
};

export type DeliveryBreakdownRow = {
  hour: string;
  delivery: string;
  count: number;
};

type AnalyticsEngineResponse<T> = {
  data: T[];
  meta: { name: string; type: string }[];
  rows: number;
};

type QueryType =
  | 'overview'
  | 'events-timeseries'
  | 'error-rates'
  | 'top-users'
  | 'latency-by-event'
  | 'delivery-breakdown';

function useGastownQuery<T>(queryType: QueryType, hours: number) {
  return useQuery<AnalyticsEngineResponse<T>>({
    queryKey: ['gastown-analytics', queryType, hours],
    queryFn: async () => {
      const response = await fetch(
        `/admin/api/gastown-analytics?query=${queryType}&hours=${hours}`
      );
      if (!response.ok) {
        throw new Error(`Failed to fetch gastown analytics: ${queryType}`);
      }
      return response.json() as Promise<AnalyticsEngineResponse<T>>;
    },
    refetchInterval: 60000,
  });
}

export function useGastownOverview(hours = 24) {
  return useGastownQuery<OverviewData>('overview', hours);
}

export function useGastownEventsTimeseries(hours = 24) {
  return useGastownQuery<EventTimeseriesRow>('events-timeseries', hours);
}

export function useGastownErrorRates(hours = 24) {
  return useGastownQuery<ErrorRateRow>('error-rates', hours);
}

export function useGastownTopUsers(hours = 24) {
  return useGastownQuery<TopUserRow>('top-users', hours);
}

export function useGastownLatencyByEvent(hours = 24) {
  return useGastownQuery<LatencyRow>('latency-by-event', hours);
}

export function useGastownDeliveryBreakdown(hours = 24) {
  return useGastownQuery<DeliveryBreakdownRow>('delivery-breakdown', hours);
}
