import { runInDurableObject } from 'cloudflare:test';
import { signerOfTokenKid, UtsPublicJwkSchema } from '@kilocode/uts-contracts';
import { createLocalJWKSet, decodeProtectedHeader, jwtVerify } from 'jose';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getSignerStub } from '../../src/dos/stubs';
import type { UtsSignerDO } from '../../src/dos/UtsSignerDO';
import { SignerStateSchema, type SignerState } from '../../src/keys/lifecycle';
import { claims, keySet, resetSigner, restartSigner } from './support';
import { config, env } from './test-env';

const DAY = 24 * 60 * 60 * 1000;
const RETIRED_WINDOW = 70 * 60 * 1000;
const SIGNER = 5;

const signer = () => getSignerStub(env, config, SIGNER);

async function storedState(): Promise<SignerState> {
  return await runInDurableObject(signer(), async (_instance, state) =>
    SignerStateSchema.parse(await state.storage.get('signer-state'))
  );
}

async function storedAlarm(): Promise<number | null> {
  return await runInDurableObject(signer(), (_instance, state) => state.storage.getAlarm());
}

/** The published keys over RPC, as a key-set shard reads them. */
async function published() {
  const result = await signer().publicKeys();
  if (result.status !== 'ok') throw new Error(`answered ${result.status}`);
  return result;
}

const publishedKids = async () => (await published()).keys.map(key => key.kid);

/** Runs `step` inside the object as if the clock read `at`. */
async function inObjectAt<R>(at: number, step: (instance: UtsSignerDO) => Promise<R>): Promise<R> {
  return await runInDurableObject(signer(), async (instance: UtsSignerDO) => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(at);
    try {
      return await step(instance);
    } finally {
      clock.mockRestore();
    }
  });
}

/** Runs the object's alarm as if the clock read `at`, and returns the alarm it stores next. */
async function alarmAt(at: number): Promise<number | null> {
  await inObjectAt(at, instance => instance.alarm());
  return await storedAlarm();
}

async function verify(token: string) {
  return await jwtVerify(token, createLocalJWKSet(await keySet()), {
    issuer: config.endpoints.issuer,
    audience: 'gateway',
    typ: 'at+jwt',
    algorithms: ['EdDSA'],
  });
}

