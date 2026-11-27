import { describe, expect, it } from 'vitest';
import { withProxy, type Proxy } from './harness';
import { post, readyRun } from './scenario';

/** The sampled check (contract §3) with a fake container. */

const sampled = (proxy: Proxy) =>
  proxy.events().filter(event => event.type === 'ai.kilo.migration_proxy.session_sampled');

/** The monitor's paging condition (§3): unexpected above 0, or a failed sample. */
const pages = (event: { data: { attributes: Record<string, unknown> } }) =>
  Number(event.data.attributes.unexpected) > 0 || event.data.attributes.result === 'failed';

describe('the sampled check', () => {
  it('starts the container, connects with the recorded pairs, records its own pair, destroys it', async () => {
    await withProxy({}, async proxy => {
      proxy.sql(
        `INSERT INTO session_pairs (pid, backend_start, owner, recorded_at) VALUES (11, '2026-11-27T09:00:00.000001Z', 'run', ${Date.now()})`
      );
      await proxy.object.alarm();
      const [event] = sampled(proxy);
      expect(event?.data).toMatchObject({
        outcome: 'success',
        attributes: { result: 'ok', unexpected: 0, leftover: 0 },
      });
      expect(pages(event!)).toBe(false);
      expect(proxy.container.sampleBodies).toHaveLength(1);
      expect(proxy.container.sampleBodies[0]).toMatchObject({
        user: 'kilo_migration_proxy',
        password: 'sentinel-db-password',
        loginMode: 'member',
        sessionKey: 'label',
        recordedPairs: [{ pid: 11, backendStart: '2026-11-27T09:00:00.000001Z' }],
      });
      expect(proxy.log.slice(0, 3)).toEqual([
        'blockConcurrencyWhile',
        'interceptAllOutboundHttp',
        'interceptOutboundHttps:*',
      ]);
      expect(proxy.log.at(-1)).toBe('destroy');
      expect(
        proxy.sql<{ pid: number }>('SELECT pid FROM session_pairs ORDER BY pid').map(row => row.pid)
      ).toEqual([11, 202]);
      // The next sample is due an hour later.
      expect(proxy.alarmAt()).toBeGreaterThan(Date.now() + 59 * 60_000);
      await proxy.object.alarm();
      expect(sampled(proxy)).toHaveLength(1);
    });
  });

  it('reports unexpected and leftover counts, and pages on unexpected sessions (R3-M1)', async () => {
    await withProxy({}, async proxy => {
      proxy.container.sample = {
        result: 'ok',
        reason: null,
        pair: { pid: 5, backendStart: '2026-11-27T12:00:00.000000Z' },
        unexpected: 2,
        leftover: 1,
      };
      await proxy.object.alarm();
      const [event] = sampled(proxy);
      expect(event?.data).toMatchObject({
        outcome: 'failure',
        attributes: { result: 'ok', unexpected: 2, leftover: 1 },
      });
      expect(pages(event!)).toBe(true);
    });
  });

  it('writes failed for a refused connection, which pages', async () => {
    await withProxy({}, async proxy => {
      proxy.container.sample = {
        result: 'failed',
        reason: 'auth_failed',
        pair: null,
        unexpected: 0,
        leftover: 0,
      };
      await proxy.object.alarm();
      const [event] = sampled(proxy);
      expect(event?.data).toMatchObject({ outcome: 'failure', attributes: { result: 'failed' } });
      expect(pages(event!)).toBe(true);
      expect(proxy.sql('SELECT * FROM session_pairs')).toEqual([]);
    });
  });

  it('is skipped while a run is active', async () => {
    await withProxy({}, async proxy => {
      const { head } = await readyRun(proxy);
      await post(proxy, head);
      await proxy.object.alarm();
      await proxy.object.alarm();
      expect(sampled(proxy)).toEqual([]);
      expect(proxy.container.sampleBodies).toEqual([]);
    });
  });

  it('is off with MIGRATION_SESSION_SAMPLE_MINUTES = 0', async () => {
    await withProxy({ vars: { MIGRATION_SESSION_SAMPLE_MINUTES: '0' } }, async proxy => {
      await proxy.object.wake();
      await proxy.object.alarm();
      expect(sampled(proxy)).toEqual([]);
      expect(proxy.log).not.toContain('start');
    });
  });

  it('starts nothing for a refused config', async () => {
    await withProxy({ vars: { MIGRATION_DB_USER: 'postgres' } }, async proxy => {
      await proxy.object.alarm();
      expect(sampled(proxy)).toEqual([]);
      expect(proxy.log).not.toContain('start');
    });
  });
});
