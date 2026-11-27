import 'server-only';
import { createHttpSecrets, type Secrets } from '@kilocode/secrets-client';
import { vercelIdentity } from '@kilocode/service-token-client/vercel';
import { STS_ISSUERS, type StsEnvironment } from '@kilocode/sts-contracts';
import { STS_URL } from '@kilocode/web-shared/lib/config.server';
import { StsSecretReadConfigError } from '@kilocode/web-shared/lib/sts-secret-read-failure';
import { getCache, waitUntil } from '@vercel/functions';

/**
 * The STS transport of the internal API secret read of `apps/web` and `apps/ai-gateway`.
 * `sts-secret-reader.ts` imports this module only on the first read under `SECRETS_SOURCE=sts`, so
 * a deployment on `env` never loads the secrets client, the Vercel OIDC exchange or the Runtime
 * Cache.
 */

/** Reads one secret from the deployment's STS bundle and returns it as stored. */
export type StsSecretReader = (name: string) => Promise<string>;

/** The deployment's runtime variables; `process.env` itself, read live on the first STS read. */
type VercelRuntime = Readonly<Record<string, string | undefined>> & {
  VERCEL_ENV?: string;
  VERCEL_TARGET_ENV?: string;
};

/**
 * The STS environment whose bundle this deployment may read, from the deployment's own runtime
 * variables (design 6.2, `services/sts/policy/web.yaml` and `ai-gateway.yaml`): Vercel production
 * reads production, the `staging` custom environment reads staging, a preview reads development,
 * and a process outside Vercel (local development) reads development. Any other pair has no STS
 * environment.
 */
export function stsEnvironmentOfDeployment(runtime: VercelRuntime): StsEnvironment {
  const { VERCEL_ENV: environment, VERCEL_TARGET_ENV: target } = runtime;
  if (environment === 'production' && target === 'production') return 'production';
  if (environment === 'preview' && target === 'staging') return 'staging';
  if (environment === 'preview' && target === 'preview') return 'development';
  if (environment === undefined && target === undefined) return 'development';
  throw new StsSecretReadConfigError(
    'This deployment environment has no STS environment to read secrets from'
  );
}

/**
 * One bundle client per process, built on the first read. Before building it, the read checks that
 * `STS_URL` is the issuer of this deployment's own STS environment, so a staging deployment
 * configured with production STS (or the reverse) refuses every read instead of presenting its
 * identity there.
 */
export function createStsSecretReader(options: {
  runtime: VercelRuntime;
  stsUrl: string;
  createSecrets: (stsIssuer: string) => Secrets;
  waitUntil: (promise: Promise<unknown>) => void;
}): StsSecretReader {
  let secrets: Secrets | null = null;
  return async name => {
    if (secrets === null) {
      const issuer = STS_ISSUERS[stsEnvironmentOfDeployment(options.runtime)];
      if (options.stsUrl !== issuer) {
        throw new StsSecretReadConfigError(
          'STS_URL is not the STS issuer of this deployment environment'
        );
      }
      secrets = options.createSecrets(issuer);
    }
    return secrets.get(name, { waitUntil: options.waitUntil });
  };
}

/**
 * The shipped reader: the bundle request presents the function's Vercel identity exchanged for the
 * STS audience, so STS selects the workload of the calling project (`web` or `ai-gateway`), and
 * shares the exchanged token through the project's Runtime Cache, as the STS canary route does.
 * `waitUntil` keeps a background revalidation alive past the response, and is a no-op outside a
 * Vercel request.
 */
export function createVercelStsSecretReader(): StsSecretReader {
  return createStsSecretReader({
    runtime: process.env,
    stsUrl: STS_URL,
    createSecrets: stsIssuer =>
      createHttpSecrets({
        stsUrl: stsIssuer,
        getIdentityToken: vercelIdentity({
          stsAudience: stsIssuer,
          // The keys are SHA-256 already; the default 32-bit key hash could let two share an entry.
          cache: getCache({ namespace: 'sts-exchange', keyHashFunction: key => key }),
        }),
      }),
    waitUntil,
  });
}
