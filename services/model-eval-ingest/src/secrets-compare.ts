import { timingSafeEqual } from '@kilocode/encryption';
import type { SecretsExecutionContext } from '@kilocode/secrets-client';
import {
  readBundleSecret,
  readLegacySecret,
  secretsSource,
  type ModelEvalIngestSecretsEnv,
  type SecretsSource,
} from './secrets';

/**
 * The comparison runs only when `ENVIRONMENT` is `production` and `SECRETS_COMPARE_ENABLED` is
 * exactly `'true'`, under either source; both are checked before the execution context or any
 * value is read. It compares the value the sync key check already read with the other source's
 * copy, so it never serves or refuses a request and reads no other name.
 */
export type SecretsCompareEnv = ModelEvalIngestSecretsEnv & {
  ENVIRONMENT?: string;
  SECRETS_COMPARE_ENABLED?: string;
};

/**
 * One line after the first accepted sync key in an isolate: the fixed route, name and serving
 * source, and `match`, `mismatch` or `unproven`.
 */
export const SECRETS_COMPARE_EVENT = 'model_eval_ingest_secrets_compare';

/**
 * A comparison settles within this time, inside the 30 s a request's `waitUntil` may run after its
 * response. The secrets client also gives up on a cold bundle within its own 25 s first-load
 * window; a comparison that has not settled reports `unproven`.
 */
export const SECRETS_COMPARE_DEADLINE_MS = 25_000;

const NAME = 'INTERNAL_API_SECRET';

type Comparison = 'match' | 'mismatch' | 'unproven';

/**
 * Returns the isolate's hook for the sync key check. `admitted` compares once per isolate, after
 * the first accepted key, the value that key matched with the other source's copy. A refused key
 * never reaches it. It runs under the request's `waitUntil`, never throws and never delays the
 * caller. A disabled hook reads nothing, the execution context included; a request without one,
 * or whose `waitUntil` refuses the registration, reads nothing and the hook stays armed.
 */
export function createSecretsComparison() {
  let started = false;
  return {
    admitted(env: SecretsCompareEnv, ctx: SecretsExecutionContext | undefined, selected: string) {
      if (started) return;
      if (env.SECRETS_COMPARE_ENABLED !== 'true' || env.ENVIRONMENT !== 'production') return;
      if (ctx === undefined) return;
      let source: SecretsSource;
      try {
        source = secretsSource(env);
      } catch {
        return;
      }
      // The comparison starts only once `waitUntil` has accepted it: a registration that throws
      // leaves no read behind and the latch unset.
      const registered = Promise.withResolvers<void>();
      try {
        ctx.waitUntil(
          registered.promise
            .then(() => withinDeadline(compareSelected(env, ctx, source, selected)))
            .then(result => {
              console.log(SECRETS_COMPARE_EVENT, { route: 'sync', secret: NAME, source, result });
            })
        );
      } catch {
        return;
      }
      started = true;
      registered.resolve();
    },
  };
}

/** The isolate's hook, called by the sync key check (index.ts) after an accepted key only. */
export const secretsComparison = createSecretsComparison();

async function withinDeadline(work: Promise<Comparison>): Promise<Comparison> {
  const deadline = Promise.withResolvers<Comparison>();
  const handle = setTimeout(() => deadline.resolve('unproven'), SECRETS_COMPARE_DEADLINE_MS);
  try {
    return await Promise.race([work, deadline.promise]);
  } finally {
    clearTimeout(handle);
  }
}

/**
 * Exact bytes, never a trimmed form. A missing, empty or unreadable copy in the other source is
 * `unproven`, and its error is dropped so no value reaches a log.
 */
async function compareSelected(
  env: SecretsCompareEnv,
  ctx: SecretsExecutionContext,
  source: SecretsSource,
  selected: string
): Promise<Comparison> {
  const other = await readOther(env, ctx, source === 'sts' ? 'secrets-store' : 'sts');
  if (!other) return 'unproven';
  return timingSafeEqual(selected, other) ? 'match' : 'mismatch';
}

async function readOther(
  env: SecretsCompareEnv,
  ctx: SecretsExecutionContext,
  source: SecretsSource
): Promise<string | undefined> {
  try {
    if (source === 'secrets-store') return await readLegacySecret(env, NAME);
    if (env.STS === undefined) return undefined;
    return await readBundleSecret(env.STS, NAME, ctx);
  } catch {
    return undefined;
  }
}
