import 'server-only';

import { createHmac } from 'node:crypto';

import { BYOK_ENCRYPTION_KEY } from '@/lib/config.server';

export function codingPlanCredentialFingerprint(apiKey: string): string {
  if (!BYOK_ENCRYPTION_KEY) {
    throw new Error('BYOK encryption is not configured');
  }

  // Keyed API-key fingerprint for duplicate detection, not password storage.
  return createHmac('sha256', BYOK_ENCRYPTION_KEY).update(apiKey).digest('hex');
}
