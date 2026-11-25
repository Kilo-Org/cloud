import { DurableObject } from 'cloudflare:workers';
import type { AuditBatch } from '@kilocode/sts-contracts';
import { withDORetry } from '@kilocode/worker-utils';
import type { Env } from '../env';
import { ArchiveConflictError, writeArchivedBatch } from '../relay/archive';
import { ingestAuditEvents } from '../relay/axiom';
import { GENESIS_HASH, chainHash } from '../relay/chain';
import { errorName } from '../relay/error-name';
import { SecretSourceError, createSecretSource } from '../secrets';
import { getRegistryDOStub } from './RegistryDO';

export type StreamHead = { seq: number; hash: string };

const GAP_RETRY_SECONDS = 30;
const FAILURE_RETRY_SECONDS = 60;
const HOT_GAPS_KEY = 'hot_gaps';

export type StreamRetryReason = 'gap' | 'archive' | 'axiom' | 'secrets';

export type HotCopyFailureReason =
  | 'axiom_rejected'
  | 'axiom_unavailable'
  | 'secrets_denied'
  | 'secrets_unavailable';

/**
 * One archived range whose Axiom delivery is owed. `pending` is written in the same storage write
 * as the head advance, before the ingest is attempted; a failure replaces it with a concrete
 * reason. Either state means the replay job (or a redelivered batch) re-ingests the range from the
 * archive, and `recordedAt` is the wall clock of the row.
 */
export type HotStoreGap = {
  stream: string;
  fromSeq: number;
  toSeq: number;
  reason: 'pending' | HotCopyFailureReason;
  recordedAt: string;
};

/**
 * One batch's fate. `accepted` means archived and delivered to Axiom; `duplicate` means the batch
 * was already archived (`replayed` says an owed hot-copy range was re-ingested); `retry` asks the
 * queue for another attempt; `hot_gap` means archived but the hot copy is deferred to a replay job;
 * `dropped` is a non-retryable failure that lost the batch entirely.
 */
export type StreamOutcome =
  | {
      kind: 'accepted';
      stream: string;
      fromSeq: number;
      toSeq: number;
      hash: string;
      archive: 'written' | 'existing';
    }
  | { kind: 'duplicate'; stream: string; toSeq: number; headSeq: number; replayed: boolean }
  | {
      kind: 'retry';
      stream: string;
      fromSeq: number;
      reason: StreamRetryReason;
      delaySeconds: number;
    }
  | {
      kind: 'hot_gap';
      stream: string;
      fromSeq: number;
      toSeq: number;
      reason: HotCopyFailureReason;
    }
  | { kind: 'dropped'; stream: string; fromSeq: number; reason: 'archive_conflict' };

function sameRange(
  row: { fromSeq: number; toSeq: number },
  range: { fromSeq: number; toSeq: number }
): boolean {
  return row.fromSeq === range.fromSeq && row.toSeq === range.toSeq;
}

/**
 * The single writer for one audit stream: it owns the chain head, the archive object for the
 * batch, and the Axiom ingest, in that order. Queues deliver at least once and in no fixed order,
 * so every step is idempotent by chain hash and replayable by sequence range.
 *
 * The archive is the evidence store, so the head advances as soon as the object is stored. Axiom
 * is the hot copy: the head advance and the intent to deliver that range land in one storage
 * write, so an eviction can never leave an advanced head with a range nobody recorded as owed.
 */
export class StreamDO extends DurableObject<Env> {
  // Serialises the batches addressed to this stream inside the instance; the head in storage is
  // what a fresh instance reads, so eviction only ever replays an idempotent attempt.
  private tail: Promise<unknown> = Promise.resolve();

