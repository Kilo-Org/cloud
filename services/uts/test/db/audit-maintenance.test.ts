import { AUDIT_BATCH_MAX_EVENTS } from '@kilocode/sts-contracts';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { UNRELAYED_AGE } from '../../src/audit/outbox';
import { RELAY_READ, TestDatabase, auditEvent, insertAudit, sqlStateOf } from './harness';

/**
 * Partition maintenance and the relay read at volume (design section 8.1). The database holds an
 * old partition with 100,000 rows that every shard has relayed, an empty old partition, and newer
 * rows that no shard has relayed. The tests pin the plans that keep both reads off relayed rows,
 * and measure how long an audit insert waits while maintenance drops a partition. Each measured
 * figure is printed.
 */

const DAY_MS = 86_400_000;
const OLD_ROWS = 100_000;
const NEW_ROWS = 20_000;
const LOCK_TIMEOUT_MS = 200;
/**
 * Slack on the wall-clock bounds of the insert waits. The test measures client round trips, and a
 * busy shared CI runner delays them by tens of milliseconds while the database waits no longer.
 * Each bound stays tied to what it proves: an insert during the DROP waits about as long as the
 * DROP call, and an insert queued behind a DROP waits about as long as the DROP's lock timeout.
 */
const DROP_WAIT_SLACK_MS = 50;
const QUEUED_INSERT_SLACK_MS = 250;

const now = new Date();

function partitionFor(daysFromToday: number): string {
  const day = new Date(now.getTime() + daysFromToday * DAY_MS);
  return `audit_events_${day.toISOString().slice(0, 10).replaceAll('-', '')}`;
}

const OLD_PARTITION = partitionFor(-9);
const TODAY_PARTITION = partitionFor(0);

/** `(txid, id) > (last_txid, last_id)`, as EXPLAIN prints it inside an index condition. */
const ROW_COMPARISON =
  /ROW\((\w+\.)?txid, (\w+\.)?id\) > ROW\(watermark\.last_txid, watermark\.last_id\)/;

const PlanNodeSchema: z.ZodType<PlanNode> = z.lazy(() =>
  z.looseObject({
    'Node Type': z.string(),
    'Relation Name': z.string().optional(),
    'Index Name': z.string().optional(),
    'Index Cond': z.string().optional(),
    'Actual Rows': z.number(),
    'Actual Loops': z.number(),
    'Heap Fetches': z.number().optional(),
    Plans: z.array(PlanNodeSchema).optional(),
  })
);
type PlanNode = {
  'Node Type': string;
  'Relation Name'?: string;
  'Index Name'?: string;
  'Index Cond'?: string;
  'Actual Rows': number;
  'Actual Loops': number;
  'Heap Fetches'?: number;
  Plans?: PlanNode[];
};
const ExplainSchema = z.tuple([
  z.looseObject({ Plan: PlanNodeSchema, 'Execution Time': z.number() }),
]);

function planNodes(node: PlanNode): PlanNode[] {
  return [node, ...(node.Plans ?? []).flatMap(planNodes)];
}

