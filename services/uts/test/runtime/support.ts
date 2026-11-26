import { runInDurableObject } from 'cloudflare:test';
import {
  SignerKeysReadSchema,
  UTS_SIGNER_COUNT,
  UtsJwksSchema,
  type SignerKeysAnswer,
  type SignerKeysBinding,
  type SignerKeysRead,
  type UtsJwks,
} from '@kilocode/uts-contracts';
import { getKeySetShardStub, getSignerStub, KEY_SET_SHARD_COUNT } from '../../src/dos/stubs';
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

/** Restarts every key-set shard, which drops its copy and held keys, as a deploy does. */
export async function resetKeySetShards(): Promise<void> {
  for (let shard = 0; shard < KEY_SET_SHARD_COUNT; shard += 1) {
    await runInDurableObject(getKeySetShardStub(env, config, shard), (_instance, state) =>
      state.abort('test restart')
    ).catch(() => undefined);
  }
}

/** One `signerKeys()` call through `binding`, validated and then disposed as the feed Worker does. */
export async function readSignerKeys(
  binding: SignerKeysBinding = env.FEED_MINT
): Promise<SignerKeysRead> {
  const result = await binding.signerKeys();
  const read = SignerKeysReadSchema.parse(result);
  if (typeof result === 'object' && result !== null && Symbol.dispose in result) {
    const dispose = result[Symbol.dispose];
    if (typeof dispose === 'function') dispose.call(result);
  }
  return read;
}

/** The answer the feed caller gets; any refusal fails the test. */
export async function feedAnswer(): Promise<SignerKeysAnswer> {
  const read = await readSignerKeys();
  if (read.status !== 'answered') throw new Error(`feed caller got ${read.status}`);
  return read.answer;
}

/**
 * The key set as the feed Worker builds it: every signer's keys over the SignerKeys entrypoint.
 * It restarts the key-set shards first, so the answer reflects the signer objects now.
 */
export async function keySet(): Promise<UtsJwks> {
  await resetKeySetShards();
  const answer = await feedAnswer();
  return UtsJwksSchema.parse({
    keys: answer.signers.flatMap(entry => {
      if (entry.status !== 'ok') throw new Error(`signer ${entry.signer} answered ${entry.status}`);
      return entry.keys;
    }),
  });
}
