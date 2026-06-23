import {
  AutoRoutingClassifierAnalyticsResponseSchema,
  AutoRoutingClassifierModelResponseSchema,
  AutoRoutingModeResponseSchema,
  type AutoRoutingMode,
  type AutoRoutingModeOwnerType,
  type AutoRoutingAnalyticsPeriod,
} from '@kilocode/auto-routing-contracts';
import { AUTO_ROUTING_WORKER_URL } from '@/lib/config.server';
import { createWorkerAdminFetch } from './worker-admin-fetch';

const fetchAutoRoutingAdmin = createWorkerAdminFetch({
  workerUrl: AUTO_ROUTING_WORKER_URL,
  unconfiguredError: 'Auto routing worker is not configured',
});

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
