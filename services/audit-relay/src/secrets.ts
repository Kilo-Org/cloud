import {
  createWorkerSecrets,
  SecretUnavailableError,
  type BundleBinding,
  type SecretsExecutionContext,
} from '@kilocode/secrets-client';
import { z } from 'zod';

/**
 * One client per isolate, keyed by the STS binding. The client holds the bundle and its ETag, so
 * every later batch, Durable Object request and scheduled run in the isolate revalidates with
 * `If-None-Match` instead of refetching the bundle.
 */
const clients = new WeakMap<BundleBinding, SecretReader>();

/**
 * A local run has no STS to call: `sts-local` would need a manager identity and Infisical access,
 * so `wrangler dev --env local` and the Workers-pool tests read the two names from
 * AUDIT_RELAY_LOCAL_SECRETS instead. The gate is the environment, never a deployed one.
 */
let localReader: { raw: string; reader: SecretReader } | undefined;

/** The part of the client the relay uses; `Secrets` from `@kilocode/secrets-client` fits it. */
export type SecretReader = {
  get(name: string, ctx?: SecretsExecutionContext): Promise<string>;
};

/** The STS service binding and the local-run override. */
export type SecretsEnv = {
  AUDIT_ENVIRONMENT: string;
  AUDIT_RELAY_LOCAL_SECRETS?: string;
  STS: BundleBinding;
};

export type SecretsOptions = { clock?: () => number };

export function secretsFor(env: SecretsEnv, options: SecretsOptions = {}): SecretReader {
  if (env.AUDIT_ENVIRONMENT === 'local' && env.AUDIT_RELAY_LOCAL_SECRETS) {
    return localSecrets(env.AUDIT_RELAY_LOCAL_SECRETS);
  }
  const held = clients.get(env.STS);
  if (held !== undefined) return held;
  const client = createWorkerSecrets(env.STS, options);
  clients.set(env.STS, client);
  return client;
}

const LocalSecretsSchema = z.record(z.string(), z.string());

function localSecrets(raw: string): SecretReader {
  if (localReader?.raw === raw) return localReader.reader;
  const values = LocalSecretsSchema.parse(JSON.parse(raw) as unknown);
  const reader: SecretReader = {
    async get(name) {
      const found = values[name];
      if (found === undefined) {
        throw new SecretUnavailableError('missing', { secretName: name });
      }
      return found;
    },
  };
  localReader = { raw, reader };
  return reader;
}
