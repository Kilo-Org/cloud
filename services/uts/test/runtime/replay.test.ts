import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { UtsReplayDO } from '../../src/dos/UtsReplayDO';
import { replayAccess, replayNotAfter } from '../../src/oauth/replay';
import { config, env } from './test-env';

const replayStub = (name: string) => env.UTS_REPLAY_DO.get(env.UTS_REPLAY_DO.idFromName(name));
const grantStub = (grantId: string) => replayStub(`development:replay:${grantId}`);
const jti = () => crypto.randomUUID();

describe('DPoP replay object', () => {
  it('accepts a jti once per grant until it expires', async () => {
    const grantId = crypto.randomUUID();
    const stub = grantStub(grantId);
    const first = jti();
    const later = Date.now() + 60_000;
    expect(await stub.consume(first, later)).toEqual({ status: 'fresh' });
    expect(await stub.consume(first, later)).toEqual({ status: 'replayed' });
    expect(await stub.consume(jti(), later)).toEqual({ status: 'fresh' });
    expect(await grantStub(crypto.randomUUID()).consume(first, later)).toEqual({ status: 'fresh' });

    const expired = jti();
    expect(await stub.consume(expired, Date.now() - 1)).toEqual({ status: 'fresh' });
    expect(await stub.consume(expired, later)).toEqual({ status: 'fresh' });
  });

  it('deletes expired entries by alarm and all storage once none is left', async () => {
    // The entries are written directly with a later alarm, so no alarm runs before the test's.
    const seed = (stub: DurableObjectStub<UtsReplayDO>, expiries: number[]) =>
      runInDurableObject(stub, async (_instance, state) => {
        for (const expiry of expiries) await state.storage.put(`jti:${jti()}`, expiry);
        await state.storage.setAlarm(Date.now() + 60_000);
      });
    const stub = grantStub(crypto.randomUUID());
    await seed(stub, [Date.now() - 1, Date.now() + 60_000]);
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    const left = await runInDurableObject(stub, async (_instance, state) => ({
      entries: (await state.storage.list({ prefix: 'jti:' })).size,
      alarm: await state.storage.getAlarm(),
    }));
    expect(left.entries).toBe(1);
    expect(left.alarm).not.toBeNull();

    const empty = grantStub(crypto.randomUUID());
    await seed(empty, [Date.now() - 1]);
    expect(await runDurableObjectAlarm(empty)).toBe(true);
    const size = await runInDurableObject(
      empty,
      async (_instance, state) => (await state.storage.list()).size
    );
    expect(size).toBe(0);
  });

  it('refuses an object that is not named by a grant of this environment', async () => {
    for (const name of [
      'staging:replay:00000000-0000-4000-8000-000000000000',
      'development:replay:x',
    ]) {
      expect(await replayStub(name).consume(jti(), Date.now() + 60_000)).toMatchObject({
        status: 'misconfigured',
      });
    }
  });

  it('records a proof until 61 seconds after its iat, through the access the endpoints use', async () => {
    const iat = Math.floor(Date.now() / 1000);
    const proof = { jkt: new Uint8Array(32), jti: jti(), iat };
    expect(replayNotAfter(proof)).toBe((iat + 61) * 1000);
    const access = replayAccess(env, config);
    const grantId = crypto.randomUUID();
    expect(await access(grantId, proof)).toBe('fresh');
    expect(await access(grantId, proof)).toBe('replayed');
  });
});
