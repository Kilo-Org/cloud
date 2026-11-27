import {
  createWorkerSecrets,
  type BundleBinding,
  type Secrets,
  type SecretsExecutionContext,
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

/** One client per binding keeps one bundle per isolate across requests. */
const stsClients = new WeakMap<BundleBinding, Secrets>();

/** Fails closed: an unrecognised value refuses every read instead of guessing a source. */
export function secretsSource(
  env: Pick<NotificationsSecretsEnv, 'SECRETS_SOURCE'>
): z.infer<typeof SecretsSourceSchema> {
  const parsed = SecretsSourceSchema.safeParse(env.SECRETS_SOURCE ?? 'secrets-store');
  if (!parsed.success) {
    throw new Error('SECRETS_SOURCE must be either "secrets-store" or "sts"');
  }
  return parsed.data;
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
    let client = stsClients.get(binding);
    if (client === undefined) {
      client = createWorkerSecrets(binding);
      stsClients.set(binding, client);
    }
    return client.get(name, ctx);
  }
  const bindingName = SECRETS_STORE_BINDINGS[name];
  const binding = env[bindingName];
  if (binding === undefined) {
    throw new Error(`${bindingName} Secrets Store binding is missing`);
  }
  return binding.get();
}
