/**
 * Container capacity alerting — domain types and pure threshold evaluation.
 *
 * Discovery results (2026-05-12):
 *  - List endpoint: GET /accounts/{accountId}/containers/dash/applications
 *  - Detail endpoint: GET /accounts/{accountId}/containers/applications/{id}
 *  - `instances` matches the allocation pressure metric (active + healthy + starting sum)
 *  - `max_instances` is only available on the detail response
 */

import { z } from 'zod';
import type { AlertSeverity } from './slo-config';

// ── Domain types ────────────────────────────────────────────────────────────

export type HealthInstances = {
  active: number;
  healthy: number;
  starting: number;
};

export type ContainerApplication = {
  id: string;
  name: string;
  instances: number;
  maxInstances: number;
  health?: { instances: HealthInstances };
};

export type ContainerCapacityAlert = {
  severity: AlertSeverity;
  applicationName: string;
  usedInstances: number;
  maxInstances: number;
  utilizationFraction: number;
  thresholdFraction: number;
  health?: HealthInstances;
};

// ── Thresholds and allowlist ─────────────────────────────────────────────────

export const CONTAINER_CAPACITY_THRESHOLDS = {
  page: 0.95,
  ticket: 0.8,
} as const;

/** Application names to monitor (lowercase, as returned by the Cloudflare API). */
export const MONITORED_CONTAINER_APPS: readonly string[] = [
  'cloud-agent-next-sandbox',
  'cloud-agent-next-sandboxsmall',
];

// ── Zod schemas for the Cloudflare Containers API ───────────────────────────

const HealthInstancesSchema = z.object({
  active: z.number(),
  healthy: z.number(),
  starting: z.number(),
});

/** Shape returned by GET /accounts/{id}/containers/dash/applications */
export const ContainerListAppSchema = z.object({
  id: z.string(),
  name: z.string(),
  instances: z.number(),
  health: z
    .object({
      instances: HealthInstancesSchema,
    })
    .optional(),
});

export type ContainerListApp = z.infer<typeof ContainerListAppSchema>;

export const ContainerListResponseSchema = z.object({
  success: z.boolean(),
  result: z.array(ContainerListAppSchema),
  // The Cloudflare Containers list API may return a result_info object with
  // some or all pagination fields absent, so each field is marked optional.
  result_info: z
    .object({
      page: z.number().optional(),
      per_page: z.number().optional(),
      total_count: z.number().optional(),
      total_pages: z.number().optional(),
    })
    .optional(),
  errors: z.array(z.unknown()).optional(),
  messages: z.array(z.unknown()).optional(),
});

/** Shape returned by GET /accounts/{id}/containers/applications/{appId} */
export const ContainerDetailAppSchema = z.object({
  id: z.string(),
  name: z.string(),
  instances: z.number(),
  max_instances: z.number(),
  health: z
    .object({
      instances: HealthInstancesSchema,
    })
    .optional(),
});

export const ContainerDetailResponseSchema = z.object({
  success: z.boolean(),
  result: ContainerDetailAppSchema,
  errors: z.array(z.unknown()).optional(),
  messages: z.array(z.unknown()).optional(),
});

// ── Pure threshold evaluation ────────────────────────────────────────────────

/**
 * Evaluates container capacity against thresholds for monitored applications.
 *
 * Returns at most one alert per application. Page severity takes precedence
 * over ticket when both thresholds are exceeded.
 */
export function evaluateCapacityThresholds(apps: ContainerApplication[]): ContainerCapacityAlert[] {
  const alerts: ContainerCapacityAlert[] = [];

  for (const app of apps) {
    if (!MONITORED_CONTAINER_APPS.includes(app.name)) continue;
    if (app.maxInstances <= 0) continue;

    const utilization = app.instances / app.maxInstances;

    let severity: AlertSeverity | null = null;
    let thresholdFraction = 0;

    if (utilization >= CONTAINER_CAPACITY_THRESHOLDS.page) {
      severity = 'page';
      thresholdFraction = CONTAINER_CAPACITY_THRESHOLDS.page;
    } else if (utilization >= CONTAINER_CAPACITY_THRESHOLDS.ticket) {
      severity = 'ticket';
      thresholdFraction = CONTAINER_CAPACITY_THRESHOLDS.ticket;
    }

    if (severity === null) continue;

    alerts.push({
      severity,
      applicationName: app.name,
      usedInstances: app.instances,
      maxInstances: app.maxInstances,
      utilizationFraction: utilization,
      thresholdFraction,
      health: app.health?.instances,
    });
  }

  return alerts;
}
