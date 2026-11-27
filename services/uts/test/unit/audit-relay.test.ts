import {
  AuditBatchTooLargeError,
  encodeAuditBatch,
  OCSF_API_ACTIVITY,
  OCSF_CLASS,
  type AuditBatch,
  type AuditEvent,
} from '@kilocode/sts-contracts';
import { describe, expect, it } from 'vitest';
import {
  AuditRowTooLargeError,
  RELAY_MAX_READS_PER_RUN,
  RELAY_READ_LIMIT,
  WatermarkMovedError,
  auditStreamName,
  relayShard,
  type AuditOutbox,
  type OutboxRow,
  type ShardWatermark,
} from '../../src/audit/relay';

const SHARD = 3;
const STREAM = auditStreamName('development', SHARD);

function event(attributes: Record<string, string> = {}): AuditEvent {
  return {
    specversion: '1.0',
    id: crypto.randomUUID(),
    source: 'kilo:uts:development',
    type: 'ai.kilo.uts.token.issued',
    time: new Date().toISOString(),
    datacontenttype: 'application/json',
    data: {
      classUid: OCSF_CLASS.apiActivity,
      activityId: OCSF_API_ACTIVITY.create,
      outcome: 'success',
      actor: { kind: 'user', id: 'oauth/test' },
      attributes,
    },
  };
}

function randomText(length: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return btoa(String.fromCharCode(...bytes)).slice(0, length);
}

/**
 * An outbox over a list of rows already in (`txid`, `id`) order, with the watermark's
 * compare-and-set. `failAdvance` makes the next advances throw after the send, as a stop between
 * the send and the watermark write does.
 */
class MemoryOutbox implements AuditOutbox {
  watermark: ShardWatermark = { txid: 0n, id: 0n, seq: 0n };
  failAdvance = 0;
  readonly rows: OutboxRow[];

  constructor(count: number, makeEvent: (index: number) => AuditEvent = () => event()) {
    this.rows = Array.from({ length: count }, (_, index) => ({
      txid: BigInt(1000 + index),
      id: BigInt(index + 1),
      event: makeEvent(index),
    }));
  }

  async read(shard: number, limit: number) {
    expect(shard).toBe(SHARD);
    const { txid, id } = this.watermark;
    const rows = this.rows
      .filter(row => row.txid > txid || (row.txid === txid && row.id > id))
      .slice(0, limit);
    return rows.length === 0
      ? { status: 'empty' as const }
      : { status: 'rows' as const, watermarkSeq: this.watermark.seq, rows };
  }

  async advance(shard: number, fromSeq: bigint, to: ShardWatermark) {
    expect(shard).toBe(SHARD);
    if (this.failAdvance > 0) {
      this.failAdvance -= 1;
      throw new Error('connection lost');
    }
    if (this.watermark.seq !== fromSeq) return false;
    this.watermark = to;
    return true;
  }
}

/**
 * The audit relay service's view of one stream: an accepted range must start right after its
 * head, a range at or below the head is a duplicate that must match what was archived, and a
 * range across the head archives only its new suffix.
 */
class StreamSink {
  readonly archived: AuditEvent[] = [];
  duplicates = 0;

  accept(batch: AuditBatch): void {
    expect(batch.stream).toBe(STREAM);
    const head = this.archived.length;
    expect(batch.fromSeq).toBeLessThanOrEqual(head + 1);
    batch.events.forEach((item, offset) => {
      const seq = batch.fromSeq + offset;
      if (seq <= head) {
        expect(item).toEqual(this.archived[seq - 1]);
        this.duplicates += 1;
      } else {
        this.archived.push(item);
      }
    });
  }
}

function sender(sink: StreamSink, sent: AuditBatch[] = []) {
  return async (batch: AuditBatch) => {
    await encodeAuditBatch(batch);
    sent.push(batch);
    sink.accept(batch);
  };
}

