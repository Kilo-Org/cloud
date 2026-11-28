import { timingSafeEqual } from '@kilocode/encryption';
import {
  readStsSecret,
  type VerifierRoute,
  type WebhookSecretName,
  type WebhookSecretsEnv,
  type WebhookSecretsSource,
} from './secrets';
import { getSecretValue } from './util/secret';

/**
 * The comparison runs only in production and only when `SECRETS_COMPARE_ENABLED` is exactly
 * `'true'`, under either source. It compares what the serving source gave with the other source
 * and never serves or refuses a request.
 */
export type SecretsCompareEnv = WebhookSecretsEnv<WebhookSecretName> & {
  ENVIRONMENT?: string;
  SECRETS_COMPARE_ENABLED?: string;
};

/** True only when the other source holds exactly the bytes the serving source gave. */
export type SecretsCompareResult = Record<WebhookSecretName, boolean>;

const NOT_PROVEN: SecretsCompareResult = {
  INTERNAL_API_SECRET: false,
  CALLBACK_TOKEN_SECRET: false,
  NEXTAUTH_SECRET: false,
};

/** The verifier that checked a request, the source that served it, and the value it checked. */
export type CheckedSecret = {
  route: VerifierRoute;
  source: WebhookSecretsSource;
  selected: string;
};

/**
 * The admitted-request event: the three names and their booleans as before, plus the fixed route
 * and serving source of the request that started it and the names whose two values were both
 * read and differ.
 */
export const SECRETS_COMPARE_EVENT = 'webhook_secrets_compare';

/**
 * The refused-request event: the route's own name, its fixed route and serving source, and
 * `match`, `mismatch` or `unproven`.
 */
export const SECRETS_COMPARE_REFUSED_EVENT = 'webhook_secrets_compare_refused';

/**
 * A comparison settles within this time, inside the 30 s a request's `waitUntil` may run after its
 * response. The secrets client also gives up on a cold bundle within its own 25 s first-load window;
 * a comparison that has not settled reports nothing proven.
 */
export const SECRETS_COMPARE_DEADLINE_MS = 25_000;

const ROUTE_SECRET = {
  'internal-api': 'INTERNAL_API_SECRET',
  'execution-callback': 'CALLBACK_TOKEN_SECRET',
} as const satisfies Record<VerifierRoute, WebhookSecretName>;

const SECRET_NAMES = [
  'INTERNAL_API_SECRET',
  'CALLBACK_TOKEN_SECRET',
  'NEXTAUTH_SECRET',
] as const satisfies readonly WebhookSecretName[];

type Comparison = 'match' | 'mismatch' | 'unproven';

type AdmittedLine = SecretsCompareResult & {
  route: VerifierRoute;
  source: WebhookSecretsSource;
  mismatched: WebhookSecretName[];
};

type Lifetime = () => Pick<ExecutionContext, 'waitUntil'>;

/**
 * Returns the isolate's two hooks. `admitted` compares all three names once per isolate, after the
 * first accepted credential. `refused` compares only the route's own name, once per isolate and
 * route, after a presented credential is refused. Both run under the request's `waitUntil`, log one
 * line of fixed fields, never throw and never delay the caller. A disabled hook reads nothing,
 * `executionCtx` included; a context that cannot be read skips the call and stays armed.
 */
export function createSecretsComparison() {
  let admittedStarted = false;
  const refusedStarted = new Set<VerifierRoute>();
  const start = (env: SecretsCompareEnv, executionCtx: Lifetime, work: () => Promise<void>) => {
    if (env.SECRETS_COMPARE_ENABLED !== 'true' || env.ENVIRONMENT !== 'production') return false;
    let ctx: Pick<ExecutionContext, 'waitUntil'>;
    try {
      ctx = executionCtx();
    } catch {
      return false;
    }
    ctx.waitUntil(work());
    return true;
  };
  return {
    admitted(env: SecretsCompareEnv, executionCtx: Lifetime, checked: CheckedSecret): void {
      if (admittedStarted) return;
      admittedStarted = start(env, executionCtx, async () => {
        console.log(SECRETS_COMPARE_EVENT, await compareAdmitted(env, checked));
      });
    },
    refused(env: SecretsCompareEnv, executionCtx: Lifetime, checked: CheckedSecret): void {
      if (refusedStarted.has(checked.route)) return;
      const started = start(env, executionCtx, async () => {
        console.log(SECRETS_COMPARE_REFUSED_EVENT, await compareRefused(env, checked));
      });
      if (started) refusedStarted.add(checked.route);
    },
  };
}

/**
 * The isolate's hooks. The internal API key check (util/auth.ts) and the execution callback token
 * check (routes/callbacks.ts) call them.
 */
export const secretsComparison = createSecretsComparison();

async function compareAdmitted(
  env: SecretsCompareEnv,
  checked: CheckedSecret
): Promise<AdmittedLine> {
  const unproven: AdmittedLine = {
    ...NOT_PROVEN,
    route: checked.route,
    source: checked.source,
    mismatched: [],
  };
  if (env.STS === undefined) return unproven;
  return withinDeadline(compareAll(env, checked), unproven);
}

async function compareAll(env: SecretsCompareEnv, checked: CheckedSecret): Promise<AdmittedLine> {
  const [internalApi, callbackToken, nextAuth] = await Promise.all([
    compareName(env, checked, 'INTERNAL_API_SECRET'),
    compareName(env, checked, 'CALLBACK_TOKEN_SECRET'),
    compareName(env, checked, 'NEXTAUTH_SECRET'),
  ]);
  const results: Record<WebhookSecretName, Comparison> = {
    INTERNAL_API_SECRET: internalApi,
    CALLBACK_TOKEN_SECRET: callbackToken,
    NEXTAUTH_SECRET: nextAuth,
  };
  return {
    INTERNAL_API_SECRET: internalApi === 'match',
    CALLBACK_TOKEN_SECRET: callbackToken === 'match',
    NEXTAUTH_SECRET: nextAuth === 'match',
    route: checked.route,
    source: checked.source,
    mismatched: SECRET_NAMES.filter(name => results[name] === 'mismatch'),
  };
}

async function compareRefused(env: SecretsCompareEnv, checked: CheckedSecret) {
  const secret = ROUTE_SECRET[checked.route];
  const result = await withinDeadline(compareName(env, checked, secret), 'unproven');
  return { route: checked.route, secret, source: checked.source, result };
}

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
 * Exact bytes, never a trimmed or parsed form. The route's own name uses the value the request was
 * checked against; another name is read from the serving source. A missing, empty or unreadable
 * value on either side is `unproven`; the error itself is dropped so no value reaches a log.
 */
async function compareName(
  env: SecretsCompareEnv,
  checked: CheckedSecret,
  name: WebhookSecretName
): Promise<Comparison> {
  const otherSource = checked.source === 'sts' ? 'secrets-store' : 'sts';
  const [served, other] = await Promise.all([
    name === ROUTE_SECRET[checked.route] ? checked.selected : readFrom(env, checked.source, name),
    readFrom(env, otherSource, name),
  ]);
  if (!served || !other) return 'unproven';
  return timingSafeEqual(served, other) ? 'match' : 'mismatch';
}

async function readFrom(
  env: SecretsCompareEnv,
  source: WebhookSecretsSource,
  name: WebhookSecretName
): Promise<string | undefined> {
  if (source === 'sts') {
    const read = await readStsSecret(env, name);
    return read.ok ? read.value : undefined;
  }
  try {
    return await getSecretValue(env[name]);
  } catch {
    return undefined;
  }
}
