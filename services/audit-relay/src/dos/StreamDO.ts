import { DurableObject } from 'cloudflare:workers';
import type { AuditBatch, AuditEvent } from '@kilocode/sts-contracts';
import { SecretUnavailableError } from '@kilocode/secrets-client';
import { withDORetry } from '@kilocode/worker-utils';
import type { Env } from '../env';
import { pageOperator } from '../page';
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
const ARCHIVE_RETRY_SECONDS = 60;
/**
 * A gap pages once it has turned away this many batches AND persisted this long. Both must hold:
 * consumer concurrency routinely delivers a burst of later batches before the next one, which
 * reaches the attempt count in seconds, while a single stuck batch retried every 30 s reaches
 * both thresholds together after about 5 minutes, well before its 24 retries (about 12 minutes)
 * send it to the DLQ.
 */
export const GAP_PAGE_ATTEMPTS = 10;
export const GAP_PAGE_AFTER_MS = 5 * 60 * 1000;

/** Owed hot-copy rows one alarm delivers before it re-arms; each is one R2 GET and one POST. */
export const HOT_COPY_ROWS_PER_ALARM = 50;
/** Alarm backoff after a failed delivery: 30 s doubling, with jitter, capped at 15 minutes. */
export const HOT_COPY_BACKOFF_BASE_MS = 30_000;
export const HOT_COPY_BACKOFF_CAP_MS = 15 * 60 * 1000;
/** The safety-net alarm a commit arms, for a pending row whose inline ingest never finished. */
export const PENDING_ROW_ALARM_MS = 5 * 60 * 1000;
/**
 * A stream-wide hot-copy failure pages only once it is real: two failed alarm runs in a row, or
 * an owed row older than this. A blip that the next alarm run clears pages nothing.
 */
export const HOT_COPY_PAGE_AFTER_MS = 5 * 60 * 1000;
export const HOT_COPY_PAGE_AFTER_RUNS = 2;
/** A paged failure that still owes a row older than this pages a second time, once. */
export const OWED_ROW_PAGE_AGE_MS = 6 * 60 * 60 * 1000;
/**
 * Hot-copy problem pages (start, age, parked row) of one stream go out at most once per this
 * window; the recovery page of a paged failure always goes out and restarts the window.
 */
export const HOT_COPY_PAGE_INTERVAL_MS = 60 * 60 * 1000;
/** Dead letters of one stream page at most once per this window. */
export const DEAD_LETTER_PAGE_INTERVAL_MS = 60 * 60 * 1000;

const HEAD_KEY = 'head';
const GAP_KEY = 'gap';
const HOT_STATE_KEY = 'hot_state';
const DEAD_LETTER_PAGED_KEY = 'dead_letter_paged_at';
const HOT_COPY_PREFIX = 'hot_copy:';
const PARKED_PREFIX = 'hot_copy_parked:';

/**
 * The sequence the stream is waiting for, since when, and how many batches it turned away. A
 * record whose `expectedSeq` is not `head.seq + 1` belongs to a gap that has since closed.
 */
type GapWatch = { expectedSeq: number; since: number; attempts: number; paged: boolean };

/** One row per archived range, keyed by its `toSeq` so a listing is sequence order. */
function hotCopyKey(toSeq: number): string {
  return `${HOT_COPY_PREFIX}${String(toSeq).padStart(12, '0')}`;
}

/** A row the alarm no longer retries, kept for an operator under its own prefix. */
function parkedKey(toSeq: number): string {
  return `${PARKED_PREFIX}${String(toSeq).padStart(12, '0')}`;
}

