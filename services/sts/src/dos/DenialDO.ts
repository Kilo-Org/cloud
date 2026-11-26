import { DurableObject } from 'cloudflare:workers';
import { and, asc, eq, lt, sql } from 'drizzle-orm';
import { drizzle, type DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite';
import { migrate } from 'drizzle-orm/durable-sqlite/migrator';
import migrations from '../../drizzle.denial/migrations';
import {
  DenialCountsSchema,
  denialKey,
  overflowDenial,
  overflowKey,
  utcMinute,
  type Denial,
  type DenialCount,
} from '../audit/denials';
import { bundleDeniedEvent, tokenDeniedEvent } from '../audit/events';
import { AuditLog } from '../audit/log';
import { RELAY_DELAY_MS, RELAY_RETRY_MS } from '../constants';
import * as schema from '../db/denial-schema';
import { readConfig, type Env, type StsConfig } from '../env';

type DenialDatabase = DrizzleSqliteDODatabase<typeof schema>;

/**
 * Distinct denials kept per minute. Further distinct ones in that minute only add to one overflow
 * row per kind and reason (3 bundle reasons, 7 token reasons), so a flood of varied valid tokens
 * writes at most `MAX_DISTINCT_PER_MINUTE + 10` audit events per minute.
 */
export const MAX_DISTINCT_PER_MINUTE = 100;

const MINUTE_MS = 60 * 1000;

/** An isolate's count older than this is filed under the current minute instead. */
const MAX_CLAIMED_MINUTE_AGE_MS = 60 * MINUTE_MS;

/**
 * Files a count under the minute the isolate saw it in, so the event's `windowStart` is right.
 * A minute in the future or more than an hour back (a skewed or forged value) becomes the current
 * minute.
 */
function acceptedMinute(claimed: string, now: number): string {
  const current = utcMinute(now);
  const at = Date.parse(`${claimed}:00.000Z`);
  if (Number.isNaN(at) || claimed > current || now - at > MAX_CLAIMED_MINUTE_AGE_MS) return current;
  return claimed;
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'unknown';
}

/**
 * One object per environment: the `sts:<environment>:denials` audit stream. Refused bundle reads
 * and refused tokens from identified callers arrive here, at most one call per request; identical
 * denials merge per minute into one event with a count, written by the alarm after the minute
 * ends (`ai.kilo.sts.bundle.denied` or `ai.kilo.sts.token.denied`).
 */
export class DenialDO extends DurableObject<Env> {
  private readonly config: StsConfig;
  private readonly db: DenialDatabase;
  private readonly audit: AuditLog;
  private readonly stream: string;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.config = readConfig(env);
    this.db = drizzle(ctx.storage, { schema });
    this.audit = new AuditLog(ctx.storage, env.AUDIT_QUEUE);
    this.stream = `sts:${this.config.environment}:denials`;
    void ctx.blockConcurrencyWhile(async () => {
      await migrate(this.db, migrations);
    });
  }

  /** Adds counts merged in one isolate; identical denials merge again here per minute. */
  async record(raw: DenialCount[]): Promise<void> {
    const counts = DenialCountsSchema.parse(raw);
    const now = Date.now();
    for (const { denial, count, overflow, minute: claimed } of counts) {
      const minute = acceptedMinute(claimed, now);
      const key = denialKey(denial);
      if (!overflow && this.has(minute, key)) {
        this.increment(minute, key, count);
      } else if (!overflow && this.distinctIn(minute) < MAX_DISTINCT_PER_MINUTE) {
        this.db.insert(schema.denialWindow).values({ minute, key, count, denial }).run();
      } else {
        this.addOverflow(minute, denial, count);
      }
    }
    await this.scheduleAlarm(now, false);
  }

  private has(minute: string, key: string): boolean {
    return (
      this.db
        .select({ count: schema.denialWindow.count })
        .from(schema.denialWindow)
        .where(and(eq(schema.denialWindow.minute, minute), eq(schema.denialWindow.key, key)))
        .get() !== undefined
    );
  }

  private addOverflow(minute: string, denial: Denial, count: number): void {
    this.db
      .insert(schema.denialWindow)
      .values({ minute, key: overflowKey(denial), count, denial: overflowDenial(denial) })
      .onConflictDoUpdate({
        target: [schema.denialWindow.minute, schema.denialWindow.key],
        set: { count: sql`${schema.denialWindow.count} + ${count}` },
      })
      .run();
  }

  async alarm(): Promise<void> {
    const now = Date.now();
    let failed = !(await this.flushClosedWindows(now));
    try {
      await this.audit.relay(this.stream);
    } catch (error) {
      failed = true;
      console.warn('sts: denial audit relay failed; rows stay for the next alarm', {
        reason: errorName(error),
      });
    }
    this.audit.pruneIfDue(now);
    await this.scheduleAlarm(Date.now(), failed);
  }

  /**
   * Writes one event per merged row of every minute that has ended. Returns false when an append
   * failed; that row stays for the next alarm.
   */
  private async flushClosedWindows(now: number): Promise<boolean> {
    let flushed = true;
    const closed = this.db
      .select()
      .from(schema.denialWindow)
      .where(lt(schema.denialWindow.minute, utcMinute(now)))
      .all();
    for (const row of closed) {
      const window = {
        environment: this.config.environment,
        count: row.count,
        windowStart: `${row.minute}:00.000Z`,
        overflow: row.key.startsWith('overflow:'),
      };
      try {
        await this.audit.append(
          this.stream,
          row.denial.kind === 'token'
            ? tokenDeniedEvent({ ...window, denial: row.denial })
            : bundleDeniedEvent({ ...window, denial: row.denial })
        );
      } catch (error) {
        console.error('sts: denial audit append failed; the row stays for the next alarm', {
          reason: errorName(error),
        });
        flushed = false;
        continue;
      }
      this.db
        .delete(schema.denialWindow)
        .where(
          and(eq(schema.denialWindow.minute, row.minute), eq(schema.denialWindow.key, row.key))
        )
        .run();
    }
    return flushed;
  }

  private increment(minute: string, key: string, count: number): void {
    this.db
      .update(schema.denialWindow)
      .set({ count: sql`${schema.denialWindow.count} + ${count}` })
      .where(and(eq(schema.denialWindow.minute, minute), eq(schema.denialWindow.key, key)))
      .run();
  }

  private distinctIn(minute: string): number {
    return (
      this.db
        .select({ count: sql<number>`count(*)` })
        .from(schema.denialWindow)
        .where(eq(schema.denialWindow.minute, minute))
        .get()?.count ?? 0
    );
  }

  /** The oldest minute with an open window, or null when none is open. */
  private oldestWindow(): string | null {
    return (
      this.db
        .select({ minute: schema.denialWindow.minute })
        .from(schema.denialWindow)
        .orderBy(asc(schema.denialWindow.minute))
        .limit(1)
        .get()?.minute ?? null
    );
  }

  private async scheduleAlarm(now: number, failed: boolean): Promise<void> {
    let target = Number.POSITIVE_INFINITY;
    const oldest = this.oldestWindow();
    if (oldest !== null) {
      const windowEnd = Date.parse(`${oldest}:00.000Z`) + MINUTE_MS + 1_000;
      target = windowEnd > now ? windowEnd : now + (failed ? RELAY_RETRY_MS : 1_000);
    }
    if (this.audit.hasUnrelayed()) {
      target = Math.min(target, now + (failed ? RELAY_RETRY_MS : RELAY_DELAY_MS));
    } else if (this.audit.hasRows()) {
      target = Math.min(target, Math.max(now + 1_000, this.audit.nextPruneAt()));
    }
    if (target === Number.POSITIVE_INFINITY) return;
    target = Math.max(target, now + 1_000);
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > target || current < now) {
      await this.ctx.storage.setAlarm(target);
    }
  }
}
