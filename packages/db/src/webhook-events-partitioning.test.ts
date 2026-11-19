/**
 * Pins down the PostgreSQL behavior that the daily range partitioning of
 * `webhook_events_v2` (migration 0369, and
 * `apps/web/src/lib/integrations/db/webhook-event-partitions.ts`) relies on.
 *
 * It builds the same layout in a throwaway schema rather than touching
 * `public`, so it can also show the DDL PostgreSQL rejects and the
 * alternatives the design ruled out:
 *
 * - which partitioned-table DDL PostgreSQL accepts and which it rejects;
 * - that deduplication must move out of the partitioned table;
 * - the claim-then-insert flow through a signature table;
 * - how rows are routed and pruned, and how old partitions are dropped;
 * - why the partitioned table has no foreign keys to busy tables.
 *
 * Database-backed: it needs `POSTGRES_URL` and is excluded from the default
 * `test` script (see `jest.config.mjs`). PostgreSQL 18 is the target version.
 */
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { randomUUID } from 'crypto';
import type pg from 'pg';

import { createDrizzleClient } from './client';
import { computeDatabaseUrl } from './database-url';

const testDatabase = createDrizzleClient({
  connectionString: computeDatabaseUrl(),
  poolConfig: { application_name: 'webhook-events-partitioning-test', max: 1 },
});
const pool = testDatabase.pool;

