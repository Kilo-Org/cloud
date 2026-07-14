/**
 * Tests for the shared alarm scheduler that coordinates the attention outbox
 * with the session metrics lifecycle.
 */

import { describe, expect, it } from 'vitest';

import { ingestMeta, attentionOutbox } from '../db/sqlite-schema';
import { computeNextAlarmTime, minPendingAlarmTime } from './attention-alarm';

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
