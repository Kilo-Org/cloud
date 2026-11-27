import 'server-only';
import { getCache, waitUntil } from '@vercel/functions';
import {
  createHttpServiceTokens,
  type ServiceTokenRequest,
  type ServiceTokens,
} from '@kilocode/service-token-client';
import { vercelIdentity } from '@kilocode/service-token-client/vercel';
import { STS_ISSUERS, type StsEnvironment } from '@kilocode/sts-contracts';

/**
 * The STS service tokens `apps/web` and `apps/ai-gateway` present to other Kilo services. One token
 * client per process and STS environment, so every sender of the process shares its held tokens,
 * its mint batching and its backoff. Its Vercel identity shares exchanged tokens across instances
 * through the Runtime Cache namespace the apps' other STS clients use. Import it only from a
 * sender's STS mode, so a deployment on its legacy credential never loads the client or the Vercel
 * OIDC exchange.
 */
const clients = new Map<StsEnvironment, ServiceTokens>();

function clientFor(environment: StsEnvironment): ServiceTokens {
  const held = clients.get(environment);
  if (held !== undefined) return held;
  const issuer = STS_ISSUERS[environment];
  const client = createHttpServiceTokens({
    stsUrl: issuer,
    getIdentityToken: vercelIdentity({
      stsAudience: issuer,
      // The keys are SHA-256 already; the default 32-bit key hash could let two share an entry.
      cache: getCache({ namespace: 'sts-exchange', keyHashFunction: key => key }),
    }),
  });
  clients.set(environment, client);
  return client;
}

/**
 * Renewals and unanswered mints run on under the invocation's `waitUntil`, never inside the read
 * that started them; outside a Vercel request it is a no-op.
 */
const lifetime = { waitUntil: (promise: Promise<unknown>) => waitUntil(promise) };

/**
 * The token for `request` from `environment`'s STS issuer: from memory while the client holds one
 * with at least `HELD_TOKEN_MARGIN_SECONDS` left, otherwise one mint within the client's attempt
 * timeout and backoff. Rejects with `ServiceTokenError`, or the Vercel identity's error, when there
 * is none; neither carries a token.
 */
export function stsServiceToken(
  environment: StsEnvironment,
  request: ServiceTokenRequest
): Promise<string> {
  return clientFor(environment).get(request, lifetime);
}
