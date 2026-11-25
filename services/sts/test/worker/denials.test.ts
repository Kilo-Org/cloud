import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { utcMinute, type Denial } from '../../src/audit/denials';
import { MAX_DISTINCT_PER_MINUTE } from '../../src/dos/DenialDO';
import { getDenialStub } from '../../src/dos/stubs';
import { stubOfflineNetwork } from './manager';
import { resetDenialObject } from './reset';
import { config, env } from './test-env';

beforeEach(async () => {
  stubOfflineNetwork();
  await resetDenialObject(getDenialStub(env, config));
});

const now = (): string => utcMinute(Date.now());

function githubDenial(ref: string): Denial {
  return {
    channel: 'http',
    reason: 'unknown_workload',
    actor: 'github:999',
    claims: { provider: 'github', repository_id: '999', ref, event_name: 'push' },
  };
}

/** Moves every open window into the past, so the next alarm flushes it. */
async function closeWindows(): Promise<void> {
  await runInDurableObject(getDenialStub(env, config), (_instance, state) => {
    state.storage.sql.exec(`UPDATE denial_window SET minute = '2020-01-01T00:00'`);
  });
}

function events(): Promise<
  Array<{ type: string; data: { outcome: string; attributes: Record<string, unknown> } }>
> {
  return runInDurableObject(getDenialStub(env, config), (_instance, state) =>
    state.storage.sql
      .exec<{ event: string }>('SELECT event FROM audit_event ORDER BY seq')
      .toArray()
      .map(row => JSON.parse(row.event))
  );
}

describe('denial stream', () => {
  it('adds the counts an isolate merged and keeps overflow counts per reason', async () => {
    const stub = getDenialStub(env, config);
    await stub.record([
      { denial: githubDenial('refs/heads/main'), count: 40, overflow: false, minute: now() },
      {
        denial: { channel: 'http', reason: 'unknown_workload', actor: 'overflow', claims: {} },
        count: 7,
        overflow: true,
        minute: now(),
      },
    ]);
    await stub.record([
      { denial: githubDenial('refs/heads/main'), count: 2, overflow: false, minute: now() },
    ]);
    await closeWindows();
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    const written = await events();
    expect(
      written.map(event => [event.data.attributes.overflow, event.data.attributes.count]).sort()
    ).toEqual([
      [false, 42],
      [true, 7],
    ]);
  });

  it('merges identical denials in a minute into one event with a count', async () => {
    const stub = getDenialStub(env, config);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await stub.record([
        { denial: githubDenial('refs/heads/main'), count: 1, overflow: false, minute: now() },
      ]);
    }
    await stub.record([
      {
        denial: {
          channel: 'worker-binding',
          reason: 'unknown_workload',
          actor: 'rogue',
          claims: {},
        },
        count: 1,
        overflow: false,
        minute: now(),
      },
    ]);
    await closeWindows();
    expect(await runDurableObjectAlarm(stub)).toBe(true);

    const written = await events();
    expect(written).toHaveLength(2);
    expect(written.every(event => event.type === 'ai.kilo.sts.bundle.denied')).toBe(true);
    expect(written.every(event => event.data.outcome === 'denied')).toBe(true);
    const github = written.find(event => event.data.attributes.channel === 'http');
    expect(github?.data.attributes).toMatchObject({
      reason: 'unknown_workload',
      count: 3,
      windowStart: '2020-01-01T00:00:00.000Z',
      overflow: false,
      claims: ['event_name=push', 'provider=github', 'ref=refs/heads/main', 'repository_id=999'],
    });
    const remaining = await runInDurableObject(
      stub,
      (_instance, state) =>
        state.storage.sql
          .exec<{ count: number }>('SELECT count(*) AS count FROM denial_window')
          .one().count
    );
    expect(remaining).toBe(0);
  });

  it('counts distinct denials past the per-minute limit in one overflow event', async () => {
    const stub = getDenialStub(env, config);
    for (let index = 0; index < MAX_DISTINCT_PER_MINUTE + 5; index += 1) {
      await stub.record([
        {
          denial: githubDenial(`refs/heads/branch-${index}`),
          count: 1,
          overflow: false,
          minute: now(),
        },
      ]);
    }
    await closeWindows();
    expect(await runDurableObjectAlarm(stub)).toBe(true);

    const written = await events();
    expect(written).toHaveLength(MAX_DISTINCT_PER_MINUTE + 1);
    const overflow = written.filter(event => event.data.attributes.overflow === true);
    expect(overflow).toHaveLength(1);
    expect(overflow[0].data.attributes).toMatchObject({ count: 5, claims: [] });
  });

  it('files each count under the minute the isolate saw it in', async () => {
    const stub = getDenialStub(env, config);
    const threeMinutesAgo = utcMinute(Date.now() - 3 * 60 * 1000);
    await stub.record([
      {
        denial: githubDenial('refs/heads/main'),
        count: 4,
        overflow: false,
        minute: threeMinutesAgo,
      },
    ]);
    const alarm = await runInDurableObject(stub, (_instance, state) => state.storage.getAlarm());
    expect(alarm).toBeLessThanOrEqual(Date.now() + 2_000);
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    const written = await events();
    expect(written).toHaveLength(1);
    expect(written[0].data.attributes).toMatchObject({
      count: 4,
      windowStart: `${threeMinutesAgo}:00.000Z`,
    });
  });

  it('files a future or hours-old minute under the current one', async () => {
    const stub = getDenialStub(env, config);
    const future = utcMinute(Date.now() + 10 * 60 * 1000);
    const old = utcMinute(Date.now() - 2 * 60 * 60 * 1000);
    await stub.record([
      { denial: githubDenial('refs/heads/a'), count: 1, overflow: false, minute: future },
      { denial: githubDenial('refs/heads/b'), count: 1, overflow: false, minute: old },
    ]);
    const minutes = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql
        .exec<{ minute: string }>('SELECT DISTINCT minute FROM denial_window')
        .toArray()
        .map(row => row.minute)
    );
    expect(minutes).toEqual([utcMinute(Date.now())]);
  });

  it('keeps a window open until its minute ends', async () => {
    const stub = getDenialStub(env, config);
    await stub.record([
      { denial: githubDenial('refs/heads/main'), count: 1, overflow: false, minute: now() },
    ]);
    const alarm = await runInDurableObject(stub, (_instance, state) => state.storage.getAlarm());
    expect(alarm).not.toBeNull();
    expect(alarm).toBeGreaterThan(Date.now());
    expect(alarm).toBeLessThanOrEqual(Date.now() + 61_000);
    expect(await events()).toEqual([]);
  });
});
