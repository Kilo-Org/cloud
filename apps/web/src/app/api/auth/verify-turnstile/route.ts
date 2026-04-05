import { NEXTAUTH_SECRET, TURNSTILE_SECRET_KEY } from '@/lib/config.server';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'crypto';
import { assertNotNullish } from '@/lib/utils';
import type { TurnstileJwtPayload } from '@/lib/user.server';

// JWT secret for signing Turnstile verification tokens
const JWT_SECRET = NEXTAUTH_SECRET;

export async function POST(request: NextRequest) {
  const { token } = await request.json();

  if (!token) {
    return NextResponse.json({ error: 'Token is required' }, { status: 400 });
  }

  // Get client IP address (extract first IP from comma-separated list)
  const forwardedFor = request.headers.get('x-forwarded-for');
  assertNotNullish(forwardedFor);
  const clientIP = forwardedFor.split(',')[0]?.trim() ?? null;
  assertNotNullish(clientIP);

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
  res.cookies.set('turnstile_jwt', verificationJWT, {
    httpOnly: true,
    secure: process.env.NODE_ENV !== 'development',
    sameSite: 'lax',
    path: '/',
    maxAge: 60 * 60,
  });
  return res;
}
