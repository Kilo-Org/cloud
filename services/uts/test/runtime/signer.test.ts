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

/** Runs the object's alarm as if the clock read `at`. */
async function alarmAt(at: number): Promise<number | null> {
  return await runInDurableObject(signer(), async (instance: UtsSignerDO, state) => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(at);
    try {
      await instance.alarm();
    } finally {
      clock.mockRestore();
    }
    return await state.storage.getAlarm();
  });
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
    const { signer: index, keys } = await signer().publicKeys();
    expect(index).toBe(SIGNER);
    expect(keys).toHaveLength(2);
    for (const key of keys) {
      expect(UtsPublicJwkSchema.parse(key)).toEqual(key);
      expect(signerOfTokenKid(key.kid)).toBe(SIGNER);
      expect(Object.keys(key)).not.toContain('d');
    }
  });

  it('keeps keys in KV storage and no SQL table', async () => {
    await signer().publicKeys();
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
    const before = await signer().publicKeys();
    await restartSigner(SIGNER);
    expect(await signer().publicKeys()).toEqual(before);
  });

  it('refuses to create keys under a name that is not its own signer name', async () => {
    const refusal = (error: unknown) => (error instanceof Error ? error.message : String(error));
    for (const name of ['staging:signer:01', 'development:feed:01']) {
      const stub = env.UTS_SIGNER_DO.getByName(name);
      // Called inside the object, so each refusal is read as a value and never crosses RPC.
      const result = await runInDurableObject(stub, async (instance: UtsSignerDO, state) => ({
        publicKeys: await instance.publicKeys().then(() => 'answered', refusal),
        sign: await instance.sign(claims()).then(() => 'signed', refusal),
        stored: [...(await state.storage.list()).keys()],
        alarm: await state.storage.getAlarm(),
      }));
      expect(result).toEqual({
        publicKeys: 'signer object was not created by its signer name',
        sign: 'signer object was not created by its signer name',
        stored: [],
        alarm: null,
      });
    }
  });

  it('creates its keys under its own signer name, unscoped in development', async () => {
    const keys = await env.UTS_SIGNER_DO.getByName('development:signer:02').publicKeys();
    expect(keys.signer).toBe(2);
  });

  it('schedules its alarm for the next rotation', async () => {
    const state = await storedState();
    const alarm = await runInDurableObject(signer(), (_instance, objectState) =>
      objectState.storage.getAlarm()
    );
    expect(alarm).toBe(state.current.activatedAt + 30 * DAY);
  });
});

describe('signing', () => {
  it('signs an at+jwt with EdDSA under the current kid that verifies against the key set', async () => {
    const result = await signer().sign(claims());
    if (result.status !== 'signed') throw new Error(`refused: ${result.reason}`);
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
      [claims({ iat: now + 59, exp: now + 3659 }), 'expires_too_late'],
    ] as const;
    for (const [input, reason] of cases) {
      expect(await signer().sign(input)).toEqual({ status: 'refused', reason });
    }
  });
});

describe('rotation', () => {
  it('rotates by alarm, publishes the next key 7 days ahead, and keeps the retired key 70 minutes', async () => {
    const start = await storedState();
    const firstKid = start.current.kid;
    const secondKid = start.next?.kid;
    const t0 = start.current.activatedAt;

    expect(await alarmAt(t0 + 30 * DAY)).toBe(t0 + 30 * DAY + RETIRED_WINDOW);
    const afterRotation = await signer().publicKeys();
    expect(afterRotation.keys.map(key => key.kid)).toEqual([secondKid, firstKid]);

    const signed = await signer().sign(claims());
    if (signed.status !== 'signed') throw new Error(`refused: ${signed.reason}`);
    expect(signed.kid).toBe(secondKid);
    await verify(signed.token);

    expect(await alarmAt(t0 + 30 * DAY + RETIRED_WINDOW)).toBe(t0 + 53 * DAY);
    expect((await signer().publicKeys()).keys.map(key => key.kid)).toEqual([secondKid]);

    expect(await alarmAt(t0 + 53 * DAY)).toBe(t0 + 60 * DAY);
    const withNext = await storedState();
    expect(withNext.next?.publishedAt).toBe(t0 + 53 * DAY);
    expect(withNext.next?.activatesAt).toBe(t0 + 60 * DAY);
    expect((await signer().publicKeys()).keys.map(key => key.kid)).toEqual([
      secondKid,
      withNext.next?.kid,
    ]);
  });
});

describe('emergency removal', () => {
  it('removes the current kid, signs under the next key, and returns the feed entry', async () => {
    const start = await storedState();
    const result = await signer().removeKid(start.current.kid);
    if (result.status !== 'removed') throw new Error('expected removal');
    expect(result.removal.kid).toBe(start.current.kid);
    expect(result.removal.signer).toBe(SIGNER);
    expect(result.removal.revokeUntil - result.removal.removedAt).toBe(RETIRED_WINDOW);

    const kids = (await signer().publicKeys()).keys.map(key => key.kid);
    expect(kids).toEqual([start.next?.kid]);
    const signed = await signer().sign(claims());
    if (signed.status !== 'signed') throw new Error(`refused: ${signed.reason}`);
    expect(signed.kid).toBe(start.next?.kid);
  });

  it('answers unknown_kid for a kid it does not hold', async () => {
    expect(await signer().removeKid('uts-token-05-unknown')).toEqual({ status: 'unknown_kid' });
  });

  it('keeps the removal across a restart', async () => {
    const start = await storedState();
    await signer().removeKid(start.current.kid);
    await restartSigner(SIGNER);
    const kids = (await signer().publicKeys()).keys.map(key => key.kid);
    expect(kids).not.toContain(start.current.kid);
  });
});
