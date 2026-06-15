// Queue used for ingest.
export const MONITORED_QUEUE_ID = '965459cfc1a349c190bb813855a65b02';

export const QUEUE_BACKLOG_THRESHOLDS = {
  page: 50_000,
  ticket: 25_000,
} as const;

export const QUEUE_BACKLOG_PAGE_INTERVAL = 100_000;

export type QueueBacklogMetrics = {
  queueId: string;
  backlogCount: number;
  backlogBytes: number;
  oldestMessageTimestamp?: Date;
};
