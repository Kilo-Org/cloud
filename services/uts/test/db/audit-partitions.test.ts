import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TestDatabase, auditEvent, sqlStateOf } from './harness';

const DAY_MS = 86_400_000;

let db: TestDatabase;
let owner: pg.Client;
const now = new Date();

function partitionFor(daysFromToday: number): string {
  const day = new Date(now.getTime() + daysFromToday * DAY_MS);
  return `audit_events_${day.toISOString().slice(0, 10).replaceAll('-', '')}`;
}

function daysAgo(days: number): Date {
  return new Date(now.getTime() - days * DAY_MS);
}

async function maintain(at: Date, daysAhead = 7) {
  const result = await owner.query<{ action: string; partition_name: string }>(
    'SELECT * FROM uts.audit_partition_maintenance_at($1, $2)',
    [at, daysAhead]
  );
  return result.rows;
}

async function partitions(): Promise<string[]> {
  const result = await owner.query<{ relname: string }>(
    `SELECT child.relname FROM pg_inherits
     JOIN pg_class AS child ON child.oid = pg_inherits.inhrelid
     WHERE pg_inherits.inhparent = 'uts.audit_events'::regclass
     ORDER BY child.relname`
  );
  return result.rows.map(row => row.relname);
}

/** Inserts audit rows dated `createdAt`, one per shard, and returns each shard's newest row. */
async function insertRowsAt(createdAt: Date) {
  const rows = [];
  for (let index = 0; index < 8; index++) {
    const event = auditEvent();
    const result = await owner.query<{ id: bigint; txid: bigint; shard: number }>(
      `INSERT INTO uts.audit_events (created_at, event_id, event_type, event)
       VALUES ($1, $2, $3, $4)
       RETURNING id, txid, shard`,
      [createdAt, event.id, event.type, event]
    );
    rows.push(result.rows[0]);
  }
  return rows;
}

async function advanceWatermark(row: { id: bigint; txid: bigint; shard: number }) {
  await owner.query(
    'UPDATE uts.audit_relay_watermarks SET last_txid = $1::text::xid8, last_id = $2 WHERE shard = $3',
    [row.txid.toString(), row.id, row.shard]
  );
}

beforeAll(async () => {
  db = await TestDatabase.create();
  owner = await db.connectAsOwner();
});
afterAll(() => db.drop());

describe('audit partition maintenance', () => {
  it('has partitions for today and the next 7 days after migration', async () => {
    const names = await partitions();
    for (let day = 0; day <= 7; day++) expect(names).toContain(partitionFor(day));
  });

  it('creates only the missing days', async () => {
    expect(await maintain(now)).toEqual([]);
    expect(await maintain(new Date(now.getTime() + DAY_MS))).toEqual([
      { action: 'created', partition_name: partitionFor(8) },
    ]);
  });

  it('rejects a lead outside 1 to 31 days', async () => {
    expect(await sqlStateOf(() => maintain(now, 0))).toBe('22023');
    expect(await sqlStateOf(() => maintain(now, 32))).toBe('22023');
  });

  it('drops an old partition only after every shard relayed every row in it', async () => {
    await maintain(daysAgo(10), 1);
    const old = partitionFor(-10);
    const rows = await insertRowsAt(new Date(daysAgo(10).setUTCHours(12, 0, 0, 0)));
    expect(new Set(rows.map(row => row.shard)).size).toBe(8);

    expect(await maintain(now)).toEqual([
      { action: 'kept_unrelayed', partition_name: old },
      { action: 'dropped', partition_name: partitionFor(-9) },
    ]);

    const [heldBack, ...otherShards] = rows;
    for (const row of otherShards) await advanceWatermark(row);
    expect(await maintain(now)).toEqual([{ action: 'kept_unrelayed', partition_name: old }]);
    expect(await partitions()).toContain(old);

    await advanceWatermark(heldBack);
    expect(await maintain(now)).toEqual([{ action: 'dropped', partition_name: old }]);
    expect(await partitions()).not.toContain(old);
  });

  it('keeps a relayed partition until its newest row is 7 days old', async () => {
    await maintain(daysAgo(8), 1);
    const results = await maintain(now);
    expect(results).toEqual([{ action: 'dropped', partition_name: partitionFor(-8) }]);
    expect(await partitions()).toContain(partitionFor(-7));
  });
});
