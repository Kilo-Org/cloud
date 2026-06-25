/**
 * Slack notification delivery for SLO and container capacity alerts.
 */

import type { AlertSeverity } from './slo-config';
import type { HealthInstances } from './container-capacity';

type NotifyEnv = {
  O11Y_SLACK_WEBHOOK_PAGE: SecretsStoreSecret;
  O11Y_SLACK_WEBHOOK_TICKET: SecretsStoreSecret;
};

// ── Discriminated union payload types ───────────────────────────────────────

export type SloAlertPayload = {
  alertType: 'error_rate' | 'ttfb';
  severity: AlertSeverity;
  provider: string;
  model: string;
  clientName: string;
  burnRate: number;
  burnRateThreshold: number;
  windowMinutes: number;
  totalRequests: number;
  slo: number;
  // Error rate specific
  currentRate?: number;
  // TTFB specific
  currentTtfbFraction?: number;
  ttfbThresholdMs?: number;
};

export type ContainerCapacityAlertPayload = {
  alertType: 'container_capacity';
  severity: AlertSeverity;
  provider: string;
  model: string;
  clientName: string;
  usedInstances: number;
  maxInstances: number;
  utilizationFraction: number;
  thresholdFraction: number;
  health?: HealthInstances;
};

export type QueueBacklogAlertPayload = {
  alertType: 'queue_backlog';
  severity: AlertSeverity;
  provider: string;
  model: string;
  clientName: string;
  backlogCount: number;
  backlogBytes: number;
  thresholdCount: number;
  oldestMessageTimestamp?: Date;
};

export type GastownHealthAlertPayload = {
  alertType: 'gastown_container_health';
  severity: 'ticket';
  weightedFailedChecks: number;
  affectedTownCount: number;
  windowMinutes: number;
  crossedThresholds: Array<'failed_checks' | 'affected_towns'>;
  failedChecksThreshold: number;
  affectedTownsThreshold: number;
};

export type AlertPayload =
  | SloAlertPayload
  | ContainerCapacityAlertPayload
  | QueueBacklogAlertPayload
  | GastownHealthAlertPayload;

// ── Formatting helpers ───────────────────────────────────────────────────────

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(2)}%`;
}

function formatAlertTypeLabel(alertType: AlertPayload['alertType']): string {
  switch (alertType) {
    case 'error_rate':
      return 'Error Rate';
    case 'ttfb':
      return 'TTFB Latency';
    case 'container_capacity':
      return 'Container Capacity';
    case 'queue_backlog':
      return 'Queue Backlog';
    case 'gastown_container_health':
      return 'Gastown Container Health';
  }
}

function buildSloMetricLine(alert: SloAlertPayload): string {
  if (alert.alertType === 'ttfb') {
    const fraction = formatPercent(alert.currentTtfbFraction ?? 0);
    const budget = formatPercent(1 - alert.slo);
    return `${fraction} of requests exceeded ${alert.ttfbThresholdMs ?? 0}ms TTFB (budget: ${budget})`;
  }
  return `Error rate: ${formatPercent(alert.currentRate ?? 0)} (SLO: ${formatPercent(alert.slo)})`;
}

function buildSloSlackBlocks(alert: SloAlertPayload): object[] {
  const severityLabel = alert.severity === 'page' ? ':rotating_light: PAGE' : ':ticket: TICKET';
  const typeLabel = formatAlertTypeLabel(alert.alertType);

  return [
    {
      type: 'header',
      text: {
        type: 'plain_text',
        text: `${severityLabel} — LLM ${typeLabel} SLO Breach`,
      },
    },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*Provider:*\n${alert.provider}` },
        { type: 'mrkdwn', text: `*Model:*\n${alert.model}` },
        {
          type: 'mrkdwn',
          text: `*Burn rate:*\n${alert.burnRate.toFixed(1)}x (threshold: ${alert.burnRateThreshold}x)`,
        },
        { type: 'mrkdwn', text: `*Window:*\n${alert.windowMinutes} min` },
      ],
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `${buildSloMetricLine(alert)}\nRequests in window: ${alert.totalRequests.toLocaleString()}\nClient: ${alert.clientName}`,
      },
    },
  ];
}