describe('UTS audit outbox relay', () => {
  it('does nothing when no row waits', async () => {
    const outbox = new MemoryOutbox(0);
    const sent: AuditBatch[] = [];
    const result = await relayShard({
      outbox,
      shard: SHARD,
      stream: STREAM,
      send: sender(new StreamSink(), sent),
    });
    expect(result).toEqual({ status: 'idle', sent: 0 });
    expect(sent).toEqual([]);
  });

  it('sends contiguous batches of at most 500 rows and moves the watermark after each', async () => {
    const outbox = new MemoryOutbox(1_200);
    const sink = new StreamSink();
    const sent: AuditBatch[] = [];
    const result = await relayShard({
      outbox,
      shard: SHARD,
      stream: STREAM,
      send: sender(sink, sent),
    });
    expect(result).toEqual({ status: 'drained', sent: 1_200 });
    expect(sent.map(batch => [batch.fromSeq, batch.toSeq])).toEqual([
      [1, 500],
      [501, 1_000],
      [1_001, 1_200],
    ]);
    expect(outbox.watermark).toEqual({ txid: 2_199n, id: 1_200n, seq: 1_200n });
    expect(sink.archived).toEqual(outbox.rows.map(row => row.event));
  });

  it('stops at its read budget and reports that more rows may wait', async () => {
    const total = RELAY_READ_LIMIT * RELAY_MAX_READS_PER_RUN + 1;
    const outbox = new MemoryOutbox(total);
    const sink = new StreamSink();
    const first = await relayShard({ outbox, shard: SHARD, stream: STREAM, send: sender(sink) });
    expect(first).toEqual({ status: 'more', sent: total - 1 });
    const second = await relayShard({ outbox, shard: SHARD, stream: STREAM, send: sender(sink) });
    expect(second).toEqual({ status: 'drained', sent: 1 });
    expect(sink.archived).toHaveLength(total);
  });

  it('keeps the watermark when the queue refuses a send, and sends the same range next run', async () => {
    const outbox = new MemoryOutbox(10);
    const sink = new StreamSink();
    const failing = async () => {
      throw new Error('queue unavailable');
    };
    await expect(
      relayShard({ outbox, shard: SHARD, stream: STREAM, send: failing })
    ).rejects.toThrow('queue unavailable');
    expect(outbox.watermark.seq).toBe(0n);

    const sent: AuditBatch[] = [];
    await relayShard({ outbox, shard: SHARD, stream: STREAM, send: sender(sink, sent) });
    expect(sent.map(batch => [batch.fromSeq, batch.toSeq])).toEqual([[1, 10]]);
    expect(sink.archived).toEqual(outbox.rows.map(row => row.event));
  });

  it('resends a batch the queue took before a stop, and the sink sees a duplicate and no gap', async () => {
    const outbox = new MemoryOutbox(700);
    const sink = new StreamSink();
    const sent: AuditBatch[] = [];
    outbox.failAdvance = 1;
    await expect(
      relayShard({ outbox, shard: SHARD, stream: STREAM, send: sender(sink, sent) })
    ).rejects.toThrow('connection lost');
    expect(outbox.watermark.seq).toBe(0n);

    outbox.rows.push({ txid: 5_000n, id: 701n, event: event() });
    await relayShard({ outbox, shard: SHARD, stream: STREAM, send: sender(sink, sent) });
    expect(sent.map(batch => [batch.fromSeq, batch.toSeq])).toEqual([
      [1, 500],
      [1, 500],
      [501, 701],
    ]);
    expect(sent[1]).toEqual(sent[0]);
    expect(sink.duplicates).toBe(500);
    expect(sink.archived).toEqual(outbox.rows.map(row => row.event));
    expect(outbox.watermark.seq).toBe(701n);
  });

  it('halves a batch the encoder refuses, keeping the sequence contiguous', async () => {
    const outbox = new MemoryOutbox(RELAY_READ_LIMIT, () => event({ filler: randomText(400) }));
    const sink = new StreamSink();
    const sent: AuditBatch[] = [];
    await relayShard({ outbox, shard: SHARD, stream: STREAM, send: sender(sink, sent) });
    expect(sent.length).toBeGreaterThan(1);
    sent.forEach((batch, index) => {
      expect(batch.fromSeq).toBe(index === 0 ? 1 : sent[index - 1].toSeq + 1);
    });
    expect(sent.at(-1)?.toSeq).toBe(RELAY_READ_LIMIT);
    expect(sink.archived).toEqual(outbox.rows.map(row => row.event));
  });

  it('stops with the watermark in place on a single row the encoder refuses', async () => {
    const outbox = new MemoryOutbox(3);
    const refuse = async () => {
      throw new AuditBatchTooLargeError(70_000, 10);
    };
    await expect(
      relayShard({ outbox, shard: SHARD, stream: STREAM, send: refuse })
    ).rejects.toThrow(AuditRowTooLargeError);
    expect(outbox.watermark.seq).toBe(0n);
  });

  it('stops when another runner moved the watermark', async () => {
    const outbox = new MemoryOutbox(5);
    const sink = new StreamSink();
    const racing = async (batch: AuditBatch) => {
      await sender(sink)(batch);
      outbox.watermark = { txid: 1_004n, id: 5n, seq: 5n };
    };
    await expect(
      relayShard({ outbox, shard: SHARD, stream: STREAM, send: racing })
    ).rejects.toThrow(WatermarkMovedError);
    expect(outbox.watermark.seq).toBe(5n);
  });
});
