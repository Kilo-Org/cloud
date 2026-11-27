import {
  createWorkerServiceTokens,
  type MintBinding,
  type ServiceTokens,
} from '@kilocode/service-token-client';
import {
  STS_ISSUERS,
  STS_USAGE_PUBLISH,
  StsEnvironmentSchema,
  type StsEnvironment,
} from '@kilocode/sts-contracts';
import { createVerifier, httpJwksSource, type Verifier } from '@kilocode/verify';

/**
 * The STS settings the publish routes and the usage writer use. The STS canary (sts-canary.ts)
 * keeps its own verifier and token client, so neither path changes the other's caches.
 */
export type StsEnv = {
  STS?: MintBinding;
  /** The STS issuer: the `iss` the publish verifier accepts and the base of its key-set URL. */
  STS_URL?: string;
  /** `production` or `staging`: the one `env` claim accepted; must match `STS_URL`. */
  STS_ENVIRONMENT?: string;
};

/**
 * This Worker's own origin per STS environment, named in the publish routes' 401 and 403
 * challenges: each script's `workers.dev` address (it has no routes), and the `wrangler dev`
 * default for development. Fixed here, never taken from the request, so a client cannot choose
 * the challenge or a verifier instance.
 */
export const USAGE_INGEST_RESOURCE_ORIGINS: Readonly<Record<StsEnvironment, string>> = {
  production: 'https://usage-ingest.engineering-e11.workers.dev',
  staging: 'https://usage-ingest-staging.engineering-e11.workers.dev',
  development: 'http://localhost:8787',
};

export const RESOURCE_METADATA_PATH = '/.well-known/oauth-protected-resource';

type PublishVerifyConfig = { stsUrl: string; environment: StsEnvironment };

/**
 * The issuer and environment the publish routes accept: `STS_ENVIRONMENT` when `STS_ISSUERS` names
 * `STS_URL` under it. `development` accepts only a loopback issuer (the tests' stand-in). `null`:
 * STS verification is not configured.
 */
export function publishVerifyConfig(
  env: Pick<StsEnv, 'STS_URL' | 'STS_ENVIRONMENT'>
): PublishVerifyConfig | null {
  const environment = StsEnvironmentSchema.safeParse(env.STS_ENVIRONMENT);
  if (!env.STS_URL || !environment.success) return null;
  if (environment.data !== 'development') {
    return STS_ISSUERS[environment.data] === env.STS_URL
      ? { stsUrl: env.STS_URL, environment: environment.data }
      : null;
  }
  let hostname: string;
  try {
    hostname = new URL(env.STS_URL).hostname;
  } catch {
    return null;
  }
  return hostname === '127.0.0.1' || hostname === 'localhost'
    ? { stsUrl: env.STS_URL, environment: environment.data }
    : null;
}

/** One publish verifier per isolate, keyed only by the verified issuer and environment. */
let verifier: { key: string; instance: Verifier<false> } | null = null;

export function publishVerifierFor(config: PublishVerifyConfig): Verifier<false> {
  const key = `${config.stsUrl}|${config.environment}`;
  if (verifier?.key !== key) {
    verifier = {
      key,
      instance: createVerifier({
        audience: STS_USAGE_PUBLISH.audience,
        environment: config.environment,
        resourceMetadataUrl: `${USAGE_INGEST_RESOURCE_ORIGINS[config.environment]}${RESOURCE_METADATA_PATH}`,
        sts: { issuer: config.stsUrl, jwks: httpJwksSource(config.stsUrl) },
      }),
    };
  }
  return verifier.instance;
}

/** The writer's token client, one per isolate, keyed by the binding. */
let tokens: { binding: MintBinding; client: ServiceTokens } | null = null;

export function writerTokensFor(binding: MintBinding): ServiceTokens {
  if (tokens?.binding !== binding) tokens = { binding, client: createWorkerServiceTokens(binding) };
  return tokens.client;
}
