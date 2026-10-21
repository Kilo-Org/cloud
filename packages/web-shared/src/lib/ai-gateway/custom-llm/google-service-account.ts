import 'server-only';

import type { GoogleServiceAccountKey } from '@kilocode/db/schema-types';
import { createHash } from 'node:crypto';
import { GoogleAuth } from 'google-auth-library';

const GOOGLE_CLOUD_PLATFORM_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';
const authClients = new Map<string, GoogleAuth>();

type GoogleServiceAccountSigningKey = Pick<GoogleServiceAccountKey, 'client_email' | 'private_key'>;

function getAuthClient(serviceAccount: GoogleServiceAccountSigningKey): GoogleAuth {
  const cacheKey = createHash('sha256')
    .update(serviceAccount.client_email)
    .update('\0')
    .update(serviceAccount.private_key)
    .digest('base64url');
  const cached = authClients.get(cacheKey);
  if (cached) return cached;

  const auth = new GoogleAuth({
    credentials: serviceAccount,
    scopes: [GOOGLE_CLOUD_PLATFORM_SCOPE],
  });
  authClients.set(cacheKey, auth);
  return auth;
}

export async function getGoogleServiceAccountAccessToken(
  serviceAccount: GoogleServiceAccountSigningKey
): Promise<string> {
  const accessToken = await getAuthClient(serviceAccount).getAccessToken();
  if (!accessToken) {
    throw new Error('Google service account authentication returned no access token');
  }
  return accessToken;
}
