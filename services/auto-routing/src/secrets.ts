import type { WebInternalAuthEnv } from '@kilocode/worker-utils/web-internal-credential';

/** The same `STS` handle as the web service-token client declares it. */
type ServiceTokenBinding = NonNullable<WebInternalAuthEnv['STS']>;
import {
  createWorkerSecrets,
  type BundleBinding,
  type Secrets,
  type SecretsExecutionContext,
} from '@kilocode/secrets-client';

/**
 * Every secret this Worker reads, by its STS bundle name (design 4.7: canonical names, no
 * environment suffix) mapped to the binding it reads today. `INTERNAL_API_SECRET`,
 * `NEXTAUTH_SECRET`, `OPENROUTER_API_KEY` and `O11Y_CF_AE_API_TOKEN` resolve from `/shared`;
 * `AUTO_ROUTING_DECISION_SECRET` from `/workloads/auto-routing`. services/sts/policy/
 * auto-routing.yaml grants all five.
 */
const BINDINGS = {
  INTERNAL_API_SECRET: 'INTERNAL_API_SECRET_PROD',
  OPENROUTER_API_KEY: 'OPENROUTER_API_KEY',
  O11Y_CF_AE_API_TOKEN: 'O11Y_CF_AE_API_TOKEN',
  NEXTAUTH_SECRET: 'NEXTAUTH_SECRET',
  AUTO_ROUTING_DECISION_SECRET: 'AUTO_ROUTING_DECISION_SECRET',
} as const;

export type AutoRoutingSecretName = keyof typeof BINDINGS;

type BindingName = (typeof BINDINGS)[AutoRoutingSecretName];

/** A Secrets Store binding, or the plain Worker secret, which arrives as its own string. */
type LegacySecretValue = string | { get(): Promise<string> };

/**
 * `SECRETS_SOURCE` selects where every read goes: `secrets-store` reads the binding the
 * deployment holds today, `sts` reads the bundle over the `STS` service binding. An absent value
 * means `secrets-store`, so merging this path changes nothing until secrets-cutover flips the
 * variable. The `sts` source never falls back to the legacy binding: a failed bundle read fails
 * the read.
 */
export type AutoRoutingSecretsEnv = Partial<Record<BindingName, LegacySecretValue>> & {
  SECRETS_SOURCE?: string;
  /**
   * The one `STS` binding: `service: "sts"`, entrypoint `SecretsBroker`. A Worker that also mints
   * web service tokens types the same handle with that client's RPC surface, so the reader accepts
   * either shape and narrows to the bundle it reads; both name the same runtime binding.
   */
  STS?: BundleBinding | ServiceTokenBinding;
};

export type SecretsSource = 'secrets-store' | 'sts';

/** Fails closed: an unrecognised value refuses every read instead of guessing a source. */
export function secretsSource(env: Pick<AutoRoutingSecretsEnv, 'SECRETS_SOURCE'>): SecretsSource {
  const source = env.SECRETS_SOURCE ?? 'secrets-store';
  if (source !== 'secrets-store' && source !== 'sts') {
    throw new Error('SECRETS_SOURCE must be either "secrets-store" or "sts"');
  }
  return source;
}

/** One client per binding keeps one bundle per isolate across requests. */
const stsClients = new WeakMap<BundleBinding, Secrets>();

/**
 * Hono's `executionCtx` getter throws outside a request context, which is how unit tests call the
 * routes. A missing context only costs the `waitUntil` keep-alive for a bundle revalidation; it
 * never changes which secret a read returns.
 */
export function requestContext(c: {
  executionCtx: SecretsExecutionContext;
}): SecretsExecutionContext | undefined {
  try {
    return c.executionCtx;
  } catch {
    return undefined;
  }
}

/**
 * Reads one secret from the selected source and returns it as stored, empty included, so every
 * caller keeps its own empty-value handling. `ctx` belongs to the invocation doing the read (the
 * Worker request or the usage-writer Durable Object): a bundle revalidation it starts runs under
 * that invocation's `waitUntil`.
 */
export async function readAutoRoutingSecret(
  env: AutoRoutingSecretsEnv,
  name: AutoRoutingSecretName,
  ctx?: SecretsExecutionContext
): Promise<string> {
  if (secretsSource(env) === 'sts') {
    const binding = env.STS as BundleBinding | undefined;
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