function buildCapacitySlackBlocks(alert: ContainerCapacityAlertPayload): object[] {
  const severityLabel = alert.severity === 'page' ? ':rotating_light: PAGE' : ':ticket: TICKET';
  const utilizationPct = (alert.utilizationFraction * 100).toFixed(1);
  const thresholdPct = (alert.thresholdFraction * 100).toFixed(1);

  const healthText =
    alert.health !== undefined
      ? `\nHealth: active=${alert.health.active}, healthy=${alert.health.healthy}, starting=${alert.health.starting}`
      : '';

  return [
    {
      type: 'header',
      text: {
        type: 'plain_text',
        text: `${severityLabel} — Container Capacity Alert`,
      },
    },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*Application:*\n${alert.model}` },
        {
          type: 'mrkdwn',
          text: `*Instances:*\n${alert.usedInstances} / ${alert.maxInstances}`,
        },
        { type: 'mrkdwn', text: `*Utilization:*\n${utilizationPct}%` },
        { type: 'mrkdwn', text: `*Threshold:*\n${thresholdPct}%` },
      ],
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `Container: ${alert.clientName}${healthText}`,
      },
    },
  ];
}

function buildQueueBacklogSlackBlocks(alert: QueueBacklogAlertPayload): object[] {
  const severityLabel = alert.severity === 'page' ? ':rotating_light: PAGE' : ':ticket: TICKET';
  const oldestMessageTimestamp = alert.oldestMessageTimestamp?.toISOString() ?? 'Unknown';

  return [
    {
      type: 'header',
      text: {
        type: 'plain_text',
        text: `${severityLabel} — Queue Backlog Alert`,
      },
    },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*Queue ID:*\n${alert.model}` },
        {
          type: 'mrkdwn',
          text: `*Backlog:*\n${alert.backlogCount.toLocaleString('en-US')} messages`,
        },
        {
          type: 'mrkdwn',
          text: `*Threshold:*\n${alert.thresholdCount.toLocaleString('en-US')} messages`,
        },
        { type: 'mrkdwn', text: `*Backlog bytes:*\n${alert.backlogBytes.toLocaleString('en-US')}` },
      ],
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `Oldest message: ${oldestMessageTimestamp}`,
      },
    },
  ];
}

const GASTOWN_DASHBOARD_URL = 'https://ops.kiloapps.io/d/gastown-ops-1/gastown-operations';
const GASTOWN_HEALTH_RUNBOOK_URL =
  'https://github.com/Kilo-Org/on-call/blob/main/runbooks/gastown-container-health-failures.md';

function buildGastownHealthSlackBlocks(alert: GastownHealthAlertPayload): object[] {
  const crossedThresholds = alert.crossedThresholds
    .map(threshold =>
      threshold === 'failed_checks'
        ? `${alert.failedChecksThreshold.toLocaleString('en-US')} failed checks`
        : `${alert.affectedTownsThreshold.toLocaleString('en-US')} affected towns`
    )
    .join(' and ');

  return [
    {
      type: 'header',
      text: {
        type: 'plain_text',
        text: ':ticket: TICKET — Gastown container health failures',
      },
    },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*Window:*\n${alert.windowMinutes}-minute window` },
        {
          type: 'mrkdwn',
          text: `*Failed checks:*\n${alert.weightedFailedChecks.toLocaleString('en-US')}`,
        },
        {
          type: 'mrkdwn',
          text: `*Affected towns:*\n${alert.affectedTownCount.toLocaleString('en-US')}`,
        },
        { type: 'mrkdwn', text: `*Threshold crossed:*\n${crossedThresholds}` },
      ],
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `Investigate aggregate container health failures. Do not restart towns without active-session authorization.\n<${GASTOWN_DASHBOARD_URL}|Gastown dashboard> | <${GASTOWN_HEALTH_RUNBOOK_URL}|Container-health runbook>`,
      },
    },
  ];
}

/**
 * Builds a Slack Block Kit message body for the given alert.
 * Exported for testing.
 */
export function buildSlackMessage(alert: AlertPayload): object {
  switch (alert.alertType) {
    case 'container_capacity':
      return { blocks: buildCapacitySlackBlocks(alert) };
    case 'queue_backlog':
      return { blocks: buildQueueBacklogSlackBlocks(alert) };
    case 'gastown_container_health':
      return { blocks: buildGastownHealthSlackBlocks(alert) };
    default:
      return { blocks: buildSloSlackBlocks(alert) };
  }
}

// ── Notification delivery ───────────────────────────────────────────────────

export async function sendAlertNotification(alert: AlertPayload, env: NotifyEnv): Promise<void> {
  const webhookSecret =
    alert.severity === 'page' ? env.O11Y_SLACK_WEBHOOK_PAGE : env.O11Y_SLACK_WEBHOOK_TICKET;

  const webhookUrl = await webhookSecret.get();
  if (!webhookUrl) {
    throw new Error(`No Slack webhook configured for severity: ${alert.severity}`);
  }

  const body = buildSlackMessage(alert);

  const response = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5_000),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Slack webhook failed (${response.status}): ${text}`);
  }
}
