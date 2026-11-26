import { encodeAuditBatch, type AuditBatch } from '@kilocode/sts-contracts';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  identityStoreOutbox,
  maintainAuditPartitions,
  maintainOAuthRows,
  partitionRunwayDays,
  unrelayedAges,
} from '../../src/audit/outbox';
import { auditStreamName, relayShard, type AuditOutbox } from '../../src/audit/relay';
import { type IdentityStore, withIdentityStore } from '../../src/db/client';
import { TestDatabase, auditEvent, insertAudit, sqlStateOf } from './harness';

const INVALID_PARAMETER = '22023';

let db: TestDatabase;
let app: pg.Client;
let owner: pg.Client;

beforeAll(async () => {
  db = await TestDatabase.create();
  app = await db.connect('uts_app_a');
  owner = await db.connectAsOwner();
});
afterAll(() => db.drop());

function withStore<Result>(work: (store: IdentityStore) => Promise<Result>): Promise<Result> {
  return withIdentityStore(db.url('uts_app_b'), { waitUntil: () => undefined }, work);
}

/** Inserts audit rows until `count` of them landed in `shard`; returns their event ids in order. */
async function insertIntoShard(client: pg.Client, shard: number, count: number): Promise<string[]> {
  const ids: string[] = [];
  while (ids.length < count) {
    const event = auditEvent();
    const row = await insertAudit(client, event);
    if (row.shard === shard) ids.push(event.id);
  }
  return ids;
}

/** The audit relay service's archive of one stream, as in the unit test's sink. */
function archive(stream: string) {
  const events: string[] = [];
  const batches: AuditBatch[] = [];
  return {
    events,
    batches,
    async send(batch: AuditBatch): Promise<void> {
      await encodeAuditBatch(batch);
      expect(batch.stream).toBe(stream);
      expect(batch.fromSeq).toBeLessThanOrEqual(events.length + 1);
      batches.push(batch);
      batch.events.forEach((item, offset) => {
        const seq = batch.fromSeq + offset;
        if (seq <= events.length) expect(item.id).toBe(events[seq - 1]);
        else events.push(item.id);
      });
    },
  };
}

/** Relays one shard until a run finds nothing; other test files' writes can hold the horizon. */
async function relayUntilIdle(
  outbox: AuditOutbox,
  shard: number,
  send: (batch: AuditBatch) => Promise<void>
) {
  const stream = auditStreamName('development', shard);
  for (;;) {
    const result = await relayShard({ outbox, shard, stream, send });
    if (result.status === 'idle') return;
  }
}

describe('audit outbox relay against the identity store', () => {
  it('holds back rows behind an open transaction and relays them in transaction order once it commits', async () => {
    const shard = 1;
    const stream = auditStreamName('development', shard);
    const sink = archive(stream);
    const early = await db.connect('uts_app_a');

    // An open transaction takes its id with its first row, before the rows committed below.
    await early.query('BEGIN');
    const held = await insertIntoShard(early, shard, 1);
    const committed = await insertIntoShard(app, shard, 5);

    await withStore(async store => {
      const result = await relayShard({
        outbox: identityStoreOutbox(store),
        shard,
        stream,
        send: batch => sink.send(batch),
      });
      expect(result).toEqual({ status: 'idle', sent: 0 });
    });

    await early.query('COMMIT');
    await vi.waitFor(
      async () => {
        await withStore(store =>
          relayUntilIdle(identityStoreOutbox(store), shard, batch => sink.send(batch))
        );
        expect(sink.events).toEqual([...held, ...committed]);
      },
      { timeout: 30_000, interval: 200 }
    );
  }, 35_000);

  it('relays every row once across a send failure and a stop after the send', async () => {
    const shard = 2;
    const stream = auditStreamName('development', shard);
    const sink = archive(stream);
    await insertIntoShard(app, shard, 40);
    // Earlier tests left rows in this shard too; the relay owes every row of the shard.
    const shardIds = async () =>
      (
        await owner.query<{ event_id: string }>(
          'SELECT event_id FROM uts.audit_events WHERE shard = $1 ORDER BY txid, id',
          [shard]
        )
      ).rows.map(row => row.event_id);
    const ids = await shardIds();

    await vi.waitFor(
      async () => {
        const read = await withStore(store => identityStoreOutbox(store).read(shard, 500));
        expect(read.status === 'rows' ? read.rows.length : 0).toBe(ids.length);
      },
      { timeout: 30_000, interval: 200 }
    );

    // The queue refuses: nothing moves.
    await withStore(async store => {
      await expect(
        relayShard({
          outbox: identityStoreOutbox(store),
          shard,
          stream,
          send: async () => {
            throw new Error('queue unavailable');
          },
        })
      ).rejects.toThrow('queue unavailable');
    });

    // The queue takes the batch and the watermark write never happens.
    await withStore(async store => {
      const outbox = identityStoreOutbox(store);
      const stopped: AuditOutbox = {
        read: (s, limit) => outbox.read(s, limit),
        advance: async () => {
          throw new Error('stopped');
        },
      };
      await expect(
        relayShard({ outbox: stopped, shard, stream, send: batch => sink.send(batch) })
      ).rejects.toThrow('stopped');
    });

    await insertIntoShard(app, shard, 3);
    const all = await shardIds();
    await vi.waitFor(
      async () => {
        await withStore(store =>
          relayUntilIdle(identityStoreOutbox(store), shard, batch => sink.send(batch))
        );
        expect(sink.events).toEqual(all);
      },
      { timeout: 30_000, interval: 200 }
    );
    // The batch the queue took before the stop is sent again from sequence 1.
    expect(sink.batches[0]).toMatchObject({ fromSeq: 1, toSeq: ids.length });
    expect(sink.batches[1].fromSeq).toBe(1);
    const watermark = await owner.query<{ last_seq: bigint }>(
      'SELECT last_seq FROM uts.audit_relay_watermarks WHERE shard = $1',
      [shard]
    );
    expect(watermark.rows[0].last_seq).toBe(BigInt(all.length));
  }, 35_000);

  it('refuses to move a watermark that another runner moved', async () => {
    const shard = 4;
    await insertIntoShard(app, shard, 1);
    const moved = await withStore(store =>
      identityStoreOutbox(store).advance(shard, 99n, { txid: 1n, id: 1n, seq: 100n })
    );
    expect(moved).toBe(false);
  });

  it('reports the age of a shard first unrelayed row', async () => {
    const shard = 5;
    await insertIntoShard(app, shard, 1);
    await owner.query(
      `UPDATE uts.audit_events SET created_at = now() - interval '90 seconds' WHERE shard = $1`,
      [shard]
    );
    const ages = await withStore(store => unrelayedAges(store));
    const age = ages.find(entry => entry.shard === shard)?.ageSeconds ?? 0;
    expect(age).toBeGreaterThan(60);
  });

  it('runs partition and OAuth maintenance through the app login', async () => {
    await withStore(async store => {
      const steps = await maintainAuditPartitions(store);
      expect(steps.filter(step => step.action !== 'kept_unrelayed')).toEqual([]);
      expect(await partitionRunwayDays(store)).toBe(8);
      const kinds = await maintainOAuthRows(store);
      expect(kinds.map(row => row.kind).sort()).toEqual([
        'authorization_codes',
        'dpop_proofs',
        'revocations',
        'rotated_refresh_tokens',
        'third_party_refresh_tokens',
      ]);
    });
  });
});