const SCHEMA = `webhook_partition_test_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
const PARENT = 'webhook_events_v2';
const SIGNATURES = 'webhook_event_signatures';
const SIGNATURES_PKEY = 'webhook_event_signatures_pkey';
const OWNER_CHECK = 'webhook_events_v2_owner_check';
const DAYS = ['2026-01-01', '2026-01-02', '2026-01-03'] as const;

/** Schema-qualified, quoted identifier. */
function q(name: string): string {
  return `"${SCHEMA}"."${name}"`;
}

/** Daily partitions are named after the first day they hold. */
function partitionName(parent: string, day: string): string {
  return `${parent}_${day.replaceAll('-', '_')}`;
}

/** The day after `day`, as `YYYY-MM-DD` in UTC. */
function nextDay(day: string): string {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

/**
 * The corrected parent DDL. Compared with the plan: no `WITH (fillfactor)` on
 * the parent (PostgreSQL rejects it), and no unique constraint on
 * `event_signature` (it cannot exist without `created_at`).
 */
function createParentSql(parent: string): string {
  return `
    CREATE TABLE ${q(parent)} (
      id uuid NOT NULL DEFAULT pg_catalog.gen_random_uuid(),
      owned_by_organization_id uuid,
      owned_by_user_id text,
      platform text NOT NULL,
      event_type text NOT NULL,
      event_action text,
      payload jsonb NOT NULL,
      headers jsonb NOT NULL,
      processed boolean NOT NULL DEFAULT false,
      processed_at timestamptz,
      handlers_triggered text[] NOT NULL DEFAULT '{}',
      errors jsonb,
      event_signature text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT "${parent}_pkey" PRIMARY KEY (id, created_at),
      CONSTRAINT "${parent === PARENT ? OWNER_CHECK : `${parent}_owner_check`}" CHECK (
        (owned_by_user_id IS NOT NULL AND owned_by_organization_id IS NULL) OR
        (owned_by_user_id IS NULL AND owned_by_organization_id IS NOT NULL)
      )
    ) PARTITION BY RANGE (created_at)
  `;
}

/**
 * Bounds are explicit UTC instants: a bare date literal is read in the session
 * time zone, so the partition boundary would depend on who ran the DDL.
 * Fillfactor is set per partition, since the parent cannot carry it.
 */
async function createDailyPartition(parent: string, day: string): Promise<string> {
  const name = partitionName(parent, day);
  await pool.query(
    `CREATE TABLE ${q(name)} PARTITION OF ${q(parent)}
       FOR VALUES FROM ('${day} 00:00:00+00') TO ('${nextDay(day)} 00:00:00+00')
       WITH (fillfactor = 90)`
  );
  return name;
}

async function createPartitionedTable(parent: string, days: readonly string[]): Promise<void> {
  await pool.query(createParentSql(parent));
  for (const day of days) {
    await createDailyPartition(parent, day);
  }
}

type PgError = Error & { code?: string; constraint?: string };

async function expectPgError(run: () => Promise<unknown>): Promise<PgError> {
  let caught: unknown;
  try {
    await run();
  } catch (error) {
    caught = error;
  }
  if (caught === undefined) throw new Error('expected the statement to fail, but it succeeded');
  if (!(caught instanceof Error)) throw caught;
  return caught as PgError;
}

type EventInput = {
  id?: string;
  signature?: string;
  createdAt: string;
  organizationId?: string | null;
  userId?: string | null;
};

async function insertEvent(
  executor: Pick<pg.Pool, 'query'>,
  parent: string,
  input: EventInput
): Promise<{ id: string; partition: string }> {
  const id = input.id ?? randomUUID();
  const ownerIsDefault = input.organizationId === undefined && input.userId === undefined;
  const { rows } = await executor.query<{ id: string; partition: string }>(
    `INSERT INTO ${q(parent)}
       (id, owned_by_organization_id, owned_by_user_id, platform, event_type,
        payload, headers, event_signature, created_at)
     VALUES ($1, $2, $3, 'github', 'pull_request', '{}', '{}', $4, $5)
     RETURNING id, tableoid::regclass::text AS partition`,
    [
      id,
      ownerIsDefault ? organizationId : (input.organizationId ?? null),
      input.userId ?? null,
      input.signature ?? `delivery-${randomUUID()}`,
      input.createdAt,
    ]
  );
  const row = rows[0];
  if (!row) throw new Error('insert returned no row');
  return row;
}

/** Leaf tables an `EXPLAIN (FORMAT JSON)` plan reads or writes. */
function planRelations(plan: unknown): string[] {
  const names = new Set<string>();
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (node === null || typeof node !== 'object') return;
    for (const [key, value] of Object.entries(node)) {
      if (key === 'Relation Name' && typeof value === 'string') names.add(value);
      else visit(value);
    }
  };
  visit(plan);
  return [...names].sort();
}

async function explainRelations(statement: string, params: unknown[] = []): Promise<string[]> {
  const { rows } = await pool.query<{ 'QUERY PLAN': unknown }>(
    `EXPLAIN (FORMAT JSON) ${statement}`,
    params
  );
  return planRelations(rows[0]?.['QUERY PLAN']).filter(name => name !== PARENT);
}

let organizationId: string;

beforeAll(async () => {
  await pool.query(`CREATE SCHEMA "${SCHEMA}"`);
  // Stand-ins for the real FK targets: the cascade behavior under test is the
  // same, and these need no fixture rows for the many NOT NULL user columns.
  await pool.query(`CREATE TABLE ${q('organizations')} (id uuid PRIMARY KEY)`);
  await pool.query(`CREATE TABLE ${q('kilocode_users')} (id text PRIMARY KEY)`);
  await pool.query(`
    CREATE TABLE ${q(SIGNATURES)} (
      event_signature text NOT NULL,
      webhook_event_id uuid NOT NULL,
      webhook_event_created_at timestamptz NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT "${SIGNATURES_PKEY}" PRIMARY KEY (event_signature)
    )
  `);
  await createPartitionedTable(PARENT, DAYS);
  await pool.query(
    `CREATE INDEX ON ${q(PARENT)} (owned_by_organization_id, created_at);
     CREATE INDEX ON ${q(PARENT)} (owned_by_user_id, created_at);
     CREATE INDEX ON ${q(PARENT)} (created_at)`
  );

  organizationId = randomUUID();
  await pool.query(`INSERT INTO ${q('organizations')} (id) VALUES ($1)`, [organizationId]);
});

afterAll(async () => {
  await pool.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
  await pool.end();
});

describe('webhook_events partitioned layout DDL', () => {
  it('rejects fillfactor on the partitioned parent but accepts it on each partition', async () => {
    const error = await expectPgError(() =>
      pool.query(
        `CREATE TABLE ${q('fillfactor_on_parent')} (id uuid, created_at timestamptz)
           PARTITION BY RANGE (created_at) WITH (fillfactor = 90)`
      )
    );
    expect(error.message).toMatch(/cannot specify storage parameters for a partitioned table/);

    const { rows } = await pool.query<{
      relname: string;
      reloptions: string[] | null;
    }>(
      `SELECT c.relname, c.reloptions
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1 AND c.relname = ANY($2)
        ORDER BY c.relname`,
      [SCHEMA, [PARENT, partitionName(PARENT, DAYS[0])]]
    );
    expect(rows).toEqual([
      { relname: PARENT, reloptions: null },
      {
        relname: partitionName(PARENT, DAYS[0]),
        reloptions: ['fillfactor=90'],
      },
    ]);
  });

  it('rejects a primary key or unique constraint that omits created_at', async () => {
    const uniqueSignature = await expectPgError(() =>
      pool.query(
        `CREATE TABLE ${q('unique_signature_only')} (
           id uuid NOT NULL, event_signature text NOT NULL UNIQUE, created_at timestamptz NOT NULL
         ) PARTITION BY RANGE (created_at)`
      )
    );
    expect(uniqueSignature.message).toMatch(/must include all partitioning columns/);

    const idOnlyPrimaryKey = await expectPgError(() =>
      pool.query(
        `CREATE TABLE ${q('id_only_pkey')} (id uuid PRIMARY KEY, created_at timestamptz NOT NULL)
           PARTITION BY RANGE (created_at)`
      )
    );
    expect(idOnlyPrimaryKey.message).toMatch(/must include all partitioning columns/);
  });
});

describe('deduplication on a partitioned webhook_events', () => {
  it('does not deduplicate redeliveries with a (event_signature, created_at) unique key', async () => {
    const table = 'unique_signature_and_created_at';
    await pool.query(
      `CREATE TABLE ${q(table)} (
         event_signature text NOT NULL,
         created_at timestamptz NOT NULL,
         UNIQUE (event_signature, created_at)
       ) PARTITION BY RANGE (created_at)`
    );
    await pool.query(
      `CREATE TABLE ${q(`${table}_p`)} PARTITION OF ${q(table)}
         FOR VALUES FROM ('2026-01-01 00:00:00+00') TO ('2026-01-03 00:00:00+00')`
    );

    // A redelivery reuses the delivery ID but gets a new created_at.
    await pool.query(
      `INSERT INTO ${q(table)} VALUES ('same-delivery', '2026-01-01 10:00:00+00'),
                                      ('same-delivery', '2026-01-02 10:00:00+00')`
    );
    const { rows } = await pool.query<{ count: string }>(
      `SELECT count(*) FROM ${q(table)} WHERE event_signature = 'same-delivery'`
    );
    expect(Number(rows[0]?.count)).toBe(2);
  });

  it('cannot use ON CONFLICT (event_signature) against the partitioned parent', async () => {
    // insertOrLoadBitbucketWebhookEvent uses exactly this conflict target today.
    const error = await expectPgError(() =>
      pool.query(
        `INSERT INTO ${q(PARENT)}
           (owned_by_organization_id, platform, event_type, payload, headers, event_signature, created_at)
         VALUES ($1, 'bitbucket', 'pullrequest', '{}', '{}', 'conflict-target', '2026-01-01 10:00:00+00')
         ON CONFLICT (event_signature) DO NOTHING`,
        [organizationId]
      )
    );
    expect(error.code).toBe('42P10');
  });

  it('lets only the first claim of a signature through', async () => {
    const signature = `delivery-${randomUUID()}`;
    const claim = () =>
      pool.query(
        `INSERT INTO ${q(SIGNATURES)} (event_signature, webhook_event_id, webhook_event_created_at)
         VALUES ($1, $2, '2026-01-01 10:00:00+00')
         ON CONFLICT (event_signature) DO NOTHING
         RETURNING event_signature`,
        [signature, randomUUID()]
      );

    expect((await claim()).rowCount).toBe(1);
    expect((await claim()).rowCount).toBe(0);
  });

  it('reports a plain duplicate claim as 23505 on the signature constraint', async () => {
    // logWebhookEvent detects duplicates by matching this code and constraint name.
    const signature = `delivery-${randomUUID()}`;
    const insert = () =>
      pool.query(
        `INSERT INTO ${q(SIGNATURES)} (event_signature, webhook_event_id, webhook_event_created_at)
         VALUES ($1, $2, '2026-01-01 10:00:00+00')`,
        [signature, randomUUID()]
      );

    await insert();
    const error = await expectPgError(insert);
    expect(error.code).toBe('23505');
    expect(error.constraint).toBe(SIGNATURES_PKEY);
  });

  it('releases the claim when the event insert in the same transaction fails', async () => {
    const signature = `delivery-${randomUUID()}`;
    const eventId = randomUUID();
    const createdAt = '2026-01-02 10:00:00+00';
    const client = await pool.connect();
    const claim = () =>
      client.query(
        `INSERT INTO ${q(SIGNATURES)} (event_signature, webhook_event_id, webhook_event_created_at)
         VALUES ($1, $2, $3)
         ON CONFLICT (event_signature) DO NOTHING
         RETURNING event_signature`,
        [signature, eventId, createdAt]
      );

    try {
      await client.query('BEGIN');
      expect((await claim()).rowCount).toBe(1);
      // Both owners null violates the owner check, so the event insert fails.
      await expectPgError(() =>
        insertEvent(client, PARENT, {
          id: eventId,
          signature,
          createdAt,
          organizationId: null,
          userId: null,
        })
      );
      await client.query('ROLLBACK');

      // A retry of the same delivery can claim it again and succeed.
      await client.query('BEGIN');
      expect((await claim()).rowCount).toBe(1);
      await insertEvent(client, PARENT, { id: eventId, signature, createdAt });
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }

    const { rows } = await pool.query<{ events: number; signatures: number }>(
      `SELECT (SELECT count(*)::int FROM ${q(PARENT)} WHERE event_signature = $1) AS events,
              (SELECT count(*)::int FROM ${q(SIGNATURES)} WHERE event_signature = $1) AS signatures`,
      [signature]
    );
    expect(rows[0]).toEqual({ events: 1, signatures: 1 });
  });
});

describe('routing rows to daily partitions', () => {
  it('routes each row by created_at, with the upper bound exclusive', async () => {
    const lastInstantOfDayOne = await insertEvent(pool, PARENT, {
      createdAt: '2026-01-01 23:59:59.999+00',
    });
    const firstInstantOfDayTwo = await insertEvent(pool, PARENT, {
      createdAt: '2026-01-02 00:00:00+00',
    });

    // regclass text quotes only identifiers that need it; these names do not.
    expect(lastInstantOfDayOne.partition).toBe(`${SCHEMA}.${partitionName(PARENT, '2026-01-01')}`);
    expect(firstInstantOfDayTwo.partition).toBe(`${SCHEMA}.${partitionName(PARENT, '2026-01-02')}`);
  });

  it('rejects a row with no matching partition when there is no default partition', async () => {
    // The partition cron must stay ahead of now(), or webhook inserts fail.
    const error = await expectPgError(() =>
      insertEvent(pool, PARENT, { createdAt: '2026-02-01 10:00:00+00' })
    );
    expect(error.code).toBe('23514');
    expect(error.message).toMatch(/no partition of relation/);
  });

  it('reads bare date bounds in the session time zone, so they overlap UTC-bounded neighbors', async () => {
    const parent = 'time_zone_bounds';
    await pool.query(
      `CREATE TABLE ${q(parent)} (created_at timestamptz NOT NULL) PARTITION BY RANGE (created_at)`
    );
    const client = await pool.connect();
    try {
      await client.query(`SET TIME ZONE 'America/Los_Angeles'`);
      await client.query(
        `CREATE TABLE ${q(`${parent}_bare`)} PARTITION OF ${q(parent)}
           FOR VALUES FROM ('2026-01-01') TO ('2026-01-02')`
      );
      // The bare-date partition really ends at 2026-01-02 08:00 UTC, so the next
      // day's UTC-bounded partition collides with it and the cron would fail.
      const overlap = await expectPgError(() =>
        client.query(
          `CREATE TABLE ${q(`${parent}_next`)} PARTITION OF ${q(parent)}
             FOR VALUES FROM ('2026-01-02 00:00:00+00') TO ('2026-01-03 00:00:00+00')`
        )
      );
      expect(overlap.message).toMatch(/would overlap partition/);

      await client.query(
        `CREATE TABLE ${q(`${parent}_utc`)} PARTITION OF ${q(parent)}
           FOR VALUES FROM ('2026-01-03 00:00:00+00') TO ('2026-01-04 00:00:00+00')`
      );
      await client.query(`SET TIME ZONE 'UTC'`);
      const { rows } = await client.query<{ relname: string; bound: string }>(
        `SELECT c.relname, pg_get_expr(c.relpartbound, c.oid) AS bound
           FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = $1 AND c.relname = ANY($2)
          ORDER BY c.relname`,
        [SCHEMA, [`${parent}_bare`, `${parent}_utc`]]
      );
      expect(rows).toEqual([
        {
          relname: `${parent}_bare`,
          bound: "FOR VALUES FROM ('2026-01-01 08:00:00+00') TO ('2026-01-02 08:00:00+00')",
        },
        {
          relname: `${parent}_utc`,
          bound: "FOR VALUES FROM ('2026-01-03 00:00:00+00') TO ('2026-01-04 00:00:00+00')",
        },
      ]);
    } finally {
      await client.query('RESET TIME ZONE');
      client.release();
    }
  });
});

describe('partition pruning', () => {
  const allPartitions = DAYS.map(day => partitionName(PARENT, day)).sort();

  it('reads one partition for a created_at window', async () => {
    const relations = await explainRelations(
      `SELECT * FROM ${q(PARENT)}
        WHERE owned_by_organization_id = '${randomUUID()}'
          AND created_at >= '2026-01-02 00:00:00+00' AND created_at < '2026-01-03 00:00:00+00'`
    );
    expect(relations).toEqual([partitionName(PARENT, '2026-01-02')]);
  });

  it('touches every partition when an update filters on id alone', async () => {
    const relations = await explainRelations(
      `UPDATE ${q(PARENT)} SET processed = true WHERE id = '${randomUUID()}'`
    );
    expect(relations).toEqual(allPartitions);
  });

  it('touches one partition when an update filters on id and created_at', async () => {
    const relations = await explainRelations(
      `UPDATE ${q(PARENT)} SET processed = true
        WHERE id = '${randomUUID()}' AND created_at = '2026-01-03 10:00:00+00'`
    );
    expect(relations).toEqual([partitionName(PARENT, '2026-01-03')]);
  });

  it('updates the processing columns without touching an index (HOT)', async () => {
    const event = await insertEvent(pool, PARENT, {
      createdAt: '2026-01-03 10:00:00+00',
    });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE ${q(PARENT)}
            SET processed = true, processed_at = now(), handlers_triggered = '{code_review}', errors = NULL
          WHERE id = $1 AND created_at = '2026-01-03 10:00:00+00'`,
        [event.id]
      );
      // The xact-level counter is current within this transaction; the
      // cumulative pg_stat views are flushed asynchronously.
      const { rows } = await client.query<{ hot: string }>(
        `SELECT pg_stat_get_xact_tuples_hot_updated($1::regclass) AS hot`,
        [q(partitionName(PARENT, '2026-01-03'))]
      );
      expect(Number(rows[0]?.hot)).toBe(1);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  });
});

