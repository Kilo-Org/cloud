import {
  createWorkerSecrets,
  SecretUnavailableError,
  type BundleBinding,
  type SecretUnavailableReason,
  type Secrets,
} from '@kilocode/secrets-client';
import type * as WorkerdModule from 'cloudflare:workers';
import { resError } from '@kilocode/worker-utils';
import { z } from 'zod';
import { logger } from './util/logger';
import { getSecretValue } from './util/secret';

/**
 * The three secrets this Worker reads. Each name is its Secrets Store binding and its manager and
 * STS bundle name. STS resolves a name from `/workloads/cloudflare-webhook-agent-ingest` first,
 * then `/shared` (design 4.2); all three live in `/shared`.
 */
export type WebhookSecretName = 'INTERNAL_API_SECRET' | 'CALLBACK_TOKEN_SECRET' | 'NEXTAUTH_SECRET';

const SecretsSourceSchema = z.enum(['secrets-store', 'sts']);

export type WebhookSecretsSource = z.infer<typeof SecretsSourceSchema>;

/**
 * `SECRETS_SOURCE` selects where every read of the three secrets goes: `secrets-store` (or no
 * value) reads the Secrets Store binding exactly as before, `sts` reads the bundle over the `STS`
 * service binding and never falls back to the Secrets Store.
 */
export type WebhookSecretsSelection = {
  SECRETS_SOURCE?: string;
  STS?: BundleBinding;
};

/** The selection plus the Secrets Store binding that the `secrets-store` source reads for `N`. */
export type WebhookSecretsEnv<N extends WebhookSecretName> = WebhookSecretsSelection &
  Record<N, SecretsStoreSecret | string>;

/** Why a non-legacy source gave no value. Every value is fixed here; none comes from an error. */
export type SecretRefusal =
  | 'invalid_source'
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
 * The selected source, or `undefined` for an unrecognised value. Callers fail closed on
 * `undefined` and read neither source.
 */
export function secretsSource(
  env: Pick<WebhookSecretsSelection, 'SECRETS_SOURCE'>
): WebhookSecretsSource | undefined {
  const parsed = SecretsSourceSchema.safeParse(env.SECRETS_SOURCE ?? 'secrets-store');
  return parsed.success ? parsed.data : undefined;
}

type StsReadResult = { ok: true; value: string } | { ok: false; reason: SecretRefusal };

const INVALID_SOURCE: StsReadResult = { ok: false, reason: 'invalid_source' };

let stsReadLogged = false;

function logStsReadOnce(value: string): void {
  if (stsReadLogged || value === '') return;
  stsReadLogged = true;
  logger.info('Webhook secret source read succeeded', { source: 'sts' });
}

/**
 * Reads one name from the STS bundle and returns it as delivered, empty included, so each caller
 * keeps its own empty-value handling. It never throws and never reads the Secrets Store: a failure
 * returns only a fixed reason, so no error name, message or cause reaches a log or a response. It
 * does not check `SECRETS_SOURCE`; the `sts` source and the source comparison
 * (src/secrets-compare.ts) both read through it.
 */
export async function readStsSecret(
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
 * A sender could not get a secret from a non-legacy source. The message is fixed and safe to store
 * as a request's failure text; `secret` and `reason` hold fixed values only.
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
 * The value a sender uses. The `secrets-store` source returns or throws exactly what it did
 * before. The `sts` source returns the delivered value; a failed read, and an unrecognised
 * `SECRETS_SOURCE`, log a fixed event and throw `SecretSourceUnavailableError`.
 */
export async function readSecret<N extends WebhookSecretName>(
  env: WebhookSecretsEnv<NoInfer<N>>,
  name: N
): Promise<string> {
  const source = secretsSource(env);
  // Widening to the binding record keeps `bindings[name]` typed as the binding.
  const bindings: Record<N, SecretsStoreSecret | string> = env;
  if (source === 'secrets-store') return getSecretValue(bindings[name]);
  const read = source === 'sts' ? await readStsSecret(env, name) : INVALID_SOURCE;
  if (read.ok) {
    logStsReadOnce(read.value);
    return read.value;
  }
  logger.error('Webhook secret unavailable', { secret: name, reason: read.reason });
  throw new SecretSourceUnavailableError(name, read.reason);
}

/**
 * What an inbound credential is checked against. `read` holds the value as `source` returned it.
 * `keyless` means the `sts` source read nothing because the request presents no credential; the
 * verifier refuses it as it refuses any missing credential. `refused` carries a fixed reason.
 */
export type ExpectedSecret =
  | { status: 'read'; source: WebhookSecretsSource; secret: string }
  | { status: 'keyless'; source: 'sts' }
  | { status: 'refused'; reason: SecretRefusal };

/**
 * The expected value for a verifier. The comparison stays at the verifier. The `secrets-store`
 * source reads the binding for every request, a keyless one included, and returns or throws
 * exactly what it did before. The `sts` source reads the bundle only for a request that presents
 * a credential and never falls back.
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
  if (source === undefined) return { status: 'refused', reason: 'invalid_source' };
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
