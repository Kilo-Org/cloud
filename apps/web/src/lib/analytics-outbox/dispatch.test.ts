/**
 * Unit tests for the analytics outbox cron drainer (P2-A-04): the orchestration
 * order and the summary accounting, with the PostHog client and the DB
 * transitions stubbed. The transitions themselves are covered by
 * `analytics-outbox.integration.test.ts`.
 */
import { randomUUID } from 'crypto';
import { captureMessage } from '@sentry/nextjs';

import { dispatchQueuedAnalyticsEvents } from '@/lib/analytics-outbox/dispatch';
import {
  claimDueOutboxEvents,
  markOutboxDelivered,
  markOutboxRetry,
  purgeExpired,
  reclaimStaleSendingEvents,
} from '@kilocode/db/analytics-outbox';
import type { AnalyticsEventOutboxRow } from '@kilocode/db/schema';

const mockCapture = jest.fn();
const mockFlushPostHog = jest.fn();

jest.mock('@/lib/posthog', () => ({
  __esModule: true,
  default: jest.fn(() => ({ capture: mockCapture })),
  flushPostHog: (...args: unknown[]) => mockFlushPostHog(...args),
}));

jest.mock('@/lib/drizzle', () => ({
  db: {},
}));

jest.mock('@/lib/config.server', () => ({
  IS_IN_AUTOMATED_TEST: true,
}));

jest.mock('@sentry/nextjs', () => ({
  captureMessage: jest.fn(),
  captureException: jest.fn(),
}));

jest.mock('@kilocode/db/analytics-outbox', () => ({
  claimDueOutboxEvents: jest.fn(),
  markOutboxDelivered: jest.fn(),
  markOutboxRetry: jest.fn(),
  purgeExpired: jest.fn(),
  reclaimStaleSendingEvents: jest.fn(),
}));

const mockClaimDueOutboxEvents = jest.mocked(claimDueOutboxEvents);
const mockMarkOutboxDelivered = jest.mocked(markOutboxDelivered);
const mockMarkOutboxRetry = jest.mocked(markOutboxRetry);
const mockPurgeExpired = jest.mocked(purgeExpired);
const mockReclaimStaleSendingEvents = jest.mocked(reclaimStaleSendingEvents);

function makeRow(overrides: Partial<AnalyticsEventOutboxRow> = {}): AnalyticsEventOutboxRow {
  return {
    id: randomUUID(),
    event_uuid: randomUUID(),
    event_name: 'session_create_settled',
    distinct_id: 'user@example.com',
    properties: { source: 'server' },
    status: 'sending',
    attempts: 0,
    next_attempt_at: null,
    claimed_at: new Date().toISOString(),
    created_at: new Date().toISOString(),
    delivered_at: null,
    last_error: null,
    ...overrides,
  };
}

const emptyPurge = {
  outboxDeliveredPurged: 0,
  outboxFailedPurged: 0,
  expiredUnsettledLedgerSettled: 0,
};

