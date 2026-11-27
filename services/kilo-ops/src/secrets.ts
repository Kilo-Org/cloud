import {
  createWorkerSecrets,
  type BundleBinding,
  type Secrets,
  type SecretsExecutionContext,
} from '@kilocode/secrets-client';

/**
 * Every secret this Worker reads, by its STS bundle name (design 4.7: canonical names, no
 * environment suffix) mapped to the binding it reads today. `O11Y_CF_AE_API_TOKEN` resolves from
 * `/shared` (the analytics token other Workers read too); `GF_SECRET_KEY` lives in
 * `/workloads/kilo-ops`. services/sts/policy/kilo-ops.yaml grants both.
 */
const BINDINGS = {
  O11Y_CF_AE_API_TOKEN: 'CF_ANALYTICS_API_KEY',
  GF_SECRET_KEY: 'GF_SECRET_KEY',
} as const;

export type KiloOpsSecretName = keyof typeof BINDINGS;

type BindingName = (typeof BINDINGS)[KiloOpsSecretName];

/** A Secrets Store binding, or the plain Worker secret, which arrives as its own string. */
type LegacySecretValue = string | { get(): Promise<string> };

/**
 * `SECRETS_SOURCE` selects where every read goes: `secrets-store` reads the binding the
 * deployment holds today, `sts` reads the bundle over the `STS` service binding. An absent value
 * means `secrets-store`, so merging this path changes nothing until secrets-cutover flips the
 * variable. The `sts` source never falls back to the legacy binding: a failed bundle read fails
 * the read.
 */
export type KiloOpsSecretsEnv = Partial<Record<BindingName, LegacySecretValue>> & {
  SECRETS_SOURCE?: string;
  STS?: BundleBinding;
  /** `production` or `development`: only a production deployment gets logged for a missing source. */
  ENVIRONMENT?: string;
};

type SecretsSource = 'secrets-store' | 'sts';

/** Fails closed: an unrecognised value refuses every read instead of guessing a source. */
export function secretsSource(env: Pick<KiloOpsSecretsEnv, 'SECRETS_SOURCE'>): SecretsSource {
  const source = env.SECRETS_SOURCE ?? 'secrets-store';
  if (source !== 'secrets-store' && source !== 'sts') {
    throw new Error('SECRETS_SOURCE must be either "secrets-store" or "sts"');
  }
  return source;
}

/** One client per binding keeps one bundle per isolate across requests. */
const stsClients = new WeakMap<BundleBinding, Secrets>();

/**
 * Whether this deployment has a source for `name` at all: `secrets-store` needs the binding it
 * reads, while `sts` has one by definition and is checked on the read itself. A caller that offers
 * a feature gated on a secret uses this to tell "this deployment runs that feature off" from "a
 * read failed", which are different answers to its caller.
 */
export function secretConfigured(env: KiloOpsSecretsEnv, name: KiloOpsSecretName): boolean {
  if (secretsSource(env) === 'sts') return true;
  return env[BINDINGS[name]] !== undefined;
}

/**
 * Reads one secret from the selected source and returns it as stored, empty included, so every
 * caller keeps its own empty-value handling. `ctx` belongs to the invocation doing the read (the
 * Durable Object request): a bundle revalidation it starts runs under that invocation's
 * `waitUntil`.
 */
export async function readKiloOpsSecret(
  env: KiloOpsSecretsEnv,
  name: KiloOpsSecretName,
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

/** What one read produced, for a caller that has to answer its own HTTP. */
type SecretRead = { state: 'value'; value: string } | { state: 'off' } | { state: 'failed' };

/**
 * One read, classified: `off` when this deployment binds no source for the name, so the feature it
 * feeds is not deployed here; `failed` when a configured source refused the read. Neither returns a
 * value, and a caller tells them apart so an absent feature does not read as a broken one. An `off`
 * in production is logged, because there the absence is a broken deploy rather than a choice.
 */
export async function readSecretState(
  env: KiloOpsSecretsEnv,
  name: KiloOpsSecretName,
  ctx?: SecretsExecutionContext
): Promise<SecretRead> {
  try {
    if (!secretConfigured(env, name)) {
      // A deployment that never binds the source runs the feature off (dev), so it stays quiet. The
      // same absence in production is a broken deploy, not a choice, and has no read to fail: say
      // so, or it answers 503 with nothing in the logs.
      if (env.ENVIRONMENT === 'production') {
        console.error(`[readSecretState] ${name} has no source bound in this deployment`);
      }
      return { state: 'off' };
    }
    return { state: 'value', value: await readKiloOpsSecret(env, name, ctx) };
  } catch (err) {
    console.error(
      '[readSecretState] secret read failed:',
      err instanceof Error ? err.message : err
    );
    return { state: 'failed' };
  }
}