beforeEach(async () => {
  await resetSigner(SIGNER);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('signer keys', () => {
  it('publishes a current and a next key under kids of this signer, without private parts', async () => {
    const { signer: index, keys } = await published();
    expect(index).toBe(SIGNER);
    expect(keys).toHaveLength(2);
    for (const key of keys) {
      expect(UtsPublicJwkSchema.parse(key)).toEqual(key);
      expect(signerOfTokenKid(key.kid)).toBe(SIGNER);
      expect(Object.keys(key)).not.toContain('d');
    }
  });

  it('keeps keys in KV storage and no SQL table', async () => {
    await published();
    await runInDurableObject(signer(), async (_instance, state) => {
      const tables = state.storage.sql
        .exec<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'table'`)
        .toArray()
        .map(row => row.name)
        .filter(name => !name.startsWith('_cf_') && !name.startsWith('sqlite_'));
      expect(tables).toEqual([]);
    });
    const stored = await storedState();
    expect(stored.current.privateJwk.d.length).toBeGreaterThan(0);
  });

  it('keeps its keys across a restart', async () => {
    const before = await published();
    await restartSigner(SIGNER);
    expect(await published()).toEqual(before);
  });

  it('answers misconfigured, and creates no keys, under a name that is not its own signer name', async () => {
    const reason = 'signer object was not created by its signer name';
    for (const name of ['staging:signer:01', 'development:feed:01']) {
      const stub = env.UTS_SIGNER_DO.getByName(name);
      expect(await stub.publicKeys()).toEqual({ status: 'misconfigured', reason });
      expect(await stub.sign(claims())).toEqual({ status: 'misconfigured', reason });
      expect(await stub.signMany([claims()])).toEqual({ status: 'misconfigured', reason });
      expect(await stub.removeKid('uts-token-01-unknown')).toEqual({
        status: 'misconfigured',
        reason,
      });
      const stored = await runInDurableObject(stub, async (_instance, state) => ({
        keys: [...(await state.storage.list()).keys()],
        alarm: await state.storage.getAlarm(),
      }));
      expect(stored).toEqual({ keys: [], alarm: null });
    }
  });

  it('creates its keys under its own signer name, unscoped in development', async () => {
    const result = await env.UTS_SIGNER_DO.getByName('development:signer:02').publicKeys();
    expect(result).toMatchObject({ status: 'ok', signer: 2 });
  });

  it("refuses stored keys in any object but that signer's object of this environment", async () => {
    const state = await storedState();
    const reason = `stored state names signer ${SIGNER}, but this is not that signer's development object`;
    // Another signer's object, and this signer's object of another environment.
    try {
      for (const name of ['development:signer:06', 'staging:signer:05']) {
        const stub = () => env.UTS_SIGNER_DO.getByName(name);
        await runInDurableObject(stub(), async (_instance, object) => {
          await object.storage.deleteAlarm();
          await object.storage.deleteAll();
          await object.storage.put('signer-state', state);
        });
        await runInDurableObject(stub(), (_instance, object) => object.abort('test restart')).catch(
          () => undefined
        );
        expect(await stub().publicKeys()).toEqual({ status: 'misconfigured', reason });
        expect(await stub().sign(claims())).toEqual({ status: 'misconfigured', reason });
        expect(await stub().removeKid(state.current.kid)).toEqual({
          status: 'misconfigured',
          reason,
        });
      }
    } finally {
      await resetSigner(6);
    }
  });

  it('loads its stored keys when opened by its raw id, which carries no name, as an alarm does', async () => {
    const before = await published();
    const id = env.UTS_SIGNER_DO.idFromString(signer().id.toString());
    await restartSigner(SIGNER);
    expect(await env.UTS_SIGNER_DO.get(id).publicKeys()).toEqual(before);
  });

  it('schedules its alarm for the next rotation', async () => {
    const state = await storedState();
    expect(await storedAlarm()).toBe(state.current.activatedAt + 30 * DAY);
  });
});

describe('RPC surface', () => {
  it('serves only its RPC methods; every other member stays out of reach of a binding holder', async () => {
    const stub = signer();
    for (const name of [
      'ready',
      'load',
      'advanceStored',
      'bootstrap',
      'commit',
      'transition',
      'current',
      'settled',
      'scheduleAlarm',
      'refusalFor',
      'admit',
      'config',
      'phase',
    ]) {
      const member: unknown = Reflect.get(stub, name);
      if (typeof member !== 'function') throw new Error(`the stub has no callable ${name}`);
      await expect(
        Promise.resolve().then(() => Reflect.apply(member, stub, [])),
        name
      ).rejects.toThrow(/does not implement/);
    }
    const stored = await storedState();
    expect(await publishedKids()).toEqual([stored.current.kid, stored.next.kid]);
  });
});

describe('signing', () => {
  it('signs an at+jwt with EdDSA under the current kid that verifies against the key set', async () => {
    const result = await signer().sign(claims());
    if (result.status !== 'signed') throw new Error(`not signed: ${result.status}`);
    expect(decodeProtectedHeader(result.token)).toEqual({
      alg: 'EdDSA',
      typ: 'at+jwt',
      kid: (await storedState()).current.kid,
    });
    const { payload } = await verify(result.token);
    expect(payload.scope).toBe('gateway:models.read');
  });

  it('refuses claim sets a verifier must never see', async () => {
    const now = Math.floor(Date.now() / 1000);
    const cases = [
      [{ ...claims(), aud: undefined }, 'invalid_claims'],
      [{ ...claims(), scope: 'a b' }, 'invalid_claims'],
      [{ ...claims(), extra: 'claim' }, 'invalid_claims'],
      [claims({ iat: now, exp: now + 3601 }), 'invalid_claims'],
      [claims({ iss: 'https://uts.kiloapps.io' }), 'issuer_mismatch'],
      [claims({ env: 'production' }), 'environment_mismatch'],
      [claims({ iat: now - 120, exp: now + 600 }), 'issued_at_out_of_range'],
      [claims({ iat: now - 30, exp: now - 1 }), 'already_expired'],
      [claims({ iat: now - 30, exp: now }), 'already_expired'],
      [claims({ iat: now + 59, exp: now + 3659 }), 'expires_too_late'],
    ] as const;
    for (const [input, reason] of cases) {
      expect(await signer().sign(input)).toEqual({ status: 'refused', reason });
    }
  });

  it('signs the claim sets of one mint in one call, in order, under the current kid', async () => {
    const scopes = ['gateway:models.read', 'gateway:chat.write', 'gateway:usage.read'];
    const result = await signer().signMany(scopes.map(scope => claims({ scope })));
    if (result.status !== 'signed') throw new Error(`not signed: ${result.status}`);
    const { current } = await storedState();
    expect(result.kid).toBe(current.kid);
    expect(result.tokens).toHaveLength(3);
    for (const [index, token] of result.tokens.entries()) {
      expect(decodeProtectedHeader(token).kid).toBe(current.kid);
      expect((await verify(token)).payload.scope).toBe(scopes[index]);
    }
  });

  it('refuses the whole batch when one claim set is refused, and a batch outside 1 to 8', async () => {
    expect(
      await signer().signMany([claims(), claims({ iss: 'https://uts.kiloapps.io' }), claims()])
    ).toEqual({ status: 'refused', reason: 'issuer_mismatch' });
    expect(await signer().signMany([claims(), { ...claims(), extra: 'claim' }])).toEqual({
      status: 'refused',
      reason: 'invalid_claims',
    });
    for (const batch of [[], Array.from({ length: 9 }, () => claims()), claims()]) {
      expect(await signer().signMany(batch)).toEqual({
        status: 'refused',
        reason: 'invalid_batch',
      });
    }
    expect(await signer().signMany(Array.from({ length: 8 }, () => claims()))).toMatchObject({
      status: 'signed',
    });
  });
});

describe('rotation', () => {
  it('rotates by alarm, publishes the new next key at once, and keeps the retired key 70 minutes', async () => {
    const start = await storedState();
    const firstKid = start.current.kid;
    const secondKid = start.next.kid;
    const t0 = start.current.activatedAt;

    expect(await alarmAt(t0 + 30 * DAY)).toBe(t0 + 30 * DAY + RETIRED_WINDOW);
    const rotated = await storedState();
    expect(rotated.current.kid).toBe(secondKid);
    expect(rotated.next.publishedAt).toBe(t0 + 30 * DAY);
    expect(rotated.next.activatesAt).toBe(t0 + 60 * DAY);
    const thirdKid = rotated.next.kid;
    expect(await publishedKids()).toEqual([secondKid, thirdKid, firstKid]);

    const signed = await signer().sign(claims());
    if (signed.status !== 'signed') throw new Error(`not signed: ${signed.status}`);
    expect(signed.kid).toBe(secondKid);
    await verify(signed.token);

    expect(await alarmAt(t0 + 30 * DAY + RETIRED_WINDOW)).toBe(t0 + 60 * DAY);
    expect(await publishedKids()).toEqual([secondKid, thirdKid]);
  });

  it('applies a change whose alarm never ran at the next call, and stores the following alarm', async () => {
    const start = await storedState();
    const overdue = start.current.activatedAt + 30 * DAY + 1;
    const answered = await inObjectAt(overdue, async instance => await instance.publicKeys());
    expect(answered).toMatchObject({ status: 'ok' });
    const after = await storedState();
    expect(after.current.kid).toBe(start.next.kid);
    expect(await storedAlarm()).toBe(overdue + RETIRED_WINDOW);
  });

  it('signs under the next key when the rotation is overdue at signing time', async () => {
    const start = await storedState();
    const overdue = start.current.activatedAt + 30 * DAY + 1;
    const signed = await inObjectAt(overdue, async instance => await instance.sign(claims()));
    expect(signed).toMatchObject({ status: 'signed', kid: start.next.kid });
  });

  it('sets a lost alarm again on the next key read', async () => {
    const state = await storedState();
    await runInDurableObject(signer(), (_instance, objectState) =>
      objectState.storage.deleteAlarm()
    );
    expect(await storedAlarm()).toBeNull();
    await published();
    expect(await storedAlarm()).toBe(state.next.activatesAt);
  });
});

describe('emergency removal', () => {
  it('removes the current kid, signs under the published next key, and publishes a new next key', async () => {
    const start = await storedState();
    const result = await signer().removeKid(start.current.kid);
    if (result.status !== 'removed') throw new Error(`answered ${result.status}`);
    expect(result.removal.kid).toBe(start.current.kid);
    expect(result.removal.signer).toBe(SIGNER);
    expect(result.removal.revokeUntil - result.removal.removedAt).toBe(RETIRED_WINDOW);

    const after = await storedState();
    expect(after.current.kid).toBe(start.next.kid);
    expect(after.next.activatesAt).toBe(after.current.activatedAt + 30 * DAY);
    expect(await publishedKids()).toEqual([start.next.kid, after.next.kid]);
    const signed = await signer().sign(claims());
    if (signed.status !== 'signed') throw new Error(`not signed: ${signed.status}`);
    expect(signed.kid).toBe(start.next.kid);
  });

  it('after a storage exposure, signs under a key created after it: next first, then current', async () => {
    const exposed = await storedState();
    await signer().removeKid(exposed.next.kid);
    const fresh = (await storedState()).next.kid;
    await signer().removeKid(exposed.current.kid);
    const kids = await publishedKids();
    expect(kids[0]).toBe(fresh);
    expect(kids).not.toContain(exposed.current.kid);
    expect(kids).not.toContain(exposed.next.kid);
  });

  it('answers unknown_kid for a kid it does not hold', async () => {
    expect(await signer().removeKid('uts-token-05-unknown')).toEqual({ status: 'unknown_kid' });
  });

  it('keeps the removal across a restart', async () => {
    const start = await storedState();
    await signer().removeKid(start.current.kid);
    await restartSigner(SIGNER);
    expect(await publishedKids()).not.toContain(start.current.kid);
  });

  it('answers a repeated removal with the stored entry and changes nothing, also after a restart', async () => {
    const start = await storedState();
    const first = await signer().removeKid(start.current.kid);
    if (first.status !== 'removed') throw new Error(`answered ${first.status}`);
    const removedState = await storedState();
    expect(removedState.removed).toEqual([first.removal]);
    expect(await signer().removeKid(start.current.kid)).toEqual(first);
    await restartSigner(SIGNER);
    expect(await signer().removeKid(start.current.kid)).toEqual(first);
    expect(await storedState()).toEqual(removedState);
  });

  it('removes the key once when a retry follows a call that failed on its alarm write', async () => {
    const start = await storedState();
    // The failed alarm write throws inside the transition, which resets the object.
    await expect(
      runInDurableObject(signer(), async (instance: UtsSignerDO, object) => {
        vi.spyOn(object.storage, 'setAlarm').mockRejectedValueOnce(new Error('alarm write failed'));
        await instance.removeKid(start.current.kid);
      })
    ).rejects.toThrow('alarm write failed');
    // The key change and its alarm commit together, so the failed call stored nothing.
    expect(await storedState()).toEqual(start);
    const retry = await signer().removeKid(start.current.kid);
    if (retry.status !== 'removed') throw new Error(`answered ${retry.status}`);
    const after = await storedState();
    expect(after.current.kid).toBe(start.next.kid);
    expect(after.removed).toEqual([retry.removal]);
    expect(await storedAlarm()).toBe(retry.removal.revokeUntil);
    expect(await signer().removeKid(start.current.kid)).toEqual(retry);
  });

  it('drops the stored entry by alarm at its revokeUntil', async () => {
    const start = await storedState();
    const first = await signer().removeKid(start.current.kid);
    if (first.status !== 'removed') throw new Error(`answered ${first.status}`);
    expect(await storedAlarm()).toBe(first.removal.revokeUntil);
    const following = await alarmAt(first.removal.revokeUntil);
    expect((await storedState()).removed).toEqual([]);
    expect(following).toBe((await storedState()).next.activatesAt);
    expect(await signer().removeKid(start.current.kid)).toEqual({ status: 'unknown_kid' });
  });
});
