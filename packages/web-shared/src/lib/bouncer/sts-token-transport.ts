import 'server-only';
import { createHttpServiceTokens } from '@kilocode/service-token-client';
import { vercelIdentity } from '@kilocode/service-token-client/vercel';
import { STS_ISSUERS } from '@kilocode/sts-contracts';
import {
  BouncerStsConfigError,
  type BouncerTokenRead,
} from '@kilocode/web-shared/lib/bouncer/sts-auth';
import { STS_URL } from '@kilocode/web-shared/lib/config.server';
import { stsEnvironmentOfDeployment } from '@kilocode/web-shared/lib/sts-secret-transport';
import { getCache } from '@vercel/functions';

/**
 * The token client of the shared Bouncer client, loaded by `sts-auth.ts` on the first call with
 * `BOUNCER_STS_TOKENS=on`. One client per process: it holds the Bouncer tokens in memory, renews
 * each at 80 % of its lifetime and batches concurrent first reads into one STS call.
 */

/**
 * Builds the read, or throws `BouncerStsConfigError` when `stsUrl` is not the STS issuer of this
 * deployment's own environment, so a deployment never presents its identity to another
 * environment's STS. Bouncer accepts only production tokens, and only production STS grants them
 * (`services/sts/policy/web.yaml`, `ai-gateway.yaml`): elsewhere STS denies the token and every
 * call keeps the legacy key alone.
 */
export function createBouncerTokenReadFor(options: {
  runtime: Readonly<Record<string, string | undefined>>;
  stsUrl: string;
  createTokens: (stsIssuer: string) => { get: BouncerTokenRead };
}): BouncerTokenRead {
  let issuer: string;
  try {
    issuer = STS_ISSUERS[stsEnvironmentOfDeployment(options.runtime)];
  } catch {
    throw new BouncerStsConfigError('This deployment environment has no STS environment');
  }
  if (options.stsUrl !== issuer) {
    throw new BouncerStsConfigError('STS_URL is not the STS issuer of this deployment environment');
  }
  const tokens = options.createTokens(issuer);
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
