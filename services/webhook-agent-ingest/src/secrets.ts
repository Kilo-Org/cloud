import {
  createWorkerSecrets,
  SecretUnavailableError,
  type BundleBinding,
  type SecretUnavailableReason,
  type Secrets,
} from '@kilocode/secrets-client';
import type * as WorkerdModule from 'cloudflare:workers';
import { resError } from '@kilocode/worker-utils';
import { logger } from './util/logger';
import { getSecretValue } from './util/secret';

/**
 * The three secrets this Worker reads. Each name is its Secrets Store binding and its manager and
 * STS bundle name. STS resolves a name from `/workloads/cloudflare-webhook-agent-ingest` first,
 * then `/shared` (design 4.2); all three live in `/shared`.
 */
export type WebhookSecretName = 'INTERNAL_API_SECRET' | 'CALLBACK_TOKEN_SECRET' | 'NEXTAUTH_SECRET';

/** Where the three secrets are read: the STS bundle, or the Worker's own bindings. */
export type WebhookSecretsSource = 'secrets-store' | 'sts';

/**
 * `ENVIRONMENT` fixes where every read of the three secrets goes. `production` reads the bundle
 * over the `STS` service binding and never falls back to the Secrets Store. `development` (the
 * local-only `env.dev`) reads its own bindings, `.dev.vars` strings included. Any other value, an
 * absent one included, reads neither and refuses.
 */
export type WebhookSecretsSelection = {
  ENVIRONMENT?: string;
  STS?: BundleBinding;
};

/** The selection plus the binding that `development` reads for `N`. */
export type WebhookSecretsEnv<N extends WebhookSecretName> = WebhookSecretsSelection &
  Record<N, SecretsStoreSecret | string>;

/** Why no value was read. Every value is fixed here; none comes from an error. */
export type SecretRefusal =
  | 'unsupported_environment'
  | 'binding_missing'
  | 'missing'
  | 'not_granted'
  | 'denied'
  | 'unavailable'
  | 'read_failed';

const CLIENT_REASONS: Record<SecretUnavailableReason, SecretRefusal> = {
  missing: 'missing',
  not_granted: 'not_granted',
  denied: 'denied',
  unavailable: 'unavailable',
};

/** One client per binding keeps one bundle per isolate across requests and queue batches. */
const stsClients = new WeakMap<BundleBinding, Secrets>();

/**
 * The workerd built-in, loaded once on the first `sts` read and shared by concurrent reads. A
 * failed load clears it, so the next read loads again; the failure still reaches the caller.
 */
let workerdModule: Promise<typeof WorkerdModule> | undefined;

/**
 * The source `ENVIRONMENT` fixes, or `undefined` for an environment this Worker does not deploy.
 * Callers fail closed on `undefined` and read neither source.
 */
export function secretsSource(
  env: Pick<WebhookSecretsSelection, 'ENVIRONMENT'>
): WebhookSecretsSource | undefined {
  if (env.ENVIRONMENT === 'production') return 'sts';
  if (env.ENVIRONMENT === 'development') return 'secrets-store';
  return undefined;
}

type StsReadResult = { ok: true; value: string } | { ok: false; reason: SecretRefusal };

const UNSUPPORTED_ENVIRONMENT: StsReadResult = { ok: false, reason: 'unsupported_environment' };

let stsReadLogged = false;

function logStsReadOnce(value: string): void {
  if (stsReadLogged || value === '') return;
  stsReadLogged = true;
  logger.info('Webhook secret source read succeeded', { source: 'sts' });
}

/**
 * Reads one name from the STS bundle and returns it as delivered, empty included, so each caller
 * keeps its own empty-value handling. It never throws and never reads the Secrets Store: a failure
 * returns only a fixed reason, so no error name, message or cause reaches a log or a response.
 */
