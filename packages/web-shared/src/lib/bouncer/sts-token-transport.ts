import 'server-only';
import { createHttpServiceTokens, type IdentityTokenSource } from '@kilocode/service-token-client';
import {
  SharedExchangedToken,
  vercelIdentity,
  type Exchange,
} from '@kilocode/service-token-client/vercel';
import { MintResultSchema, STS_ISSUERS } from '@kilocode/sts-contracts';
import {
  BouncerStsConfigError,
  type BouncerTokenRead,
  type BouncerTransport,
  type BouncerTransportHooks,
} from '@kilocode/web-shared/lib/bouncer/sts-auth-contract';
import { STS_URL } from '@kilocode/web-shared/lib/config.server';
import { stsEnvironmentOfDeployment } from '@kilocode/web-shared/lib/sts-secret-transport';
import { getCache } from '@vercel/functions';
import { getVercelOidcToken } from '@vercel/oidc';

/**
 * The token client of the shared Bouncer client, loaded by `sts-auth.ts` on the first call with
 * `BOUNCER_CLIENT_AUTH=dual` (or at install with the flag on). One client per process: it holds the
 * Bouncer tokens in memory, starts a token's renewal on a read after 80 % of its lifetime, and
 * batches concurrent reads into one attempt (one STS call per scope: the client sends one token per
 * audience per call).
 */

/** Design 3.1: a deployment's first mint is jittered by up to 2 s after its first exchange. */
export const BOUNCER_FIRST_MINT_JITTER_MS = 2_000;
/** A readiness check that found no exchanged token is not repeated for this long. */
export const BOUNCER_NOT_HELD_MEMORY_MS = 250;
/**
 * After `skipJitter`, a first-mint jitter that starts within this long is skipped. It covers an
 * admission call's whole token wait (250 ms, `BOUNCER_TOKEN_WAIT_MS` in `sts-auth.ts`), so the mint
 * its read starts goes to STS at once.
 */
export const BOUNCER_JITTER_SKIP_MS = 250;

type Connection = {
  tokens: { get: BouncerTokenRead };
  exchangeReady: () => Promise<boolean>;
  skipJitter: () => void;
};

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
  const { tokens, exchangeReady, skipJitter } = options.connect(STS_ISSUERS.production);
  return { read: async (target, ctx) => await tokens.get(target, ctx), exchangeReady, skipJitter };
}

/**
 * The token client over `identity`, with the readiness check, the first-mint jitter and the mint
 * counter.
 *
 * - Identity step: every STS call of an attempt (one per scope) shares one step, so a first mint
 *   runs one exchange and one jitter for all scopes. The step starts the readiness check and the
 *   identity side by side, so a scale-out mint pays for one Runtime Cache round trip, not two in a
 *   row.
 * - Readiness: `exchangeHeld` (memory, else the Runtime Cache) runs one check at a time; every
 *   caller during a check shares it, and a check that finds nothing is remembered for
 *   `BOUNCER_NOT_HELD_MEMORY_MS`. While an identity step has not yet seen a held exchanged token
 *   (`firstMintPending`, set before the step's first await), readiness is false, so no call waits
 *   through an exchange or a jitter.
 * - Jitter: when the step finds no held exchanged token, this instance exchanges or polls for the
 *   deployment's first one; the mint then waits a random 0 to `BOUNCER_FIRST_MINT_JITTER_MS`
 *   before it goes to STS, so a deployment's instances spread out. `skipJitter` ends a running
 *   jitter and skips one that starts within `BOUNCER_JITTER_SKIP_MS`; only an `sts` admission call
 *   asks for it, so `dual` and background renewals keep the jitter. A deployment's first `sts`
 *   mints are then spread only by the exchange step itself (one instance exchanges, the others
 *   poll the Runtime Cache with backoff for its token).
 * - Counter: every STS answer reaches `hooks.mint`: `true` only for an answer that issued a token,
 *   `false` for a denial, any other answer, or a request that failed.
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
  let firstMintPending = false;
  let step: Promise<string> | null = null;
  let skipJitterUntil = Number.NEGATIVE_INFINITY;
  let endJitter: (() => void) | null = null;

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
    if (firstMintPending || now() < notHeldUntil) return false;
    const found = await held();
    return found && !firstMintPending;
  }

  function skipJitter(): void {
    skipJitterUntil = now() + BOUNCER_JITTER_SKIP_MS;
    endJitter?.();
  }

  async function identityStep(): Promise<string> {
    firstMintPending = true;
    try {
      const identity = Promise.resolve(options.identity());
      // Rejections surface through the `await identity` below; this keeps an early one handled.
      void identity.catch(() => undefined);
      if (await held()) {
        firstMintPending = false;
        return await identity;
      }
      const token = await identity;
      if (now() >= skipJitterUntil) {
        const jitter = Promise.withResolvers<void>();
        endJitter = jitter.resolve;
        const timer = setTimeout(
          jitter.resolve,
          Math.floor(random() * BOUNCER_FIRST_MINT_JITTER_MS)
        );
        await jitter.promise;
        clearTimeout(timer);
        endJitter = null;
      }
      return token;
    } finally {
      firstMintPending = false;
    }
  }

  const getIdentityToken: IdentityTokenSource = Object.assign(
    async () => {
      step ??= identityStep().finally(() => {
        step = null;
      });
      return await step;
    },
    { invalidate: options.identity.invalidate }
  );

  const countingFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    try {
      const response = await fetchFn(input, init);
      options.hooks.mint(await issuedAToken(response));
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
    skipJitter,
  };
}

/**
 * Whether an STS answer issued a token. STS answers 200 for a denial too (a policy without the
 * Bouncer grant), and that must not count as a successful mint; the token client reads its own
 * copy of the body.
 */
async function issuedAToken(response: Response): Promise<boolean> {
  if (!response.ok) return false;
  try {
    const result = MintResultSchema.safeParse(await response.clone().json());
    return (
      result.success &&
      result.data.status === 'ok' &&
      result.data.tokens.some(token => token.status === 'issued')
    );
  } catch {
    return false;
  }
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
 *
 * This identity is separate from the usage publisher's (`ai-gateway/usage-publish-token.ts`) on
 * purpose: each module loads only when its own flag is on, so neither pulls the other's token
 * client into a deployment that does not use it. Both read and write the same `sts-exchange`
 * Runtime Cache entry, so a deployment still exchanges once per issuer; the cost of keeping them
 * apart is one extra exchanged token held in memory per process. The readiness check reads its base
 * token from `@vercel/oidc` too, the source `vercelIdentity` uses, so both see the same identity.
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
