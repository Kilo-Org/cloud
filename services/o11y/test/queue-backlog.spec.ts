import { describe, expect, it } from 'vitest';
import {
  MONITORED_QUEUE_ID,
  QUEUE_BACKLOG_THRESHOLDS,
  evaluateQueueBacklog,
  type QueueBacklogMetrics,
} from '../src/alerting/queue-backlog';

function makeMetrics(backlogCount: number): QueueBacklogMetrics {
  return {
    queueId: MONITORED_QUEUE_ID,
    backlogCount,
    backlogBytes: backlogCount * 100,
    oldestMessageTimestamp: new Date('2026-06-04T08:00:00.000Z'),
  };
}

describe('evaluateQueueBacklog', () => {
  it('returns no alert below the ticket backlog threshold', () => {
    expect(evaluateQueueBacklog(makeMetrics(QUEUE_BACKLOG_THRESHOLDS.ticket - 1))).toBeNull();
  });

  it('returns a ticket alert at the ticket backlog threshold', () => {
    expect(evaluateQueueBacklog(makeMetrics(QUEUE_BACKLOG_THRESHOLDS.ticket))).toEqual({
      severity: 'ticket',
      queueId: MONITORED_QUEUE_ID,
      backlogCount: QUEUE_BACKLOG_THRESHOLDS.ticket,
      backlogBytes: QUEUE_BACKLOG_THRESHOLDS.ticket * 100,
      thresholdCount: QUEUE_BACKLOG_THRESHOLDS.ticket,
      oldestMessageTimestamp: new Date('2026-06-04T08:00:00.000Z'),
    });
  });

  it('returns only a page alert at the page backlog threshold', () => {
    expect(evaluateQueueBacklog(makeMetrics(QUEUE_BACKLOG_THRESHOLDS.page))).toMatchObject({
      severity: 'page',
      thresholdCount: QUEUE_BACKLOG_THRESHOLDS.page,
    });
  });
});
