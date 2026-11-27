import {
  createWorkerSecrets,
  SecretUnavailableError,
  type BundleBinding,
} from '@kilocode/secrets-client';
import { z } from 'zod';
import type { Env, UtsConfig } from '../env';
import { LOGIN_NAMES } from './config';

/**
 * The rotation job's two secrets in the UTS STS bundle (`services/sts/policy/uts.yaml`, manager
 * folder `/workloads/uts`):
 *
 * - `UTS_HYPERDRIVE_SWITCH_TOKEN`: a Cloudflare API token of a dedicated account member with
 *   Hyperdrive edit rights only (design 5.2).
 * - `UTS_IDENTITY_STORE_LOGIN_SEEDS`: JSON `{ "<login>": "<password>" }` with the first password
 *   provisioning gave each login. The rotation object adopts a login's seed only while it holds no
 *   password of its own, and after a lost login (design 5.2, break-glass); a seed is stale once
 *   the job has rotated that login.
 */
export const SWITCH_TOKEN_NAME = 'UTS_HYPERDRIVE_SWITCH_TOKEN';
export const LOGIN_SEEDS_NAME = 'UTS_IDENTITY_STORE_LOGIN_SEEDS';

const LoginSeedsSchema = z.partialRecord(z.enum(LOGIN_NAMES), z.string().min(1));
export type LoginSeeds = z.infer<typeof LoginSeedsSchema>;

/** Development: the same two names as JSON in `UTS_LOCAL_SECRETS`. */
const LocalSecretsSchema = z.strictObject({
  [SWITCH_TOKEN_NAME]: z.string().min(1),
  [LOGIN_SEEDS_NAME]: z.string().min(1).optional(),
});

export type RotationSecrets = {
  switchToken(): Promise<string>;
  /** The seeds, or none when the secret is absent; throws when it does not parse. */
  loginSeeds(): Promise<LoginSeeds>;
};

type Reader = { get(name: string): Promise<string> };

/** One bundle client per STS binding, so each run revalidates with its ETag. */
const readers = new WeakMap<BundleBinding, Reader>();

function readerFor(env: Env, config: UtsConfig): Reader {
  if (config.environment === 'development') {
    const local = LocalSecretsSchema.parse(JSON.parse(env.UTS_LOCAL_SECRETS ?? 'null'));
    return {
      async get(name) {
        const value =
          name === SWITCH_TOKEN_NAME ? local[SWITCH_TOKEN_NAME] : local[LOGIN_SEEDS_NAME];
        if (value === undefined) throw new SecretUnavailableError('missing', { secretName: name });
        return value;
      },
    };
  }
  if (env.STS === undefined) throw new Error('STS is not bound');
  const held = readers.get(env.STS);
  if (held !== undefined) return held;
  const created = createWorkerSecrets(env.STS);
  readers.set(env.STS, created);
  return created;
}

export function rotationSecrets(env: Env, config: UtsConfig): RotationSecrets {
  const reader = readerFor(env, config);
  return {
    switchToken: () => reader.get(SWITCH_TOKEN_NAME),
    async loginSeeds() {
      try {
        return LoginSeedsSchema.parse(JSON.parse(await reader.get(LOGIN_SEEDS_NAME)));
      } catch (error) {
        if (error instanceof SecretUnavailableError && error.reason === 'missing') return {};
        throw error;
      }
    },
  };
}
