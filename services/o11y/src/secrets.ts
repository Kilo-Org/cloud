import {
  createWorkerSecrets,
  type Secrets,
  type SecretsExecutionContext,
} from '@kilocode/secrets-client';
import type { BundleRequest, BundleResult } from '@kilocode/sts-contracts';
import { z } from 'zod';

/**
 * Every secret o11y reads. Each name matches its Secrets Store secret name and its STS bundle
 * key, so switching sources needs no rename (design 4.7: canonical names, no environment suffix).
 */
export const O11Y_SECRET_NAMES = [
  'O11Y_KILO_GATEWAY_CLIENT_SECRET',
  'O11Y_CF_AE_API_TOKEN',
  'O11Y_SLACK_WEBHOOK_PAGE',
  'O11Y_SLACK_WEBHOOK_TICKET',
  'O11Y_CF_CONTAINERS_API_TOKEN',
] as const;

export type O11ySecretName = (typeof O11Y_SECRET_NAMES)[number];

export type O11ySecretsEnv = Partial<Record<O11ySecretName, SecretsStoreSecret>> & {
  /** `secrets-store` keeps today's bindings; `sts` reads the same names from the STS bundle. */
  SECRETS_SOURCE?: string;
  /** The STS binding. Wrangler types a cross-worker entrypoint binding as an untyped `Service`. */
  STS?: unknown;
};

const SecretsSourceSchema = z.enum(['secrets-store', 'sts']);

export type SecretsSource = z.infer<typeof SecretsSourceSchema>;

type BundleBinding = {
  getBundle(request: BundleRequest): Promise<BundleResult>;
};

const stsClients = new WeakMap<object, Secrets>();

function isBundleBinding(value: unknown): value is BundleBinding {
  return (
    typeof value === 'object' &&
    value !== null &&
    'getBundle' in value &&
    typeof value.getBundle === 'function'
  );
}

/** Fails closed: an unrecognised value refuses every read instead of guessing a source. */
export function secretsSource(env: Pick<O11ySecretsEnv, 'SECRETS_SOURCE'>): SecretsSource {
  const parsed = SecretsSourceSchema.safeParse(env.SECRETS_SOURCE ?? 'secrets-store');
  if (!parsed.success) {
    throw new Error('SECRETS_SOURCE must be either "secrets-store" or "sts"');
  }
  return parsed.data;
}

function stsSecrets(env: O11ySecretsEnv, binding: BundleBinding): Secrets {
  const cached = stsClients.get(env);
  if (cached) return cached;
  const client = createWorkerSecrets(binding);
  stsClients.set(env, client);
  return client;
}

export async function readO11ySecret(
  env: O11ySecretsEnv,
  name: O11ySecretName,
  ctx?: SecretsExecutionContext
): Promise<string> {
  if (secretsSource(env) === 'sts') {
    const binding = env.STS;
    if (!isBundleBinding(binding)) {
      throw new Error('SECRETS_SOURCE is "sts" but the STS service binding is missing');
    }
    return stsSecrets(env, binding).get(name, ctx);
  }

  const value = await env[name]?.get();
  if (!value) throw new Error(`${name} secret is not configured`);
  return value;
}
