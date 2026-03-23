import { NextResponse } from 'next/server';
import { createDeviceAuthRequest } from '@/lib/device-auth/device-auth';
import { headers } from 'next/headers';
import { APP_URL } from '@/lib/constants';
import { TURNSTILE_SECRET_KEY } from '@/lib/config.server';

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const turnstileToken = body?.turnstileToken;

  if (!turnstileToken) {
    return NextResponse.json(
      { error: 'Turnstile verification token is required' },
      { status: 403 }
    );
  }

  const headersList = await headers();
  const ipAddress = headersList.get('x-forwarded-for') || undefined;

  const turnstileResponse = await fetch(
    'https://challenges.cloudflare.com/turnstile/v0/siteverify',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        secret: TURNSTILE_SECRET_KEY,
        response: turnstileToken,
        remoteip: ipAddress,
      }),
    }
  );

  const turnstileResult = await turnstileResponse.json();

  if (!turnstileResult.success) {
    return NextResponse.json(
      { error: 'Turnstile verification failed', details: turnstileResult['error-codes'] },
      { status: 403 }
    );
  }

  const userAgent = headersList.get('user-agent') || undefined;

  const { code, expiresAt } = await createDeviceAuthRequest({
    userAgent,
    ipAddress,
  });

  const verificationUrl = `${APP_URL}/device-auth?code=${code}`;

  return NextResponse.json({
    code,
    verificationUrl,
    expiresIn: Math.floor((expiresAt.getTime() - Date.now()) / 1000),
  });
}
