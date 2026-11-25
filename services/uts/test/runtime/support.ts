import { runInDurableObject } from 'cloudflare:test';
import {
  SignerKeysResultSchema,
  UTS_SIGNER_COUNT,
  UtsJwksSchema,
  type UtsJwks,
} from '@kilocode/uts-contracts';
import { getSignerStub } from '../../src/dos/stubs';
import type { SignableClaims } from '../../src/keys/claims';
import { config, env } from './test-env';

/** A claim set the development signer accepts. */
export function claims(overrides: Partial<SignableClaims> = {}): SignableClaims {
  const now = Math.floor(Date.now() / 1000);
  return {
    iss: config.endpoints.issuer,
    exp: now + 600,
    aud: 'gateway',
    sub: 'user-test',
    client_id: 'kilo-cli',
    iat: now,
    jti: crypto.randomUUID(),
    scope: 'gateway:models.read',
    sid: 'grant-test',
    env: 'development',
    ...overrides,
  };
}

/**
 * Durable Object storage is shared by every test in a file, so a test that needs a new signer
 * empties its storage and aborts the instance; the next call bootstraps fresh keys.
 */
export async function resetSigner(signer: number): Promise<void> {
  await runInDurableObject(getSignerStub(env, config, signer), async (_instance, state) => {
    await state.storage.deleteAlarm();
    await state.storage.deleteAll();
  });
  await restartSigner(signer);
}

/** Restarts an object: the next call runs its constructor again over the same storage. */
export async function restartSigner(signer: number): Promise<void> {
  await runInDurableObject(getSignerStub(env, config, signer), (_instance, state) =>
    state.abort('test restart')
  ).catch(() => undefined);
}

export async function resetAllSigners(): Promise<void> {
  for (let signer = 0; signer < UTS_SIGNER_COUNT; signer += 1) await resetSigner(signer);
}

/** The key set as the feed Worker builds it: every signer's keys over the internal entrypoint. */
export async function keySet(): Promise<UtsJwks> {
  const result = SignerKeysResultSchema.parse(await env.FEED_SIGNER_KEYS.publicKeys());
  if (result.status !== 'ok') throw new Error('the feed caller was refused');
  return UtsJwksSchema.parse({ keys: result.signers.flatMap(entry => entry.keys) });
}
