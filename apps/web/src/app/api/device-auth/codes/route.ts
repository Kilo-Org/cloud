import { NextResponse } from 'next/server';
import { createDeviceAuthRequest } from '@/lib/device-auth/device-auth';
import { headers } from 'next/headers';
import { APP_URL } from '@/lib/constants';
import { buildDeviceAuthVerificationUrl } from '@/app/device-auth/device-auth-url';

export async function POST(_request: Request) {
  const headersList = await headers();
  const userAgent = headersList.get('user-agent') || undefined;
  const ipAddress = headersList.get('x-forwarded-for') || undefined;

  const { code, expiresAt } = await createDeviceAuthRequest({
    userAgent,
    ipAddress,
  });

  const verificationUrl = buildDeviceAuthVerificationUrl(APP_URL, code, { app: true });

  return NextResponse.json({
    code,
    verificationUrl,
    expiresIn: Math.floor((expiresAt.getTime() - Date.now()) / 1000),
  });
}
