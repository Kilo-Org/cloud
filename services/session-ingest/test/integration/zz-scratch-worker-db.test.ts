import { env } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import { getWorkerDb } from '@kilocode/db/client';
import { sql } from 'drizzle-orm';

const APP = `scratch-workerd-${crypto.randomUUID().slice(0, 8)}`;

function db() {
  return getWorkerDb(env.HYPERDRIVE.connectionString, { application_name: APP });
}

async function openConnections(): Promise<number> {
  const probe = getWorkerDb(env.HYPERDRIVE.connectionString, { application_name: 'probe' });
  const r = await probe.execute<{ n: string }>(
    sql`select count(*)::text as n from pg_stat_activity where application_name = ${APP}`
  );
  return Number(r.rows[0]?.n);
}

describe('scratch: getWorkerDb in workerd against local Postgres', () => {
  it('reports connection string kind', () => {
    console.log('HYPERDRIVE connectionString host', new URL(env.HYPERDRIVE.connectionString).host);
  });

  it('applies bounds inside a transaction and not outside', async () => {
    const d = db();
    const inside = await d.transaction(async tx => {
      const r = await tx.execute<{ l: string; i: string }>(
        sql`select current_setting('lock_timeout') as l, current_setting('idle_in_transaction_session_timeout') as i`
      );
      return r.rows[0];
    });
    const outside = await d.execute<{ l: string; i: string }>(
      sql`select current_setting('lock_timeout') as l, current_setting('idle_in_transaction_session_timeout') as i`
    );
    console.log('inside', inside, 'outside', outside.rows[0]);
    expect(inside).toEqual({ l: '10s', i: '30s' });
    expect(outside.rows[0]).toEqual({ l: '0', i: '0' });
  });

  it('closes connections after queries and transactions', async () => {
    const d = db();
    await d.execute(sql`select 1`);
    await d.transaction(async tx => tx.execute(sql`select 2`));
    await d.execute(sql`select 3`);
    await new Promise(r => setTimeout(r, 200));
    const n = await openConnections();
    console.log('open connections after 3 uses', n, 'pool totalCount', d.$client.totalCount);
    expect(n).toBe(0);
    expect(d.$client.totalCount).toBe(0);
  });

  it('ends a FOR UPDATE wait at the lock bound', async () => {
    const holder = db();
    const waiter = db();
    await holder.execute(sql`create temp table if not exists x(id int)`);
    let release = () => {};
    const released = new Promise<void>(r => (release = r));
    let locked = () => {};
    const isLocked = new Promise<void>(r => (locked = r));
    const holding = holder.transaction(async tx => {
      await tx.execute(sql`select id from kilocode_users order by id limit 1 for update`);
      locked();
      await released;
    });
    await isLocked;
    const t0 = Date.now();
    const result = await waiter
      .transaction(tx => tx.execute(sql`select id from kilocode_users order by id limit 1 for update`))
      .then(
        () => 'admitted',
        (e: unknown) => (e instanceof Error && e.cause && typeof e.cause === 'object' && 'code' in e.cause ? e.cause.code : String(e))
      );
    const waited = Date.now() - t0;
    release();
    await holding;
    console.log('lock wait result', result, 'ms', waited);
    expect(result).toBe('55P03');
    expect(waited).toBeGreaterThanOrEqual(9_000);
    expect(waited).toBeLessThan(15_000);
  }, 30_000);

  it('terminates an idle transaction and reports the error without an uncaught exception', async () => {
    const warn = vi.spyOn(console, 'warn');
    const d = db();
    const t0 = Date.now();
    const result = await d
      .transaction(async tx => {
        await tx.execute(sql`select 1`);
        await new Promise(r => setTimeout(r, 33_000));
        await tx.execute(sql`select 2`);
      })
      .then(
        () => 'committed',
        (e: unknown) => (e instanceof Error ? `${e.message} | cause: ${String((e as { cause?: unknown }).cause)}` : String(e))
      );
    console.log('idle txn result after ms', Date.now() - t0, result);
    console.log('warn calls', JSON.stringify(warn.mock.calls));
    expect(result).not.toBe('committed');
    expect(warn).toHaveBeenCalledWith('Worker database connection failed', expect.anything());
    await new Promise(r => setTimeout(r, 200));
    expect(await openConnections()).toBe(0);
  }, 60_000);
});
