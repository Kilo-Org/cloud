import { describe, expect, it } from 'vitest';
import {
  AuditBatchTooLargeError,
  AuditEventSchema,
  encodeAuditBatch,
  type AuditBatch,
  type AuditEvent,
} from './audit';
import {
  AuditEventTooLargeError,
  assertRelayable,
  relayAudit,
  type AuditRelayStore,
  type AuditRow,
} from './audit-relay';

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

function fakeStore(initial: AuditRow[]): { store: AuditRelayStore; watermark: () => number } {
  let watermark = 0;
  return {
    store: {
      nextRows: (afterSeq, limit) => initial.filter(row => row.seq > afterSeq).slice(0, limit),
      watermark: () => watermark,
      advanceWatermark: toSeq => {
        watermark = toSeq;
      },
    },
    watermark: () => watermark,
  };
}

function oversizedEvent(): AuditEvent {
  return auditEvent(
    Object.fromEntries(
      Array.from({ length: 300 }, (_unused, index) => [`k${index}`, randomFiller(300)])
    )
  );
}

describe('audit relay', () => {
  it('sends contiguous batches of at most 500 events and advances the watermark', async () => {
    const { store, watermark } = fakeStore(rows(600));
    const batches: AuditBatch[] = [];
    const sent = await relayAudit({
      store,
      stream: 'sts:production:bundle:o11y',
      send: async batch => {
        await encodeAuditBatch(batch);
        batches.push(batch);
      },
    });

    expect(batches.map(batch => [batch.fromSeq, batch.toSeq])).toEqual([
      [1, 500],
      [501, 600],
    ]);
    expect(batches[0].stream).toBe('sts:production:bundle:o11y');
    expect(sent).toBe(600);
    expect(watermark()).toBe(600);
  });

  it('splits a batch the queue rejects as larger than 60 KB', async () => {
    const { store, watermark } = fakeStore(rows(500, 300));
    const batches: AuditBatch[] = [];
    const sent = await relayAudit({
      store,
      stream: 'sts:production:bundle:o11y',
      send: async batch => {
        await encodeAuditBatch(batch);
        batches.push(batch);
      },
    });

    expect(batches.length).toBeGreaterThan(1);
    const covered: number[] = [];
    for (const batch of batches) {
      expect(batch.toSeq - batch.fromSeq + 1).toBe(batch.events.length);
      for (let seq = batch.fromSeq; seq <= batch.toSeq; seq += 1) covered.push(seq);
    }
    expect(covered).toEqual(Array.from({ length: 500 }, (_unused, index) => index + 1));
    expect(sent).toBe(500);
    expect(watermark()).toBe(500);
  });

  it('never skips an event: one that cannot fit alone stops the relay before it', async () => {
    const initial: AuditRow[] = [
      { seq: 1, event: auditEvent({ filler: randomFiller(32) }) },
      { seq: 2, event: oversizedEvent() },
      { seq: 3, event: auditEvent({ filler: randomFiller(32) }) },
    ];
    const { store, watermark } = fakeStore(initial);
    const batches: AuditBatch[] = [];
    await expect(
      relayAudit({
        store,
        stream: 'sts:production:bundle:o11y',
        send: async batch => {
          await encodeAuditBatch(batch);
          batches.push(batch);
        },
      })
    ).rejects.toBeInstanceOf(AuditEventTooLargeError);

    expect(batches.map(batch => [batch.fromSeq, batch.toSeq])).toEqual([[1, 1]]);
    expect(watermark()).toBe(1);
  });

  it('refuses at append time an event that could not be relayed alone', async () => {
    await expect(
      encodeAuditBatch({
        schemaVersion: 1,
        stream: 'sts:production:bundle:o11y',
        fromSeq: 1,
        toSeq: 1,
        events: [oversizedEvent()],
      })
    ).rejects.toBeInstanceOf(AuditBatchTooLargeError);
    await expect(
      assertRelayable('sts:production:bundle:o11y', oversizedEvent())
    ).rejects.toBeInstanceOf(AuditEventTooLargeError);
    await expect(
      assertRelayable('sts:production:bundle:o11y', auditEvent({ filler: randomFiller(32) }))
    ).resolves.toBeUndefined();
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
      })
    ).rejects.toThrow('queue unavailable');
    expect(watermark()).toBe(0);
  });
});
