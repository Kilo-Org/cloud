import {
  createWorkerSecrets,
  type BundleBinding,
  type Secrets,
  type SecretsExecutionContext,
} from '@kilocode/secrets-client';

/**
 * Every secret this Worker reads, by its STS bundle name (design 4.7: canonical names, no
 * environment suffix) mapped to the binding it reads today. `NEXTAUTH_SECRET` resolves from
 * `/shared`; services/sts/policy/kilo-ai-attribution.yaml grants both names.
 */
const BINDINGS = {
  NEXTAUTH_SECRET: 'NEXTAUTH_SECRET',
  ADMIN_SECRET: 'ADMIN_SECRET',
} as const;

export type AiAttributionSecretName = keyof typeof BINDINGS;

type BindingName = (typeof BINDINGS)[AiAttributionSecretName];

/** A Secrets Store binding, or the plain Worker secret, which arrives as its own string. */
type LegacySecretValue = string | { get(): Promise<string> };

/**
 * `SECRETS_SOURCE` selects where every read goes: `env` reads the binding the deployment holds
 * today, `sts` reads the bundle over the `STS` service binding. An absent value means `env`, so
 * merging this path changes nothing until secrets-cutover flips the variable. The `sts` source
 * never falls back to the legacy binding: a failed bundle read fails the read.
 */
export type AiAttributionSecretsEnv = Partial<Record<BindingName, LegacySecretValue>> & {
  SECRETS_SOURCE?: string;
  STS?: BundleBinding;
};

export type SecretsSource = 'env' | 'sts';

/** Fails closed: an unrecognised value refuses every read instead of guessing a source. */
export function secretsSource(env: Pick<AiAttributionSecretsEnv, 'SECRETS_SOURCE'>): SecretsSource {
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
 * Worker request): a bundle revalidation it starts runs under that invocation's `waitUntil`.
 */
export async function readAiAttributionSecret(
  env: AiAttributionSecretsEnv,
  name: AiAttributionSecretName,
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
