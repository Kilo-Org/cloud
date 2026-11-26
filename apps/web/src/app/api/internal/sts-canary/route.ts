import { NextResponse, after } from 'next/server';
import type { NextRequest } from 'next/server';
import { getCache } from '@vercel/functions';
import { STS_CANARY_VERIFY_PATH, STS_ENVIRONMENTS, STS_ISSUERS } from '@kilocode/sts-contracts';
import { createHttpServiceTokens } from '@kilocode/service-token-client';
import { vercelIdentity } from '@kilocode/service-token-client/vercel';
import { createVerifier, httpJwksSource } from '@kilocode/verify';
import { STS_URL, USAGE_INGEST_URL } from '@kilocode/web-shared/lib/config.server';
import { APP_URL } from '@kilocode/web-shared/lib/constants';
import { usageIngestSiblingUrl } from '@kilocode/web-shared/lib/ai-gateway/usage-publisher';
import { createStsCanaryHandler } from '@/lib/sts-canary';

/**
 * The web side of the STS canary pair (decision D6c, services/usage-ingest README "STS canary"):
 * usage-ingest's 5-minute cron calls it with a `web:sts.canary` STS token. It authenticates only
 * with that token, never with the internal API secret.
 */

// The slowest run is a 5 s key-set fetch, a 30 s mint attempt and four 10 s calls to usage-ingest,
// 75 s; usage-ingest waits 80 s. `STS_CANARY_ROUTE_MAX_DURATION_SECONDS` in
// `@kilocode/sts-contracts` states the arithmetic; Next.js needs the literal here.
export const maxDuration = 90;

let handler: ((request: Request) => Promise<Response>) | null = null;

/**
 * Built on the first request, once per instance, so the verifier's key set, the token client's
 * tokens and the shared Vercel identity serve every later request. A missing or invalid setting
 * leaves it unbuilt and answers 503; so does an `STS_URL` that is not one of `STS_ISSUERS`, since
 * the environment the verifier accepts is the one whose STS that is.
 */
function canaryHandler(): ((request: Request) => Promise<Response>) | null {
  if (handler !== null) return handler;
  const verifyUrl = usageIngestSiblingUrl(USAGE_INGEST_URL, STS_CANARY_VERIFY_PATH);
  const environment = STS_ENVIRONMENTS.find(name => STS_ISSUERS[name] === STS_URL);
  if (verifyUrl === undefined || environment === undefined) return null;
  const waitUntil = (promise: Promise<unknown>) => after(promise);
  try {
    handler = createStsCanaryHandler({
      verifier: createVerifier({
        audience: 'web',
        environment,
        // RFC 9728 metadata URL of this app, from configuration, never from a request's Host; it
        // appears only in 401 challenges.
        resourceMetadataUrl: `${new URL(APP_URL).origin}/.well-known/oauth-protected-resource`,
        sts: { issuer: STS_URL, jwks: httpJwksSource(STS_URL) },
      }),
      tokens: createHttpServiceTokens({
        stsUrl: STS_URL,
        getIdentityToken: vercelIdentity({
          stsAudience: STS_URL,
          // The keys are SHA-256 already; the default 32-bit key hash could let two share an entry.
          cache: getCache({ namespace: 'sts-exchange', keyHashFunction: key => key }),
        }),
      }),
      verifyUrl,
      waitUntil,
    });
  } catch (error) {
    console.error('sts canary: invalid configuration', {
      errorName: error instanceof Error ? error.name : typeof error,
    });
    return null;
  }
  return handler;
}

export async function POST(request: NextRequest): Promise<Response> {
  const canary = canaryHandler();
  if (canary === null) {
    return NextResponse.json(
      {
        error:
          'sts canary is not configured: USAGE_INGEST_URL and an STS_URL from STS_ISSUERS are required',
      },
      { status: 503, headers: { 'cache-control': 'no-store' } }
    );
  }
  return await canary(request);
}
