import { timingSafeEqual } from '@kilocode/encryption';
import { readStsSecret, type WebhookSecretName, type WebhookSecretsEnv } from './secrets';
import { getSecretValue } from './util/secret';

/**
 * The comparison runs only in production, only while `SECRETS_SOURCE` is explicitly
 * `secrets-store`, and only when `SECRETS_COMPARE_ENABLED` is exactly `'true'`. Production sets the
 * flag in wrangler.jsonc; `env.dev` does not.
 */
export type SecretsCompareEnv = WebhookSecretsEnv<WebhookSecretName> & {
  ENVIRONMENT?: string;
  SECRETS_COMPARE_ENABLED?: string;
};

/** True only when the STS bundle holds exactly the bytes the Secrets Store serves today. */
export type SecretsCompareResult = Record<WebhookSecretName, boolean>;

const NOT_PROVEN: SecretsCompareResult = {
  INTERNAL_API_SECRET: false,
  CALLBACK_TOKEN_SECRET: false,
  NEXTAUTH_SECRET: false,
};

/** The one log event. Its only fields are the three names and their booleans. */
export const SECRETS_COMPARE_EVENT = 'webhook_secrets_compare';

/**
 * The whole comparison settles within this time, inside the 30 s a request's `waitUntil` may run
 * after its response. The secrets client also gives up on a cold bundle within its own 25 s
 * first-load window; a comparison that has not settled reports every name false.
 */
export const SECRETS_COMPARE_DEADLINE_MS = 25_000;

/**
 * Returns a hook that, on its first enabled call in the isolate, compares the STS copy of each name
 * with its Secrets Store value under the request's `waitUntil` and logs one line of names and
 * booleans. Every later call does nothing. Its result never serves or refuses a request: the hook
 * returns nothing, never throws and never delays the caller, and the work runs after it returns.
 * `executionCtx` is read only when the hook is enabled; a context that cannot be read skips it.
 */
export function createSecretsComparison(): (
  env: SecretsCompareEnv,
  executionCtx: () => Pick<ExecutionContext, 'waitUntil'>
) => void {
  let started = false;
  return (env, executionCtx) => {
    if (started) return;
    if (env.SECRETS_COMPARE_ENABLED !== 'true' || env.ENVIRONMENT !== 'production') return;
    if (env.SECRETS_SOURCE !== 'secrets-store') return;
    let ctx: Pick<ExecutionContext, 'waitUntil'>;
    try {
      ctx = executionCtx();
    } catch {
      return;
    }
    started = true;
    ctx.waitUntil(
      compareWithinDeadline(env).then(result => {
        console.log(SECRETS_COMPARE_EVENT, result);
      })
    );
  };
}

/**
 * The isolate's one hook. Only authenticated requests call it: the internal API after its key
 * check (util/auth.ts) and the execution callback after its token check (routes/callbacks.ts).
 */
export const compareSecretsOnce = createSecretsComparison();

async function compareWithinDeadline(env: SecretsCompareEnv): Promise<SecretsCompareResult> {
  const deadline = Promise.withResolvers<SecretsCompareResult>();
  const handle = setTimeout(() => deadline.resolve(NOT_PROVEN), SECRETS_COMPARE_DEADLINE_MS);
  try {
    return await Promise.race([compareSecrets(env), deadline.promise]);
  } finally {
    clearTimeout(handle);
  }
}

async function compareSecrets(env: SecretsCompareEnv): Promise<SecretsCompareResult> {
  if (env.STS === undefined) return NOT_PROVEN;
  const [internalApi, callbackToken, nextAuth] = await Promise.all([
    copyMatches(env, 'INTERNAL_API_SECRET'),
    copyMatches(env, 'CALLBACK_TOKEN_SECRET'),
    copyMatches(env, 'NEXTAUTH_SECRET'),
  ]);
  return {
    INTERNAL_API_SECRET: internalApi,
    CALLBACK_TOKEN_SECRET: callbackToken,
    NEXTAUTH_SECRET: nextAuth,
  };
}

/**
 * Exact bytes, never a trimmed or parsed form. A missing, empty or unreadable value on either side
 * reports false; the error itself is dropped so no value reaches a log.
 */
async function copyMatches(env: SecretsCompareEnv, name: WebhookSecretName): Promise<boolean> {
  try {
    const [stored, copied] = await Promise.all([
      getSecretValue(env[name]),
      readStsSecret(env, name),
    ]);
    return copied.ok && stored !== '' && timingSafeEqual(stored, copied.value);
  } catch {
    return false;
  }
}
