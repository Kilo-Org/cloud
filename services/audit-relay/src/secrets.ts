import type { BundleRequest, BundleResult } from '@kilocode/sts-contracts';
import { z } from 'zod';

/**
 * The Worker's only way to read a secret. Deployed Workers answer through the STS service
 * binding, which hands back the bundle for the `props.caller` this Worker deployed with; a local
 * dev or test run answers from AUDIT_RELAY_LOCAL_SECRETS.
 */
export type SecretSource = { get(name: string): Promise<string> };

/** The RPC surface of the STS `SecretsBroker` entrypoint, narrowed to what this Worker calls. */
export type StsBinding = { getBundle(request: BundleRequest): Promise<BundleResult> };

export type SecretSourceEnv = {
  AUDIT_ENVIRONMENT: string;
  AUDIT_RELAY_LOCAL_SECRETS?: string;
  STS: StsBinding;
};

export type SecretSourceFailure = 'denied' | 'unavailable' | 'missing' | 'not_modified';

export class SecretSourceError extends Error {
  constructor(
    readonly kind: SecretSourceFailure,
    message: string
  ) {
    super(message);
    this.name = 'SecretSourceError';
  }

  /** Only an unreachable STS or a stale answer is worth another queue attempt. */
  get retryable(): boolean {
    return this.kind === 'unavailable' || this.kind === 'not_modified';
  }
}

export function createStsSecretSource(sts: StsBinding): SecretSource {
  let bundle: Promise<BundleResult> | undefined;
  return {
    async get(name) {
      const result = await (bundle ??= sts.getBundle({}));
      return readBundleSecret(result, name);
    },
  };
}

function readBundleSecret(result: BundleResult, name: string): string {
  switch (result.status) {
    case 'ok': {
      const secret = result.secrets[name];
      if (!secret) throw new SecretSourceError('missing', `the STS bundle does not hold ${name}`);
      return secret.value;
    }
    case 'not_modified':
      throw new SecretSourceError(
        'not_modified',
        'STS answered not_modified to an unconditional bundle request'
      );
    case 'denied':
      throw new SecretSourceError('denied', `STS denied the bundle: ${result.reason}`);
    case 'unavailable':
      throw new SecretSourceError('unavailable', `STS is unavailable: ${result.reason}`);
  }
}

const LocalSecretsSchema = z.record(z.string(), z.string());

export function createSecretSource(env: SecretSourceEnv): SecretSource {
  if (env.AUDIT_ENVIRONMENT === 'local' && env.AUDIT_RELAY_LOCAL_SECRETS) {
    return createLocalSecretSource(env.AUDIT_RELAY_LOCAL_SECRETS);
  }
  return createStsSecretSource(env.STS);
}

function createLocalSecretSource(raw: string): SecretSource {
  const secrets = LocalSecretsSchema.parse(JSON.parse(raw) as unknown);
  return {
    async get(name) {
      if (!Object.hasOwn(secrets, name)) {
        throw new SecretSourceError('missing', `the local secrets do not hold ${name}`);
      }
      return secrets[name];
    },
  };
}
