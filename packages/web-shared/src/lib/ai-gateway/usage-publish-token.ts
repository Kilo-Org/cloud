import 'server-only';

import { getCache, waitUntil } from '@vercel/functions';
import {
  createHttpServiceTokens,
  ServiceTokenError,
  type ServiceTokens,
} from '@kilocode/service-token-client';
import { vercelIdentity } from '@kilocode/service-token-client/vercel';
import { STS_ISSUERS, STS_USAGE_PUBLISH } from '@kilocode/sts-contracts';
import type { PublishEnvironment } from './usage-publish-credential';

/**
 * The STS side of `USAGE_PUBLISHER_AUTH=sts`. `usage-publisher.ts` imports this module only for an
 * STS publication, so a `legacy` deployment never loads it.
 */

/**
 * `retryAfterMs` is the token client's own backoff: no new mint starts before it, so an earlier
 * attempt would fail the same way without asking STS.
 */
export type PublishToken =
  | { kind: 'token'; token: string }
  | { kind: 'denied' }
  | { kind: 'unavailable'; retryAfterMs: number };

/**
 * One token client per process and issuer. Its Vercel identity shares exchanged tokens through the
 * Runtime Cache namespace the web app's other STS clients use.
 */
let tokens: { issuer: string; client: ServiceTokens } | null = null;

function tokensFor(issuer: string): ServiceTokens {
  if (tokens?.issuer !== issuer) {
    tokens = {
      issuer,
      client: createHttpServiceTokens({
        stsUrl: issuer,
        getIdentityToken: vercelIdentity({
          stsAudience: issuer,
          // The keys are SHA-256 already; the default 32-bit key hash could let two share an entry.
          cache: getCache({ namespace: 'sts-exchange', keyHashFunction: key => key }),
        }),
      }),
    };
  }
  return tokens.client;
}

/**
 * Renewals and unanswered mints run on under the invocation's `waitUntil`, never inside a
 * publication's budget; outside a Vercel request it is a no-op.
 */
const lifetime = { waitUntil: (promise: Promise<unknown>) => waitUntil(promise) };

/**
 * The `STS_USAGE_PUBLISH` token for one send from `environment`'s STS issuer, read from the
 * process's token client, which returns a held token only while it has at least
 * `HELD_TOKEN_MARGIN_SECONDS` left. A read still waiting after `budgetMs` is left to `waitUntil`
 * and answers `unavailable`. No token or error detail is returned.
 */
export async function usagePublishToken(
  environment: PublishEnvironment,
  budgetMs: number
): Promise<PublishToken> {
  let read: Promise<string>;
  try {
    read = tokensFor(STS_ISSUERS[environment]).get(STS_USAGE_PUBLISH, lifetime);
  } catch {
    return { kind: 'unavailable', retryAfterMs: 0 };
  }
  const late = Promise.withResolvers<null>();
  const timer = setTimeout(() => late.resolve(null), budgetMs);
  try {
    const token = await Promise.race([read, late.promise]);
    if (token !== null) return { kind: 'token', token };
    lifetime.waitUntil(read.catch(() => {}));
    return { kind: 'unavailable', retryAfterMs: 0 };
  } catch (error) {
    if (!(error instanceof ServiceTokenError)) return { kind: 'unavailable', retryAfterMs: 0 };
    if (error.reason === 'denied') return { kind: 'denied' };
    return { kind: 'unavailable', retryAfterMs: (error.retryAfterSeconds ?? 0) * 1000 };
  } finally {
    clearTimeout(timer);
  }
}
