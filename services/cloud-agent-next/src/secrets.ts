import {
  createWorkerSecrets,
  type BundleBinding,
  type Secrets,
  type SecretsExecutionContext,
} from '@kilocode/secrets-client';

/**
 * Every secret this Worker reads, by its STS bundle name (design 4.7: canonical names, no
 * environment suffix) mapped to the binding it reads today. `INTERNAL_API_SECRET` and
 * `NEXTAUTH_SECRET` resolve from `/shared`; services/sts/policy/cloud-agent-next.yaml grants
 * them. The rest live in `/workloads/cloud-agent-next`.
 *
 * `INTERNAL_API_SECRET` has two storage forms in the deployed Worker: inbound
 * `x-internal-api-key` checks read the plain Worker secret of that name, and outbound requests
 * present the Secrets Store copy `INTERNAL_API_SECRET_PROD`. Each family keeps reading its own
 * legacy binding under the `secrets-store` source, so the default deployment is byte-exact; only
 * the `sts` source unifies both on the one bundle value. `readCloudAgentNextStoreSecret` serves the
 * second family.
 *
 * `CLOUD_AGENT_SENTRY_DSN` stays outside this module: it is a client-side public key whose
 * consumers are synchronous (the Sentry SDK's `withSentry` /
 * `instrumentDurableObjectWithSentry` options callbacks, and the egress envelope hostname check),
 * and a Durable Object is instrumented in a synchronous constructor trap, so no read of it can
 * await a broker.
 *
 * The deployment still holds `GITHUB_APP_PRIVATE_KEY`, `GITHUB_LITE_APP_PRIVATE_KEY`, `SSEC_KEY`
 * and `R2_SECRET_ACCESS_KEY` as plain Worker secrets that nothing in this package reads (not the
 * Worker, not the runtime scripts, not the wrapper). They are left out on purpose: an STS policy
 * grants only what a workload reads, and the four should be deleted from the deployment rather
 * than copied into Infisical.
 */
const BINDINGS = {
  INTERNAL_API_SECRET: 'INTERNAL_API_SECRET',
  NEXTAUTH_SECRET: 'NEXTAUTH_SECRET',
  AGENT_ENV_VARS_PRIVATE_KEY: 'AGENT_ENV_VARS_PRIVATE_KEY',
  R2_ATTACHMENTS_READONLY_SECRET_ACCESS_KEY: 'R2_ATTACHMENTS_READONLY_SECRET_ACCESS_KEY',
} as const;

/** The Secrets Store copies of canonical names whose legacy value is a store binding. */
const STORE_BINDINGS = {
  INTERNAL_API_SECRET: 'INTERNAL_API_SECRET_PROD',
} as const;

export type CloudAgentNextSecretName = keyof typeof BINDINGS;

export type CloudAgentNextStoreSecretName = keyof typeof STORE_BINDINGS;

type BindingName =
  | (typeof BINDINGS)[CloudAgentNextSecretName]
  | (typeof STORE_BINDINGS)[CloudAgentNextStoreSecretName];

/** A Secrets Store binding, or the plain Worker secret, which arrives as its own string. */
type LegacySecretValue = string | { get(): Promise<string> };

/**
 * `SECRETS_SOURCE` selects where every read goes: `secrets-store` reads the binding the
 * deployment holds today, `sts` reads the bundle over the `STS` service binding. An absent value
 * means `secrets-store`, so merging this path changes nothing until secrets-cutover flips the
 * variable. The `sts` source never falls back to the legacy binding: a failed bundle read fails
 * the read.
 */
export type CloudAgentNextSecretsEnv = Partial<Record<BindingName, LegacySecretValue>> & {
  SECRETS_SOURCE?: string;
  STS?: BundleBinding;
};

export type SecretsSource = 'secrets-store' | 'sts';

/** Fails closed: an unrecognised value refuses every read instead of guessing a source. */
export function secretsSource(
  env: Pick<CloudAgentNextSecretsEnv, 'SECRETS_SOURCE'>
): SecretsSource {
  const source = env.SECRETS_SOURCE ?? 'secrets-store';
  if (source !== 'secrets-store' && source !== 'sts') {
    throw new Error('SECRETS_SOURCE must be either "secrets-store" or "sts"');
  }
  return source;
}

/** One client per binding keeps one bundle per isolate across requests. */
const stsClients = new WeakMap<BundleBinding, Secrets>();

/**
 * Reads one canonical name from the bundle. `ctx` belongs to the invocation doing the read (the
 * Worker request, queue batch or Durable Object): a bundle revalidation it starts runs under that
 * invocation's `waitUntil`.
 */
async function readBundleSecret(
  env: Pick<CloudAgentNextSecretsEnv, 'SECRETS_SOURCE' | 'STS'>,
  name: CloudAgentNextSecretName,
  ctx?: SecretsExecutionContext
): Promise<string> {
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

/**
 * Reads one secret from the selected source and returns it as stored, empty included, so every
 * caller keeps its own empty-value handling.
 */
export async function readCloudAgentNextSecret(
  env: CloudAgentNextSecretsEnv,
  name: CloudAgentNextSecretName,
  ctx?: SecretsExecutionContext
): Promise<string> {
  if (secretsSource(env) === 'sts') return readBundleSecret(env, name, ctx);
  const bindingName = BINDINGS[name];
  const value = env[bindingName];
  if (value === undefined) {
    throw new Error(`${bindingName} is not configured`);
  }
  return typeof value === 'string' ? value : value.get();
}

/**
 * Reads the Secrets Store copy of a canonical name, the binding the outbound family reads today.
 * Under `sts` both families read the same bundle key, so one `/shared/INTERNAL_API_SECRET` value
 * serves inbound and outbound after the flip.
 */
export async function readCloudAgentNextStoreSecret(
  env: CloudAgentNextSecretsEnv,
  name: CloudAgentNextStoreSecretName,
  ctx?: SecretsExecutionContext
): Promise<string> {
  if (secretsSource(env) === 'sts') return readBundleSecret(env, name, ctx);
  const bindingName = STORE_BINDINGS[name];
  const value = env[bindingName];
  if (value === undefined) {
    throw new Error(`${bindingName} is not configured`);
  }
  return typeof value === 'string' ? value : value.get();
}
