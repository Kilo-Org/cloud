import 'server-only';
import { createHttpServiceTokens } from '@kilocode/service-token-client';
import {
  SharedExchangedToken,
  vercelIdentity,
  type Exchange,
} from '@kilocode/service-token-client/vercel';
import { STS_ISSUERS } from '@kilocode/sts-contracts';
import {
  BouncerStsConfigError,
  type BouncerTokenRead,
  type BouncerTransport,
} from '@kilocode/web-shared/lib/bouncer/sts-auth-contract';
import { STS_URL } from '@kilocode/web-shared/lib/config.server';
import { stsEnvironmentOfDeployment } from '@kilocode/web-shared/lib/sts-secret-transport';
import { getCache } from '@vercel/functions';
import { getVercelOidcToken } from '@vercel/functions/oidc';

/**
 * The token client of the shared Bouncer client, loaded by `sts-auth.ts` on the first call with
 * `BOUNCER_STS_TOKENS=on`. One client per process: it holds the Bouncer tokens in memory, starts a
 * token's renewal on a read after 80 % of its lifetime, and batches concurrent reads into one
 * attempt (one STS call per scope: the client sends one token per audience per call).
 */

/**
 * Builds the transport, or throws `BouncerStsConfigError` unless this is a Vercel production
 * deployment whose `stsUrl` is the production STS issuer. Bouncer runs in production only and
 * accepts only production STS tokens, and only production STS grants them
 * (`services/sts/policy/web.yaml`, `ai-gateway.yaml`): a preview or staging deployment with the
 * flag on makes no STS call at all and keeps the legacy key alone, and no deployment presents its
 * identity to another environment's STS.
 */
export function createBouncerTransportFor(options: {
  runtime: Readonly<Record<string, string | undefined>>;
  stsUrl: string;
  connect: (stsIssuer: string) => {
    tokens: { get: BouncerTokenRead };
    exchangeReady: () => Promise<boolean>;
  };
}): BouncerTransport {
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
  const { tokens, exchangeReady } = options.connect(STS_ISSUERS.production);
  return { read: async (target, ctx) => await tokens.get(target, ctx), exchangeReady };
}

/** The readiness check's exchange: it never exchanges, so a miss costs no Vercel exchange. */
const NO_EXCHANGE: Exchange = async () => ({ kind: 'failed', detail: 'readiness check only' });

/**
 * The shipped transport: the mint presents the function's Vercel identity exchanged for the STS
 * audience, shared across the deployment's instances through the Runtime Cache, as the STS canary
 * route and the STS secret read do. Readiness asks a second `SharedExchangedToken` over the same
 * Runtime Cache, with no jitter, no claim and an exchange that always fails: a token in its memory
 * answers at once, one in the cache costs one read (then memory), and a miss costs up to three
 * reads, never an exchange or a write.
 */
export function createBouncerTransport(): BouncerTransport {
  return createBouncerTransportFor({
    runtime: process.env,
    stsUrl: STS_URL,
    connect: stsIssuer => {
      // The keys are SHA-256 already; the default 32-bit key hash could let two share an entry.
      const cache = getCache({ namespace: 'sts-exchange', keyHashFunction: key => key });
      const readiness = new SharedExchangedToken(cache);
      return {
        tokens: createHttpServiceTokens({
          stsUrl: stsIssuer,
          getIdentityToken: vercelIdentity({ stsAudience: stsIssuer, cache }),
        }),
        exchangeReady: async () => {
          try {
            const held = await readiness.get(await getVercelOidcToken(), stsIssuer, NO_EXCHANGE, {
              jitterMs: 0,
              claim: false,
            });
            return held.status === 'ok';
          } catch {
            return false;
          }
        },
      };
    },
  });
}
