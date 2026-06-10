import {
  AutoRoutingClassifierAnalyticsResponseSchema,
  AutoRoutingClassifierModelResponseSchema,
  type AutoRoutingAnalyticsPeriod,
} from '@kilocode/auto-routing-contracts';
import { AUTO_ROUTING_WORKER_URL, INTERNAL_API_SECRET } from '@/lib/config.server';
import * as z from 'zod';

export type AutoRoutingAdminResult<T> = {
  status: number;
  body: T;
};

type ErrorBody = { error: string };
const ErrorBodySchema = z.object({ error: z.string() });

type AutoRoutingAdminRequestInit = Omit<RequestInit, 'headers'> & {
  headers?: Record<string, string>;
};

async function fetchAutoRoutingAdmin<T>(
  path: string,
  init: AutoRoutingAdminRequestInit,
  schema: z.ZodType<T>
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
      ...init.headers,
    },
  });

  const body: unknown = await response.json();
  if (!response.ok) {
    const parsedError = ErrorBodySchema.safeParse(body);
    return {
      status: response.status,
      body: parsedError.success
        ? parsedError.data
        : { error: `Request failed: ${response.status}` },
    };
  }

  return {
    status: response.status,
    body: schema.parse(body),
  };
}

export function getAutoRoutingClassifierModel() {
  return fetchAutoRoutingAdmin(
    '/admin/classifier-model',
    {
      method: 'GET',
    },
    AutoRoutingClassifierModelResponseSchema
  );
}

export function updateAutoRoutingClassifierModel(model: string) {
  return fetchAutoRoutingAdmin(
    '/admin/classifier-model',
    {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model }),
    },
    AutoRoutingClassifierModelResponseSchema
  );
}

export function getAutoRoutingClassifierAnalytics(period: AutoRoutingAnalyticsPeriod) {
  return fetchAutoRoutingAdmin(
    `/admin/classifier-analytics?period=${period}`,
    {
      method: 'GET',
    },
    AutoRoutingClassifierAnalyticsResponseSchema
  );
}
