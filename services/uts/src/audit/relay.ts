import {
  AUDIT_BATCH_MAX_EVENTS,
  AuditBatchTooLargeError,
  type AuditBatch,
  type AuditEvent,
} from '@kilocode/sts-contracts';
import type { UtsEnvironment } from '@kilocode/uts-contracts';

/**
 * The UTS audit outbox relay (design 8.1). Each of the 8 shards (audit row id modulo 8) is one
 * audit stream, `uts:<environment>:<shard>`, whose sequence numbers count that shard's rows in
 * (`txid`, `id`) order. A run reads committed rows past the shard's watermark, sends them as
 * `AuditBatch` messages, and moves the watermark after each message the queue accepted.
 *
 * At least once, never a gap:
 * * The watermark moves only after the queue accepted the batch, and only from the sequence
 *   number it was read at. A send that threw, or a stop between the send and the watermark write,
 *   leaves the watermark where it was, so the next run sends the same rows again under the same
 *   sequence numbers; the audit relay service dedupes them against its archive.
 * * A repeated read past an unchanged watermark starts with the same rows in the same order
 *   (`RELAY_READ` in `outbox.ts`), so a resent range carries the same events at the same numbers.
 */

/** Rows per read and per batch; the contract's cap. */
export const RELAY_READ_LIMIT = AUDIT_BATCH_MAX_EVENTS;

/** Reads per run; a larger backlog continues in the next run, which starts at once. */
export const RELAY_MAX_READS_PER_RUN = 10;

export const AUDIT_SHARD_COUNT = 8;

export type ShardWatermark = { txid: bigint; id: bigint; seq: bigint };

export type OutboxRow = { txid: bigint; id: bigint; event: AuditEvent };

export type OutboxRead =
  | { status: 'empty' }
  | { status: 'rows'; watermarkSeq: bigint; rows: readonly OutboxRow[] };

export type AuditOutbox = {
  /** Up to `limit` committed rows past the shard's watermark, oldest first. */
  read(shard: number, limit: number): Promise<OutboxRead>;
  /**
   * Moves the shard's watermark to `to`, only while it still stands at `fromSeq`. `false`: it had
   * moved, so another runner owns the shard now.
   */
  advance(shard: number, fromSeq: bigint, to: ShardWatermark): Promise<boolean>;
};

/** Sends one batch as one queue message; throws `AuditBatchTooLargeError` for a batch to split. */
export type SendBatch = (batch: AuditBatch) => Promise<void>;

/** The shard's watermark moved under this run: another runner relays the shard. */
export class WatermarkMovedError extends Error {
  override name = 'WatermarkMovedError';
  constructor(readonly shard: number) {
    super(`audit relay watermark of shard ${shard} moved under this run`);
  }
}

/**
 * A single row the encoder refuses. The database's 8 KB row limit makes this impossible; the run
 * stops with the watermark in place rather than skip the row.
 */
export class AuditRowTooLargeError extends Error {
  override name = 'AuditRowTooLargeError';
  constructor(readonly shard: number) {
    super(`an audit row of shard ${shard} does not fit one queue message`);
  }
}

/**
 * `idle`: nothing past the watermark. `drained`: sent everything the reads found. `more`: the run
 * stopped at its read budget with a full last read, so more rows may wait.
 */
export type RelayRunResult = { status: 'idle' | 'drained' | 'more'; sent: number };

export function auditStreamName(environment: UtsEnvironment, shard: number): string {
  return `uts:${environment}:${shard}`;
}

/** Sequence numbers in a batch are JSON numbers; a stream never nears 2^53 rows. */
function toSeqNumber(seq: bigint): number {
  if (seq > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError('audit sequence past 2^53');
  return Number(seq);
}

type ShardRun = {
  outbox: AuditOutbox;
  shard: number;
  stream: string;
  send: SendBatch;
};

/**
 * Sends `rows`, numbered from `fromSeq`, as one batch, or as halves when the encoder refuses the
 * batch, moving the watermark after each accepted message. Returns the next free sequence number.
 */
async function sendRows(
  run: ShardRun,
  rows: readonly OutboxRow[],
  fromSeq: bigint
): Promise<bigint> {
  const count = BigInt(rows.length);
  const toSeq = fromSeq + count - 1n;
  try {
    await run.send({
      schemaVersion: 1,
      stream: run.stream,
      fromSeq: toSeqNumber(fromSeq),
      toSeq: toSeqNumber(toSeq),
      events: rows.map(row => row.event),
    });
  } catch (error) {
    if (!(error instanceof AuditBatchTooLargeError)) throw error;
    if (rows.length === 1) throw new AuditRowTooLargeError(run.shard);
    const middle = Math.ceil(rows.length / 2);
    const next = await sendRows(run, rows.slice(0, middle), fromSeq);
    return await sendRows(run, rows.slice(middle), next);
  }
  const last = rows[rows.length - 1];
  const moved = await run.outbox.advance(run.shard, fromSeq - 1n, {
    txid: last.txid,
    id: last.id,
    seq: toSeq,
  });
  if (!moved) throw new WatermarkMovedError(run.shard);
  return toSeq + 1n;
}

/** One relay run for one shard: up to `RELAY_MAX_READS_PER_RUN` reads of up to 500 rows each. */
export async function relayShard(run: ShardRun): Promise<RelayRunResult> {
  let sent = 0;
  for (let reads = 0; reads < RELAY_MAX_READS_PER_RUN; reads += 1) {
    const read = await run.outbox.read(run.shard, RELAY_READ_LIMIT);
    if (read.status === 'empty') return { status: sent === 0 ? 'idle' : 'drained', sent };
    await sendRows(run, read.rows, read.watermarkSeq + 1n);
    sent += read.rows.length;
    if (read.rows.length < RELAY_READ_LIMIT) return { status: 'drained', sent };
  }
  return { status: 'more', sent };
}
