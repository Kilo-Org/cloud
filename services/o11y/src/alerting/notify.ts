/**
 * Slack notification delivery for SLO, container allocation and queue alerts.
 */

import type { AlertSeverity } from './slo-config';
import type { ContainerAllocations } from './container-allocations';
import { readO11ySecret } from '../secrets';

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

export type ContainerAllocationAlertPayload = {
  alertType: 'container_capacity';
  severity: AlertSeverity;
  provider: string;
  model: string;
  clientName: string;
  allocatedInstances: number;
  thresholdCount: number;
  counts: ContainerAllocations;
};

export type QueueBacklogAlertPayload = {
  alertType: 'queue_backlog';
  queueName?: string;
  runbookUrl?: string;
  severity: AlertSeverity;
  provider: string;
  model: string;
  clientName: string;
  backlogCount: number;
  backlogBytes: number;
  thresholdCount: number;
  oldestMessageTimestamp?: Date;
};

export type DeadLetterQueueAlertPayload = {
  alertType: 'dead_letter_queue';
  severity: AlertSeverity;
  provider: string;
  model: string;
  clientName: string;
  queueId: string;
  backlogCount: number;
  newMessages: number;
  backlogBytes: number;
  oldestMessageTimestamp?: Date;
};

export type AlertPayload =
  | SloAlertPayload
  | ContainerAllocationAlertPayload
  | QueueBacklogAlertPayload
  | DeadLetterQueueAlertPayload;

// ── Formatting helpers ───────────────────────────────────────────────────────

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(2)}%`;
}

/**
 * A Slack block field for a value that comes from telemetry or configuration
 * rather than this Worker's source. Plain text renders the value exactly as it
 * is given.
 */
function plainTextField(label: string, value: string): object {
  return { type: 'plain_text', text: `${label}:\n${value}` };
}

function formatSeverityLabel(severity: AlertSeverity): string {
  switch (severity) {
    case 'page':
      return ':rotating_light: PAGE';
    case 'ticket':
      return ':ticket: TICKET';
    case 'info':
      return ':information_source: INFO';
  }
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
    case 'dead_letter_queue':
      return 'Dead-Letter Queue';
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
  const severityLabel = formatSeverityLabel(alert.severity);
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
        plainTextField('Provider', alert.provider),
        plainTextField('Model', alert.model),
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

function buildContainerAllocationSlackBlocks(alert: ContainerAllocationAlertPayload): object[] {
  const severityLabel = formatSeverityLabel(alert.severity);
  return [
    {
      type: 'header',
      text: { type: 'plain_text', text: `${severityLabel} - Container Allocation Alert` },
    },
    {
      type: 'section',
      fields: [
        plainTextField('Application', alert.model),
        { type: 'mrkdwn', text: `*Allocated containers:*\n${alert.allocatedInstances}` },
        { type: 'mrkdwn', text: `*Alert threshold:*\n${alert.thresholdCount} containers` },
        { type: 'mrkdwn', text: `*Running:*\n${alert.counts.running}` },
      ],
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `Provisioning: ${alert.counts.provisioning}\nStopping: ${alert.counts.stopping}\nAllocation count includes running, provisioning, and stopping containers. Threshold is operational, not a Cloudflare limit.`,
      },
    },
  ];
}

function buildQueueBacklogSlackBlocks(alert: QueueBacklogAlertPayload): object[] {
  const severityLabel = formatSeverityLabel(alert.severity);
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
        ...(alert.queueName ? [plainTextField('Queue', alert.queueName)] : []),
        plainTextField('Queue ID', alert.model),
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
        text: `Oldest message: ${oldestMessageTimestamp}${alert.runbookUrl ? `\nRunbook: ${alert.runbookUrl}` : ''}`,
      },
    },
  ];
}

function buildDeadLetterQueueSlackBlocks(alert: DeadLetterQueueAlertPayload): object[] {
  const severityLabel = formatSeverityLabel(alert.severity);
  const oldestMessageTimestamp = alert.oldestMessageTimestamp?.toISOString() ?? 'Unknown';

  return [
    {
      type: 'header',
      text: { type: 'plain_text', text: `${severityLabel} — Dead-Letter Queue Alert` },
    },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*Queue:*\n${alert.model}` },
        {
          type: 'mrkdwn',
          text: `*Backlog:*\n${alert.backlogCount.toLocaleString('en-US')} messages (${alert.newMessages.toLocaleString('en-US')} since last alert)`,
        },
        { type: 'mrkdwn', text: `*Queue ID:*\n${alert.queueId}` },
        { type: 'mrkdwn', text: `*Backlog bytes:*\n${alert.backlogBytes.toLocaleString('en-US')}` },
      ],
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `Each message is usage that was not recorded after every retry. Oldest message: ${oldestMessageTimestamp}\nRunbook: services/usage-ingest/README.md#dead-letter-alert`,
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
      return { blocks: buildContainerAllocationSlackBlocks(alert) };
    case 'queue_backlog':
      return { blocks: buildQueueBacklogSlackBlocks(alert) };
    case 'dead_letter_queue':
      return { blocks: buildDeadLetterQueueSlackBlocks(alert) };
    default:
      return { blocks: buildSloSlackBlocks(alert) };
  }
}

// ── Notification delivery ───────────────────────────────────────────────────

export async function sendAlertNotification(alert: AlertPayload, env: NotifyEnv): Promise<void> {
  const webhookUrl = await readO11ySecret(
    env,
    alert.severity === 'page' ? 'O11Y_SLACK_WEBHOOK_PAGE' : 'O11Y_SLACK_WEBHOOK_TICKET'
  );

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
