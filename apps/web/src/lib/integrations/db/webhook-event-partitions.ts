import type { db as defaultDb } from '@kilocode/web-shared/lib/drizzle';
import { sql } from 'drizzle-orm';

/**
 * Daily partitions of `webhook_events_v2`, and retention for it and
 * `webhook_event_signatures`. The migration creates the first partitions; the
 * `cleanup-webhook-events` cron keeps the window current from then on, and
 * `withWebhookEventPartitions` creates them on demand where no cron runs.
 *
 * There is deliberately no DEFAULT partition: PostgreSQL refuses
 * `DETACH PARTITION ... CONCURRENTLY` while one exists. The cron instead keeps
 * PARTITION_DAYS_AHEAD days provisioned ahead.
 */

type PartitionExecutor = Pick<typeof defaultDb, 'execute'>;

/** Structural, so the schema-less database the test worker setup migrates also fits. */
type PartitionDb = PartitionExecutor & {
  transaction<T>(run: (tx: PartitionExecutor) => Promise<T>): Promise<T>;
};

export const WEBHOOK_EVENTS_RETENTION_DAYS = 60;
export const PARTITION_DAYS_AHEAD = 7;
export const SIGNATURE_PRUNE_BATCH_SIZE = 5_000;
export const SIGNATURE_PRUNE_MAX_BATCHES = 4;

const PARENT_TABLE = 'webhook_events_v2';
const PARTITION_NAME_PATTERN = /^webhook_events_v2_(\d{4})_(\d{2})_(\d{2})$/;
const DAY_MS = 24 * 60 * 60 * 1_000;

/**
 * Creating a partition takes ACCESS EXCLUSIVE on the parent for a moment. Waiting
 * longer than this behind a long reader would queue every webhook insert behind
 * it, so give up and let the next cron run retry.
 */
const CREATE_PARTITION_LOCK_TIMEOUT = '2s';

/**
 * SQLSTATEs a later run can clear on its own: a lock or statement timeout, or
 * another run's detach still pending. With days of partitions provisioned ahead,
 * one of these is not worth failing a run over.
 */
const TRANSIENT_PARTITION_ERROR_CODES = new Set(['55P03', '57014', '55000']);

type PartitionError = { name: string; error: unknown };

function postgresErrorCode(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) return null;
  // Drizzle wraps driver errors, so the code may be on the error or its cause.
  const candidate = 'code' in error ? error.code : undefined;
  if (typeof candidate === 'string') return candidate;
  return 'cause' in error ? postgresErrorCode(error.cause) : null;
}

export function isTransientPartitionError(error: unknown): boolean {
  const code = postgresErrorCode(error);
  return code !== null && TRANSIENT_PARTITION_ERROR_CODES.has(code);
}

function utcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function isoDay(day: Date): string {
  return day.toISOString().slice(0, 10);
}

export function webhookEventPartitionName(day: Date): string {
  return `${PARENT_TABLE}_${isoDay(day).replaceAll('-', '_')}`;
}

/** The UTC day a partition holds, or null for a name this module did not create. */
export function webhookEventPartitionDay(name: string): Date | null {
  const match = PARTITION_NAME_PATTERN.exec(name);
  if (!match) return null;
  const [, year, month, day] = match;
  const parsed = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  return isoDay(parsed) === `${year}-${month}-${day}` ? parsed : null;
}

type PartitionState = 'attached' | 'detach_pending' | 'detached';

/**
 * Partitions of the parent, plus tables that carry a partition name but are no
 * longer attached: a run whose detach succeeded and whose drop then failed
 * leaves one behind, and the next run must still drop it.
 */
async function listPartitions(
  fromDb: PartitionExecutor
): Promise<Array<{ name: string; state: PartitionState }>> {
  const { rows } = await fromDb.execute<{ name: string; state: PartitionState }>(sql`
    SELECT c.relname AS name,
      CASE
        WHEN i.inhrelid IS NULL THEN 'detached'
        WHEN i.inhdetachpending THEN 'detach_pending'
        ELSE 'attached'
      END AS state
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
    LEFT JOIN pg_inherits i
      ON i.inhrelid = c.oid AND i.inhparent = 'public.webhook_events_v2'::regclass
    WHERE c.relkind = 'r' AND c.relname ~ '^webhook_events_v2_[0-9]{4}_[0-9]{2}_[0-9]{2}$'
    ORDER BY c.relname
  `);
  return rows;
}