  acceptBatch(batch: AuditBatch): Promise<StreamOutcome> {
    const run = this.tail.then(
      () => this.applyBatch(batch),
      () => this.applyBatch(batch)
    );
    this.tail = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  /** Ranges a replay job must re-ingest from the archive into Axiom, pending ones included. */
  async hotStoreGaps(): Promise<HotStoreGap[]> {
    return this.readHotStoreGaps();
  }

  /** Marks a replayed range done; a later duplicate batch covering it also clears it. */
  async clearHotStoreGap(fromSeq: number, toSeq: number): Promise<void> {
    const gaps = await this.readHotStoreGaps();
    await this.writeHotStoreGaps(
      gaps.filter(gap => gap.fromSeq !== fromSeq || gap.toSeq !== toSeq)
    );
  }

  private async applyBatch(batch: AuditBatch): Promise<StreamOutcome> {
    const head = await this.readHead();
    if (batch.toSeq <= head.seq) return this.replayIfGapped(batch, head);
    if (batch.fromSeq > head.seq + 1) {
      return {
        kind: 'retry',
        stream: batch.stream,
        fromSeq: batch.fromSeq,
        reason: 'gap',
        delaySeconds: GAP_RETRY_SECONDS,
      };
    }

    const fromSeq = Math.max(batch.fromSeq, head.seq + 1);
    const trimmed: AuditBatch =
      fromSeq === batch.fromSeq
        ? batch
        : { ...batch, fromSeq, events: batch.events.slice(fromSeq - batch.fromSeq) };
    const hash = await chainHash(head.hash, trimmed);

    let archive: 'written' | 'existing';
    try {
      archive = await writeArchivedBatch(this.env.AUDIT_ARCHIVE, {
        batch: trimmed,
        prevHash: head.hash,
        hash,
      });
    } catch (error) {
      if (error instanceof ArchiveConflictError) {
        return { kind: 'dropped', stream: trimmed.stream, fromSeq, reason: 'archive_conflict' };
      }
      console.error(
        JSON.stringify({
          event: 'audit_relay.archive_failed',
          stream: trimmed.stream,
          fromSeq,
          error: errorName(error),
        })
      );
      return {
        kind: 'retry',
        stream: trimmed.stream,
        fromSeq,
        reason: 'archive',
        delaySeconds: FAILURE_RETRY_SECONDS,
      };
    }

    await this.recordHead(trimmed.stream, trimmed.toSeq, hash);

    const owed: HotStoreGap = {
      stream: trimmed.stream,
      fromSeq,
      toSeq: trimmed.toSeq,
      reason: 'pending',
      recordedAt: new Date().toISOString(),
    };
    const gaps = await this.readHotStoreGaps();
    // One write for the whole commit: the head and the promise to deliver this range to Axiom
    // land together, so an eviction here is replayed instead of silently losing the range.
    await this.ctx.storage.put({
      stream: trimmed.stream,
      head: { seq: trimmed.toSeq, hash },
      [HOT_GAPS_KEY]: [...gaps.filter(gap => !sameRange(gap, owed)), owed],
    });

    const hotCopy = await this.deliverHotCopy(trimmed);
    if (hotCopy.kind !== 'delivered') return hotCopy;
    return {
      kind: 'accepted',
      stream: trimmed.stream,
      fromSeq,
      toSeq: trimmed.toSeq,
      hash,
      archive,
    };
  }

  /**
   * A batch at or below the head was already archived. If an owed hot-copy range overlaps it, the
   * redelivery is the second chance: re-ingest the events the message still carries (at-least-once,
   * deduped by event id) and clear the rows it fully covers.
   */
  private async replayIfGapped(batch: AuditBatch, head: StreamHead): Promise<StreamOutcome> {
    const gaps = await this.readHotStoreGaps();
    const overlapping = gaps.some(gap => gap.toSeq >= batch.fromSeq && gap.fromSeq <= batch.toSeq);
    if (!overlapping) {
      return {
        kind: 'duplicate',
        stream: batch.stream,
        toSeq: batch.toSeq,
        headSeq: head.seq,
        replayed: false,
      };
    }

    const hotCopy = await this.deliverHotCopy(batch);
    if (hotCopy.kind !== 'delivered') return hotCopy;

    const covered = (gap: HotStoreGap) => gap.fromSeq >= batch.fromSeq && gap.toSeq <= batch.toSeq;
    await this.writeHotStoreGaps(gaps.filter(gap => !covered(gap)));
    return {
      kind: 'duplicate',
      stream: batch.stream,
      toSeq: batch.toSeq,
      headSeq: head.seq,
      replayed: true,
    };
  }

  private async deliverHotCopy(
    batch: AuditBatch
  ): Promise<
    { kind: 'delivered' } | Extract<StreamOutcome, { kind: 'retry' } | { kind: 'hot_gap' }>
  > {
    const range = { stream: batch.stream, fromSeq: batch.fromSeq, toSeq: batch.toSeq };

    let token: string;
    try {
      token = await createSecretSource(this.env).get('AUDIT_RELAY_AXIOM_TOKEN');
    } catch (error) {
      const denied = error instanceof SecretSourceError && !error.retryable;
      const reason: HotCopyFailureReason = denied ? 'secrets_denied' : 'secrets_unavailable';
      await this.recordHotStoreGap({ ...range, reason });
      if (denied) return { kind: 'hot_gap', ...range, reason };
      return {
        kind: 'retry',
        ...range,
        reason: 'secrets',
        delaySeconds: FAILURE_RETRY_SECONDS,
      };
    }

    const ingest = await ingestAuditEvents(
      { url: this.env.AXIOM_URL, dataset: this.env.AXIOM_DATASET, token },
      batch.events,
      fetch
    );
    switch (ingest.kind) {
      case 'ok':
        await this.clearHotStoreGap(batch.fromSeq, batch.toSeq);
        return { kind: 'delivered' };
      case 'retryable':
        await this.recordHotStoreGap({ ...range, reason: 'axiom_unavailable' });
        return {
          kind: 'retry',
          ...range,
          reason: 'axiom',
          delaySeconds: FAILURE_RETRY_SECONDS,
        };
      case 'rejected':
        await this.recordHotStoreGap({ ...range, reason: 'axiom_rejected' });
        return { kind: 'hot_gap', ...range, reason: 'axiom_rejected' };
    }
  }

  private async readHead(): Promise<StreamHead> {
    const stored = await this.ctx.storage.get<StreamHead>('head');
    return stored ?? { seq: 0, hash: GENESIS_HASH };
  }

  private async readHotStoreGaps(): Promise<HotStoreGap[]> {
    return (await this.ctx.storage.get<HotStoreGap[]>(HOT_GAPS_KEY)) ?? [];
  }

  private async writeHotStoreGaps(gaps: HotStoreGap[]): Promise<void> {
    await this.ctx.storage.put(HOT_GAPS_KEY, gaps);
  }

  // Replaces the pending row for the range with the concrete failure, keeping one row per range.
  private async recordHotStoreGap(gap: Omit<HotStoreGap, 'recordedAt'>): Promise<void> {
    const gaps = await this.readHotStoreGaps();
    const entry: HotStoreGap = { ...gap, recordedAt: new Date().toISOString() };
    const others = gaps.filter(existing => !sameRange(existing, gap));
    // Read-modify-write without an I/O boundary: the input gate keeps it atomic.
    await this.writeHotStoreGaps([...others, entry]);
  }

  // The registry only indexes heads for the checkpoint and verify jobs. A failure there must not
  // stall the stream, so the head still advances and the gap is logged for an operator.
  private async recordHead(stream: string, seq: number, hash: string): Promise<void> {
    try {
      await withDORetry(
        () => getRegistryDOStub(this.env),
        stub => stub.recordHead(stream, seq, hash),
        'recordHead'
      );
    } catch (error) {
      console.error(
        JSON.stringify({
          event: 'audit_relay.registry_record_failed',
          stream,
          seq,
          error: errorName(error),
        })
      );
    }
  }
}

export function getStreamDOStub(
  env: Pick<Env, 'AUDIT_STREAM'>,
  stream: string
): DurableObjectStub<StreamDO> {
  return env.AUDIT_STREAM.get(env.AUDIT_STREAM.idFromName(stream));
}
