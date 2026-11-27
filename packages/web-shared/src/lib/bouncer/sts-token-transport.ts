import 'server-only';
import { createHttpServiceTokens } from '@kilocode/service-token-client';
import { vercelIdentity } from '@kilocode/service-token-client/vercel';
import { STS_ISSUERS } from '@kilocode/sts-contracts';
import {
  BouncerStsConfigError,
  type BouncerTokenRead,
} from '@kilocode/web-shared/lib/bouncer/sts-auth-contract';
import { STS_URL } from '@kilocode/web-shared/lib/config.server';
import { stsEnvironmentOfDeployment } from '@kilocode/web-shared/lib/sts-secret-transport';
import { getCache } from '@vercel/functions';

/**
 * The token client of the shared Bouncer client, loaded by `sts-auth.ts` on the first call with
 * `BOUNCER_STS_TOKENS=on`. One client per process: it holds the Bouncer tokens in memory, renews
 * each at 80 % of its lifetime and batches concurrent first reads into one STS call.
 */

/**
 * Builds the read, or throws `BouncerStsConfigError` unless this is a Vercel production deployment
 * whose `stsUrl` is the production STS issuer. Bouncer runs in production only and accepts only
 * production STS tokens, and only production STS grants them (`services/sts/policy/web.yaml`,
 * `ai-gateway.yaml`): a preview or staging deployment with the flag on makes no STS call at all and
 * keeps the legacy key alone, and no deployment presents its identity to another environment's STS.
 */
export function createBouncerTokenReadFor(options: {
  runtime: Readonly<Record<string, string | undefined>>;
  stsUrl: string;
  createTokens: (stsIssuer: string) => { get: BouncerTokenRead };
}): BouncerTokenRead {
  let production: boolean;
  try {
    production = stsEnvironmentOfDeployment(options.runtime) === 'production';
  } catch {
    throw new BouncerStsConfigError('This deployment environment has no STS environment');
  }
  if (!production) {
    throw new BouncerStsConfigError('Bouncer accepts STS tokens from production deployments only');
  }
  if (options.stsUrl !== STS_ISSUERS.production) {
    throw new BouncerStsConfigError('STS_URL is not the production STS issuer');
  }
  const tokens = options.createTokens(STS_ISSUERS.production);
  return async (target, ctx) => await tokens.get(target, ctx);
}

/**
 * The shipped read: the mint presents the function's Vercel identity exchanged for the STS
 * audience, shared across the deployment's instances through the Runtime Cache, as the STS canary
 * route and the STS secret read do.
 */
export function createBouncerTokenRead(): BouncerTokenRead {
  return createBouncerTokenReadFor({
    runtime: process.env,
    stsUrl: STS_URL,
    createTokens: stsIssuer =>
      createHttpServiceTokens({
        stsUrl: stsIssuer,
        getIdentityToken: vercelIdentity({
          stsAudience: stsIssuer,
          // The keys are SHA-256 already; the default 32-bit key hash could let two share an entry.
          cache: getCache({ namespace: 'sts-exchange', keyHashFunction: key => key }),
        }),
      }),
  });
}
