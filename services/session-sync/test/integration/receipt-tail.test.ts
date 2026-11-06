import { runInDurableObject } from 'cloudflare:test';
import { asc } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { migrate } from 'drizzle-orm/durable-sqlite/migrator';
import { expect, it } from 'vitest';

import migrations from '../../drizzle/migrations';
import { receipts } from '../../src/db/sqlite-schema';
import { getSessionSyncDOStub } from '../../src/dos/SessionSyncDO';
import { apply } from '../../src/dos/session-sync/batch';
import * as session from '../../src/dos/session-sync/session';
import { LIMITS } from '../../src/protocol';
import { batch, client, newSessionID, personal, testEnv } from '../helpers';

it('retains the exact accepted tail across retries, rollback, migration and restart', async () => {
  const principal = personal(crypto.randomUUID());
  const sessionID = newSessionID();
  const sourceID = crypto.randomUUID();
  const api = client(principal);
  await (await api.register(sessionID, sourceID)).json();
  let stub = getSessionSyncDOStub(testEnv, { tenant: principal.tenant, sessionID });
  await runInDurableObject(stub, async (_instance, state) => {
    const cursors: { query: string; cursor: SqlStorageCursor<Record<string, SqlStorageValue>> }[] =
      [];
    const storage = {
      sql: {
        exec(query: string, ...bindings: (string | number | ArrayBuffer | null)[]) {
          const cursor = state.storage.sql.exec(query, ...bindings);
          cursors.push({ query, cursor });
          return cursor;
        },
      },
      transactionSync: <T>(fn: () => T) => state.storage.transactionSync(fn),
    };
    const db = drizzle(storage as unknown as DurableObjectStorage);
    const accepted = [];
    let position = 0;
    expect(db.select().from(receipts).all()).toHaveLength(0);
    for (let ordinal = 1; ordinal <= 600; ordinal++) {
      const packet = batch(
        sourceID,
        position,
        position + (ordinal % 7) + 1,
        ordinal % 3 === 0
          ? []
          : [
              { op: 'put', kind: 'message-part', id: 'active', value: { text: 'x'.repeat(2048) } },
              ...(ordinal % 3 === 1
                ? []
                : [{ op: 'put' as const, kind: 'message' as const, id: 'm', value: ordinal }]),
            ]
      );
      cursors.length = 0;
      const receipt = state.storage.transactionSync(() =>
        apply(db, principal, sessionID, packet, `digest-${ordinal}`, ordinal)
      );
      accepted.push({ packet, receipt });
      position = packet.through;
      if ([1, 255, 256, 257, 259, 600].includes(ordinal)) {
        const work = cursors.map(({ query, cursor }) => ({
          query,
          read: cursor.rowsRead,
          written: cursor.rowsWritten,
        }));
        expect(work.every(row => !row.query.toLowerCase().includes('offset'))).toBe(true);
        if (ordinal === 257) {
          expect(work.reduce((sum, row) => sum + row.read, 0)).toBeLessThanOrEqual(12);
        }
        if (ordinal === 259) {
          expect(work.reduce((sum, row) => sum + row.read, 0)).toBe(8);
          expect(work.reduce((sum, row) => sum + row.written, 0)).toBe(6);
        }
        expect(
          db
            .select()
            .from(receipts)
            .orderBy(asc(receipts.through))
            .all()
            .map(row => row.revision)
        ).toEqual(accepted.slice(-LIMITS.receipts).map(row => row.receipt.revision));
      }
    }
    expect(
      state.storage.sql
        .exec<{ detail: string }>(
          'EXPLAIN QUERY PLAN SELECT through FROM receipts ORDER BY through ASC LIMIT 1'
        )
        .one().detail
    ).toContain('receipts_through_idx');
    const latest = accepted.at(-1);
    const oldest = accepted[0];
    if (!latest || !oldest) throw new Error('Missing accepted fixture');
    const tail = () => db.select().from(receipts).orderBy(asc(receipts.through)).all();
    const retained = tail();
    cursors.length = 0;
    expect(
      state.storage.transactionSync(() =>
        apply(db, principal, sessionID, latest.packet, 'digest-600', 999)
      )
    ).toEqual(latest.receipt);
    expect(cursors.reduce((sum, row) => sum + row.cursor.rowsWritten, 0)).toBe(0);
    expect(() =>
      state.storage.transactionSync(() =>
        apply(db, principal, sessionID, latest.packet, 'changed', 999)
      )
    ).toThrow(session.SyncFailure);
    expect(() =>
      state.storage.transactionSync(() =>
        apply(db, principal, sessionID, oldest.packet, 'digest-1', 999)
      )
    ).toThrow('already covers');
    expect(() =>
      state.storage.transactionSync(() =>
        apply(
          db,
          principal,
          sessionID,
          { ...latest.packet, sourceID: crypto.randomUUID() },
          'digest-600',
          999
        )
      )
    ).toThrow('another source');
    expect(() =>
      state.storage.transactionSync(() =>
        apply(db, { ...principal, userID: 'other' }, sessionID, latest.packet, 'digest-600', 999)
      )
    ).toThrow(session.SyncFailure);
    const next = batch(sourceID, position, position + 9, [
      { op: 'put', kind: 'message', id: 'rollback', value: 'probe' },
    ]);
    expect(() =>
      state.storage.transactionSync(() => {
        apply(
          db,
          principal,
          sessionID,
          {
            ...next,
            changes: [
              ...next.changes,
              {
                op: 'put',
                kind: 'message',
                id: 'missing',
                blob: { hash: 'a'.repeat(64), bytes: 1 },
              },
            ],
          },
          'failed',
          999
        );
      })
    ).toThrow('Upload the blob');
    expect(() =>
      state.storage.transactionSync(() => {
        apply(db, principal, sessionID, next, 'rolled-back-prune', 999);
        throw new Error('Synthetic rollback after prune');
      })
    ).toThrow('Synthetic rollback');
    expect(tail()).toEqual(retained);
    expect(session.load(db)).toMatchObject({ position, revision: 600, batches: 600 });
    await migrate(db, migrations);
    expect(tail()).toEqual(retained);
  });
  await expect(
    runInDurableObject(stub, (_instance, state) => state.abort('Receipt fixture restart'))
  ).rejects.toThrow();
  stub = getSessionSyncDOStub(testEnv, { tenant: principal.tenant, sessionID });
  expect(await (await api.state(sessionID)).json()).toMatchObject({
    batches: 600,
    revision: 600,
    lastReceipt: { revision: 600 },
  });
  await (await api.remove(sessionID)).json();
  await runInDurableObject(stub, (_instance, state) => {
    expect(drizzle(state.storage).select().from(receipts).all()).toEqual([]);
  });
  expect((await api.register(sessionID, sourceID)).status).toBe(410);
});
