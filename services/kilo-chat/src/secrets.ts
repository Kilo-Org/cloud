import {
  createWorkerSecrets,
  type BundleBinding,
  type Secrets,
  type SecretsExecutionContext,
} from '@kilocode/secrets-client';

/**
 * Every secret this Worker reads, by its STS bundle name (design 4.7: canonical names, no
 * environment suffix) mapped to the binding it reads today. `NEXTAUTH_SECRET` and
 * `INTERNAL_API_SECRET` resolve from `/shared`; the R2 media credentials keep their binding names
 * and resolve from `/workloads/kilo-chat`. services/sts/policy/kilo-chat.yaml grants them all.
 */
const BINDINGS = {
  NEXTAUTH_SECRET: 'NEXTAUTH_SECRET',
  GATEWAY_TOKEN_SECRET: 'GATEWAY_TOKEN_SECRET',
  R2_ACCESS_KEY_ID: 'R2_ACCESS_KEY_ID',
  R2_SECRET_ACCESS_KEY: 'R2_SECRET_ACCESS_KEY',
  INTERNAL_API_SECRET: 'INTERNAL_API_SECRET',
} as const;

export type KiloChatSecretName = keyof typeof BINDINGS;

type BindingName = (typeof BINDINGS)[KiloChatSecretName];

/** A Secrets Store binding, or the plain Worker secret, which arrives as its own string. */
type LegacySecretValue = string | { get(): Promise<string> };

/**
 * `SECRETS_SOURCE` selects where every read goes: `env` reads the binding the deployment holds
 * today, `sts` reads the bundle over the `STS` service binding. An absent value means `env`, so
 * merging this path changes nothing until secrets-cutover flips the variable. The `sts` source
 * never falls back to the legacy binding: a failed bundle read fails the read.
 */
export type KiloChatSecretsEnv = Partial<Record<BindingName, LegacySecretValue>> & {
  SECRETS_SOURCE?: string;
  STS?: BundleBinding;
};

export type SecretsSource = 'env' | 'sts';

/** Fails closed: an unrecognised value refuses every read instead of guessing a source. */
export function secretsSource(env: Pick<KiloChatSecretsEnv, 'SECRETS_SOURCE'>): SecretsSource {
  const source = env.SECRETS_SOURCE ?? 'env';
  if (source !== 'env' && source !== 'sts') {
    throw new Error('SECRETS_SOURCE must be either "env" or "sts"');
  }
  return source;
}

/** One client per binding keeps one bundle per isolate across requests. */
const stsClients = new WeakMap<BundleBinding, Secrets>();

/**
 * Reads one secret from the selected source and returns it as stored, empty included, so every
 * caller keeps its own empty-value handling. `ctx` belongs to the invocation doing the read (the
 * Worker request or Durable Object): a bundle revalidation it starts runs under that invocation's
 * `waitUntil`.
 */
export async function readKiloChatSecret(
  env: KiloChatSecretsEnv,
  name: KiloChatSecretName,
  ctx?: SecretsExecutionContext
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
  const bindingName = BINDINGS[name];
  const value = env[bindingName];
  if (value === undefined) {
    throw new Error(`${bindingName} is not configured`);
  }
  return typeof value === 'string' ? value : value.get();
}
