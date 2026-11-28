import {
  createWorkerSecrets,
  type BundleBinding,
  type Secrets,
  type SecretsExecutionContext,
} from '@kilocode/secrets-client';

/**
 * Every secret o11y reads. Each name matches its STS bundle key and its Secrets Store secret name,
 * so a revert needs no rename (design 4.7: canonical names, no environment suffix).
 */
export type O11ySecretName =
  | 'O11Y_KILO_GATEWAY_CLIENT_SECRET'
  | 'O11Y_CF_AE_API_TOKEN'
  | 'O11Y_SLACK_WEBHOOK_PAGE'
  | 'O11Y_SLACK_WEBHOOK_TICKET'
  | 'O11Y_CF_CONTAINERS_API_TOKEN';

/**
 * Every read goes through the STS bundle over the service binding: production binds `sts`, and
 * `wrangler dev --env local` binds `sts-local`, so a local run reads the local broker and never the
 * production one. The Secrets Store bindings stay bound and unread until the cutover removes them;
 * rollback is a revert of the STS-only change.
 */
export type O11ySecretsEnv = {
  STS: BundleBinding;
};

/** One client per binding keeps one bundle per isolate across requests. */
const stsClients = new WeakMap<BundleBinding, Secrets>();

/** The source holds no value, or an empty one, for a secret o11y reads. */
export class SecretNotConfiguredError extends Error {
  constructor(name: O11ySecretName) {
    super(`${name} secret is not configured`);
    this.name = 'SecretNotConfiguredError';
  }
}

/** Resolves a non-empty value; an empty bundle value throws `SecretNotConfiguredError`. */
export async function readO11ySecret(
  env: O11ySecretsEnv,
  name: O11ySecretName,
  ctx?: SecretsExecutionContext
): Promise<string> {
  let client = stsClients.get(env.STS);
  if (client === undefined) {
    client = createWorkerSecrets(env.STS);
    stsClients.set(env.STS, client);
  }
  const value = await client.get(name, ctx);
  if (!value) throw new SecretNotConfiguredError(name);
  return value;
}