describe('uts.advance_audit_watermark', () => {
  const ADVANCE = `SELECT uts.advance_audit_watermark($1, $2, $3::text::xid8, $4, $5) AS advanced`;

  /**
   * Every row of `shard` past its watermark, oldest first, once all of them are below the horizon.
   * Earlier tests leave rows in every shard, so the count is read, not assumed.
   */
  async function finalRows(shard: number) {
    return await vi.waitFor(
      async () => {
        const result = await app.query<{ txid: bigint; id: bigint; final: boolean }>(
          `SELECT event.txid, event.id,
             event.txid < pg_snapshot_xmin(pg_current_snapshot()) AS final
           FROM uts.audit_relay_watermarks AS watermark
           JOIN uts.audit_events AS event ON event.shard = watermark.shard
             AND (event.txid, event.id) > (watermark.last_txid, watermark.last_id)
           WHERE watermark.shard = $1
           ORDER BY event.txid, event.id`,
          [shard]
        );
        expect(result.rows.every(row => row.final)).toBe(true);
        return result.rows;
      },
      { timeout: 30_000, interval: 200 }
    );
  }

  async function advance(
    shard: number,
    fromSeq: number,
    to: { txid: bigint; id: bigint },
    toSeq: number
  ) {
    return await app.query<{ advanced: boolean }>(ADVANCE, [
      shard,
      fromSeq,
      to.txid.toString(),
      to.id,
      toSeq,
    ]);
  }

  it('refuses a move that skips a row, goes back, targets no final row or moves too far', async () => {
    const shard = 6;
    await insertIntoShard(app, shard, 3);
    const [first, second, third] = await finalRows(shard);

    // Past two rows numbered as one: the skipped row would never be sent.
    expect(await sqlStateOf(() => advance(shard, 0, second, 1))).toBe(INVALID_PARAMETER);
    // A row that does not exist in the shard.
    expect(
      await sqlStateOf(() => advance(shard, 0, { txid: third.txid, id: third.id + 1_000_000n }, 3))
    ).toBe(INVALID_PARAMETER);
    // More than one batch.
    expect(await sqlStateOf(() => advance(shard, 0, third, 501))).toBe(INVALID_PARAMETER);

    expect((await advance(shard, 0, first, 1)).rows).toEqual([{ advanced: true }]);
    // Back to the old position, and a stale starting sequence.
    expect(await sqlStateOf(() => advance(shard, 1, first, 2))).toBe(INVALID_PARAMETER);
    expect((await advance(shard, 0, second, 2)).rows).toEqual([{ advanced: false }]);
    expect((await advance(shard, 1, third, 3)).rows).toEqual([{ advanced: true }]);
  }, 35_000);

  it('refuses a row whose transaction is still open', async () => {
    const shard = 7;
    const open = await db.connect('uts_app_a');
    await open.query('BEGIN');
    try {
      let row = await insertAudit(open, auditEvent());
      while (row.shard !== shard) row = await insertAudit(open, auditEvent());
      expect(await sqlStateOf(() => advance(shard, 0, row, 1))).toBe(INVALID_PARAMETER);
    } finally {
      await open.query('ROLLBACK');
    }
  });

  it('turns a move without a send into a sequence gap the archive refuses', async () => {
    const shard = 3;
    const stream = auditStreamName('development', shard);
    const sink = archive(stream);
    await insertIntoShard(app, shard, 2);
    const [first] = await finalRows(shard);

    // The row is numbered 1 but never sent, so the next batch starts at 2.
    expect((await advance(shard, 0, first, 1)).rows).toEqual([{ advanced: true }]);
    await withStore(async store => {
      await expect(
        relayShard({
          outbox: identityStoreOutbox(store),
          shard,
          stream,
          send: batch => sink.send(batch),
        })
      ).rejects.toThrow('expected 2 to be less than or equal to 1');
    });
    expect(sink.events).toEqual([]);
  }, 35_000);
});
