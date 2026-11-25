import {
  AuditBatchTooLargeError,
  AuditEventSchema,
  encodeAuditBatch,
  type AuditBatch,
  type AuditEvent,
} from '@kilocode/sts-contracts';
import { describe, expect, it } from 'vitest';
import {
  AUDIT_RETENTION_MS,
  relayAudit,
  type AuditRelayStore,
  type AuditRow,
} from '../../src/audit/relay';

function auditEvent(attributes: Record<string, string | string[]>): AuditEvent {
  return AuditEventSchema.parse({
    specversion: '1.0',
    id: crypto.randomUUID(),
    source: 'kilo:sts:production',
    type: 'ai.kilo.sts.bundle.delivered',
    time: new Date().toISOString(),
    datacontenttype: 'application/json',
    data: {
      classUid: 6003,
      activityId: 2,
      outcome: 'success',
      actor: { kind: 'workload', id: 'o11y' },
      attributes,
    },
  });
}

function randomFiller(length: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function rows(count: number, fillerLength = 4): AuditRow[] {
  return Array.from({ length: count }, (_unused, index) => ({
    seq: index + 1,
    event: auditEvent({ filler: randomFiller(fillerLength) }),
  }));
}

function fakeStore(initial: AuditRow[]): {
  store: AuditRelayStore;
  watermark: () => number;
  pruned: number[];
} {
  let watermark = 0;
  const pruned: number[] = [];
  return {
    store: {
      nextRows: (afterSeq, limit) => initial.filter(row => row.seq > afterSeq).slice(0, limit),
      watermark: () => watermark,
      advanceWatermark: toSeq => {
        watermark = toSeq;
      },
      prune: olderThanMs => {
        pruned.push(olderThanMs);
      },
    },
    watermark: () => watermark,
    pruned,
  };
}

describe('audit relay', () => {
  it('sends contiguous batches of at most 500 events and advances the watermark', async () => {
    const { store, watermark } = fakeStore(rows(600));
    const batches: AuditBatch[] = [];
    const result = await relayAudit({
      store,
      stream: 'sts:production:bundle:o11y',
      send: async batch => {
        await encodeAuditBatch(batch);
        batches.push(batch);
      },
      now: Date.now(),
    });

    expect(batches.map(batch => [batch.fromSeq, batch.toSeq])).toEqual([
      [1, 500],
      [501, 600],
    ]);
    expect(batches[0].stream).toBe('sts:production:bundle:o11y');
    expect(result.sent).toBe(600);
    expect(result.skipped).toEqual([]);
    expect(watermark()).toBe(600);
  });

  it('splits a batch the queue rejects as larger than 60 KB', async () => {
    const { store, watermark } = fakeStore(rows(500, 300));
    const batches: AuditBatch[] = [];
    const result = await relayAudit({
      store,
      stream: 'sts:production:bundle:o11y',
      send: async batch => {
        await encodeAuditBatch(batch);
        batches.push(batch);
      },
      now: Date.now(),
    });

    expect(batches.length).toBeGreaterThan(1);
    const covered: number[] = [];
    for (const batch of batches) {
      expect(batch.toSeq - batch.fromSeq + 1).toBe(batch.events.length);
      for (let seq = batch.fromSeq; seq <= batch.toSeq; seq += 1) covered.push(seq);
    }
    expect(covered).toEqual(Array.from({ length: 500 }, (_unused, index) => index + 1));
    expect(result.sent).toBe(500);
    expect(watermark()).toBe(500);
  });

  it('skips one event above the limit and keeps the stream moving', async () => {
    const oversized = auditEvent(
      Object.fromEntries(
        Array.from({ length: 300 }, (_unused, index) => [`k${index}`, randomFiller(300)])
      )
    );
    await expect(
      encodeAuditBatch({
        schemaVersion: 1,
        stream: 'sts:production:bundle:o11y',
        fromSeq: 2,
        toSeq: 2,
        events: [oversized],
      })
    ).rejects.toBeInstanceOf(AuditBatchTooLargeError);

    const initial: AuditRow[] = [
      { seq: 1, event: auditEvent({ filler: randomFiller(32) }) },
      { seq: 2, event: oversized },
      { seq: 3, event: auditEvent({ filler: randomFiller(32) }) },
    ];
    const { store, watermark } = fakeStore(initial);
    const batches: AuditBatch[] = [];
    const result = await relayAudit({
      store,
      stream: 'sts:production:bundle:o11y',
      send: async batch => {
        await encodeAuditBatch(batch);
        batches.push(batch);
      },
      now: Date.now(),
    });

    expect(result.skipped).toEqual([2]);
    expect(batches.map(batch => [batch.fromSeq, batch.toSeq])).toEqual([
      [1, 1],
      [3, 3],
    ]);
    expect(watermark()).toBe(3);
  });

  it('leaves the watermark when the queue is unreachable', async () => {
    const { store, watermark } = fakeStore(rows(3));
    await expect(
      relayAudit({
        store,
        stream: 'sts:production:bundle:o11y',
        send: async () => {
          throw new Error('queue unavailable');
        },
        now: Date.now(),
      })
    ).rejects.toThrow('queue unavailable');
    expect(watermark()).toBe(0);
  });

  it('prunes relayed rows past retention before reading', async () => {
    const { store, pruned } = fakeStore([]);
    const now = Date.now();
    await relayAudit({
      store,
      stream: 'sts:production:bundle:o11y',
      send: async () => {},
      now,
    });
    expect(pruned).toEqual([now - AUDIT_RETENTION_MS]);
  });
});
