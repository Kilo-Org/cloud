import { env, runInDurableObject } from 'cloudflare:test';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { describe, expect, it } from 'vitest';
import type { SandboxSessionV2 } from '../../src/control-plane/session/session-do.js';
import { createCloudWakeups } from '../../src/control-plane/session/wakeups.js';
import { CLOUD_WAKEUP_EXPIRED } from '../../src/shared/cloud-wakeup.js';

const sessions = (env as unknown as { SANDBOX_SESSION: DurableObjectNamespace<SandboxSessionV2> })
  .SANDBOX_SESSION;
const schedule = {
  action: 'schedule',
  callId: 'one',
  delay: '20s',
  prompt: 'Read the local report.',
} as const;
const now = 60_000;

describe('Cloud wakeups in Session DO SQLite', () => {
  it('deduplicates a call and permits one pending wakeup', async () => {
    await runInDurableObject(sessions.get(sessions.newUniqueId()), async (instance, ctx) => {
      await instance.getWakeup();
      const wakeups = createCloudWakeups(drizzle(ctx.storage));
      const result = wakeups.schedule(schedule, now, now + 60_000, 'snapshot');
      expect(result).toMatchObject({
        ok: true,
        wakeup: { mode: 'stay-awake', dueAt: now + 20_000 },
      });
      expect(wakeups.schedule(schedule, now + 1_000, now + 60_000, 'snapshot')).toEqual(result);
      expect(
        wakeups.schedule({ ...schedule, callId: 'two' }, now, now + 60_000, 'snapshot')
      ).toMatchObject({ ok: false });
    });
  });

  it('retains the admission ID across retries and does not replay a settled wakeup', async () => {
    await runInDurableObject(sessions.get(sessions.newUniqueId()), async (instance, ctx) => {
      await instance.getWakeup();
      const store = () => createCloudWakeups(drizzle(ctx.storage));
      store().schedule(schedule, now, now + 60_000, 'snapshot');
      const ids: string[] = [];
      const attempt = (at: number) =>
        store().fire({
          now: at,
          expiresAt: now + 60_000,
          isAdmitted: () => false,
          admit: async id => {
            ids.push(id);
            return ids.length > 1;
          },
        });
      expect(await attempt(now + 20_000)).toBeNull();
      expect(await attempt(now + 25_000)).toMatchObject({ state: 'fired' });
      expect(await attempt(now + 30_000)).toBeNull();
      expect(ids).toHaveLength(2);
      expect(ids[0]).toBe(ids[1]);
    });
  });

  it('does not admit a cancelled or expired wakeup', async () => {
    await runInDurableObject(sessions.get(sessions.newUniqueId()), async (instance, ctx) => {
      await instance.getWakeup();
      const store = createCloudWakeups(drizzle(ctx.storage));
      expect(store.schedule(schedule, now, now + 20_000, 'snapshot')).toMatchObject({
        ok: false,
        error: expect.stringContaining('before runtime authorization'),
      });
      const result = store.schedule(schedule, now, now + 60_000, 'snapshot');
      if (!result.ok) throw new Error(result.error);
      expect(store.cancel(result.wakeup.id)).toMatchObject({
        ok: true,
        wakeup: { state: 'cancelled' },
      });
      const expire = () =>
        store.fire({
          now: now + 30_000,
          expiresAt: now + 29_000,
          isAdmitted: () => false,
          admit: async () => {
            throw new Error('unexpected admission');
          },
        });
      expect(await expire()).toBeNull();
      store.schedule({ ...schedule, callId: 'two' }, now, now + 60_000, 'snapshot');
      expect(await expire()).toMatchObject({ state: 'failed', failure: CLOUD_WAKEUP_EXPIRED });
    });
  });
});
