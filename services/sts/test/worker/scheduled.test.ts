import { createScheduledController, runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getRefresherStub } from '../../src/dos/stubs';
import worker from '../../src/index';
import { stubOfflineNetwork } from './manager';
import { resetRefresherObject } from './reset';
import { config, env } from './test-env';

beforeEach(async () => {
  stubOfflineNetwork();
  await resetRefresherObject(getRefresherStub(env, config));
});

afterEach(() => {
  stubOfflineNetwork();
  vi.restoreAllMocks();
});

describe('scheduled handler', () => {
  it('starts the refresher loop and records the deployed policy once across runs', async () => {
    // The offline manager makes the alarm's first read fail and log a warning.
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const refresher = () => getRefresherStub(env, config);
    expect(
      await runInDurableObject(refresher(), (_instance, state) => state.storage.getAlarm())
    ).toBeNull();

    await worker.scheduled(
      createScheduledController({ cron: '*/5 * * * *', scheduledTime: Date.now() }),
      env
    );

    // The first refresh is due at once, so the alarm can be running while this reads (it awaits
    // the queue and the manager); the alarm itself is covered by the bundle object tests. This
    // checks that the cron reached ensureStarted: the schedule row and the policy event exist.
    const after = await runInDurableObject(refresher(), (_instance, state) => ({
      scheduleRows: state.storage.sql
        .exec<{ count: number }>('SELECT count(*) AS count FROM refresher_state')
        .one().count,
      policyEvents: state.storage.sql
        .exec<{ count: number }>(
          `SELECT count(*) AS count FROM audit_event WHERE event LIKE '%ai.kilo.sts.policy.changed%'`
        )
        .one().count,
    }));
    expect(after.scheduleRows).toBe(1);
    expect(after.policyEvents).toBe(1);

    await worker.scheduled(
      createScheduledController({ cron: '*/5 * * * *', scheduledTime: Date.now() }),
      env
    );
    const again = await runInDurableObject(
      refresher(),
      (_instance, state) =>
        state.storage.sql.exec<{ count: number }>(`SELECT count(*) AS count FROM audit_event`).one()
          .count
    );
    expect(again).toBe(1);
  });
});
