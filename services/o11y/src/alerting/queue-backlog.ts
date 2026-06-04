import type { AlertSeverity } from './slo-config';

// Queue used for ingest.
export const MONITORED_QUEUE_ID = '965459cfc1a349c190bb813855a65b02';

export const QUEUE_BACKLOG_THRESHOLDS = {
  page: 50_000,
  ticket: 25_000,
} as const;

export type QueueBacklogMetrics = {
  queueId: string;
  backlogCount: number;
  backlogBytes: number;
  oldestMessageTimestamp?: Date;
};

export type QueueBacklogAlert = QueueBacklogMetrics & {
  severity: AlertSeverity;
  thresholdCount: number;
};

export function evaluateQueueBacklog(metrics: QueueBacklogMetrics): QueueBacklogAlert | null {
  let severity: AlertSeverity | null = null;
  let thresholdCount = 0;

  if (metrics.backlogCount >= QUEUE_BACKLOG_THRESHOLDS.page) {
    severity = 'page';
    thresholdCount = QUEUE_BACKLOG_THRESHOLDS.page;
  } else if (metrics.backlogCount >= QUEUE_BACKLOG_THRESHOLDS.ticket) {
    severity = 'ticket';
    thresholdCount = QUEUE_BACKLOG_THRESHOLDS.ticket;
  }

  if (severity === null) return null;

  return {
    ...metrics,
    severity,
    thresholdCount,
  };
}
