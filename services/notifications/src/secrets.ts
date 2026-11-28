import {
  createWorkerSecrets,
  SecretUnavailableError,
  type BundleBinding,
  type Secrets,
  type SecretsExecutionContext,
  type SecretUnavailableReason,
} from '@kilocode/secrets-client';
import { z } from 'zod';

/**
 * Every secret Notifications reads, by its manager and STS bundle name (design 4.7), mapped to the
 * Secrets Store binding the `secrets-store` source reads instead. STS resolves the two
 * `NOTIFICATIONS_` names from `/workloads/notifications` and the two shared names from `/shared`.
 */
const SECRETS_STORE_BINDINGS = {
  NOTIFICATIONS_APNS_PRIVATE_KEY: 'APNS_PRIVATE_KEY',
  NOTIFICATIONS_EXPO_ACCESS_TOKEN: 'EXPO_ACCESS_TOKEN',
  NEXTAUTH_SECRET: 'NEXTAUTH_SECRET',
  INTERNAL_API_SECRET: 'INTERNAL_API_SECRET',
} as const;

export type NotificationsSecretName = keyof typeof SECRETS_STORE_BINDINGS;

type SecretsStoreBindingName = (typeof SECRETS_STORE_BINDINGS)[NotificationsSecretName];

type SecretsStoreBindings = Partial<Record<SecretsStoreBindingName, SecretsStoreSecret>>;

/**
 * `SECRETS_SOURCE` selects where every read goes: `secrets-store` reads the Secrets Store bindings,
 * `sts` reads the bundle over the `STS` service binding. An absent variable means `secrets-store`.
 * The `sts` source never falls back to the Secrets Store: a failed bundle read fails the read.
 */
export type NotificationsSecretsEnv = SecretsStoreBindings & {
  SECRETS_SOURCE?: string;
  STS?: BundleBinding;
};

const SecretsSourceSchema = z.enum(['secrets-store', 'sts']);

export type NotificationsSecretsSource = z.infer<typeof SecretsSourceSchema>;

/** The selected source as a fixed log label: an unrecognised value is `invalid`, never its text. */
export type SecretsSourceLabel = NotificationsSecretsSource | 'invalid';

/** One client per binding keeps one bundle per isolate across requests. */
const stsClients = new WeakMap<BundleBinding, Secrets>();

export function secretsSourceLabel(
  env: Pick<NotificationsSecretsEnv, 'SECRETS_SOURCE'>
): SecretsSourceLabel {
  const parsed = SecretsSourceSchema.safeParse(env.SECRETS_SOURCE ?? 'secrets-store');
  return parsed.success ? parsed.data : 'invalid';
}

/** Fails closed: an unrecognised value refuses every read instead of guessing a source. */
export function secretsSource(
  env: Pick<NotificationsSecretsEnv, 'SECRETS_SOURCE'>
): NotificationsSecretsSource {
  const source = secretsSourceLabel(env);
  if (source === 'invalid') {
    throw new Error('SECRETS_SOURCE must be either "secrets-store" or "sts"');
  }
  return source;
}

/**
 * The fixed event the first non-empty value the `sts` source serves in an isolate logs, once. Only
 * `readNotificationsSecret` logs it; the source comparison's own bundle reads never do.
 */
export const STS_SOURCE_READ_EVENT = 'notifications_secret_source_read';

let stsReadLogged = false;

function logStsReadOnce(value: string): void {
  if (stsReadLogged || value === '') return;
  stsReadLogged = true;
  console.log(STS_SOURCE_READ_EVENT, { source: 'sts' });
}

/**
 * Reads one secret from the selected source and returns it as stored, empty included, so every
 * caller keeps its own empty-value handling. `ctx` belongs to the invocation doing the read (the
 * Worker request, queue batch, or Durable Object): a bundle revalidation it starts runs under that
 * invocation's `waitUntil`.
 */
export async function readNotificationsSecret(
  env: NotificationsSecretsEnv,
  name: NotificationsSecretName,
  ctx: SecretsExecutionContext
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
  return readSecretsStoreSecret(env, name);
}

/**
 * Reads one secret from the STS bundle over `binding`, whatever `SECRETS_SOURCE` selects, through
 * the isolate's one client for that binding.
 */
export async function readBundleSecret(
  binding: BundleBinding,
  name: NotificationsSecretName,
  ctx: SecretsExecutionContext
): Promise<string> {
  let client = stsClients.get(binding);
  if (client === undefined) {
    client = createWorkerSecrets(binding);
    stsClients.set(binding, client);
  }
  return client.get(name, ctx);
}

/** Reads one secret from its Secrets Store binding, whatever `SECRETS_SOURCE` selects. */
export async function readSecretsStoreSecret(
  env: SecretsStoreBindings,
  name: NotificationsSecretName
): Promise<string> {
  const bindingName = SECRETS_STORE_BINDINGS[name];
  const binding = env[bindingName];
  if (binding === undefined) {
    throw new Error(`${bindingName} Secrets Store binding is missing`);
  }
  return binding.get();
}

/** The inbound credential checks, as fixed log labels. `v1_other` is any other `/v1/*` path. */
export type GuardRoute =
  | 'badges'
  | 'badges_mark_read'
  | 'v1_other'
  | 'dispatch'
  | 'glanceable_refresh';

/** Why a guard had no expected value. Every value is fixed here; none comes from an error. */
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

/** The fixed reason a `readNotificationsSecret` call for `name` under `env` failed with `error`. */
export function secretRefusal(
  env: NotificationsSecretsEnv,
  name: NotificationsSecretName,
  error: unknown
): SecretRefusal {
  const source = secretsSourceLabel(env);
  if (source === 'invalid') return 'invalid_source';
  const binding = source === 'sts' ? env.STS : env[SECRETS_STORE_BINDINGS[name]];
  if (binding === undefined) return 'binding_missing';
  return error instanceof SecretUnavailableError && Object.hasOwn(CLIENT_REASONS, error.reason)
    ? CLIENT_REASONS[error.reason]
    : 'read_failed';
}

type GuardLabels = {
  route: GuardRoute;
  secret: NotificationsSecretName;
  source: SecretsSourceLabel;
};

/**
 * A guard refused a request because the credential was absent (`missing`), did not verify
 * (`invalid`), or the verifier failed (`verify_failed`). Fixed fields only: never the credential,
 * the expected value, a caller id or request text.
 */
export function logCredentialRefused(
  labels: GuardLabels & { reason: 'missing' | 'invalid' | 'verify_failed' }
): void {
  console.warn('notifications_credential_refused', labels);
}

/** A guard had no expected value to check against. Fixed fields only; the answer is unchanged. */
export function logSecretUnavailable(labels: GuardLabels & { reason: SecretRefusal }): void {
  console.error('notifications_secret_unavailable', labels);
}
