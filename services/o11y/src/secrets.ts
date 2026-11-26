import {
  createWorkerSecrets,
  type BundleBinding,
  type Secrets,
  type SecretsExecutionContext,
} from '@kilocode/secrets-client';
import { z } from 'zod';

/**
 * Every secret o11y reads. Each name matches its Secrets Store secret name and its STS bundle
 * key, so switching sources needs no rename (design 4.7: canonical names, no environment suffix).
 */
export type O11ySecretName =
  | 'O11Y_KILO_GATEWAY_CLIENT_SECRET'
  | 'O11Y_CF_AE_API_TOKEN'
  | 'O11Y_SLACK_WEBHOOK_PAGE'
  | 'O11Y_SLACK_WEBHOOK_TICKET'
  | 'O11Y_CF_CONTAINERS_API_TOKEN';

/**
 * `SECRETS_SOURCE` selects where every read goes: `secrets-store` reads the Secrets Store
 * bindings, `sts` reads the same names from the STS bundle. Production reads `sts`. Rollback is a
 * redeploy with the variable set back to `secrets-store`; both sources stay bound until the
 * cutover completes. An absent variable means `secrets-store`.
 */
export type O11ySecretsEnv = Partial<Record<O11ySecretName, SecretsStoreSecret>> & {
  SECRETS_SOURCE?: string;
  STS?: BundleBinding;
};

const SecretsSourceSchema = z.enum(['secrets-store', 'sts']);

/** One client per binding keeps one bundle per isolate across requests. */
const stsClients = new WeakMap<BundleBinding, Secrets>();

/** Fails closed: an unrecognised value refuses every read instead of guessing a source. */
export function secretsSource(
  env: Pick<O11ySecretsEnv, 'SECRETS_SOURCE'>
): z.infer<typeof SecretsSourceSchema> {
  const parsed = SecretsSourceSchema.safeParse(env.SECRETS_SOURCE ?? 'secrets-store');
  if (!parsed.success) {
    throw new Error('SECRETS_SOURCE must be either "secrets-store" or "sts"');
  }
  return parsed.data;
}

/** The source holds no value, or an empty one, for a secret o11y reads. */
export class SecretNotConfiguredError extends Error {
  constructor(name: O11ySecretName) {
    super(`${name} secret is not configured`);
    this.name = 'SecretNotConfiguredError';
  }
}

/** Resolves a non-empty value; an empty value throws `SecretNotConfiguredError` on either source. */
export async function readO11ySecret(
  env: O11ySecretsEnv,
  name: O11ySecretName,
  ctx?: SecretsExecutionContext
): Promise<string> {
  let value: string | null | undefined;
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
    value = await client.get(name, ctx);
  } else {
    value = await env[name]?.get();
  }
  if (!value) throw new SecretNotConfiguredError(name);
  return value;
}
