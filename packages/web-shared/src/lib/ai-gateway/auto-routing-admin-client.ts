import {
  AutoRoutingClassifierAnalyticsResponseSchema,
  AutoRoutingClassifierModelResponseSchema,
  AutoRoutingModeResponseSchema,
  type AutoRoutingModeOwnerQuery,
  type UpdateAutoRoutingModeRequest,
  type AutoRoutingAnalyticsPeriod,
} from '@kilocode/auto-routing-contracts';
import { AUTO_ROUTING_WORKER_URL } from '@kilocode/web-shared/lib/config.server';
import { createWorkerAdminFetch } from './worker-admin-fetch';

/**
 * Only the web app calls these. Its installed sender (`auto-routing-sender.ts`,
 * `AUTO_ROUTING_ADMIN_SENDER_AUTH`) picks the credential: the internal secret, or an
 * `auto-routing:admin.read` (GET) or `auto-routing:admin.write` (PUT) STS token.
 */
const fetchAutoRoutingAdmin = createWorkerAdminFetch({
  workerUrl: AUTO_ROUTING_WORKER_URL,
  unconfiguredError: 'Auto routing worker is not configured',
});

export function getAutoRoutingClassifierModel() {
  return fetchAutoRoutingAdmin(
    'adminRead',
    '/admin/classifier-model',
    {
      method: 'GET',
    },
    AutoRoutingClassifierModelResponseSchema
  );
}

export function updateAutoRoutingClassifierModel(model: string | null) {
  return fetchAutoRoutingAdmin(
    'adminWrite',
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
    'adminRead',
    `/admin/classifier-analytics?period=${period}`,
    {
      method: 'GET',
    },
    AutoRoutingClassifierAnalyticsResponseSchema
  );
}

export function getAutoRoutingMode(owner: AutoRoutingModeOwnerQuery) {
  const searchParams = new URLSearchParams(owner);
  return fetchAutoRoutingAdmin(
    'adminRead',
    `/admin/routing-mode?${searchParams}`,
    {
      method: 'GET',
    },
    AutoRoutingModeResponseSchema
  );
}

export function updateAutoRoutingMode(owner: UpdateAutoRoutingModeRequest) {
  return fetchAutoRoutingAdmin(
    'adminWrite',
    '/admin/routing-mode',
    {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(owner),
    },
    AutoRoutingModeResponseSchema
  );
}
