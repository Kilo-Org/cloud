import { DurableObject } from 'cloudflare:workers';
import type { AuditBatch, AuditEvent } from '@kilocode/sts-contracts';
import { SecretUnavailableError } from '@kilocode/secrets-client';
import { withDORetry } from '@kilocode/worker-utils';
import type { Env } from '../env';
import {
  ArchiveConflictError,
  archiveObjectKey,
  readArchivedObject,
  writeArchivedBatch,
} from '../relay/archive';
import { ingestAuditEvents } from '../relay/axiom';
import { canonicalJson } from '../relay/canonical';
import { GENESIS_HASH, chainHash } from '../relay/chain';
import { errorName } from '../relay/error-name';
import { secretsFor } from '../secrets';
import { getRegistryDOStub } from './RegistryDO';

export type StreamHead = { seq: number; hash: string };

const GAP_RETRY_SECONDS = 30;
const FAILURE_RETRY_SECONDS = 60;
/**
 * A gap pages once it has turned away this many batches AND persisted this long. Both must hold:
 * consumer concurrency routinely delivers a burst of later batches before the next one, which
 * reaches the attempt count in seconds, while a single stuck batch retried every 30 s reaches
 * both thresholds together, around the time `max_retries: 10` sends it to the DLQ.
 */
export const GAP_PAGE_ATTEMPTS = 10;
export const GAP_PAGE_AFTER_MS = 5 * 60 * 1000;

const HEAD_KEY = 'head';
const GAP_KEY = 'gap';
const HOT_COPY_PREFIX = 'hot_copy:';

/**
 * The sequence the stream is waiting for, since when, and how many batches it turned away. A
 * record whose `expectedSeq` is not `head.seq + 1` belongs to a gap that has since closed.
 */
type GapWatch = { expectedSeq: number; since: number; attempts: number; paged: boolean };

/** One row per archived range, keyed by its `toSeq` so a listing is sequence order. */
function hotCopyKey(toSeq: number): string {
  return `${HOT_COPY_PREFIX}${String(toSeq).padStart(12, '0')}`;
}

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
 * archive. Rows are the archived ranges themselves, so they never overlap.
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
 * queue for another attempt; `gap_stalled` is a gap retry that also pages, once per gap;
 * `hot_gap` means archived but the hot copy is deferred to a replay job; `dropped` is a
 * non-retryable failure that lost the batch entirely; `duplicate_mismatch` is a batch at or below
 * the head that disagrees with the archive and is paged and acked unused.
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
  | { kind: 'dropped'; stream: string; fromSeq: number; reason: 'archive_conflict' }
  | {
      kind: 'gap_stalled';
      stream: string;
      fromSeq: number;
      expectedSeq: number;
      attempts: number;
      stalledMs: number;
      delaySeconds: number;
    }
  | {
      kind: 'duplicate_mismatch';
      stream: string;
      fromSeq: number;
      toSeq: number;
      reason: DuplicateMismatchReason;
    };

/**
 * Why a batch at or below the head disagrees with the archive: `content` differs from the object
 * at its `toSeq`, `unaligned` names a `toSeq` no object ends at, `corrupt` finds an object there
 * that does not decode.
 */
export type DuplicateMismatchReason = 'content' | 'unaligned' | 'corrupt';

