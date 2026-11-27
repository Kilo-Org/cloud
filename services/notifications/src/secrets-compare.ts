import { timingSafeEqual } from '@kilocode/encryption';
import type { BundleBinding, SecretsExecutionContext } from '@kilocode/secrets-client';
import {
  readBundleSecret,
  readSecretsStoreSecret,
  type NotificationsSecretName,
  type NotificationsSecretsEnv,
} from './secrets';

/**
 * Only the exact string `'true'` in `SECRETS_COMPARE_ENABLED` turns the comparison on; production
 * sets it in wrangler.jsonc and staging does not. It runs only while `SECRETS_SOURCE` is explicitly
 * `secrets-store`.
 */
export type SecretsCompareEnv = NotificationsSecretsEnv & { SECRETS_COMPARE_ENABLED?: string };

/**
 * One boolean per name the pre-flip check covers: true only when the STS bundle holds exactly the
 * bytes the Secrets Store serves today. Expo has its own copy check and is not compared here.
 */
export type SecretsCompareResult = Record<
  Extract<
    NotificationsSecretName,
    'NOTIFICATIONS_APNS_PRIVATE_KEY' | 'NEXTAUTH_SECRET' | 'INTERNAL_API_SECRET'
  >,
  boolean
>;

const NOT_PROVEN: SecretsCompareResult = {
  NOTIFICATIONS_APNS_PRIVATE_KEY: false,
  NEXTAUTH_SECRET: false,
  INTERNAL_API_SECRET: false,
};

/**
 * The whole comparison settles within this time, inside the 30 s a request's `waitUntil` may run
 * after its response. The secrets client also gives up on a cold bundle within its own 25 s
 * first-load window; a comparison that has not settled reports every name false.
 */
export const SECRETS_COMPARE_DEADLINE_MS = 25_000;

/**
 * Returns a hook that, on its first eligible call in the isolate, compares the STS copy of each
 * name with its Secrets Store value under the caller's `waitUntil` and logs one line of names and
 * booleans. Every later call does nothing. It never changes which source serves a read, and it
 * never throws or delays the caller: the work runs after the hook returns.
 */
export function createSecretsComparison(): (
  env: SecretsCompareEnv,
  ctx: SecretsExecutionContext
) => void {
  let started = false;
  return (env, ctx) => {
    if (started || env.SECRETS_COMPARE_ENABLED !== 'true') return;
    if (env.SECRETS_SOURCE !== 'secrets-store') return;
    started = true;
    ctx.waitUntil(
      compareWithinDeadline(env, ctx).then(result => {
        console.log('notifications_secrets_compare', result);
      })
    );
  };
}

async function compareWithinDeadline(
  env: SecretsCompareEnv,
  ctx: SecretsExecutionContext
): Promise<SecretsCompareResult> {
  const deadline = Promise.withResolvers<SecretsCompareResult>();
  const handle = setTimeout(() => deadline.resolve(NOT_PROVEN), SECRETS_COMPARE_DEADLINE_MS);
  try {
    return await Promise.race([compareSecrets(env, ctx), deadline.promise]);
  } finally {
    clearTimeout(handle);
  }
}

async function compareSecrets(
  env: SecretsCompareEnv,
  ctx: SecretsExecutionContext
): Promise<SecretsCompareResult> {
  const binding = env.STS;
  if (binding === undefined) return NOT_PROVEN;
  const [apnsKey, nextAuth, internalApi] = await Promise.all([
    copyMatches(env, binding, 'NOTIFICATIONS_APNS_PRIVATE_KEY', ctx),
    copyMatches(env, binding, 'NEXTAUTH_SECRET', ctx),
    copyMatches(env, binding, 'INTERNAL_API_SECRET', ctx),
  ]);
  return {
    NOTIFICATIONS_APNS_PRIVATE_KEY: apnsKey,
    NEXTAUTH_SECRET: nextAuth,
    INTERNAL_API_SECRET: internalApi,
  };
}

/**
 * Exact bytes, never a parsed form. The APNs reader strips the PEM armour and every whitespace
 * character before decoding (`pemToDer` in lib/apns-live-activity.ts), so a copy that differs only
 * in whitespace would sign the same, yet reports false here. A missing, empty or unreadable value
 * on either side reports false; the error itself is dropped so no value reaches a log.
 */
async function copyMatches(
  env: SecretsCompareEnv,
  binding: BundleBinding,
  name: keyof SecretsCompareResult,
  ctx: SecretsExecutionContext
): Promise<boolean> {
  try {
    const [stored, copied] = await Promise.all([
      readSecretsStoreSecret(env, name),
      readBundleSecret(binding, name, ctx),
    ]);
    return stored !== '' && timingSafeEqual(stored, copied);
  } catch {
    return false;
  }
}