export type WebhookEventPartitionProvisioning = {
  created: string[];
  errors: PartitionError[];
  /** Today's or tomorrow's partition, absent after this run: inserts fail soon. */
  missingSoon: string[];
};

/** Ensures today's UTC partition and the next PARTITION_DAYS_AHEAD exist. */
export async function provisionWebhookEventPartitions(
  fromDb: PartitionDb,
  now: Date = new Date()
): Promise<WebhookEventPartitionProvisioning> {
  const states = new Map(
    (await listPartitions(fromDb)).map(partition => [partition.name, partition.state])
  );
  const created: string[] = [];
  const errors: PartitionError[] = [];
  const today = utcDay(now);
  const days = Array.from(
    { length: PARTITION_DAYS_AHEAD + 1 },
    (_, offset) => new Date(today.getTime() + offset * DAY_MS)
  );

  for (const day of days) {
    const name = webhookEventPartitionName(day);
    const state = states.get(name);
    if (state === 'attached') continue;
    if (state !== undefined) {
      // The name is taken by a table that is not an attached partition, so this
      // day cannot be created and inserts for it will fail. Needs an operator.
      errors.push({ name, error: new Error(`${name} exists but is not an attached partition`) });
      continue;
    }
    const nextDay = new Date(day.getTime() + DAY_MS);
    try {
      await fromDb.transaction(async tx => {
        await tx.execute(sql.raw(`SET LOCAL lock_timeout = '${CREATE_PARTITION_LOCK_TIMEOUT}'`));
        // Explicit +00 bounds: a bare date would be read in the session time zone.
        // No IF NOT EXISTS: an existing table of this name must not pass as created.
        await tx.execute(
          sql.raw(
            `CREATE TABLE "public"."${name}" PARTITION OF "public"."${PARENT_TABLE}" ` +
              `FOR VALUES FROM ('${isoDay(day)} 00:00:00+00') TO ('${isoDay(nextDay)} 00:00:00+00') ` +
              `WITH (fillfactor = 90)`
          )
        );
      });
      created.push(name);
    } catch (error) {
      // A concurrent run that created the same day first is not an error.
      if (postgresErrorCode(error) === '42P07') continue;
      errors.push({ name, error });
    }
  }

  const attachedAfter = new Set(
    (await listPartitions(fromDb))
      .filter(partition => partition.state === 'attached')
      .map(partition => partition.name)
  );
  const missingSoon = days
    .slice(0, 2)
    .map(webhookEventPartitionName)
    .filter(name => !attachedAfter.has(name));
  // A day another run created is attached now, so it is no longer an error.
  const unresolved = errors.filter(({ name }) => !attachedAfter.has(name));

  return { created, errors: unresolved, missingSoon };
}

export type WebhookEventPartitionRetention = {
  finalized: string[];
  dropped: string[];
  errors: PartitionError[];
};

const RETENTION_ORDER: Record<PartitionState, number> = {
  detach_pending: 0,
  detached: 1,
  attached: 2,
};

/**
 * Detaches and drops every partition whose whole day is older than the
 * retention window.
 *
 * A concurrent detach cancelled partway (for example by the statement timeout)
 * leaves its partition pending, and while any partition is pending PostgreSQL
 * refuses every other concurrent detach on the parent. So pending detaches are
 * finalized first, and once a detach fails no further ones are started.
 *
 * Neither statement can run inside a transaction block; `execute` on the pool
 * runs each in its own implicit transaction.
 */