/**
 * Which failures can belong to one row rather than to the whole hot copy:
 *
 * - `archive_unreadable` (the row's archive object is missing, does not decode, or no longer
 *   starts at the row's `fromSeq`) is always about that row: it is parked at once and paged
 *   outside the hourly cap, because it means the archive changed under the relay.
 * - `axiom_rejected` (Axiom refused the payload: 400, 413, 422) is about the row only once a
 *   later row is delivered in the same alarm run; then the row is parked. A rejection with no
 *   delivery after it, or two rejections in a row, is a stream-wide failure (a dataset or schema
 *   problem), so the rows stay owed under backoff and paging.
 *
 * Every other reason, `axiom_refused` (any other 4xx, such as a missing dataset) included, is
 * stream-wide.
 */
export type HotCopyFailureReason =
  | 'axiom_rejected'
  | 'axiom_refused'
  | 'axiom_unavailable'
  | 'secrets_denied'
  | 'secrets_unavailable'
  | 'archive_unreadable'
  | 'archive_unavailable';

/**
 * One archived range whose Axiom delivery is owed. `pending` is written in the same storage write
 * as the head advance, before the ingest is attempted; a failure replaces it with the concrete
 * reason. The StreamDO alarm delivers every row from the archive and deletes it. Rows are the
 * archived ranges themselves, so they never overlap. `recordedAt` is when the range was archived
 * and stays fixed, so it measures how long the hot copy has owed it.
 */
export type HotStoreGap = {
  stream: string;
  fromSeq: number;
  toSeq: number;
  reason: 'pending' | HotCopyFailureReason;
  recordedAt: string;
};

/**
 * The hot copy's health for the stream. `failing` is the current stream-wide failure (cleared,
 * with a recovery page if it was paged, once the alarm has delivered every owed row); `attempts`
 * counts failed alarm runs in a row and drives the backoff; `lastPageAt` enforces the page cap
 * across failures.
 */
type HotCopyState = {
  stream: string;
  attempts: number;
  failing: {
    reason: HotCopyFailureReason;
    since: string;
    paged: boolean;
    agePaged: boolean;
  } | null;
  lastPageAt: number | null;
};

/**
 * One batch's fate. `accepted` means archived; `hotCopy` says whether Axiom has it yet or the
 * alarm owes it. `duplicate` means the batch was already archived and agrees with the archive;
 * `retry` asks the queue for another attempt (a gap, or an archive write that failed);
 * `gap_stalled` is a gap retry that also pages, once per gap; `dropped` is an archive conflict
 * that lost the batch entirely; `duplicate_mismatch` is a batch at or below the head that
 * disagrees with the archive and is paged and acked unused.
 */