describe('dispatchQueuedAnalyticsEvents', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCapture.mockReset();
    mockFlushPostHog.mockReset();
    mockFlushPostHog.mockResolvedValue(undefined);
    mockReclaimStaleSendingEvents.mockResolvedValue([]);
    mockClaimDueOutboxEvents.mockResolvedValue([]);
    mockPurgeExpired.mockResolvedValue(emptyPurge);
  });

  it('claims and delivers a due event with the deterministic event_uuid, after the flush', async () => {
    const row = makeRow();
    mockClaimDueOutboxEvents.mockResolvedValueOnce([row]);
    mockMarkOutboxDelivered.mockResolvedValue(row);

    const summary = await dispatchQueuedAnalyticsEvents();

    expect(mockCapture).toHaveBeenCalledTimes(1);
    expect(mockCapture).toHaveBeenCalledWith({
      distinctId: row.distinct_id,
      event: row.event_name,
      properties: row.properties,
      uuid: row.event_uuid,
    });
    // The flush must complete before the row is marked delivered.
    expect(mockFlushPostHog).toHaveBeenCalledTimes(1);
    expect(mockFlushPostHog.mock.invocationCallOrder[0]).toBeLessThan(
      mockMarkOutboxDelivered.mock.invocationCallOrder[0]
    );
    expect(mockMarkOutboxDelivered).toHaveBeenCalledWith(expect.anything(), {
      eventId: row.id,
      claimedAt: row.claimed_at,
    });
    expect(summary).toEqual({
      reclaimed: 0,
      claimed: 1,
      delivered: 1,
      retried: 0,
      failed: 0,
      outboxDeliveredPurged: 0,
      outboxFailedPurged: 0,
      expiredUnsettledLedgerSettled: 0,
    });
  });

  it('walks reclaim, claim, delivery, and purge in the required order', async () => {
    const row = makeRow();
    mockClaimDueOutboxEvents.mockResolvedValueOnce([row]);
    mockMarkOutboxDelivered.mockResolvedValue(row);

    await dispatchQueuedAnalyticsEvents();

    const reclaimOrder = mockReclaimStaleSendingEvents.mock.invocationCallOrder[0];
    const claimOrder = mockClaimDueOutboxEvents.mock.invocationCallOrder[0];
    const markOrder = mockMarkOutboxDelivered.mock.invocationCallOrder[0];
    const purgeOrder = mockPurgeExpired.mock.invocationCallOrder[0];
    expect(reclaimOrder).toBeLessThan(claimOrder);
    expect(claimOrder).toBeLessThan(markOrder);
    expect(markOrder).toBeLessThan(purgeOrder);
  });

  it('backs a failed send off for retry with the error recorded', async () => {
    const row = makeRow();
    mockClaimDueOutboxEvents.mockResolvedValueOnce([row]);
    mockCapture.mockImplementation(() => {
      throw new Error('posthog unavailable');
    });
    mockMarkOutboxRetry.mockResolvedValue({
      outcome: 'retried',
      row: { ...row, status: 'pending', attempts: 1 },
    });

    const summary = await dispatchQueuedAnalyticsEvents();

    expect(mockCapture).toHaveBeenCalledTimes(1);
    expect(mockMarkOutboxRetry).toHaveBeenCalledWith(expect.anything(), {
      eventId: row.id,
      claimedAt: row.claimed_at,
      error: 'posthog unavailable',
    });
    expect(mockMarkOutboxDelivered).not.toHaveBeenCalled();
    expect(captureMessage).toHaveBeenCalled();
    expect(JSON.stringify(jest.mocked(captureMessage).mock.calls)).not.toContain(row.distinct_id);
    expect(summary.claimed).toBe(1);
    expect(summary.retried).toBe(1);
    expect(summary.failed).toBe(0);
    expect(summary.delivered).toBe(0);
  });

  it('backs a rejected async flush off for retry with the error recorded', async () => {
    const row = makeRow();
    mockClaimDueOutboxEvents.mockResolvedValueOnce([row]);
    mockFlushPostHog.mockRejectedValue(new Error('flush timed out'));
    mockMarkOutboxRetry.mockResolvedValue({
      outcome: 'retried',
      row: { ...row, status: 'pending', attempts: 1 },
    });

    const summary = await dispatchQueuedAnalyticsEvents();

    expect(mockCapture).toHaveBeenCalledTimes(1);
    expect(mockFlushPostHog).toHaveBeenCalledTimes(1);
    expect(mockMarkOutboxRetry).toHaveBeenCalledWith(expect.anything(), {
      eventId: row.id,
      claimedAt: row.claimed_at,
      error: 'flush timed out',
    });
    expect(mockMarkOutboxDelivered).not.toHaveBeenCalled();
    expect(summary.retried).toBe(1);
    expect(summary.delivered).toBe(0);
  });

  it('fails a claimed event terminally when the retry cap is reached', async () => {
    const row = makeRow();
    mockClaimDueOutboxEvents.mockResolvedValueOnce([row]);
    mockCapture.mockImplementation(() => {
      throw new Error('still down');
    });
    mockMarkOutboxRetry.mockResolvedValue({
      outcome: 'failed',
      row: { ...row, status: 'failed', attempts: 8 },
    });

    const summary = await dispatchQueuedAnalyticsEvents();

    expect(mockMarkOutboxRetry).toHaveBeenCalledWith(expect.anything(), {
      eventId: row.id,
      claimedAt: row.claimed_at,
      error: 'still down',
    });
    expect(summary.failed).toBe(1);
    expect(summary.retried).toBe(0);
  });

  it('counts reclaimed stale claims before claiming', async () => {
    mockReclaimStaleSendingEvents.mockResolvedValue([makeRow(), makeRow()]);

    const summary = await dispatchQueuedAnalyticsEvents();

    expect(summary.reclaimed).toBe(2);
    expect(summary.claimed).toBe(0);
  });

  it('surfaces the retention purge and ledger backstop counts', async () => {
    mockPurgeExpired.mockResolvedValue({
      outboxDeliveredPurged: 3,
      outboxFailedPurged: 1,
      expiredUnsettledLedgerSettled: 2,
    });

    const summary = await dispatchQueuedAnalyticsEvents();

    expect(mockPurgeExpired).toHaveBeenCalledTimes(1);
    expect(summary.outboxDeliveredPurged).toBe(3);
    expect(summary.outboxFailedPurged).toBe(1);
    expect(summary.expiredUnsettledLedgerSettled).toBe(2);
  });

  it('claims in bounded batches until no rows are due', async () => {
    const first = makeRow();
    const second = makeRow();
    mockClaimDueOutboxEvents.mockResolvedValueOnce([first]).mockResolvedValueOnce([second]);
    mockMarkOutboxDelivered.mockResolvedValue(first);

    const summary = await dispatchQueuedAnalyticsEvents({ limit: 2 });

    expect(mockClaimDueOutboxEvents.mock.calls.map(call => call[1])).toEqual([2, 1]);
    expect(mockMarkOutboxDelivered).toHaveBeenCalledTimes(2);
    expect(summary.claimed).toBe(2);
    expect(summary.delivered).toBe(2);
  });

  it('counts a late delivery mark from a reclaimed claim as delivered', async () => {
    const row = makeRow();
    mockClaimDueOutboxEvents.mockResolvedValueOnce([row]);
    mockMarkOutboxDelivered.mockResolvedValue(null);

    const summary = await dispatchQueuedAnalyticsEvents();

    expect(mockCapture).toHaveBeenCalledTimes(1);
    expect(summary.delivered).toBe(1);
  });

  it('counts a lost claim on retry as retried', async () => {
    const row = makeRow();
    mockClaimDueOutboxEvents.mockResolvedValueOnce([row]);
    mockCapture.mockImplementation(() => {
      throw new Error('posthog unavailable');
    });
    mockMarkOutboxRetry.mockResolvedValue(null);

    const summary = await dispatchQueuedAnalyticsEvents();

    expect(summary.retried).toBe(1);
    expect(summary.failed).toBe(0);
  });

  it('stops claiming once the batch limit is exhausted', async () => {
    const row = makeRow();
    mockClaimDueOutboxEvents.mockResolvedValueOnce([row]);
    mockMarkOutboxDelivered.mockResolvedValue(row);

    await dispatchQueuedAnalyticsEvents({ limit: 1 });

    expect(mockClaimDueOutboxEvents).toHaveBeenCalledTimes(1);
  });
});
