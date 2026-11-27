import { describe, expect, it } from 'vitest';
import { AuditRowTooLargeError, WatermarkMovedError } from '../../src/audit/relay';
import {
  RELAY_INTERVAL_MS,
  RELAY_MAX_BACKOFF_MS,
  classifyRelayFailure,
  nextRelayRun,
} from '../../src/audit/relay-schedule';
import { IdentityStoreError } from '../../src/db/client';

const details = {
  sqlState: undefined,
  constraint: undefined,
  table: undefined,
  systemCode: undefined,
};

describe('relay schedule', () => {
  it('runs again at once after a run that stopped at its read budget', () => {
    expect(nextRelayRun({ kind: 'ran', result: { status: 'more', sent: 5_000 } }, 3)).toEqual({
      delayMs: 0,
      failedRuns: 0,
    });
  });

  it('runs again after the interval when a run found nothing or drained the shard', () => {
    for (const status of ['idle', 'drained'] as const) {
      expect(nextRelayRun({ kind: 'ran', result: { status, sent: 0 } }, 2)).toEqual({
        delayMs: RELAY_INTERVAL_MS,
        failedRuns: 0,
      });
    }
  });

  it('waits the longest backoff after a permanent failure and counts it', () => {
    expect(
      nextRelayRun({ kind: 'failed', failure: { kind: 'permanent', reason: 'refused' } }, 0)
    ).toEqual({ delayMs: RELAY_MAX_BACKOFF_MS, failedRuns: 1 });
  });

  it('waits the interval after another runner moved the watermark, without counting a failure', () => {
    expect(nextRelayRun({ kind: 'failed', failure: { kind: 'superseded' } }, 2)).toEqual({
      delayMs: RELAY_INTERVAL_MS,
      failedRuns: 2,
    });
  });

  it('doubles the delay per retryable failure up to the cap', () => {
    const delays = [0, 1, 2, 3, 4, 40].map(
      failedBefore =>
        nextRelayRun({ kind: 'failed', failure: { kind: 'retryable', reason: 'x' } }, failedBefore)
          .delayMs
    );
    expect(delays).toEqual([5_000, 10_000, 20_000, 40_000, 60_000, 60_000]);
  });

  it('classifies each error a run can throw', () => {
    expect(classifyRelayFailure(new WatermarkMovedError(1))).toEqual({ kind: 'superseded' });
    expect(classifyRelayFailure(new AuditRowTooLargeError(1))).toEqual({
      kind: 'permanent',
      reason: 'AuditRowTooLargeError',
    });
    expect(classifyRelayFailure(new IdentityStoreError('permanent', details))).toMatchObject({
      kind: 'permanent',
    });
    expect(classifyRelayFailure(new IdentityStoreError('retryable', details))).toMatchObject({
      kind: 'retryable',
    });
    expect(classifyRelayFailure(new Error('queue down'))).toEqual({
      kind: 'retryable',
      reason: 'Error',
    });
  });
});
