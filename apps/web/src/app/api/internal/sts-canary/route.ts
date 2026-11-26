import { NextResponse, after } from 'next/server';
import type { NextRequest } from 'next/server';
import { getCache } from '@vercel/functions';
import { STS_CANARY_VERIFY_PATH } from '@kilocode/sts-contracts';
import { createHttpServiceTokens } from '@kilocode/service-token-client';
import { vercelIdentity } from '@kilocode/service-token-client/vercel';
import { createVerifier, httpJwksSource } from '@kilocode/verify';
import { STS_URL, USAGE_INGEST_URL } from '@kilocode/web-shared/lib/config.server';
import { usageIngestSiblingUrl } from '@kilocode/web-shared/lib/ai-gateway/usage-publisher';
import { createStsCanaryHandler } from '@/lib/sts-canary';

/**
 * The web side of the STS canary pair (decision D6c, services/usage-ingest README "STS canary"):
 * usage-ingest's 5-minute cron calls it with a `web:sts.canary` STS token. It authenticates only
 * with that token, never with the internal API secret.
 */

// A cold Vercel wave can take up to 20 s to share the exchanged identity token, then one mint and
// four calls to usage-ingest of at most 10 s each.
export const maxDuration = 90;

let handler: ((request: Request) => Promise<Response>) | null = null;

/**
 * Built on the first request, once per instance, so the verifier's key set, the token client's
 * tokens and the shared Vercel identity serve every later request. A missing or invalid setting
 * leaves it unbuilt and answers 503.
 */
function canaryHandler(origin: string): ((request: Request) => Promise<Response>) | null {
  if (handler !== null) return handler;
  const verifyUrl = usageIngestSiblingUrl(USAGE_INGEST_URL, STS_CANARY_VERIFY_PATH);
  if (!STS_URL || verifyUrl === undefined) return null;
  const waitUntil = (promise: Promise<unknown>) => after(promise);
  try {
    handler = createStsCanaryHandler({
      verifier: createVerifier({
        audience: 'web',
        // RFC 9728 metadata URL of this app; it appears only in 401 challenges.
        resourceMetadataUrl: `${origin}/.well-known/oauth-protected-resource`,
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
  const canary = canaryHandler(new URL(request.url).origin);
  if (canary === null) {
    return NextResponse.json(
      { error: 'sts canary is not configured: STS_URL and USAGE_INGEST_URL are required' },
      { status: 503, headers: { 'cache-control': 'no-store' } }
    );
  }
  return await canary(request);
}
