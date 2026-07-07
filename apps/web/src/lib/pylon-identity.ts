import { createHmac } from 'node:crypto';
import { PYLON_IDENTITY_SECRET } from '@/lib/config.server';

export type PylonIdentity = { email: string; name: string; emailHash: string };

export function getPylonIdentity(user: {
  google_user_email: string;
  google_user_name: string;
}): PylonIdentity | null {
  if (!PYLON_IDENTITY_SECRET) {
    return null;
  }

  // Pylon's identity secret is hex-encoded and must be decoded to raw bytes before HMAC.
  // See: https://docs.usepylon.com/pylon-docs/chat-widget/identity-verification
  const secretBytes = Buffer.from(PYLON_IDENTITY_SECRET, 'hex');
  const emailHash = createHmac('sha256', secretBytes).update(user.google_user_email).digest('hex');

  return { email: user.google_user_email, name: user.google_user_name, emailHash };
}