export async function dropExpiredWebhookEventPartitions(
  fromDb: PartitionDb,
  now: Date = new Date()
): Promise<WebhookEventPartitionRetention> {
  const finalized: string[] = [];
  const dropped: string[] = [];
  const errors: PartitionError[] = [];
  const cutoff = now.getTime() - WEBHOOK_EVENTS_RETENTION_DAYS * DAY_MS;
  let detachBlocked = false;

  const partitions = (await listPartitions(fromDb)).sort(
    (left, right) => RETENTION_ORDER[left.state] - RETENTION_ORDER[right.state]
  );

  for (const partition of partitions) {
    const day = webhookEventPartitionDay(partition.name);
    const expired = day !== null && day.getTime() + DAY_MS <= cutoff;
    // Only this function detaches partitions, and only expired ones, so a
    // pending detach is always one to finish. A detached table is dropped only
    // when its day is expired, so a stray table with a current name survives.
    if (partition.state !== 'detach_pending' && !expired) continue;
    if (partition.state !== 'detached' && detachBlocked) continue;

    const qualified = `"public"."${partition.name}"`;
    try {
      if (partition.state === 'detach_pending') {
        await fromDb.execute(
          sql.raw(`ALTER TABLE "public"."${PARENT_TABLE}" DETACH PARTITION ${qualified} FINALIZE`)
        );
        finalized.push(partition.name);
      } else if (partition.state === 'attached') {
        await fromDb.execute(
          sql.raw(
            `ALTER TABLE "public"."${PARENT_TABLE}" DETACH PARTITION ${qualified} CONCURRENTLY`
          )
        );
      }
    } catch (error) {
      detachBlocked = true;
      errors.push({ name: partition.name, error });
      continue;
    }
    try {
      await fromDb.execute(sql.raw(`DROP TABLE IF EXISTS ${qualified}`));
      dropped.push(partition.name);
    } catch (error) {
      errors.push({ name: partition.name, error });
    }
  }

  return { finalized, dropped, errors };
}

/**
 * Deletes signatures older than the event retention window, in bounded batches.
 * A signature goes at the cutoff, while its event's partition is only dropped
 * once the whole day is past it, so a held signature normally still points at
 * a stored event. If pruning falls behind, a redelivery of a signature whose
 * event is gone is rejected as a delivery conflict.
 */
export async function pruneExpiredWebhookEventSignatures(
  fromDb: PartitionDb,
  now: Date = new Date()
): Promise<{ deletedCount: number; hasMore: boolean }> {
  const cutoff = new Date(now.getTime() - WEBHOOK_EVENTS_RETENTION_DAYS * DAY_MS).toISOString();
  let deletedCount = 0;

  for (let batch = 0; batch < SIGNATURE_PRUNE_MAX_BATCHES; batch++) {
    const { rows } = await fromDb.execute<{ event_signature: string }>(sql`
      DELETE FROM webhook_event_signatures
      WHERE event_signature IN (
        SELECT event_signature FROM webhook_event_signatures
        WHERE created_at < ${cutoff}
        ORDER BY created_at
        LIMIT ${SIGNATURE_PRUNE_BATCH_SIZE}
      )
      RETURNING event_signature
    `);
    deletedCount += rows.length;
    if (rows.length < SIGNATURE_PRUNE_BATCH_SIZE) return { deletedCount, hasMore: false };
  }

  return { deletedCount, hasMore: true };
}

function isMissingPartitionError(error: unknown): boolean {
  // 23514 is also a check violation, so match the routing failure's message too.
  for (let current: unknown = error; current instanceof Error; current = current.cause) {
    if (
      postgresErrorCode(current) === '23514' &&
      current.message.includes(`no partition of relation "${PARENT_TABLE}"`)
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Runs a webhook event write, and if its day has no partition yet, creates the
 * partitions and runs it once more. The cron normally keeps them provisioned;
 * this keeps writes working where it does not run, such as local development,
 * and after it has stalled for longer than its look-ahead.
 *
 * `write` must be safe to rerun: a whole transaction that rolled back.
 */
export async function withWebhookEventPartitions<T>(
  fromDb: PartitionDb,
  write: () => Promise<T>
): Promise<T> {
  try {
    return await write();
  } catch (error) {
    if (!isMissingPartitionError(error)) throw error;
    await provisionWebhookEventPartitions(fromDb);
    return write();
  }
}
