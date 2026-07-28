import {
  AutoRoutingClassifierAnalyticsResponseSchema,
  AutoRoutingClassifierModelResponseSchema,
  AutoRoutingModeResponseSchema,
  AutoRoutingSettingsResponseSchema,
  BenchmarkProfileQuotaErrorSchema,
  type AutoRoutingMode,
  type AutoRoutingModeOwnerType,
  type AutoRoutingAnalyticsPeriod,
  type AutoRoutingSettingsResponse,
  type EfficientModelPool,
  type PoolEntry,
} from '@kilocode/auto-routing-contracts';
import { AUTO_ROUTING_WORKER_URL, INTERNAL_API_SECRET } from '@/lib/config.server';
import {
  createWorkerAdminFetch,
  ErrorBodySchema,
  type ErrorBody,
  type WorkerAdminResult,
} from './worker-admin-fetch';
import type { BenchmarkProfileQuotaError } from '@kilocode/auto-routing-contracts';

const fetchAutoRoutingAdmin = createWorkerAdminFetch({
  workerUrl: AUTO_ROUTING_WORKER_URL,
  unconfiguredError: 'Auto routing worker is not configured',
});

export type AutoRoutingSettingsWorkerResult = WorkerAdminResult<
  AutoRoutingSettingsResponse | BenchmarkProfileQuotaError | ErrorBody
>;

export function getAutoRoutingClassifierModel() {
  return fetchAutoRoutingAdmin(
    '/admin/classifier-model',
    {
      method: 'GET',
    },
    AutoRoutingClassifierModelResponseSchema
  );
}

export function updateAutoRoutingClassifierModel(model: string | null) {
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

export function getAutoRoutingMode(owner: {
  ownerType: AutoRoutingModeOwnerType;
  ownerId: string;
}) {
  const searchParams = new URLSearchParams(owner);
  return fetchAutoRoutingAdmin(
    `/admin/routing-mode?${searchParams}`,
    {
      method: 'GET',
    },
    AutoRoutingModeResponseSchema
  );
}

export function updateAutoRoutingMode(owner: {
  ownerType: AutoRoutingModeOwnerType;
  ownerId: string;
  mode: AutoRoutingMode | null;
}) {
  return fetchAutoRoutingAdmin(
    '/admin/routing-mode',
    {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(owner),
    },
    AutoRoutingModeResponseSchema
  );
}

/**
 * Settings fetch preserves 429 quota bodies (`error` + `retryAt`) that the
 * generic worker admin helper would strip to `{ error }` only.
 */
async function fetchAutoRoutingSettingsAdmin(
  path: string,
  init: Omit<RequestInit, 'headers'> & { headers?: Record<string, string> }
): Promise<AutoRoutingSettingsWorkerResult> {
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
    if (response.status === 429) {
      const quota = BenchmarkProfileQuotaErrorSchema.safeParse(body);
      if (quota.success) {
        return { status: 429, body: quota.data };
      }
    }
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
    body: AutoRoutingSettingsResponseSchema.parse(body),
  };
}

export function getAutoRoutingSettings(owner: {
  ownerType: AutoRoutingModeOwnerType;
  ownerId: string;
}): Promise<AutoRoutingSettingsWorkerResult> {
  const searchParams = new URLSearchParams(owner);
  return fetchAutoRoutingSettingsAdmin(`/admin/routing-settings?${searchParams}`, {
    method: 'GET',
  });
}

export function updateAutoRoutingSettings(params: {
  ownerType: AutoRoutingModeOwnerType;
  ownerId: string;
  mode: AutoRoutingMode | null;
  pool: EfficientModelPool | null;
  retryEntries?: PoolEntry[];
}): Promise<AutoRoutingSettingsWorkerResult> {
  const { retryEntries, ...rest } = params;
  return fetchAutoRoutingSettingsAdmin('/admin/routing-settings', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      ...rest,
      ...(retryEntries !== undefined ? { retryEntries } : {}),
    }),
  });
}
