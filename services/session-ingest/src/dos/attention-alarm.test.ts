/**
 * Tests for the shared alarm scheduler that coordinates the attention outbox
 * with the session metrics lifecycle.
 */

import { describe, expect, it } from 'vitest';

import { ingestMeta, attentionOutbox } from '../db/sqlite-schema';
import {
  computeNextAlarmTime,
  minPendingAlarmTime,
  shouldEmitMetricsFromAttentionAlarm,
} from './attention-alarm';

describe('minPendingAlarmTime', () => {
  it('returns only metrics when outbox is null', () => {
    expect(minPendingAlarmTime(1000, false, null)).toBe(1000);
  });

  it('returns only outbox when metrics is null', () => {
    expect(minPendingAlarmTime(null, false, 2000)).toBe(2000);
  });

  it('returns the minimum when both are present', () => {
    expect(minPendingAlarmTime(5000, false, 2000)).toBe(2000);
    expect(minPendingAlarmTime(1000, false, 2000)).toBe(1000);
  });

  it('ignores metrics when metricsEmitted is true', () => {
    expect(minPendingAlarmTime(1000, true, null)).toBeNull();
    expect(minPendingAlarmTime(1000, true, 2000)).toBe(2000);
  });

  it('ignores metrics when metricsEmitted is the string "true"', () => {
    expect(minPendingAlarmTime(1000, 'true', null)).toBeNull();
    expect(minPendingAlarmTime(1000, 'true', 2000)).toBe(2000);
  });

  it('ignores invalid numeric metricsAlarmAt values', () => {
    expect(minPendingAlarmTime(NaN, false, null)).toBeNull();
    expect(minPendingAlarmTime('', false, null)).toBeNull();
    expect(minPendingAlarmTime('invalid', false, null)).toBeNull();
    expect(minPendingAlarmTime(0, false, null)).toBeNull();
    expect(minPendingAlarmTime(-1, false, null)).toBeNull();
    expect(minPendingAlarmTime(undefined, false, null)).toBeNull();
  });

  it('returns null when both inputs are absent', () => {
    expect(minPendingAlarmTime(null, false, null)).toBeNull();
    expect(minPendingAlarmTime(undefined, false, null)).toBeNull();
  });
});

describe('computeNextAlarmTime', () => {
  it('wires DB meta and outbox to minPendingAlarmTime', () => {
    const metaRows = [
      { key: 'metricsAlarmAt', value: '5000' },
      { key: 'metricsEmitted', value: 'false' },
    ];
    const outboxRow = { next_attempt_at: 2000 };

    let currentTable: string | null = null;
    const selectChain = {
      from: (table: unknown) => {
        currentTable =
          table === ingestMeta
            ? 'ingest_meta'
            : table === attentionOutbox
              ? 'attention_outbox'
              : null;
        return selectChain;
      },
      where: () => selectChain,
      orderBy: () => selectChain,
      limit: () => selectChain,
      all: () => (currentTable === 'ingest_meta' ? metaRows : []),
      get: () => (currentTable === 'attention_outbox' ? outboxRow : undefined),
    };

    const db = {
      select: () => selectChain,
    };

    expect(computeNextAlarmTime(db as never)).toBe(2000);
  });
});

describe('shouldEmitMetricsFromAttentionAlarm', () => {
  // Pure helper used by the alarm() body to decide whether the immediate
  // attention alarm should also drive a metrics emission. It must ignore
  // calls when the persisted metrics deadline is still in the future or
  // missing entirely (legacy platform alarms without a persisted deadline).
  const NOW = 1_700_000_000_000;

  it('emits when metricsAlarmAt is finite positive and <= now', () => {
    expect(shouldEmitMetricsFromAttentionAlarm('false', String(NOW - 1), NOW)).toBe(true);
    expect(shouldEmitMetricsFromAttentionAlarm('false', String(NOW), NOW)).toBe(true);
  });

  it('skips when metricsAlarmAt is strictly in the future', () => {
    expect(shouldEmitMetricsFromAttentionAlarm('false', String(NOW + 1), NOW)).toBe(false);
    expect(shouldEmitMetricsFromAttentionAlarm(null, String(NOW + 60_000), NOW)).toBe(false);
  });

  it('skips when metricsEmitted is already true', () => {
    expect(shouldEmitMetricsFromAttentionAlarm('true', String(NOW - 100), NOW)).toBe(false);
  });

  it('skips when metricsAlarmAt is missing (legacy platform alarm)', () => {
    expect(shouldEmitMetricsFromAttentionAlarm('false', null, NOW)).toBe(false);
    expect(shouldEmitMetricsFromAttentionAlarm(null, null, NOW)).toBe(false);
  });

  it('skips when metricsAlarmAt is non-numeric or non-positive', () => {
    expect(shouldEmitMetricsFromAttentionAlarm('false', 'not-a-number', NOW)).toBe(false);
    expect(shouldEmitMetricsFromAttentionAlarm('false', '', NOW)).toBe(false);
    expect(shouldEmitMetricsFromAttentionAlarm('false', '0', NOW)).toBe(false);
    expect(shouldEmitMetricsFromAttentionAlarm('false', '-1', NOW)).toBe(false);
  });

  it('treats the boolean-true metricsEmitted as already emitted (defense in depth)', () => {
    // The DO reads metricsEmitted as a string column; this guard makes the
    // helper safe if a future refactor passes the raw row value through.
    expect(
      shouldEmitMetricsFromAttentionAlarm(true as unknown as string, String(NOW - 1), NOW)
    ).toBe(false);
  });
});