type HotCopyResult =
  | { kind: 'delivered' }
  | Extract<StreamOutcome, { kind: 'retry' } | { kind: 'hot_gap' }>;

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
  // Serialises the batches addressed to this stream inside the instance: R2 and fetch awaits open
  // the input gate, so without it two batches could both read the same head. The head in storage
  // is what a fresh instance reads, so eviction only ever replays an idempotent attempt.
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

  /** Ranges a replay job must re-ingest from the archive into Axiom, oldest first. */
  async hotStoreGaps(limit = 1000): Promise<HotStoreGap[]> {
    const rows = await this.ctx.storage.list<HotStoreGap>({ prefix: HOT_COPY_PREFIX, limit });
    return [...rows.values()];
  }

  /** Marks a replayed range done; a later duplicate batch covering it also clears it. */
  async clearHotStoreGap(fromSeq: number, toSeq: number): Promise<void> {
    const key = hotCopyKey(toSeq);
    const row = await this.ctx.storage.get<HotStoreGap>(key);
    if (row?.fromSeq === fromSeq) await this.ctx.storage.delete(key);
  }

  private async applyBatch(batch: AuditBatch): Promise<StreamOutcome> {
    const head = await this.readHead();
    if (batch.toSeq <= head.seq) return this.replayIfOwed(batch, head);
    if (batch.fromSeq > head.seq + 1) return this.gapRetry(batch, head);

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
    // One write for the whole commit: the head and the promise to deliver this range to Axiom
    // land together, so an eviction here is replayed instead of silently losing the range.
    await this.ctx.storage.put<StreamHead | HotStoreGap>({
      [HEAD_KEY]: { seq: trimmed.toSeq, hash },
      [hotCopyKey(trimmed.toSeq)]: owed,
    });

    const hotCopy = await this.deliverHotCopy(trimmed, trimmed.events, [owed], [owed]);
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

  /** Retries a batch past a gap and pages, once per gap, when the gap stops closing. */
  private async gapRetry(batch: AuditBatch, head: StreamHead): Promise<StreamOutcome> {
    const expectedSeq = head.seq + 1;
    const now = Date.now();
    const stored = await this.ctx.storage.get<GapWatch>(GAP_KEY);
    const watch: GapWatch =
      stored?.expectedSeq === expectedSeq
        ? { ...stored, attempts: stored.attempts + 1 }
        : { expectedSeq, since: now, attempts: 1, paged: false };
    const stalledMs = now - watch.since;
    const stalled =
      !watch.paged && watch.attempts >= GAP_PAGE_ATTEMPTS && stalledMs >= GAP_PAGE_AFTER_MS;
    await this.ctx.storage.put<GapWatch>(GAP_KEY, { ...watch, paged: watch.paged || stalled });
    if (stalled) {
      return {
        kind: 'gap_stalled',
        stream: batch.stream,
        fromSeq: batch.fromSeq,
        expectedSeq,
        attempts: watch.attempts,
        stalledMs,
        delaySeconds: GAP_RETRY_SECONDS,
      };
    }
    return {
      kind: 'retry',
      stream: batch.stream,
      fromSeq: batch.fromSeq,
      reason: 'gap',
      delaySeconds: GAP_RETRY_SECONDS,
    };
  }

  /**
   * A batch at or below the head was already archived. It must agree with the archive before
   * anything else: a redelivery is byte-identical, so a difference is a forged or corrupted
   * message and is paged, never replayed. If owed hot-copy rows overlap an agreeing batch, the
   * redelivery is the second chance: ingest the events of those rows the message carries
   * (at-least-once, deduped by event id) and clear the rows it fully covers.
   */
  private async replayIfOwed(batch: AuditBatch, head: StreamHead): Promise<StreamOutcome> {
    let agreement: 'match' | DuplicateMismatchReason;
    try {
      agreement = await this.compareWithArchive(batch);
    } catch (error) {
      console.error(
        JSON.stringify({
          event: 'audit_relay.duplicate_check_failed',
          stream: batch.stream,
          toSeq: batch.toSeq,
          error: errorName(error),
        })
      );
      return {
        kind: 'retry',
        stream: batch.stream,
        fromSeq: batch.fromSeq,
        reason: 'archive',
        delaySeconds: FAILURE_RETRY_SECONDS,
      };
    }
    if (agreement !== 'match') {
      return {
        kind: 'duplicate_mismatch',
        stream: batch.stream,
        fromSeq: batch.fromSeq,
        toSeq: batch.toSeq,
        reason: agreement,
      };
    }

    const owed = await this.owedRowsWithin(batch);
    if (owed.length === 0) {
      return {
        kind: 'duplicate',
        stream: batch.stream,
        toSeq: batch.toSeq,
        headSeq: head.seq,
        replayed: false,
      };
    }

    const events = owed.flatMap(row =>
      batch.events.slice(
        Math.max(row.fromSeq, batch.fromSeq) - batch.fromSeq,
        Math.min(row.toSeq, batch.toSeq) - batch.fromSeq + 1
      )
    );
    const covered = owed.filter(row => row.fromSeq >= batch.fromSeq && row.toSeq <= batch.toSeq);
    const hotCopy = await this.deliverHotCopy(batch, events, owed, covered);
    if (hotCopy.kind !== 'delivered') return hotCopy;
    return {
      kind: 'duplicate',
      stream: batch.stream,
      toSeq: batch.toSeq,
      headSeq: head.seq,
      replayed: true,
    };
  }

  /**
   * Compares a duplicate with the archived object that ends at its `toSeq`. When the duplicate
   * covers the whole object, its trimmed form must re-hash to the stored chain hash; when it
   * covers only a suffix of the object (the producer split differently), the overlapping events
   * must serialise identically, which is the same test because the hash is
   * `sha256(prevHash || canonicalJson(batch))`. Throws on an R2 failure, which a retry fixes.
   */
  private async compareWithArchive(batch: AuditBatch): Promise<'match' | DuplicateMismatchReason> {
    const read = await readArchivedObject(
      this.env.AUDIT_ARCHIVE,
      archiveObjectKey(batch.stream, batch.toSeq)
    );
    if (read.kind === 'missing') return 'unaligned';
    if (read.kind === 'corrupt') return 'corrupt';
    const archived = read.object;
    if (archived.batch.toSeq !== batch.toSeq) return 'content';

    if (batch.fromSeq <= archived.batch.fromSeq) {
      const trimmed: AuditBatch = {
        ...batch,
        fromSeq: archived.batch.fromSeq,
        events: batch.events.slice(archived.batch.fromSeq - batch.fromSeq),
      };
      return (await chainHash(archived.prevHash, trimmed)) === archived.hash ? 'match' : 'content';
    }
    const overlap = archived.batch.events.slice(batch.fromSeq - archived.batch.fromSeq);
    return canonicalJson(overlap) === canonicalJson(batch.events) ? 'match' : 'content';
  }

  // Rows are disjoint archived ranges keyed by toSeq, so the ones overlapping the batch are the
  // run that starts at the first key at or above `batch.fromSeq`.
  private async owedRowsWithin(batch: AuditBatch): Promise<HotStoreGap[]> {
    const rows = await this.ctx.storage.list<HotStoreGap>({
      prefix: HOT_COPY_PREFIX,
      start: hotCopyKey(batch.fromSeq),
      limit: batch.events.length + 1,
    });
    return [...rows.values()].filter(row => row.fromSeq <= batch.toSeq);
  }

  /**
   * Ingests `events` and settles the owed rows they belong to: success deletes `cleared`, a
   * failure stamps every row in `owed` with the concrete reason so the replay job knows why.
   */
  private async deliverHotCopy(
    batch: AuditBatch,
    events: AuditEvent[],
    owed: HotStoreGap[],
    cleared: HotStoreGap[]
  ): Promise<HotCopyResult> {
    const range = { stream: batch.stream, fromSeq: batch.fromSeq, toSeq: batch.toSeq };

    let token: string;
    try {
      token = await secretsFor(this.env).get('AUDIT_RELAY_AXIOM_TOKEN', this.ctx);
    } catch (error) {
      const denied = error instanceof SecretUnavailableError && !error.retryable;
      const reason: HotCopyFailureReason = denied ? 'secrets_denied' : 'secrets_unavailable';
      await this.stampHotCopyRows(owed, reason);
      if (denied) return { kind: 'hot_gap', ...range, reason };
      return {
        kind: 'retry',
        stream: batch.stream,
        fromSeq: batch.fromSeq,
        reason: 'secrets',
        delaySeconds: FAILURE_RETRY_SECONDS,
      };
    }

    const ingest = await ingestAuditEvents(
      { url: this.env.AXIOM_URL, dataset: this.env.AXIOM_DATASET, token },
      events,
      fetch
    );
    switch (ingest.kind) {
      case 'ok':
        if (cleared.length > 0) {
          await this.ctx.storage.delete(cleared.map(row => hotCopyKey(row.toSeq)));
        }
        return { kind: 'delivered' };
      case 'retryable':
        await this.stampHotCopyRows(owed, 'axiom_unavailable');
        return {
          kind: 'retry',
          stream: batch.stream,
          fromSeq: batch.fromSeq,
          reason: 'axiom',
          delaySeconds: FAILURE_RETRY_SECONDS,
        };
      case 'rejected':
        await this.stampHotCopyRows(owed, 'axiom_rejected');
        return { kind: 'hot_gap', ...range, reason: 'axiom_rejected' };
    }
  }

  private async stampHotCopyRows(rows: HotStoreGap[], reason: HotCopyFailureReason): Promise<void> {
    const recordedAt = new Date().toISOString();
    const entries: Record<string, HotStoreGap> = {};
    for (const row of rows) entries[hotCopyKey(row.toSeq)] = { ...row, reason, recordedAt };
    await this.ctx.storage.put(entries);
  }

  private async readHead(): Promise<StreamHead> {
    return (await this.ctx.storage.get<StreamHead>(HEAD_KEY)) ?? { seq: 0, hash: GENESIS_HASH };
  }

  // The registry only indexes heads for the checkpoint and verify jobs. A failure there must not
  // stall the stream, so the head still advances and the miss is logged; the next batch of the
  // stream records the newer head.
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
