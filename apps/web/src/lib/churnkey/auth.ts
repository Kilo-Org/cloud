import 'server-only';

import { createHmac } from 'node:crypto';

export function computeChurnkeyAuthHash(stripeCustomerId: string): string {
  const secret = process.env.CHURNKEY_API_SECRET;
  if (!secret) {
    throw new Error('CHURNKEY_API_SECRET is not configured');
  }
  return createHmac('sha256', secret).update(stripeCustomerId).digest('hex');
}
