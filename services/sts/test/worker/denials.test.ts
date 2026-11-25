import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Denial } from '../../src/audit/denials';
import { MAX_DISTINCT_PER_MINUTE } from '../../src/dos/DenialDO';
import { getDenialStub } from '../../src/dos/stubs';
import { stubOfflineNetwork } from './manager';
import { resetDenialObject } from './reset';
import { config, env } from './test-env';

beforeEach(async () => {
  stubOfflineNetwork();
  await resetDenialObject(getDenialStub(env, config));
});

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
  it('merges identical denials in a minute into one event with a count', async () => {
    const stub = getDenialStub(env, config);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await stub.record(githubDenial('refs/heads/main'));
    }
    await stub.record({
      channel: 'worker-binding',
      reason: 'unknown_workload',
      actor: 'rogue',
      claims: {},
    });
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
      await stub.record(githubDenial(`refs/heads/branch-${index}`));
    }
    await closeWindows();
    expect(await runDurableObjectAlarm(stub)).toBe(true);

    const written = await events();
    expect(written).toHaveLength(MAX_DISTINCT_PER_MINUTE + 1);
    const overflow = written.filter(event => event.data.attributes.overflow === true);
    expect(overflow).toHaveLength(1);
    expect(overflow[0].data.attributes).toMatchObject({ count: 5, claims: [] });
  });

  it('keeps a window open until its minute ends', async () => {
    const stub = getDenialStub(env, config);
    await stub.record(githubDenial('refs/heads/main'));
    const alarm = await runInDurableObject(stub, (_instance, state) => state.storage.getAlarm());
    expect(alarm).not.toBeNull();
    expect(alarm).toBeGreaterThan(Date.now());
    expect(alarm).toBeLessThanOrEqual(Date.now() + 61_000);
    expect(await events()).toEqual([]);
  });
});
