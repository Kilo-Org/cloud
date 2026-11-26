import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import { getAuditRelayStub } from '../../src/dos/stubs';
import {
  RELAY_INTERVAL_MS,
  RELAY_MAX_BACKOFF_MS,
  type UtsAuditRelayDO,
} from '../../src/dos/UtsAuditRelayDO';
import { config, env } from './test-env';

describe('audit relay objects', () => {
  it('keep one alarm armed however often ensureStarted runs', async () => {
    const stub = getAuditRelayStub(env, config, 0);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      expect(await stub.ensureStarted()).toBe(true);
      // The first alarm is due at once; its run fails (no database here) and arms the next one.
      const armed = await vi.waitFor(async () => {
        const alarm = await runInDurableObject(stub, (_instance, state) =>
          state.storage.getAlarm()
        );
        expect(alarm).toBeGreaterThan(Date.now());
        return alarm;
      });
      expect(await stub.ensureStarted()).toBe(true);
      const after = await runInDurableObject(stub, (_instance, state) => state.storage.getAlarm());
      expect(after).toBe(armed);
    } finally {
      errors.mockRestore();
    }
  });

  it('refuse an object not created under an audit relay name', async () => {
    const stub = env.UTS_AUDIT_RELAY_DO.get(
      env.UTS_AUDIT_RELAY_DO.idFromName('development:audit-relay:9')
    );
    expect(await stub.ensureStarted()).toBe(false);
    const other = env.UTS_AUDIT_RELAY_DO.get(
      env.UTS_AUDIT_RELAY_DO.idFromName('staging:audit-relay:1')
    );
    expect(await other.ensureStarted()).toBe(false);
  });

  it('back off after each failed run, doubling to the cap, and log every failure', async () => {
    // The test pool has no identity store (its Hyperdrive binding names a closed port), so every
    // run fails before it reads; an unknown failure counts as retryable.
    const stub = getAuditRelayStub(env, config, 6);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const delays = await runInDurableObject(stub, async (instance: UtsAuditRelayDO, state) => {
        const seen: number[] = [];
        for (let run = 0; run < 6; run += 1) {
          const before = Date.now();
          await instance.alarm();
          const alarm = await state.storage.getAlarm();
          seen.push(Math.round(((alarm ?? 0) - before) / 1_000) * 1_000);
        }
        return seen;
      });
      expect(delays).toEqual([
        RELAY_INTERVAL_MS,
        RELAY_INTERVAL_MS * 2,
        RELAY_INTERVAL_MS * 4,
        RELAY_INTERVAL_MS * 8,
        RELAY_MAX_BACKOFF_MS,
        RELAY_MAX_BACKOFF_MS,
      ]);
      const logged = errors.mock.calls.map(([line]) => JSON.parse(String(line)));
      expect(logged.filter(line => line.event === 'uts.audit_relay.failed')).toHaveLength(6);
      expect(logged[0]).toMatchObject({
        stream: 'uts:development:6',
        failure: 'retryable',
        failedRuns: 1,
      });
    } finally {
      errors.mockRestore();
    }
  });
});