async function readStsSecret(
  env: Pick<WebhookSecretsSelection, 'STS'>,
  name: WebhookSecretName
): Promise<StsReadResult> {
  const binding = env.STS;
  if (binding === undefined) return { ok: false, reason: 'binding_missing' };
  let client = stsClients.get(binding);
  if (client === undefined) {
    client = createWorkerSecrets(binding);
    stsClients.set(binding, client);
  }
  try {
    // The fetch and queue handlers pass no execution context down, so the module-level
    // `waitUntil` hands a revalidation this read starts to the invocation doing the read. A static
    // import cannot work: the Node unit tests of every module that imports this file cannot
    // resolve the workerd built-in, and the `secrets-store` source never needs it.
    workerdModule ??= import('cloudflare:workers').catch((error: unknown) => {
      workerdModule = undefined;
      throw error;
    });
    const { waitUntil } = await workerdModule;
    return { ok: true, value: await client.get(name, { waitUntil }) };
  } catch (error) {
    const reason =
      error instanceof SecretUnavailableError && Object.hasOwn(CLIENT_REASONS, error.reason)
        ? CLIENT_REASONS[error.reason]
        : 'read_failed';
    return { ok: false, reason };
  }
}

/**
 * A sender could not get a secret from STS, or `ENVIRONMENT` names no source. The message is fixed
 * and safe to store as a request's failure text; `secret` and `reason` hold fixed values only.
 */
export class SecretSourceUnavailableError extends Error {
  constructor(
    readonly secret: WebhookSecretName,
    readonly reason: SecretRefusal
  ) {
    super('Webhook credentials are temporarily unavailable');
    this.name = 'SecretSourceUnavailableError';
  }
}

/**
 * The value a sender uses. `development` returns or throws exactly what its binding gives.
 * `production` returns the delivered bundle value; a failed read, and an unsupported
 * `ENVIRONMENT`, log a fixed event and throw `SecretSourceUnavailableError`.
 */
export async function readSecret<N extends WebhookSecretName>(
  env: WebhookSecretsEnv<NoInfer<N>>,
  name: N
): Promise<string> {
  const source = secretsSource(env);
  // Widening to the binding record keeps `bindings[name]` typed as the binding.
  const bindings: Record<N, SecretsStoreSecret | string> = env;
  if (source === 'secrets-store') return getSecretValue(bindings[name]);
  const read = source === 'sts' ? await readStsSecret(env, name) : UNSUPPORTED_ENVIRONMENT;
  if (read.ok) {
    logStsReadOnce(read.value);
    return read.value;
  }
  logger.error('Webhook secret unavailable', { secret: name, reason: read.reason });
  throw new SecretSourceUnavailableError(name, read.reason);
}

/**
 * What an inbound credential is checked against. `read` holds the value as `source` returned it.
 * `keyless` means production read nothing because the request presents no credential; the
 * verifier refuses it as it refuses any missing credential. `refused` carries a fixed reason.
 */
export type ExpectedSecret =
  | { status: 'read'; source: WebhookSecretsSource; secret: string }
  | { status: 'keyless'; source: 'sts' }
  | { status: 'refused'; reason: SecretRefusal };

/**
 * The expected value for a verifier. The comparison stays at the verifier. `development` reads
 * its binding for every request, a keyless one included, and returns or throws exactly what it
 * gives. `production` reads the bundle only for a request that presents a credential and never
 * falls back.
 */
export async function expectedSecret<N extends WebhookSecretName>(
  env: WebhookSecretsEnv<NoInfer<N>>,
  name: N,
  presented: string | null | undefined
): Promise<ExpectedSecret> {
  const source = secretsSource(env);
  const bindings: Record<N, SecretsStoreSecret | string> = env;
  if (source === 'secrets-store') {
    return { status: 'read', source, secret: await getSecretValue(bindings[name]) };
  }
  if (source === undefined) return { status: 'refused', reason: 'unsupported_environment' };
  if (!presented) return { status: 'keyless', source };
  const read = await readStsSecret(env, name);
  if (read.ok) logStsReadOnce(read.value);
  return read.ok
    ? { status: 'read', source, secret: read.value }
    : { status: 'refused', reason: read.reason };
}

/** The two inbound verifiers, as fixed log labels. */
export type VerifierRoute = 'internal-api' | 'execution-callback';

/**
 * The generic, retryable answer a verifier gives when it cannot get its expected value, before it
 * reads the body or calls a Durable Object. The log line carries only fixed fields.
 */
export function secretUnavailableResponse(route: VerifierRoute, reason: SecretRefusal): Response {
  logger.error('Webhook verifier secret unavailable', { route, reason });
  return Response.json(resError('Internal key unavailable'), {
    status: 503,
    headers: { 'Retry-After': '30' },
  });
}
