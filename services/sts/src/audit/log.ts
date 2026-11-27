import {
  assertRelayable,
  encodeAuditBatch,
  relayAudit,
  type AuditEvent,
  type AuditRelayStore,
} from '@kilocode/sts-contracts';
import { and, asc, between, eq, gt, lt } from 'drizzle-orm';
import { drizzle, type DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite';
import { AUDIT_RETENTION_MS, PRUNE_INTERVAL_MS } from '../constants';
import { auditEvent, auditPrune, auditWatermark } from '../db/audit-tables';

/** Rows deleted per statement, and statements per prune, so one alarm stays short. */
const PRUNE_BATCH_ROWS = 5_000;
const PRUNE_MAX_BATCHES = 10;

/** How long relayed rows stay, and how often the log prunes them. */
export type AuditLogRetention = { retentionMs: number; pruneIntervalMs: number };

/**
 * One Durable Object's audit stream: rows appended in the call that performs the action, relayed
 * to the audit queue in order, and deleted a retention period (7 days unless the owner sets
 * another) after the queue accepted them.
 */
export class AuditLog {
  private readonly db: DrizzleSqliteDODatabase;

  constructor(
    storage: DurableObjectStorage,
    private readonly queue: Queue,
    private readonly retention: AuditLogRetention = {
      retentionMs: AUDIT_RETENTION_MS,
      pruneIntervalMs: PRUNE_INTERVAL_MS,
    }
  ) {
    this.db = drizzle(storage);
  }

  /** Appends one event to `stream`, or throws; the caller's action fails with it (design 8.1). */
  async append(stream: string, event: AuditEvent): Promise<void> {
    await assertRelayable(stream, event);
    this.db.insert(auditEvent).values({ event, createdAt: Date.now() }).run();
  }

  /** Sends every unrelayed row as batches of `stream`; throws when the queue refuses one. */
  async relay(stream: string): Promise<number> {
    return await relayAudit({
      store: this.store(),
      stream,
      send: async batch => {
        await this.queue.send(await encodeAuditBatch(batch), { contentType: 'bytes' });
      },
    });
  }

  hasUnrelayed(): boolean {
    return (
      this.db
        .select({ seq: auditEvent.seq })
        .from(auditEvent)
        .where(gt(auditEvent.seq, this.watermark()))
        .limit(1)
        .get() !== undefined
    );
  }

  hasRows(): boolean {
    return this.db.select({ seq: auditEvent.seq }).from(auditEvent).limit(1).get() !== undefined;
  }

  /** When the next prune is due; a log that never pruned is due now. */
  nextPruneAt(): number {
    const row = this.db.select().from(auditPrune).where(eq(auditPrune.id, 1)).get();
    return row === undefined ? 0 : row.prunedAt + this.retention.pruneIntervalMs;
  }

  /**
   * Deletes relayed rows older than the retention, at most once per prune interval. Each
   * statement touches one bounded primary-key range from the oldest row, and rows only age in
   * sequence order, so the walk stops at the first range that still holds a young row. A prune
   * that reaches its batch bound leaves the interval unrecorded and runs again on the next alarm.
   * A row past the watermark (not yet relayed) is never deleted.
   */
  pruneIfDue(now: number): void {
    if (now < this.nextPruneAt()) return;
    const cutoff = now - this.retention.retentionMs;
    const watermark = this.watermark();
    for (let batch = 0; batch < PRUNE_MAX_BATCHES; batch += 1) {
      const oldest = this.db
        .select({ seq: auditEvent.seq, createdAt: auditEvent.createdAt })
        .from(auditEvent)
        .orderBy(asc(auditEvent.seq))
        .limit(1)
        .get();
      if (oldest === undefined || oldest.seq > watermark || oldest.createdAt >= cutoff) {
        this.recordPrune(now);
        return;
      }
      const upTo = Math.min(watermark, oldest.seq + PRUNE_BATCH_ROWS - 1);
      this.db
        .delete(auditEvent)
        .where(and(between(auditEvent.seq, oldest.seq, upTo), lt(auditEvent.createdAt, cutoff)))
        .run();
    }
  }

  private recordPrune(now: number): void {
    this.db
      .insert(auditPrune)
      .values({ id: 1, prunedAt: now })
      .onConflictDoUpdate({ target: auditPrune.id, set: { prunedAt: now } })
      .run();
  }

  private watermark(): number {
    return (
      this.db.select().from(auditWatermark).where(eq(auditWatermark.id, 1)).get()?.relayedSeq ?? 0
    );
  }

  private store(): AuditRelayStore {
    return {
      nextRows: (afterSeq, limit) =>
        this.db
          .select({ seq: auditEvent.seq, event: auditEvent.event })
          .from(auditEvent)
          .where(gt(auditEvent.seq, afterSeq))
          .orderBy(asc(auditEvent.seq))
          .limit(limit)
          .all(),
      watermark: () => this.watermark(),
      advanceWatermark: toSeq => {
        this.db
          .insert(auditWatermark)
          .values({ id: 1, relayedSeq: toSeq })
          .onConflictDoUpdate({ target: auditWatermark.id, set: { relayedSeq: toSeq } })
          .run();
      },
    };
  }
}
