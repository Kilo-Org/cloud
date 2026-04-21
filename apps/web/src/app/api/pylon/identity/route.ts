import { createHmac } from 'node:crypto';
import { NextResponse } from 'next/server';
import { PYLON_IDENTITY_SECRET } from '@/lib/config.server';
import { getUserFromAuth } from '@/lib/user.server';

type IdentityResponse = { email: string; name: string; emailHash: string } | { error: string };

export async function GET(): Promise<NextResponse<IdentityResponse>> {
  const { user, authFailedResponse } = await getUserFromAuth({ adminOnly: false });

  if (authFailedResponse) {
    return authFailedResponse;
  }

  if (!PYLON_IDENTITY_SECRET) {
    return NextResponse.json({ error: 'Pylon not configured' }, { status: 503 });
  }

  const email = user.google_user_email;
  const name = user.google_user_name;
  // Pylon's identity secret is hex-encoded and must be decoded to raw bytes before HMAC.
  // See: https://docs.usepylon.com/pylon-docs/chat-widget/identity-verification
  const secretBytes = Buffer.from(PYLON_IDENTITY_SECRET, 'hex');
  const emailHash = createHmac('sha256', secretBytes).update(email).digest('hex');

  return NextResponse.json({ email, name, emailHash });
}