async function explain(client: pg.Client, statement: string) {
  const result = await client.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${statement}`);
  const [explained] = ExplainSchema.parse(result.rows[0]['QUERY PLAN']);
  return { nodes: planNodes(explained.Plan), executionMs: explained['Execution Time'] };
}

let db: TestDatabase;
let owner: pg.Client;

async function partitions(): Promise<string[]> {
  const result = await owner.query<{ relname: string }>(
    `SELECT child.relname FROM pg_inherits
     JOIN pg_class AS child ON child.oid = pg_inherits.inhrelid
     WHERE pg_inherits.inhparent = 'uts.audit_events'::regclass
     ORDER BY child.relname`
  );
  return result.rows.map(row => row.relname);
}

function milliseconds(values: number[]): string {
  return `${Math.max(...values).toFixed(1)} ms max, ${values.length} inserts`;
}

beforeAll(async () => {
  db = await TestDatabase.create();
  owner = await db.connectAsOwner();
  // The two old partitions, created the way the cron creates partitions: one call per partition.
  let created = true;
  while (created) {
    const step = await owner.query(
      `SELECT 1 FROM uts.audit_partition_maintenance_at(now() - interval '9 days', 1)
       WHERE action = 'created'`
    );
    created = step.rowCount === 1;
  }
  const event = auditEvent();
  await owner.query(
    `INSERT INTO uts.audit_events (created_at, event_id, event_type, event)
     SELECT now() - interval '9 days', ids.id, $1, jsonb_set($2::jsonb, '{id}', to_jsonb(ids.id::text))
     FROM (SELECT gen_random_uuid() AS id FROM generate_series(1, $3)) AS ids`,
    [event.type, event, OLD_ROWS]
  );
  // Every shard has relayed every row so far.
  await owner.query(
    `UPDATE uts.audit_relay_watermarks AS watermark
     SET last_txid = newest.txid, last_id = newest.id
     FROM (SELECT DISTINCT ON (shard) shard, txid, id FROM uts.audit_events
           ORDER BY shard, txid DESC, id DESC) AS newest
     WHERE watermark.shard = newest.shard`
  );
  await owner.query(`VACUUM (ANALYZE) uts.${OLD_PARTITION}`);
  const app = await db.connect('uts_app_a');
  await app.query(
    `INSERT INTO uts.audit_events (event_id, event_type, event)
     SELECT ids.id, $1, jsonb_set($2::jsonb, '{id}', to_jsonb(ids.id::text))
     FROM (SELECT gen_random_uuid() AS id FROM generate_series(1, $3)) AS ids`,
    [event.type, event, NEW_ROWS]
  );
  await owner.query(`ANALYZE uts.${TODAY_PARTITION}`);
}, 180_000);
afterAll(() => db.drop());

describe('audit reads at volume', () => {
  it('read past the watermark with the row comparison as the index condition of every partition', async () => {
    await owner.query('SET plan_cache_mode = force_generic_plan');
    await owner.query(`PREPARE relay_read(smallint, integer) AS ${RELAY_READ}`);
    try {
      const { nodes, executionMs } = await explain(
        owner,
        `EXECUTE relay_read(3, ${AUDIT_BATCH_MAX_EVENTS})`
      );
      const scans = nodes.filter(node => node['Relation Name']?.startsWith('audit_events_'));
      expect(scans.map(scan => scan['Relation Name']).sort()).toEqual(await partitions());
      for (const scan of scans) {
        expect(scan['Node Type']).toBe('Index Scan');
        expect(scan['Index Name']).toBe(`${scan['Relation Name']}_shard_txid_id_idx`);
        expect(scan['Index Cond']).toMatch(ROW_COMPARISON);
      }
      const relayed = scans.find(scan => scan['Relation Name'] === OLD_PARTITION);
      expect(relayed?.['Actual Rows']).toBe(0);
      console.info(
        `relay read (generic plan) over ${OLD_ROWS} relayed and ${NEW_ROWS} new rows: ${executionMs} ms`
      );
    } finally {
      await owner.query('DEALLOCATE relay_read');
      await owner.query('RESET plan_cache_mode');
    }

    // Other test files' writes hold back the server-wide horizon for up to several seconds, so
    // the read may wait up to 30 seconds.
    await vi.waitFor(
      async () => {
        const read = await owner.query<{ shard: number; created_at: Date }>(RELAY_READ, [
          3,
          AUDIT_BATCH_MAX_EVENTS,
        ]);
        expect(read.rows).toHaveLength(AUDIT_BATCH_MAX_EVENTS);
        for (const row of read.rows) {
          expect(row.shard).toBe(3);
          expect(row.created_at.getTime()).toBeGreaterThan(now.getTime() - DAY_MS);
        }
      },
      { timeout: 30_000, interval: 100 }
    );
  }, 35_000);

  it('check a relayed partition with one index-only probe per shard', async () => {
    const built = await owner.query<{ query: string }>(
      'SELECT uts.audit_partition_unrelayed_query($1) AS query',
      [OLD_PARTITION]
    );
    const { query } = built.rows[0];
    const { nodes, executionMs } = await explain(owner, query);
    const partitionNodes = nodes.filter(node => node['Relation Name'] === OLD_PARTITION);
    expect(partitionNodes).toHaveLength(1);
    expect(partitionNodes[0]).toMatchObject({
      'Node Type': 'Index Only Scan',
      'Index Name': `${OLD_PARTITION}_shard_txid_id_idx`,
      'Actual Rows': 0,
      'Actual Loops': 8,
      'Heap Fetches': 0,
    });
    expect(partitionNodes[0]['Index Cond']).toMatch(ROW_COMPARISON);
    expect(nodes.filter(node => node['Node Type'] === 'Seq Scan')).toEqual([
      expect.objectContaining({ 'Relation Name': 'audit_relay_watermarks' }),
    ]);
    const answer = await owner.query<{ exists: boolean }>(query);
    expect(answer.rows).toEqual([{ exists: false }]);
    console.info(`partition check over ${OLD_ROWS} relayed rows: ${executionMs} ms`);
  });

  it('find each shard first unrelayed row with one index probe per shard and partition', async () => {
    const { nodes, executionMs } = await explain(owner, UNRELAYED_AGE);
    const scans = nodes.filter(node => node['Relation Name']?.startsWith('audit_events_'));
    expect(scans.map(scan => scan['Relation Name']).sort()).toEqual(await partitions());
    for (const scan of scans) {
      expect(scan['Node Type']).toBe('Index Scan');
      expect(scan['Index Name']).toBe(`${scan['Relation Name']}_shard_txid_id_idx`);
      expect(scan['Index Cond']).toMatch(ROW_COMPARISON);
    }
    const relayed = scans.find(scan => scan['Relation Name'] === OLD_PARTITION);
    expect(relayed?.['Actual Rows']).toBe(0);
    // The 8 watermark rows are read once; no partition is scanned without its index.
    expect(
      nodes.filter(
        node =>
          node['Node Type'] === 'Seq Scan' && node['Relation Name'] !== 'audit_relay_watermarks'
      )
    ).toEqual([]);
    console.info(
      `unrelayed age over ${scans.length} partitions, ${OLD_ROWS} relayed rows: ${executionMs} ms`
    );
  });
});

describe('expired DPoP proofs at volume', () => {
  it('delete only the expired range through the expires_at index', async () => {
    const live = 75_000;
    const expired = 5_000;
    await owner.query(
      `INSERT INTO uts.dpop_proofs (grant_id, jti, expires_at)
       SELECT gen_random_uuid(), md5(n::text), now() + (60 + n % 60) * interval '1 second'
       FROM generate_series(1, $1) AS n
       UNION ALL
       SELECT gen_random_uuid(), md5(('x' || n)::text), now() - (1 + n % 60) * interval '1 second'
       FROM generate_series(1, $2) AS n`,
      [live, expired]
    );
    await owner.query('ANALYZE uts.dpop_proofs');
    const { nodes, executionMs } = await explain(
      owner,
      `SELECT stale.grant_id, stale.jti FROM uts.dpop_proofs AS stale
       WHERE stale.expires_at < now() LIMIT 5000`
    );
    const indexScans = nodes.filter(node => node['Index Name'] === 'dpop_proofs_expires_idx');
    expect(indexScans).toHaveLength(1);
    expect(indexScans[0]['Actual Rows']).toBe(expired);
    expect(nodes.filter(node => node['Node Type'] === 'Seq Scan')).toEqual([]);
    const started = performance.now();
    const deleted = await owner.query<{ kind: string; deleted: number }>(
      'SELECT kind, deleted FROM uts.maintain_oauth_rows()'
    );
    const callMs = performance.now() - started;
    expect(deleted.rows.find(row => row.kind === 'dpop_proofs')?.deleted).toBe(expired);
    console.info(
      `expired-proof read over ${live} live and ${expired} expired proofs: ${executionMs} ms; maintenance call ${callMs.toFixed(1)} ms`
    );
  });
});

describe('watermark guard at volume', () => {
  /**
   * The row count `uts.advance_audit_watermark` checks (0002_audit_outbox.sql), with the
   * function's variables as parameters: `$1` the shard, `$2`/`$3` the old position, `$4`/`$5` the
   * new one. PL/pgSQL plans it once per session and may keep a generic plan, so the generic plan
   * is the one that must stay on the index.
   */
  const WATERMARK_COUNT = `SELECT count(*) FROM (
      SELECT 1
      FROM uts.audit_events AS passed
      WHERE passed.shard = $1
        AND (passed.txid, passed.id) > ($2, $3)
        AND (passed.txid, passed.id) <= ($4, $5)
      ORDER BY passed.txid, passed.id
      LIMIT 501
    ) AS window_rows`;
  const LOWER_BOUND = /ROW\((\w+\.)?txid, (\w+\.)?id\) > ROW\(\$2, \$3\)/;
  const UPPER_BOUND = /ROW\((\w+\.)?txid, (\w+\.)?id\) <= ROW\(\$4, \$5\)/;

  it('pin the count query to the function body', async () => {
    const body = await owner.query<{ prosrc: string }>(
      `SELECT prosrc FROM pg_proc
       WHERE oid = 'uts.advance_audit_watermark(smallint, bigint, xid8, bigint, bigint)'::regprocedure`
    );
    const squash = (text: string) => text.replaceAll(/\s+/g, ' ');
    expect(squash(body.rows[0].prosrc)).toContain(
      squash(`ORDER BY passed.txid, passed.id
    LIMIT 501`)
    );
  });

  it('count a 500-row move with both row comparisons as the index condition of every partition', async () => {
    const watermark = await owner.query<{ last_txid: string; last_id: string }>(
      `SELECT last_txid::text, last_id::text FROM uts.audit_relay_watermarks WHERE shard = 3`
    );
    const target = await owner.query<{ txid: string; id: string }>(
      `SELECT event.txid::text, event.id::text
       FROM uts.audit_events AS event, uts.audit_relay_watermarks AS watermark
       WHERE watermark.shard = 3 AND event.shard = 3
         AND (event.txid, event.id) > (watermark.last_txid, watermark.last_id)
       ORDER BY event.txid, event.id
       OFFSET ${AUDIT_BATCH_MAX_EVENTS - 1} LIMIT 1`
    );
    const [from] = watermark.rows;
    const [to] = target.rows;
    await owner.query('SET plan_cache_mode = force_generic_plan');
    await owner.query(
      `PREPARE watermark_count(smallint, xid8, bigint, xid8, bigint) AS ${WATERMARK_COUNT}`
    );
    try {
      const { nodes, executionMs } = await explain(
        owner,
        `EXECUTE watermark_count(3, '${from.last_txid}', ${from.last_id}, '${to.txid}', ${to.id})`
      );
      const scans = nodes.filter(node => node['Relation Name']?.startsWith('audit_events_'));
      expect(scans.map(scan => scan['Relation Name']).sort()).toEqual(await partitions());
      for (const scan of scans) {
        expect(['Index Scan', 'Index Only Scan']).toContain(scan['Node Type']);
        expect(scan['Index Name']).toBe(`${scan['Relation Name']}_shard_txid_id_idx`);
        expect(scan['Index Cond']).toMatch(LOWER_BOUND);
        expect(scan['Index Cond']).toMatch(UPPER_BOUND);
      }
      const relayed = scans.find(scan => scan['Relation Name'] === OLD_PARTITION);
      expect(relayed?.['Actual Rows']).toBe(0);
      const read = scans.reduce(
        (total, scan) => total + scan['Actual Rows'] * scan['Actual Loops'],
        0
      );
      expect(read).toBe(AUDIT_BATCH_MAX_EVENTS);
      expect(read).toBeLessThanOrEqual(501);
      console.info(
        `watermark count (generic plan) of a ${AUDIT_BATCH_MAX_EVENTS}-row move over ${OLD_ROWS} relayed rows: ${executionMs} ms`
      );
    } finally {
      await owner.query('DEALLOCATE watermark_count');
      await owner.query('RESET plan_cache_mode');
    }
  });
});

describe('partition maintenance under insert load', () => {
  it('truncate a relayed partition without locking the parent table', async () => {
    const maintainer = await db.connectAsOwner();
    const inserter = await db.connect('uts_app_a');
    // Hold the TRUNCATE's transaction open to inspect its locks.
    await maintainer.query('BEGIN');
    try {
      const started = performance.now();
      const result = await maintainer.query(
        'SELECT * FROM uts.audit_partition_maintenance_at(now(), 7)'
      );
      const callMs = performance.now() - started;
      expect(result.rows).toEqual([{ action: 'truncated', partition_name: OLD_PARTITION }]);

      const locks = await maintainer.query<{ relation: string; mode: string }>(
        `SELECT relation::regclass::text AS relation, mode FROM pg_locks
         WHERE pid = pg_backend_pid() AND locktype = 'relation'
           AND relation IN ('uts.audit_events'::regclass, $1::regclass)`,
        [`uts.${OLD_PARTITION}`]
      );
      expect(locks.rows.map(lock => lock.relation)).not.toContain('uts.audit_events');
      expect(locks.rows).toContainEqual({
        relation: `uts.${OLD_PARTITION}`,
        mode: 'AccessExclusiveLock',
      });

      // An insert goes through while the TRUNCATE's lock is still held.
      const insertStarted = performance.now();
      await insertAudit(inserter);
      const insertMs = performance.now() - insertStarted;
      expect(insertMs).toBeLessThan(LOCK_TIMEOUT_MS);
      console.info(
        `truncate call over ${OLD_ROWS} rows ${callMs.toFixed(1)} ms; an insert during its open ` +
          `transaction took ${insertMs.toFixed(1)} ms`
      );
    } finally {
      await maintainer.query('COMMIT');
    }
    const left = await owner.query(`SELECT count(*)::int AS rows FROM uts.${OLD_PARTITION}`);
    expect(left.rows).toEqual([{ rows: 0 }]);
  });

  it('give up after its lock wait when an insert holds the table, so a queued insert waits no longer', async () => {
    const holder = await db.connect('uts_app_b');
    const maintainer = await db.connectAsOwner();
    const watcher = await db.connect();
    const inserter = await db.connect('uts_app_a');
    const pid = z
      .object({ pid: z.number() })
      .parse((await maintainer.query('SELECT pg_backend_pid() AS pid')).rows[0]).pid;

    await holder.query('BEGIN');
    await insertAudit(holder);
    try {
      const started = performance.now();
      const call = sqlStateOf(() =>
        maintainer.query('SELECT * FROM uts.audit_partition_maintenance_at(now(), 7)')
      );
      // The DROP now waits for the parent's lock, and every new insert queues behind it.
      await vi.waitFor(
        async () => {
          const waiting = await watcher.query(
            'SELECT 1 FROM pg_locks WHERE pid = $1 AND NOT granted',
            [pid]
          );
          expect(waiting.rowCount).toBe(1);
        },
        { timeout: LOCK_TIMEOUT_MS, interval: 2 }
      );
      const insertStarted = performance.now();
      await insertAudit(inserter);
      const insertWait = performance.now() - insertStarted;
      expect(await call).toBe('55P03');
      const callMs = performance.now() - started;

      expect(callMs).toBeGreaterThanOrEqual(LOCK_TIMEOUT_MS - 5);
      expect(insertWait).toBeLessThan(LOCK_TIMEOUT_MS + QUEUED_INSERT_SLACK_MS);
      console.info(
        `lock wait gave up after ${callMs.toFixed(1)} ms; the queued insert waited ${insertWait.toFixed(1)} ms`
      );
    } finally {
      await holder.query('COMMIT');
    }
    expect(await partitions()).toContain(OLD_PARTITION);
  });

  it('drop the emptied partition while inserts wait no longer than the DDL', async () => {
    const inserter = await db.connect('uts_app_a');
    const baseline: number[] = [];
    for (let index = 0; index < 200; index++) {
      const started = performance.now();
      await insertAudit(inserter);
      baseline.push(performance.now() - started);
    }

    const during: number[] = [];
    let running = true;
    const load = (async () => {
      while (running) {
        const started = performance.now();
        await insertAudit(inserter);
        during.push(performance.now() - started);
      }
    })();
    await vi.waitFor(() => expect(during.length).toBeGreaterThan(20));

    const started = performance.now();
    const result = await owner.query('SELECT * FROM uts.audit_partition_maintenance_at(now(), 7)');
    const callMs = performance.now() - started;
    const settled = during.length + 20;
    await vi.waitFor(() => expect(during.length).toBeGreaterThan(settled));
    running = false;
    await load;

    expect(result.rows).toEqual([{ action: 'dropped', partition_name: OLD_PARTITION }]);
    expect(await partitions()).not.toContain(OLD_PARTITION);
    expect(Math.max(...during)).toBeLessThanOrEqual(
      callMs + Math.max(...baseline) + DROP_WAIT_SLACK_MS
    );
    console.info(
      `drop call ${callMs.toFixed(1)} ms; inserts before: ${milliseconds(baseline)}; ` +
        `inserts around the drop: ${milliseconds(during)}`
    );
  });
});
