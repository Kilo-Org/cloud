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

export type HeldTokenRead =
  | { kind: 'token'; token: string }
  | { kind: 'not_held' }
  | { kind: 'failed'; error: unknown };

/**
 * Reads still waiting for a token, one per STS environment and scope. While one waits the client
 * holds no usable token for that scope, so a later read answers `not_held` without asking it.
 */
const waiting = new Map<string, Promise<unknown>>();

/**
 * For a best-effort sender that never waits on STS: the token when the client holds a usable one,
 * or its refusal when it refuses at once (a denial, or a backoff after a failed mint), both
 * answered within the current turn of the event loop. Otherwise `not_held` at once: the read, and
 * the mint it started, run on under `waitUntil`, so a later send finds the token. One such read
 * waits per environment and scope; others answer `not_held` without a read of their own.
 */
export async function stsServiceTokenIfHeld(
  environment: StsEnvironment,
  request: ServiceTokenRequest
): Promise<HeldTokenRead> {
  const key = `${environment} ${request.scope}`;
  if (waiting.has(key)) return { kind: 'not_held' };
  const read: Promise<HeldTokenRead> = stsServiceToken(environment, request).then(
    token => ({ kind: 'token', token }),
    (error: unknown) => ({ kind: 'failed', error })
  );
  // A held token or an immediate refusal settles in microtasks, before any timer fires.
  const later = Promise.withResolvers<null>();
  const timer = setTimeout(() => later.resolve(null), 0);
  try {
    const now = await Promise.race([read, later.promise]);
    if (now !== null) return now;
  } finally {
    clearTimeout(timer);
  }
  // Reads that started together share the client's one mint; the first to wait is the one kept.
  const settled: Promise<unknown> = read.finally(() => {
    if (waiting.get(key) === settled) waiting.delete(key);
  });
  if (!waiting.has(key)) waiting.set(key, settled);
  lifetime.waitUntil(settled);
  return { kind: 'not_held' };
}