describe('foreign keys and the owner check', () => {
  type LockedTable = { relation: string; mode: string };

  /** Locks the session holds on the stand-ins for kilocode_users and organizations. */
  async function referencedTableLocks(client: pg.PoolClient): Promise<LockedTable[]> {
    const { rows } = await client.query<LockedTable>(
      `SELECT c.relname AS relation, l.mode
         FROM pg_locks l JOIN pg_class c ON c.oid = l.relation
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE l.pid = pg_backend_pid() AND n.nspname = $1
          AND c.relname IN ('kilocode_users', 'organizations')
          AND l.mode <> 'AccessShareLock'
        ORDER BY c.relname`,
      [SCHEMA]
    );
    return rows;
  }

  it('locks referenced tables against writes on every partition change when it has foreign keys', async () => {
    // The ruled-out design: the same parent, with cascading foreign keys.
    const parent = 'with_foreign_keys';
    await pool.query(
      `CREATE TABLE ${q(parent)} (
         id uuid NOT NULL,
         owned_by_organization_id uuid REFERENCES ${q('organizations')}(id) ON DELETE CASCADE,
         owned_by_user_id text REFERENCES ${q('kilocode_users')}(id) ON DELETE CASCADE,
         created_at timestamptz NOT NULL,
         PRIMARY KEY (id, created_at)
       ) PARTITION BY RANGE (created_at)`
    );
    await createDailyPartition(parent, '2026-01-01');
    const client = await pool.connect();
    const inTransaction = async (statement: string) => {
      await client.query('BEGIN');
      try {
        await client.query(statement);
        return await referencedTableLocks(client);
      } finally {
        await client.query('COMMIT');
      }
    };
    const shareRowExclusive = [
      { relation: 'kilocode_users', mode: 'ShareRowExclusiveLock' },
      { relation: 'organizations', mode: 'ShareRowExclusiveLock' },
    ];

    try {
      // ShareRowExclusive conflicts with the RowExclusive lock every write takes.
      await expect(
        inTransaction(
          `CREATE TABLE ${q(`${parent}_2026_01_02`)} PARTITION OF ${q(parent)}
             FOR VALUES FROM ('2026-01-02 00:00:00+00') TO ('2026-01-03 00:00:00+00')`
        )
      ).resolves.toEqual(shareRowExclusive);
      await expect(
        inTransaction(
          `ALTER TABLE ${q(parent)} DETACH PARTITION ${q(partitionName(parent, '2026-01-01'))}`
        )
      ).resolves.toEqual(shareRowExclusive);
      // Dropping the detached partition blocks even reads of both tables.
      await expect(
        inTransaction(`DROP TABLE ${q(partitionName(parent, '2026-01-01'))}`)
      ).resolves.toEqual([
        { relation: 'kilocode_users', mode: 'AccessExclusiveLock' },
        { relation: 'organizations', mode: 'AccessExclusiveLock' },
      ]);
    } finally {
      client.release();
    }
  });

  it('takes no lock on those tables for partition changes without foreign keys', async () => {
    const parent = 'without_foreign_keys';
    await createPartitionedTable(parent, ['2026-01-01']);
    const client = await pool.connect();
    try {
      for (const statement of [
        `CREATE TABLE ${q(`${parent}_2026_01_02`)} PARTITION OF ${q(parent)}
           FOR VALUES FROM ('2026-01-02 00:00:00+00') TO ('2026-01-03 00:00:00+00')`,
        `ALTER TABLE ${q(parent)} DETACH PARTITION ${q(partitionName(parent, '2026-01-01'))}`,
        `DROP TABLE ${q(partitionName(parent, '2026-01-01'))}`,
      ]) {
        await client.query('BEGIN');
        await client.query(statement);
        expect(await referencedTableLocks(client)).toEqual([]);
        await client.query('COMMIT');
      }
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  });

  it('enforces the owner check on every partition', async () => {
    const error = await expectPgError(() =>
      insertEvent(pool, PARENT, {
        createdAt: '2026-01-01 10:00:00+00',
        organizationId: null,
        userId: null,
      })
    );
    expect(error.code).toBe('23514');
    expect(error.constraint).toBe(OWNER_CHECK);
  });
});

describe('retention by dropping partitions', () => {
  it('detaches a partition concurrently and drops it, removing its rows', async () => {
    const parent = 'retention_without_default';
    await createPartitionedTable(parent, DAYS);
    const expiredId = (await insertEvent(pool, parent, { createdAt: '2026-01-01 10:00:00+00' })).id;
    const keptId = (await insertEvent(pool, parent, { createdAt: '2026-01-02 10:00:00+00' })).id;

    // CONCURRENTLY cannot run inside a transaction block; pool.query autocommits.
    const expired = partitionName(parent, '2026-01-01');
    await pool.query(`ALTER TABLE ${q(parent)} DETACH PARTITION ${q(expired)} CONCURRENTLY`);
    await pool.query(`DROP TABLE ${q(expired)}`);

    const { rows } = await pool.query<{ id: string }>(`SELECT id FROM ${q(parent)}`);
    expect(rows.map(row => row.id)).toEqual([keptId]);
    expect(rows.map(row => row.id)).not.toContain(expiredId);
  });

  it('refuses a concurrent detach while a default partition exists', async () => {
    // A default partition (safety net for a lagging partition cron) and
    // DETACH ... CONCURRENTLY cannot be combined; the plan must pick one.
    const parent = 'retention_with_default';
    await createPartitionedTable(parent, DAYS);
    await pool.query(`CREATE TABLE ${q(`${parent}_default`)} PARTITION OF ${q(parent)} DEFAULT`);

    const expired = partitionName(parent, '2026-01-01');
    const error = await expectPgError(() =>
      pool.query(`ALTER TABLE ${q(parent)} DETACH PARTITION ${q(expired)} CONCURRENTLY`)
    );
    expect(error.code).toBe('55000');
    expect(error.message).toMatch(/default partition exists/);

    // A plain detach still works, at the cost of a stronger lock on the parent.
    await pool.query(`ALTER TABLE ${q(parent)} DETACH PARTITION ${q(expired)}`);
    await pool.query(`DROP TABLE ${q(expired)}`);
  });
});
