import type pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { rowMaintenance, runMaintenance } from '../../src/audit/maintenance';
import { type IdentityStore, withIdentityStore } from '../../src/db/client';
import { TestDatabase, auditEvent } from './harness';

/**
 * The cron's identity-store work and its alert log lines (`src/audit/maintenance.ts`). A lock that
 * another session holds on the partitioned table makes a partition CREATE or DROP give up after
 * its 200 ms lock timeout, which is how a maintenance call fails here.
 */

let db: TestDatabase;
let owner: pg.Client;

beforeAll(async () => {
  db = await TestDatabase.create();
  owner = await db.connectAsOwner();
});
afterAll(() => db.drop());
afterEach(() => vi.restoreAllMocks());

function withStore<Result>(work: (store: IdentityStore) => Promise<Result>): Promise<Result> {
  return withIdentityStore(db.url('uts_app_b'), { waitUntil: () => undefined }, work);
}

/** Every JSON log line `run` writes through `console.error` and `console.log`. */
async function logLines(run: () => Promise<void>): Promise<Array<Record<string, unknown>>> {
  const lines: string[] = [];
  const keep = (line: unknown) => {
    lines.push(String(line));
  };
  vi.spyOn(console, 'error').mockImplementation(keep);
  vi.spyOn(console, 'log').mockImplementation(keep);
  await run();
  vi.restoreAllMocks();
  return lines.filter(line => line.startsWith('{')).map(line => JSON.parse(line));
}

/** Runs `work` while another session holds a lock that refuses partition DDL but not reads. */
async function withPartitionDdlBlocked(work: () => Promise<void>): Promise<void> {
  const blocker = await db.connectAsOwner();
  await blocker.query('BEGIN');
  await blocker.query('LOCK TABLE ONLY uts.audit_events IN SHARE ROW EXCLUSIVE MODE');
  try {
    await work();
  } finally {
    await blocker.query('ROLLBACK');
  }
}

async function insertAt(daysAgo: number) {
  const event = auditEvent();
  const result = await owner.query<{ shard: number; txid: bigint; id: bigint }>(
    `INSERT INTO uts.audit_events (created_at, event_id, event_type, event)
     VALUES (now() - $1 * interval '1 day', $2, $3, $4) RETURNING shard, txid, id`,
    [daysAgo, event.id, event.type, event]
  );
  return result.rows[0];
}

const partitionDaysAgo = async (days: number) =>
  (
    await owner.query<{ name: string }>(
      `SELECT 'audit_events_' || to_char((now() AT TIME ZONE 'UTC')::date - $1::integer, 'YYYYMMDD') AS name`,
      [days]
    )
  ).rows[0].name;

describe('cron maintenance alerts', () => {
  it('logs kept partitions, the lag and the failed step when a partition drop gives up', async () => {
    // Partitions 10 and 9 days old, both past the 7-day tier.
    while (
      (
        await owner.query(
          `SELECT 1 FROM uts.audit_partition_maintenance_at(now() - interval '10 days', 1)
           WHERE action = 'created'`
        )
      ).rowCount === 1
    );
    // The 9-day-old row is relayed; the 10-day-old row, written later, is not.
    const relayed = await insertAt(9);
    await owner.query(
      'UPDATE uts.audit_relay_watermarks SET last_txid = $1::text::xid8, last_id = $2 WHERE shard = $3',
      [relayed.txid.toString(), relayed.id, relayed.shard]
    );
    const unrelayed = await insertAt(10);
    const kept = await partitionDaysAgo(10);
    const truncated = await partitionDaysAgo(9);

    // The first call truncates the relayed partition; the second call's DROP cannot get its lock.
    const lines = await logLines(() =>
      withPartitionDdlBlocked(() => withStore(store => runMaintenance(store)))
    );

    expect(lines).toContainEqual({
      event: 'uts.audit_partitions.step',
      action: 'truncated',
      partition_name: truncated,
    });
    expect(lines).toContainEqual(
      expect.objectContaining({
        event: 'uts.maintenance.failed',
        step: 'audit_partitions',
        sqlState: '55P03',
      })
    );
    expect(lines).toContainEqual({ event: 'uts.audit_partitions.kept_unrelayed', partition: kept });
    expect(lines.filter(line => line.event === 'uts.audit_partitions.runway_short')).toEqual([]);
    const lagging = lines.find(
      line => line.event === 'uts.audit_relay.lagging' && line.shard === unrelayed.shard
    );
    expect(lagging?.ageSeconds).toBeGreaterThan(9 * 86_400);
  });

  it('logs a short runway when a partition create gives up', async () => {
    await owner.query(
      `DO $drop$ BEGIN
         EXECUTE format('DROP TABLE uts.%I', 'audit_events_' ||
           to_char((now() AT TIME ZONE 'UTC')::date + 7, 'YYYYMMDD'));
       END $drop$`
    );

    const lines = await logLines(() =>
      withPartitionDdlBlocked(() => withStore(store => runMaintenance(store)))
    );

    expect(lines).toContainEqual(
      expect.objectContaining({
        event: 'uts.maintenance.failed',
        step: 'audit_partitions',
        sqlState: '55P03',
      })
    );
    expect(lines).toContainEqual({
      event: 'uts.audit_partitions.runway_short',
      days: 7,
      expected: 8,
    });

    // Without the lock the next run creates the missing partition and the alert stops.
    const after = await logLines(() => withStore(store => runMaintenance(store)));
    expect(after.filter(line => line.event === 'uts.audit_partitions.runway_short')).toEqual([]);
    expect(after.filter(line => line.event === 'uts.maintenance.failed')).toEqual([]);
  });

  it('logs that OAuth maintenance fell behind when a kind still fills its batch on the last call', async () => {
    await owner.query(
      `INSERT INTO uts.dpop_proofs (jkt, jti, expires_at)
       SELECT sha256(gen_random_uuid()::text::bytea), md5(n::text), now() - interval '1 minute'
       FROM generate_series(1, 6000) AS n`
    );

    const behind = await logLines(() => withStore(store => rowMaintenance(store, 'oauth_rows', 1)));
    expect(behind).toEqual([{ event: 'uts.oauth_rows.behind', kinds: ['dpop_proofs'] }]);

    // 1,000 remain, under one batch: the call catches up and logs nothing.
    const caughtUp = await logLines(() =>
      withStore(store => rowMaintenance(store, 'oauth_rows', 1))
    );
    expect(caughtUp).toEqual([]);
  });
});
