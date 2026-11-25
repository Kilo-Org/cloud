import { DurableObject } from 'cloudflare:workers';
import { and, eq, lt, sql } from 'drizzle-orm';
import { drizzle, type DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite';
import { migrate } from 'drizzle-orm/durable-sqlite/migrator';
import migrations from '../../drizzle.denial/migrations';
import { DenialCountsSchema, denialKey, type Denial, type DenialCount } from '../audit/denials';
import { bundleDeniedEvent } from '../audit/events';
import { AuditLog } from '../audit/log';
import { RELAY_DELAY_MS, RELAY_RETRY_MS } from '../constants';
import * as schema from '../db/denial-schema';
import { readConfig, type Env, type StsConfig } from '../env';

type DenialDatabase = DrizzleSqliteDODatabase<typeof schema>;

/**
 * Distinct denials kept per minute. Further distinct ones in that minute only add to one overflow
 * row per reason, so a flood of varied valid tokens writes at most
 * `MAX_DISTINCT_PER_MINUTE + 3` audit events per minute.
 */
export const MAX_DISTINCT_PER_MINUTE = 100;

const MINUTE_MS = 60 * 1000;

function utcMinute(time: number): string {
  return new Date(time).toISOString().slice(0, 16);
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'unknown';
}

/**
 * One object per environment: the `sts:<environment>:denials` audit stream. Each refused read from
 * an identified caller costs one call here; identical denials merge per minute into one event with
 * a count, written by the alarm after the minute ends.
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
    const minute = utcMinute(now);
    for (const { denial, count, overflow } of counts) {
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
    const overflow: Denial = {
      channel: denial.channel,
      reason: denial.reason,
      actor: 'overflow',
      claims: {},
    };
    this.db
      .insert(schema.denialWindow)
      .values({ minute, key: `overflow:${denial.reason}`, count, denial: overflow })
      .onConflictDoUpdate({
        target: [schema.denialWindow.minute, schema.denialWindow.key],
        set: { count: sql`${schema.denialWindow.count} + ${count}` },
      })
      .run();
  }

  async alarm(): Promise<void> {
    const now = Date.now();
    await this.flushClosedWindows(now);
    let relayFailed = false;
    try {
      await this.audit.relay(this.stream);
    } catch (error) {
      relayFailed = true;
      console.warn('sts: denial audit relay failed; rows stay for the next alarm', {
        reason: errorName(error),
      });
    }
    this.audit.pruneIfDue(now);
    await this.scheduleAlarm(Date.now(), relayFailed);
  }

  /** Writes one event per merged row of every minute that has ended. */
  private async flushClosedWindows(now: number): Promise<void> {
    const closed = this.db
      .select()
      .from(schema.denialWindow)
      .where(lt(schema.denialWindow.minute, utcMinute(now)))
      .all();
    for (const row of closed) {
      try {
        await this.audit.append(
          this.stream,
          bundleDeniedEvent({
            environment: this.config.environment,
            denial: row.denial,
            count: row.count,
            windowStart: `${row.minute}:00.000Z`,
            overflow: row.key.startsWith('overflow:'),
          })
        );
      } catch (error) {
        console.error('sts: denial audit append failed; the row stays for the next alarm', {
          reason: errorName(error),
        });
        continue;
      }
      this.db
        .delete(schema.denialWindow)
        .where(
          and(eq(schema.denialWindow.minute, row.minute), eq(schema.denialWindow.key, row.key))
        )
        .run();
    }
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

  private hasOpenWindows(): boolean {
    return (
      this.db
        .select({ minute: schema.denialWindow.minute })
        .from(schema.denialWindow)
        .limit(1)
        .get() !== undefined
    );
  }

  private async scheduleAlarm(now: number, relayFailed: boolean): Promise<void> {
    let target = Number.POSITIVE_INFINITY;
    if (this.hasOpenWindows()) target = Math.floor(now / MINUTE_MS) * MINUTE_MS + MINUTE_MS + 1_000;
    if (this.audit.hasUnrelayed()) {
      target = Math.min(target, now + (relayFailed ? RELAY_RETRY_MS : RELAY_DELAY_MS));
    } else if (this.audit.hasRows()) {
      target = Math.min(target, Math.max(now + 1_000, this.audit.nextPruneAt()));
    }
    if (target === Number.POSITIVE_INFINITY) return;
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > target || current < now) {
      await this.ctx.storage.setAlarm(target);
    }
  }
}
