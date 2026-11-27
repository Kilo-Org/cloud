import 'server-only';
import { createHttpServiceTokens, type IdentityTokenSource } from '@kilocode/service-token-client';
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
  type BouncerTransportHooks,
} from '@kilocode/web-shared/lib/bouncer/sts-auth-contract';
import { STS_URL } from '@kilocode/web-shared/lib/config.server';
import { stsEnvironmentOfDeployment } from '@kilocode/web-shared/lib/sts-secret-transport';
import { getCache } from '@vercel/functions';
import { getVercelOidcToken } from '@vercel/functions/oidc';

/**
 * The token client of the shared Bouncer client, loaded by `sts-auth.ts` on the first call with
 * `BOUNCER_STS_TOKENS=on` (or at install with the flag on). One client per process: it holds the
 * Bouncer tokens in memory, starts a token's renewal on a read after 80 % of its lifetime, and
 * batches concurrent reads into one attempt (one STS call per scope: the client sends one token per
 * audience per call).
 */

/** Design 3.1: a deployment's first mint is jittered by up to 2 s after its first exchange. */
export const BOUNCER_FIRST_MINT_JITTER_MS = 2_000;
/** A readiness check that found no exchanged token is not repeated for this long. */
export const BOUNCER_NOT_HELD_MEMORY_MS = 250;

type Connection = { tokens: { get: BouncerTokenRead }; exchangeReady: () => Promise<boolean> };

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
  connect: (stsIssuer: string) => Connection;
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

/**
 * The token client over `identity`, with the readiness check, the first-mint jitter and the mint
 * counter.
 *
 * - Readiness: `exchangeHeld` (memory, else the Runtime Cache) runs one check at a time; every
 *   caller during a check shares it, and a check that finds nothing is remembered for
 *   `BOUNCER_NOT_HELD_MEMORY_MS`. While the first mint's jitter runs, readiness is false.
 * - Jitter: when the identity step starts without a held exchanged token, this instance exchanges
 *   or polls for the deployment's first one; the mint then waits a random 0 to
 *   `BOUNCER_FIRST_MINT_JITTER_MS` before it goes to STS, so a deployment's instances spread out.
 * - Counter: every STS answer reaches `hooks.mint` (`ok` for 2xx); a request that fails is `false`.
 */
export function connectBouncerSts(options: {
  stsIssuer: string;
  hooks: BouncerTransportHooks;
  identity: IdentityTokenSource;
  exchangeHeld: () => Promise<boolean>;
  fetch?: typeof fetch;
  random?: () => number;
  now?: () => number;
}): Connection {
  const now = options.now ?? Date.now;
  const random = options.random ?? Math.random;
  const fetchFn = options.fetch ?? fetch;
  let checking: Promise<boolean> | null = null;
  let notHeldUntil = 0;
  let jitterUntil = 0;

  function held(): Promise<boolean> {
    checking ??= options
      .exchangeHeld()
      .catch(() => false)
      .then(found => {
        checking = null;
        if (!found) notHeldUntil = now() + BOUNCER_NOT_HELD_MEMORY_MS;
        return found;
      });
    return checking;
  }

  async function exchangeReady(): Promise<boolean> {
    const at = now();
    if (at < jitterUntil || at < notHeldUntil) return false;
    return await held();
  }

  const getIdentityToken: IdentityTokenSource = Object.assign(
    async () => {
      const heldBefore = await held();
      const token = await options.identity();
      if (!heldBefore) {
        const jitterMs = Math.floor(random() * BOUNCER_FIRST_MINT_JITTER_MS);
        jitterUntil = now() + jitterMs;
        const done = Promise.withResolvers<void>();
        setTimeout(done.resolve, jitterMs);
        await done.promise;
      }
      return token;
    },
    { invalidate: options.identity.invalidate }
  );

  const countingFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    try {
      const response = await fetchFn(input, init);
      options.hooks.mint(response.ok);
      return response;
    } catch (error) {
      options.hooks.mint(false);
      throw error;
    }
  }) as typeof fetch;

  return {
    tokens: createHttpServiceTokens({
      stsUrl: options.stsIssuer,
      getIdentityToken,
      fetch: countingFetch,
    }),
    exchangeReady,
  };
}

/** The readiness check's exchange: it never exchanges, so a miss costs no Vercel exchange. */
const NO_EXCHANGE: Exchange = async () => ({ kind: 'failed', detail: 'readiness check only' });

/**
 * The shipped transport: the mint presents the function's Vercel identity exchanged for the STS
 * audience, shared across the deployment's instances through the Runtime Cache, as the STS canary
 * route and the STS secret read do. Readiness asks a second `SharedExchangedToken` over the same
 * Runtime Cache, with no jitter, no claim and an exchange that always fails: a token in its memory
 * answers at once, one in the cache costs one read (then memory), and a miss costs three reads (the
 * token, the token again, the refusal marker), never an exchange or a write.
 */
export function createBouncerTransport(hooks: BouncerTransportHooks): BouncerTransport {
  return createBouncerTransportFor({
    runtime: process.env,
    stsUrl: STS_URL,
    connect: stsIssuer => {
      // The keys are SHA-256 already; the default 32-bit key hash could let two share an entry.
      const cache = getCache({ namespace: 'sts-exchange', keyHashFunction: key => key });
      const readiness = new SharedExchangedToken(cache);
      return connectBouncerSts({
        stsIssuer,
        hooks,
        identity: vercelIdentity({ stsAudience: stsIssuer, cache }),
        exchangeHeld: async () => {
          const found = await readiness.get(await getVercelOidcToken(), stsIssuer, NO_EXCHANGE, {
            jitterMs: 0,
            claim: false,
          });
          return found.status === 'ok';
        },
      });
    },
  });
}
