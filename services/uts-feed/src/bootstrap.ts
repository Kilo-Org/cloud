import type { KeySetAges } from '@kilocode/uts-contracts';
import { z } from 'zod';
import type { Env, FeedConfig } from './env';
import { serveKeySet } from './jwks';
import { serveHead, serveList } from './revocation';

/**
 * One cold-start answer (design 7): the UTS key set with its two ages, the current head and the
 * list it covers. It is whole or absent, so a verifier never takes a head without the key set
 * that verifies it, and never takes a key set without its ages, so a bootstrap does not restart a
 * held key's age (`keyAges`, the key set's `Age` and `Kilo-Key-Set-Oldest-Age`).
 */
export type BootstrapRead =
  | {
      status: 'ok';
      jwks: Record<string, unknown>;
      keyAges: KeySetAges;
      head: string;
      /** The head's `iat`, in seconds, for the head-age header of the HTTPS answer. */
      headIssuedAt: number;
      list: Uint8Array<ArrayBuffer>;
    }
  | { status: 'unavailable' }
  | { status: 'misconfigured' };

/** The key-set body this Worker serialized itself, read back as a JSON object. */
const KeySetBodySchema = z.record(z.string(), z.unknown());

export async function serveBootstrap(
  env: Env,
  config: FeedConfig,
  ctx: ExecutionContext
): Promise<BootstrapRead> {
  const [keySet, head] = await Promise.all([
    serveKeySet(env.UTS_MINT, config.environment, ctx),
    serveHead(env.UTS_FEED_READS, config, ctx),
  ]);
  if (keySet.status === 'misconfigured' || head.status === 'misconfigured') {
    return { status: 'misconfigured' };
  }
  if (keySet.status !== 'ok' || head.status !== 'ok') return { status: 'unavailable' };
  const list = await serveList(env.UTS_FEED_READS, config, head.listHash, ctx);
  if (list.status === 'misconfigured') return { status: 'misconfigured' };
  if (list.status !== 'ok') return { status: 'unavailable' };
  return {
    status: 'ok',
    jwks: KeySetBodySchema.parse(JSON.parse(keySet.body)),
    keyAges: {
      newest: Math.floor(keySet.ageMs / 1000),
      oldest: Math.floor(keySet.oldestAgeMs / 1000),
    },
    head: head.head,
    headIssuedAt: head.issuedAt,
    list: list.bytes,
  };
}
