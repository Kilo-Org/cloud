import { NEXTAUTH_SECRET, NEXTAUTH_URL } from '@kilocode/web-shared/lib/config.server';
import { TURNSTILE_SECRET_KEY } from '@/lib/web-config.server';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'crypto';
import { sentryLogger } from '@kilocode/web-shared/lib/utils.server';
import type { TurnstileJwtPayload } from '@/lib/user/next-auth-options';
import { getTrustedSignupClientIp } from '@/lib/auth/trusted-signup-ip';

// JWT secret for signing Turnstile verification tokens
const JWT_SECRET = NEXTAUTH_SECRET;

export async function POST(request: NextRequest) {
  const body: unknown = await request.json().catch(() => undefined);
  const token =
    typeof body === 'object' && body !== null && 'token' in body && typeof body.token === 'string'
      ? body.token
      : undefined;

  if (!token) {
    return NextResponse.json({ error: 'Token is required' }, { status: 400 });
  }

  // The verification token binds the sign-in to the address the platform
  // observed, so the turnstile check and the token use one resolved value.
  const clientIP = getTrustedSignupClientIp(request.headers);
  if (!clientIP) {
    sentryLogger(
      'turnstile-auth',
      'warning'
    )('SECURITY: Unable to resolve the client address for Turnstile verification');
    return NextResponse.json({ error: 'Client address unavailable' }, { status: 500 });
  }

  const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      secret: TURNSTILE_SECRET_KEY,
      response: token,
      remoteip: clientIP,
    }),
  });

  const result = await response.json();

  if (!result.success) {
    return NextResponse.json(
      { error: 'Invalid turnstile token', details: result['error-codes'] },
      { status: 400 }
    );
  }

  const jwtPayload: TurnstileJwtPayload = {
    guid: randomUUID(), // Unique identifier to prevent reuse, will be used as user id
    ip: clientIP,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 60 * 60,
  };

  const verificationJWT = jwt.sign(jwtPayload, JWT_SECRET, {
    algorithm: 'HS256',
  });

  const res = NextResponse.json({ success: true });
  const useSecureCookies = NEXTAUTH_URL?.startsWith('https://') ?? false;
  res.cookies.set('turnstile_jwt', verificationJWT, {
    httpOnly: true,
    sameSite: useSecureCookies ? 'none' : 'lax',
    secure: useSecureCookies,
    path: '/',
    maxAge: 60 * 60,
  });
  return res;
}
