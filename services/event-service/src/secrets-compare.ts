import type { BundleBinding, SecretsExecutionContext } from '@kilocode/secrets-client';
import {
  readBundleSecret,
  readLegacySecret,
  secretsSourceLabel,
  type EventServiceSecretName,
  type EventServiceSecretsEnv,
  type GuardRoute,
  type SecretsSource,
} from './secrets';

/**
 * The comparison runs only when `WORKER_ENV` is `production` and `SECRETS_COMPARE_ENABLED` is
 * exactly `'true'`, under either source; both are checked before the execution context or any
 * value is touched. It compares the exact value the verifier accepted with the other source, read
 * through its raw reader, so it never serves or refuses a request and never logs the `sts` marker.
 */
export type SecretsCompareEnv = EventServiceSecretsEnv & {
  WORKER_ENV?: string;
  SECRETS_COMPARE_ENABLED?: string;
};

/**
 * The one event: fixed route, secret name and serving source, and `match`, `mismatch` or
 * `unproven`. No value, digest, request or user identifier is ever part of it.
 */
export const SECRETS_COMPARE_EVENT = 'event_service_secrets_compare';

/**
 * A comparison settles within this time, inside the 30 s a request's `waitUntil` may run after its
 * response. The secrets client also gives up on a cold bundle within its own 25 s first-load
 * window; a comparison that has not settled reports `unproven`.
 */
export const SECRETS_COMPARE_DEADLINE_MS = 25_000;

const COMPARED_NAME = 'NEXTAUTH_SECRET' satisfies EventServiceSecretName;

type Comparison = 'match' | 'mismatch' | 'unproven';

/**
 * An admitted request: its fixed route and the exact value this request's own read resolved for
 * the verifier that accepted it. An acceptance the verifier answered from its isolate cache has no
 * such value and never reaches the hook.
 */
export type AdmittedCheck = { route: GuardRoute; selected: string };

/**
 * Returns the isolate's hook. `admitted` compares `NEXTAUTH_SECRET` once per isolate, after the
 * first accepted request, under that request's `waitUntil`; it never throws and never delays the
 * caller. A disabled hook touches nothing, the execution context included; a missing context, or
 * one whose `waitUntil` throws, skips the call and stays armed.
 */
export function createSecretsComparison() {
  let started = false;
  return {
    admitted(
      env: SecretsCompareEnv,
      ctx: SecretsExecutionContext | undefined,
      check: AdmittedCheck
    ): void {
      if (started) return;
      if (env.SECRETS_COMPARE_ENABLED !== 'true' || env.WORKER_ENV !== 'production') return;
      if (ctx === undefined) return;
      const source = secretsSourceLabel(env);
      if (source === 'invalid') return;
      // No read starts until `waitUntil` has accepted the work: the gate below opens only after a
      // successful registration, and the comparison begins in a later microtask.
      const gate = Promise.withResolvers<void>();
      const work = gate.promise
        .then(() => withinDeadline(compareName(env, ctx, source, check.selected), 'unproven'))
        .then(result => {
          console.log(SECRETS_COMPARE_EVENT, {
            route: check.route,
            secret: COMPARED_NAME,
            source,
            result,
          });
        });
      try {
        ctx.waitUntil(work);
      } catch {
        // The unopened gate leaves `work` pending with nothing started; the next request samples.
        return;
      }
      started = true;
      gate.resolve();
    },
  };
}

/** The isolate's hook, called by the bearer check (auth.ts). */
export const secretsComparison = createSecretsComparison();

async function withinDeadline<T>(work: Promise<T>, fallback: T): Promise<T> {
  const deadline = Promise.withResolvers<T>();
  const handle = setTimeout(() => deadline.resolve(fallback), SECRETS_COMPARE_DEADLINE_MS);
  try {
    return await Promise.race([work, deadline.promise]);
  } finally {
    clearTimeout(handle);
  }
}

/**
 * Exact bytes of the selected value and the other source's value; the serving source is never read
 * again. Without the STS binding nothing is read. An empty or unreadable value is `unproven`.
 */
async function compareName(
  env: SecretsCompareEnv,
  ctx: SecretsExecutionContext,
  source: SecretsSource,
  selected: string
): Promise<Comparison> {
  const binding = env.STS;
  if (binding === undefined) return 'unproven';
  const other = await readFrom(env, binding, ctx, source === 'sts' ? 'secrets-store' : 'sts');
  if (!selected || !other) return 'unproven';
  return sameBytes(selected, other) ? 'match' : 'mismatch';
}

const encoder = new TextEncoder();

/** workerd's `timingSafeEqual` throws on a length difference, so length is checked first. */
function sameBytes(left: string, right: string): boolean {
  const a = encoder.encode(left);
  const b = encoder.encode(right);
  return a.byteLength === b.byteLength && crypto.subtle.timingSafeEqual(a, b);
}

/** One raw read; the error is dropped so no value or message reaches a log. */
async function readFrom(
  env: SecretsCompareEnv,
  binding: BundleBinding,
  ctx: SecretsExecutionContext,
  source: SecretsSource
): Promise<string | undefined> {
  try {
    return source === 'sts'
      ? await readBundleSecret(binding, COMPARED_NAME, ctx)
      : await readLegacySecret(env, COMPARED_NAME);
  } catch {
    return undefined;
  }
}
