import {
  createWorkerSecrets,
  SecretUnavailableError,
  type BundleBinding,
  type Secrets,
  type SecretsExecutionContext,
  type SecretUnavailableReason,
} from '@kilocode/secrets-client';

/**
 * Every secret this Worker reads, by its STS bundle name (design 4.7: canonical names, no
 * environment suffix) mapped to the binding it reads today. `NEXTAUTH_SECRET` resolves from
 * `/shared`; services/sts/policy/event-service.yaml grants it.
 */
const BINDINGS = {
  NEXTAUTH_SECRET: 'NEXTAUTH_SECRET',
} as const;

export type EventServiceSecretName = keyof typeof BINDINGS;

type BindingName = (typeof BINDINGS)[EventServiceSecretName];

/** A Secrets Store binding, or the plain Worker secret, which arrives as its own string. */
type LegacySecretValue = string | { get(): Promise<string> };

type LegacyBindings = Partial<Record<BindingName, LegacySecretValue>>;

/**
 * `SECRETS_SOURCE` selects where every read goes: `secrets-store` reads the binding the
 * deployment holds today, `sts` reads the bundle over the `STS` service binding. An absent value
 * means `secrets-store`, so merging this path changes nothing until secrets-cutover flips the
 * variable. The `sts` source never falls back to the legacy binding: a failed bundle read fails
 * the read.
 */
export type EventServiceSecretsEnv = LegacyBindings & {
  SECRETS_SOURCE?: string;
  STS?: BundleBinding;
};

export type SecretsSource = 'secrets-store' | 'sts';

/** The selected source as a fixed log label: an unrecognised value is `invalid`, never its text. */
export type SecretsSourceLabel = SecretsSource | 'invalid';

export function secretsSourceLabel(
  env: Pick<EventServiceSecretsEnv, 'SECRETS_SOURCE'>
): SecretsSourceLabel {
  const source = env.SECRETS_SOURCE ?? 'secrets-store';
  return source === 'secrets-store' || source === 'sts' ? source : 'invalid';
}

/** Fails closed: an unrecognised value refuses every read instead of guessing a source. */
export function secretsSource(env: Pick<EventServiceSecretsEnv, 'SECRETS_SOURCE'>): SecretsSource {
  const source = secretsSourceLabel(env);
  if (source === 'invalid') {
    throw new Error('SECRETS_SOURCE must be either "secrets-store" or "sts"');
  }
  return source;
}

/** One client per binding keeps one bundle per isolate across requests. */
const stsClients = new WeakMap<BundleBinding, Secrets>();

/**
 * The fixed event the first non-empty value the `sts` source serves in an isolate logs, once. Only
 * `readEventServiceSecret` logs it; the source comparison's own bundle reads never do.
 */
export const STS_SOURCE_READ_EVENT = 'event_service_secret_source_read';

let stsReadLogged = false;

function logStsReadOnce(value: string): void {
  if (stsReadLogged || value === '') return;
  stsReadLogged = true;
  console.log(STS_SOURCE_READ_EVENT, { source: 'sts' });
}

/** Test-only: re-arm the once-per-isolate marker. */
export function resetStsReadMarkerForTest(): void {
  stsReadLogged = false;
}

/**
 * Reads one secret from the selected source and returns it as stored, empty included, so every
 * caller keeps its own empty-value handling. `ctx` belongs to the invocation doing the read (the
 * Worker request): a bundle revalidation it starts runs under that invocation's `waitUntil`.
 */
export async function readEventServiceSecret(
  env: EventServiceSecretsEnv,
  name: EventServiceSecretName,
  ctx?: SecretsExecutionContext
): Promise<string> {
  if (secretsSource(env) === 'sts') {
    const binding = env.STS;
    if (binding === undefined) {
      throw new Error('SECRETS_SOURCE is "sts" but the STS service binding is missing');
    }
    const value = await readBundleSecret(binding, name, ctx);
    logStsReadOnce(value);
    return value;
  }
  return readLegacySecret(env, name);
}

/**
 * Reads one secret from the STS bundle over `binding`, whatever `SECRETS_SOURCE` selects, through
 * the isolate's one client for that binding.
 */
export async function readBundleSecret(
  binding: BundleBinding,
  name: EventServiceSecretName,
  ctx?: SecretsExecutionContext
): Promise<string> {
  let client = stsClients.get(binding);
  if (client === undefined) {
    client = createWorkerSecrets(binding);
    stsClients.set(binding, client);
  }
  return client.get(name, ctx);
}

/** Reads one secret from its legacy binding, whatever `SECRETS_SOURCE` selects. */
export async function readLegacySecret(
  env: LegacyBindings,
  name: EventServiceSecretName
): Promise<string> {
  const bindingName = BINDINGS[name];
  const value = env[bindingName];
  if (value === undefined) {
    throw new Error(`${bindingName} is not configured`);
  }
  return typeof value === 'string' ? value : value.get();
}

/** The inbound credential checks, as fixed log labels. */
export type GuardRoute = 'connect_ticket';

/** Why a check had no expected value. Every value is fixed here; none comes from an error. */
export type SecretRefusal =
  | 'invalid_source'
  | 'binding_missing'
  | SecretUnavailableReason
  | 'empty'
  | 'read_failed';

const CLIENT_REASONS: Record<SecretUnavailableReason, SecretRefusal> = {
  missing: 'missing',
  not_granted: 'not_granted',
  denied: 'denied',
  unavailable: 'unavailable',
};

/** The fixed reason a `readEventServiceSecret` call for `name` under `env` failed with `error`. */
export function secretRefusal(
  env: EventServiceSecretsEnv,
  name: EventServiceSecretName,
  error: unknown
): SecretRefusal {
  const source = secretsSourceLabel(env);
  if (source === 'invalid') return 'invalid_source';
  const binding = source === 'sts' ? env.STS : env[BINDINGS[name]];
  if (binding === undefined) return 'binding_missing';
  return error instanceof SecretUnavailableError && Object.hasOwn(CLIENT_REASONS, error.reason)
    ? CLIENT_REASONS[error.reason]
    : 'read_failed';
}

type GuardLabels = {
  route: GuardRoute;
  secret: EventServiceSecretName;
  source: SecretsSourceLabel;
};

export const SECRET_UNAVAILABLE_EVENT = 'event_service_secret_unavailable';

/**
 * A check had no expected value to verify against. Fixed fields only: never the value, the
 * presented credential, a user id or request text; the answer is unchanged.
 */
export function logSecretUnavailable(labels: GuardLabels & { reason: SecretRefusal }): void {
  console.error(SECRET_UNAVAILABLE_EVENT, labels);
}
