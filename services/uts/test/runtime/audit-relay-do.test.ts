import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import { RELAY_INTERVAL_MS, RELAY_MAX_BACKOFF_MS } from '../../src/audit/relay-schedule';
import { getAuditRelayStub } from '../../src/dos/stubs';
import type { UtsAuditRelayDO } from '../../src/dos/UtsAuditRelayDO';
import { startRelays } from '../../src/scheduled';
import { config, env } from './test-env';

describe('the cron starting the relays', () => {
  it('logs not_started for every shard whose relay object refuses', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      // Objects named for another environment than the Worker's refuse to run.
      await startRelays(env, { ...config, environment: 'staging' });
      const notStarted = errors.mock.calls
        .map(([line]) => String(line))
        .filter(line => line.startsWith('{"event":"uts.audit_relay.not_started"'))
        .map(line => JSON.parse(line));
      expect(notStarted).toEqual(
        Array.from({ length: 8 }, (_, shard) => ({
          event: 'uts.audit_relay.not_started',
          shard,
          error: 'refused',
        }))
      );
    } finally {
      errors.mockRestore();
    }
  });

  it('logs nothing when every relay object starts', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      await startRelays(env, config);
      expect(
        errors.mock.calls.filter(([line]) => String(line).includes('uts.audit_relay.not_started'))
      ).toEqual([]);
    } finally {
      errors.mockRestore();
    }
  });
});

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

  it('back off after each failed run, doubling to the cap, across a restart before every run', async () => {
    // The test pool has no identity store (its Hyperdrive binding names a closed port), so every
    // run fails before it reads; an unknown failure counts as retryable.
    // An aborted object breaks the stub that reached it, so every call takes a new stub.
    const stub = () => getAuditRelayStub(env, config, 6);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      // An earlier test may have armed this object, and its own alarm may have failed already.
      await runInDurableObject(stub(), async (_instance, state) => {
        await state.storage.deleteAlarm();
        await state.storage.deleteAll();
      });
      const delays: number[] = [];
      for (let run = 0; run < 6; run += 1) {
        // A fresh instance each time, as after an eviction between alarms: only storage remains.
        await runInDurableObject(stub(), (_instance, state) => state.abort('test restart')).catch(
          () => undefined
        );
        delays.push(
          await runInDurableObject(stub(), async (instance: UtsAuditRelayDO, state) => {
            const before = Date.now();
            await instance.alarm();
            const alarm = await state.storage.getAlarm();
            return Math.round(((alarm ?? 0) - before) / 1_000) * 1_000;
          })
        );
      }
      expect(delays).toEqual([
        RELAY_INTERVAL_MS,
        RELAY_INTERVAL_MS * 2,
        RELAY_INTERVAL_MS * 4,
        RELAY_INTERVAL_MS * 8,
        RELAY_MAX_BACKOFF_MS,
        RELAY_MAX_BACKOFF_MS,
      ]);
      const failed = errors.mock.calls
        .map(([line]) => String(line))
        .filter(line => line.startsWith('{"event":"uts.audit_relay.failed"'))
        .map(line => JSON.parse(line));
      expect(failed.map(line => line.failedRuns)).toEqual([1, 2, 3, 4, 5, 6]);
      expect(failed[0]).toMatchObject({ stream: 'uts:development:6', failure: 'retryable' });
      expect(
        await runInDurableObject(stub(), (_instance, state) => state.storage.get('failed-runs'))
      ).toBe(6);
    } finally {
      errors.mockRestore();
    }
  });
});
