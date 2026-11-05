import 'server-only';
import { NextResponse } from 'next/server';
import { getUserFromAuth } from '@kilocode/web-shared/lib/user/server';
import { signModernKiloToken } from '@kilocode/worker-utils/kilo-token-policy';
import { KILO_API_AUDIENCE } from '@kilocode/worker-utils/internal-service-token-audiences';
import { NEXTAUTH_SECRET } from '@kilocode/web-shared/lib/config.server';

/** Browser-only feature gating is intentional; the worker enforces creator access. */
export async function POST() {
  const { user, authFailedResponse } = await getUserFromAuth({ adminOnly: false });
  if (authFailedResponse) return authFailedResponse;
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const credential = await signModernKiloToken({
    userId: user.id,
    pepper: user.api_token_pepper,
    secret: NEXTAUTH_SECRET,
    env: process.env.NODE_ENV,
    audience: KILO_API_AUDIENCE,
    tokenPurpose: 'human-api',
    credentialExchange: true,
    expiresInSeconds: 300,
  });
  return NextResponse.json(credential, { headers: { 'Cache-Control': 'no-store' } });
}
