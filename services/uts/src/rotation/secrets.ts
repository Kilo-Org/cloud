import { createWorkerSecrets, type BundleBinding } from '@kilocode/secrets-client';
import { z } from 'zod';
import type { Env, UtsConfig } from '../env';

/**
 * The rotation job's one secret in the UTS STS bundle (manager folder `/workloads/uts`):
 * `UTS_HYPERDRIVE_SWITCH_TOKEN`, a Cloudflare API token of a dedicated account member with
 * Hyperdrive edit rights only (design 5.2). The login seeds are not here: the job reads them from
 * `/db-switch/uts` through the manager client (decision Q88).
 */
export const SWITCH_TOKEN_NAME = 'UTS_HYPERDRIVE_SWITCH_TOKEN';

/** Development: the token as JSON in `UTS_LOCAL_SECRETS`. */
const LocalSecretsSchema = z.strictObject({ [SWITCH_TOKEN_NAME]: z.string().min(1) });

/** One bundle client per STS binding, so each run revalidates with its ETag. */
const readers = new WeakMap<BundleBinding, { get(name: string): Promise<string> }>();

/** The switch token; throws when the bundle or the local value cannot serve it. */
export async function switchToken(env: Env, config: UtsConfig): Promise<string> {
  if (config.environment === 'development') {
    return LocalSecretsSchema.parse(JSON.parse(env.UTS_LOCAL_SECRETS ?? 'null'))[SWITCH_TOKEN_NAME];
  }
  if (env.STS === undefined) throw new Error('STS is not bound');
  let reader = readers.get(env.STS);
  if (reader === undefined) {
    reader = createWorkerSecrets(env.STS);
    readers.set(env.STS, reader);
  }
  return await reader.get(SWITCH_TOKEN_NAME);
}
