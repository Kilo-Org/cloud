import { AUTO_ROUTING_WORKER_URL, INTERNAL_API_SECRET } from '@/lib/config.server';
import type {
  AutoRoutingAnalyticsPeriod,
  AutoRoutingClassifierAnalyticsResponse,
  AutoRoutingClassifierModelResponse,
} from './auto-routing-admin-types';

export type AutoRoutingAdminResult<T> = {
  status: number;
  body: T;
};

type ErrorBody = { error: string };

async function fetchAutoRoutingAdmin<T>(
  path: string,
  init: RequestInit
): Promise<AutoRoutingAdminResult<T | ErrorBody>> {
  if (!AUTO_ROUTING_WORKER_URL || !INTERNAL_API_SECRET) {
    return {
      status: 500,
      body: { error: 'Auto routing worker is not configured' },
    };
  }

  const response = await fetch(`${AUTO_ROUTING_WORKER_URL}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${INTERNAL_API_SECRET}`,
      ...(init.headers as Record<string, string> | undefined),
    },
  });

  return {
    status: response.status,
    body: (await response.json()) as T | ErrorBody,
  };
}

export function getAutoRoutingClassifierModel() {
  return fetchAutoRoutingAdmin<AutoRoutingClassifierModelResponse>('/admin/classifier-model', {
    method: 'GET',
  });
}

export function updateAutoRoutingClassifierModel(model: string) {
  return fetchAutoRoutingAdmin<AutoRoutingClassifierModelResponse>('/admin/classifier-model', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model }),
  });
}

export function getAutoRoutingClassifierAnalytics(period: AutoRoutingAnalyticsPeriod) {
  return fetchAutoRoutingAdmin<AutoRoutingClassifierAnalyticsResponse>(
    `/admin/classifier-analytics?period=${period}`,
    {
      method: 'GET',
    }
  );
}
