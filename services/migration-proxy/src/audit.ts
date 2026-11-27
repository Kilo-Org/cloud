import {
  AuditEventSchema,
  MIGRATION_PROXY_AUDIT_TYPES,
  MIGRATION_PROXY_WORKLOAD,
  OCSF_CLASS,
  assertRelayable,
  encodeAuditBatch,
  migrationProxyAuditSource,
  relayAudit,
  type AuditEvent,
  type StsEnvironment,
} from '@kilocode/sts-contracts';
import { and, asc, between, eq, gt, lt } from 'drizzle-orm';
import type { DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite';
import { auditEvent, auditPrune, auditWatermark } from './db/schema';

/**
 * The proxy's audit events (contract §7): OCSF API Activity 6003 in a CloudEvents envelope, one
 * stream per environment, relayed from the Durable Object's SQLite outbox to its own queue with
 * the relay code STS uses. No event carries a host, user name, password, SQL text or Postgres
 * message.
 */

type AttributeValue = string | number | boolean | string[];
type Attributes = Record<string, AttributeValue | null | undefined>;
type EventType = keyof typeof MIGRATION_PROXY_AUDIT_TYPES;

export const SYSTEM_ACTOR = { kind: 'system', id: MIGRATION_PROXY_WORKLOAD } as const;
const MAX_LIST = 256;

/** Attributes without the null or undefined ones: the event schema has no null value. */
function present(attributes: Attributes): Record<string, AttributeValue> {
  return Object.fromEntries(
    Object.entries(attributes).filter(
      (entry): entry is [string, AttributeValue] => entry[1] !== null && entry[1] !== undefined
    )
  );
}

export function auditEventOf(input: {
  environment: StsEnvironment;
  type: EventType;
  outcome: 'success' | 'failure' | 'denied';
  actor: { kind: 'workload' | 'system'; id: string };
  attributes: Attributes;
  now: number;
}): AuditEvent {
  const { type, activityId } = MIGRATION_PROXY_AUDIT_TYPES[input.type];
  return AuditEventSchema.parse({
    specversion: '1.0',
    id: crypto.randomUUID(),
    source: migrationProxyAuditSource(input.environment),
    type,
    time: new Date(input.now).toISOString(),
    datacontenttype: 'application/json',
    data: {
      classUid: OCSF_CLASS.apiActivity,
      activityId,
      outcome: input.outcome,
      actor: input.actor,
      attributes: present(input.attributes),
    },
  });
}

/** Cuts a list attribute to the schema's 256 values. */
export function capped(values: readonly string[]): string[] {
  return values.slice(0, MAX_LIST).map(value => value.slice(0, 256));
}

const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const PRUNE_INTERVAL_MS = 60 * 60 * 1000;
const PRUNE_BATCH_ROWS = 5_000;

/**
 * The outbox: rows appended in the call that performs the action, relayed in order, and deleted
 * 7 days after the queue accepted them (the same shape as STS's `AuditLog`).
 */
export class AuditLog {
  private readonly db: DrizzleSqliteDODatabase;
  private readonly queue: Queue;

  constructor(db: DrizzleSqliteDODatabase, queue: Queue) {
    this.db = db;
    this.queue = queue;
  }

  /** Appends one event, or throws; the caller's action fails with it. */
  async append(stream: string, event: AuditEvent): Promise<void> {
    await assertRelayable(stream, event);
    this.db.insert(auditEvent).values({ event, createdAt: Date.now() }).run();
  }

  async relay(stream: string): Promise<number> {
    return await relayAudit({
      store: {
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
      },
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

  /** Deletes relayed rows past retention, at most once an hour, in one bounded statement. */
  pruneIfDue(now: number): void {
    const last = this.db.select().from(auditPrune).where(eq(auditPrune.id, 1)).get();
    if (last !== undefined && now < last.prunedAt + PRUNE_INTERVAL_MS) return;
    const oldest = this.db
      .select({ seq: auditEvent.seq })
      .from(auditEvent)
      .orderBy(asc(auditEvent.seq))
      .limit(1)
      .get();
    if (oldest !== undefined) {
      const upTo = Math.min(this.watermark(), oldest.seq + PRUNE_BATCH_ROWS - 1);
      this.db
        .delete(auditEvent)
        .where(
          and(
            between(auditEvent.seq, oldest.seq, upTo),
            lt(auditEvent.createdAt, now - RETENTION_MS)
          )
        )
        .run();
    }
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
}