export type StreamOutcome =
  | {
      kind: 'accepted';
      stream: string;
      fromSeq: number;
      toSeq: number;
      hash: string;
      archive: 'written' | 'existing';
      hotCopy: 'delivered' | 'owed';
    }
  | { kind: 'duplicate'; stream: string; toSeq: number; headSeq: number }
  | {
      kind: 'retry';
      stream: string;
      fromSeq: number;
      reason: 'gap' | 'archive';
      delaySeconds: number;
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

type Delivery = { kind: 'delivered' } | { kind: 'failed'; reason: HotCopyFailureReason };

/**
 * The single writer for one audit stream: it owns the chain head, the archive object for the
 * batch, and the Axiom ingest, in that order. Queues deliver at least once and in no fixed order,
 * so every step is idempotent by chain hash and replayable by sequence range.
 *
 * The archive is the evidence store: the head advances, and the message is acked, as soon as the
 * object is stored. Axiom is the hot copy and never holds a message: the head and the row that
 * owes the range to Axiom land in one storage write, the batch tries the ingest once, and a
 * failure leaves the row to the alarm, which retries with backoff and pages once per failure.
 */
export class StreamDO extends DurableObject<Env> {
  // Serialises batches and alarm runs inside the instance: R2 and fetch awaits open the input
  // gate, so without it two batches could read the same head, or the alarm could re-create a row
  // a batch just delivered. A fresh instance reads storage, so eviction only replays idempotent work.
  private tail: Promise<unknown> = Promise.resolve();

  acceptBatch(batch: AuditBatch): Promise<StreamOutcome> {
    return this.serialised(() => this.applyBatch(batch));
  }

  async alarm(): Promise<void> {
    await this.serialised(() => this.drainHotCopy());
  }

  /** Owed rows the alarm still retries, then parked rows, each oldest first, for an operator. */
  async hotStoreGaps(limit = 1000): Promise<HotStoreGap[]> {
    const [owed, parked] = await Promise.all([
      this.ctx.storage.list<HotStoreGap>({ prefix: HOT_COPY_PREFIX, limit }),
      this.ctx.storage.list<HotStoreGap>({ prefix: PARKED_PREFIX, limit }),
    ]);
    return [...owed.values(), ...parked.values()].slice(0, limit);
  }

  /** Drops an owed or parked row an operator has replayed or written off. */
  async clearHotStoreGap(fromSeq: number, toSeq: number): Promise<void> {
    for (const key of [hotCopyKey(toSeq), parkedKey(toSeq)]) {
      const row = await this.ctx.storage.get<HotStoreGap>(key);
      if (row?.fromSeq === fromSeq) await this.ctx.storage.delete(key);
    }
  }

  /** The archived head sequence; the DLQ consumer treats a batch at or below it as a no-op. */
  async headSeq(): Promise<number> {
    return (await this.readHead()).seq;
  }

  /** True at most once per `DEAD_LETTER_PAGE_INTERVAL_MS` for this stream. */
  async claimDeadLetterPage(now: number = Date.now()): Promise<boolean> {
    const last = await this.ctx.storage.get<number>(DEAD_LETTER_PAGED_KEY);
    if (last !== undefined && now - last < DEAD_LETTER_PAGE_INTERVAL_MS) return false;
    await this.ctx.storage.put(DEAD_LETTER_PAGED_KEY, now);
    return true;
  }

  private serialised<T>(work: () => Promise<T>): Promise<T> {
    const run = this.tail.then(work, work);
    this.tail = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  private async applyBatch(batch: AuditBatch): Promise<StreamOutcome> {
    const head = await this.readHead();
    if (batch.toSeq <= head.seq) return this.checkDuplicate(batch, head);
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
        delaySeconds: ARCHIVE_RETRY_SECONDS,
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
    const [alarm, state] = await Promise.all([
      this.ctx.storage.getAlarm(),
      this.readHotState(trimmed.stream),
    ]);
    // One atomic write (no await between the calls): the head, the row that owes the range to
    // Axiom, and, when nothing is scheduled, the alarm that delivers the row if this instance
    // dies before the ingest below finishes.
    const commit: Promise<unknown>[] = [
      this.ctx.storage.put<StreamHead | HotStoreGap>({
        [HEAD_KEY]: { seq: trimmed.toSeq, hash },
        [hotCopyKey(trimmed.toSeq)]: owed,
      }),
    ];
    if (alarm === null) commit.push(this.ctx.storage.setAlarm(Date.now() + PENDING_ROW_ALARM_MS));
    await Promise.all(commit);

    // While the whole hot copy is failing, a batch leaves its row to the alarm's backoff instead
    // of adding one more doomed call per batch.
    let hotCopy: 'delivered' | 'owed' = 'owed';
    if (!state.failing) {
      const delivery = await this.deliverRow(owed, trimmed.events);
      if (delivery.kind === 'delivered') hotCopy = 'delivered';
      else await this.noteFailure(state, delivery.reason, false, owed);
    }
    return {
      kind: 'accepted',
      stream: trimmed.stream,
      fromSeq,
      toSeq: trimmed.toSeq,
      hash,
      archive,
      hotCopy,
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
   * A batch at or below the head was already archived, and its hot copy, if still owed, belongs
   * to the alarm. It must agree with the archive: a redelivery is byte-identical, so a difference
   * is a forged or corrupted message and is paged.
   */
  private async checkDuplicate(batch: AuditBatch, head: StreamHead): Promise<StreamOutcome> {
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
        delaySeconds: ARCHIVE_RETRY_SECONDS,
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
    return { kind: 'duplicate', stream: batch.stream, toSeq: batch.toSeq, headSeq: head.seq };
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

  /**
   * Delivers owed rows, oldest first, from their archive objects. An unreadable archive object
   * parks its row; a payload rejection parks its row once a later row is delivered; any other
   * failure, or a rejection nothing delivered after, stops the run and re-arms with backoff. A
   * full page of rows re-arms at once; a run that empties the queue clears the failure.
   */
  private async drainHotCopy(): Promise<void> {
    const listed = await this.ctx.storage.list<HotStoreGap>({
      prefix: HOT_COPY_PREFIX,
      limit: HOT_COPY_ROWS_PER_ALARM,
    });
    const rows = [...listed.values()];
    const first = rows[0];
    if (!first) {
      const stored = await this.ctx.storage.get<HotCopyState>(HOT_STATE_KEY);
      if (stored?.failing) await this.recovered(stored);
      return;
    }
    let state = await this.readHotState(first.stream);
    const unreadable: HotStoreGap[] = [];
    // The oldest rejected row no delivery has followed yet in this run.
    let suspect: HotStoreGap | null = null;

    for (const row of rows) {
      const delivery = await this.deliverFromArchive(row);
      if (delivery.kind === 'delivered') {
        if (suspect) state = await this.park(state, suspect, 'axiom_rejected');
        suspect = null;
        continue;
      }
      if (delivery.reason === 'archive_unreadable') {
        await this.park(state, row, 'archive_unreadable');
        unreadable.push(row);
        continue;
      }
      if (delivery.reason === 'axiom_rejected' && suspect === null) {
        await this.stampRow(row, 'axiom_rejected');
        suspect = row;
        continue;
      }
      // Every row before this one was delivered or parked, except a suspect, which is older.
      await this.pageUnreadable(first.stream, unreadable);
      await this.noteFailure(state, delivery.reason, true, suspect ?? row);
      return;
    }
    await this.pageUnreadable(first.stream, unreadable);

    if (suspect) {
      await this.noteFailure(state, 'axiom_rejected', true, suspect);
      return;
    }
    if (rows.length === HOT_COPY_ROWS_PER_ALARM) {
      await this.ctx.storage.put<HotCopyState>(HOT_STATE_KEY, { ...state, attempts: 0 });
      await this.ctx.storage.setAlarm(Date.now());
      return;
    }
    await this.recovered(state);
  }

  /**
   * An archive object that went missing or changed under the relay is evidence of tampering or
   * loss, so its page never waits for the hourly cap: one page per alarm run lists the rows.
   */
  private async pageUnreadable(stream: string, rows: HotStoreGap[]): Promise<void> {
    if (rows.length === 0) return;
    const ranges = rows.map(row => `${row.fromSeq}..${row.toSeq}`).join(', ');
    await pageOperator(
      this.env,
      `audit stream ${stream}: archive objects missing, undecodable or changed under the relay for seq ${ranges} (${rows.length} rows); their hot copy is parked, check the archive`,
      this.ctx
    );
  }

  private async deliverFromArchive(row: HotStoreGap): Promise<Delivery> {
    let events: AuditEvent[];
    try {
      const read = await readArchivedObject(
        this.env.AUDIT_ARCHIVE,
        archiveObjectKey(row.stream, row.toSeq)
      );
      if (read.kind !== 'ok' || read.object.batch.fromSeq !== row.fromSeq) {
        return { kind: 'failed', reason: 'archive_unreadable' };
      }
      events = read.object.batch.events;
    } catch {
      return { kind: 'failed', reason: 'archive_unavailable' };
    }
    return this.deliverRow(row, events);
  }

  /** One Axiom ingest of a row's events; success deletes the row. */
  private async deliverRow(row: HotStoreGap, events: AuditEvent[]): Promise<Delivery> {
    let token: string;
    try {
      token = await secretsFor(this.env).get('AUDIT_RELAY_AXIOM_TOKEN', this.ctx);
    } catch (error) {
      const denied = error instanceof SecretUnavailableError && !error.retryable;
      return { kind: 'failed', reason: denied ? 'secrets_denied' : 'secrets_unavailable' };
    }
    const ingest = await ingestAuditEvents(
      { url: this.env.AXIOM_URL, dataset: this.env.AXIOM_DATASET, token },
      events,
      fetch
    );
    switch (ingest.kind) {
      case 'ok':
        await this.ctx.storage.delete(hotCopyKey(row.toSeq));
        return { kind: 'delivered' };
      case 'unavailable':
        return { kind: 'failed', reason: 'axiom_unavailable' };
      case 'refused':
        return { kind: 'failed', reason: 'axiom_refused' };
      case 'payload_rejected':
        return { kind: 'failed', reason: 'axiom_rejected' };
    }
  }

  /**
   * Records a stream-wide failure on `row`, the oldest row still owed, and makes sure an alarm is
   * due within the backoff. A failed alarm run (`fromAlarm`) advances the backoff.
   *
   * Paging waits until the failure is real (`HOT_COPY_PAGE_AFTER_RUNS` failed runs in a row, or a
   * row owed for `HOT_COPY_PAGE_AFTER_MS`), pages once per failure and once more past
   * `OWED_ROW_PAGE_AGE_MS`, and never more than once per `HOT_COPY_PAGE_INTERVAL_MS`; a page the
   * window holds back goes out at the next failed run after it. A change of reason is logged, not
   * paged.
   */
  private async noteFailure(
    state: HotCopyState,
    reason: HotCopyFailureReason,
    fromAlarm: boolean,
    row: HotStoreGap
  ): Promise<void> {
    await this.stampRow(row, reason);
    const now = Date.now();
    const attempts = fromAlarm ? state.attempts + 1 : state.attempts;
    let failing = state.failing
      ? { ...state.failing, reason }
      : { reason, since: new Date(now).toISOString(), paged: false, agePaged: false };
    let lastPageAt = state.lastPageAt;
    const owedMs = now - Date.parse(row.recordedAt);
    const windowOpen = lastPageAt === null || now - lastPageAt >= HOT_COPY_PAGE_INTERVAL_MS;
    let page: string | null = null;
    if (
      !failing.paged &&
      windowOpen &&
      (attempts >= HOT_COPY_PAGE_AFTER_RUNS || owedMs >= HOT_COPY_PAGE_AFTER_MS)
    ) {
      failing = { ...failing, paged: true };
      lastPageAt = now;
      page = `audit stream ${state.stream}: the Axiom hot copy is failing (${reason}) since ${failing.since}; every batch is still archived and the stream retries the hot copy with backoff`;
    } else if (failing.paged && !failing.agePaged && windowOpen && owedMs >= OWED_ROW_PAGE_AGE_MS) {
      failing = { ...failing, agePaged: true };
      lastPageAt = now;
      page = `audit stream ${state.stream}: the Axiom hot copy still owes seq ${row.fromSeq}.. since ${row.recordedAt} (${reason})`;
    }
    await this.ctx.storage.put<HotCopyState>(HOT_STATE_KEY, {
      stream: state.stream,
      attempts,
      failing,
      lastPageAt,
    });
    const due = now + backoffMs(Math.max(attempts, 1));
    const scheduled = fromAlarm ? null : await this.ctx.storage.getAlarm();
    if (scheduled === null || scheduled > due) await this.ctx.storage.setAlarm(due);
    console.error(
      JSON.stringify({
        event: 'audit_relay.hot_copy_failed',
        stream: state.stream,
        reason,
        attempts,
        paged: page !== null,
      })
    );
    if (page) await pageOperator(this.env, page, this.ctx);
  }

  /**
   * Moves a row to `hot_copy_parked:`, where the alarm never retries it. A confirmed payload
   * rejection pages within the hourly window; an unreadable archive object is paged by the caller,
   * outside it.
   */
  private async park(
    state: HotCopyState,
    row: HotStoreGap,
    reason: 'axiom_rejected' | 'archive_unreadable'
  ): Promise<HotCopyState> {
    const stored = await this.ctx.storage.get<HotStoreGap>(hotCopyKey(row.toSeq));
    if (!stored) return state;
    // No await between the two writes: the move is atomic.
    const moves = [
      this.ctx.storage.delete(hotCopyKey(row.toSeq)),
      this.ctx.storage.put<HotStoreGap>(parkedKey(row.toSeq), { ...stored, reason }),
    ];
    await Promise.all(moves);

    const now = Date.now();
    const page =
      reason === 'axiom_rejected' &&
      (state.lastPageAt === null || now - state.lastPageAt >= HOT_COPY_PAGE_INTERVAL_MS);
    const next: HotCopyState = page ? { ...state, lastPageAt: now } : state;
    if (page) await this.ctx.storage.put<HotCopyState>(HOT_STATE_KEY, next);
    console.error(
      JSON.stringify({
        event: 'audit_relay.hot_copy_parked',
        stream: row.stream,
        fromSeq: row.fromSeq,
        toSeq: row.toSeq,
        reason,
        paged: page,
      })
    );
    if (page) {
      await pageOperator(
        this.env,
        `audit stream ${row.stream}: parked seq ${row.fromSeq}..${row.toSeq} (${reason}); Axiom refused this payload while later rows were delivered, check it and clear it with clearHotStoreGap`,
        this.ctx
      );
    }
    return next;
  }

  /** Clears the failure; a failure that paged its start also pages its recovery, always. */
  private async recovered(state: HotCopyState): Promise<void> {
    if (!state.failing && state.attempts === 0) return;
    const paged = state.failing?.paged === true;
    const now = Date.now();
    await this.ctx.storage.put<HotCopyState>(HOT_STATE_KEY, {
      stream: state.stream,
      attempts: 0,
      failing: null,
      lastPageAt: paged ? now : state.lastPageAt,
    });
    if (!state.failing) return;
    console.log(
      JSON.stringify({
        event: 'audit_relay.hot_copy_recovered',
        stream: state.stream,
        reason: state.failing.reason,
        paged,
      })
    );
    if (!paged) return;
    await pageOperator(
      this.env,
      `audit stream ${state.stream}: the Axiom hot copy recovered from ${state.failing.reason} (failing since ${state.failing.since}); every owed row is delivered`,
      this.ctx
    );
  }

  // Get-then-put with no other I/O between: storage awaits keep the input gate closed, so a row
  // deleted by a delivery is never re-created here. `recordedAt` stays the archive time.
  private async stampRow(row: HotStoreGap, reason: HotCopyFailureReason): Promise<void> {
    const key = hotCopyKey(row.toSeq);
    const stored = await this.ctx.storage.get<HotStoreGap>(key);
    if (stored) await this.ctx.storage.put<HotStoreGap>(key, { ...stored, reason });
  }

  private async readHotState(stream: string): Promise<HotCopyState> {
    return (
      (await this.ctx.storage.get<HotCopyState>(HOT_STATE_KEY)) ?? {
        stream,
        attempts: 0,
        failing: null,
        lastPageAt: null,
      }
    );
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

/** 30 s, 60 s, 120 s … capped at 15 minutes, each scaled by a jitter in [0.5, 1). */
export function backoffMs(attempts: number): number {
  const exponential = HOT_COPY_BACKOFF_BASE_MS * 2 ** Math.min(attempts - 1, 20);
  return Math.round(Math.min(HOT_COPY_BACKOFF_CAP_MS, exponential) * (0.5 + Math.random() * 0.5));
}

export function getStreamDOStub(
  env: Pick<Env, 'AUDIT_STREAM'>,
  stream: string
): DurableObjectStub<StreamDO> {
  return env.AUDIT_STREAM.get(env.AUDIT_STREAM.idFromName(stream));
}
