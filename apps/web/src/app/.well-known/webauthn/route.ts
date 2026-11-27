import { APP_URL } from '@kilocode/web-shared/lib/constants';
import { type NextRequest, NextResponse } from 'next/server';
import { webAuthnRelatedOrigins } from '@/lib/auth/webauthn-related-origins';

/**
 * WebAuthn related origins for the app's passkey relying party (`webauthn-related-origins.ts`).
 * The browser fetches this without cookies or a referrer and requires a 200 with the
 * `application/json` content type, so every other answer is a refusal.
 */
export function GET(request: NextRequest): NextResponse {
  const document = webAuthnRelatedOrigins({
    appUrl: APP_URL,
    vercelEnv: process.env.VERCEL_ENV,
    vercelTargetEnv: process.env.VERCEL_TARGET_ENV,
    requestHost: request.headers.get('host'),
  });
  if (!document) {
    return new NextResponse(null, { status: 404, headers: { 'cache-control': 'no-store' } });
  }
  return NextResponse.json(document, { headers: { 'cache-control': 'public, max-age=300' } });
}
