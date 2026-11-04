import 'server-only';

import type { GoogleServiceAccountSigningKey } from '@kilocode/db/schema-types';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { GoogleAuth, gaxios } from 'google-auth-library';

const GOOGLE_CLOUD_PLATFORM_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';
const TOKEN_EXCHANGE_TIMEOUT_MS = 5_000;

class GoogleServiceAccountTimeoutError extends Error {
  constructor() {
    super('Google service account authentication timed out after 5 seconds');
  }
}

export const MAX_CACHED_AUTH_CLIENTS = 64;

const authClients = new Map<string, GoogleAuth>();

function getAuthClient(serviceAccount: GoogleServiceAccountSigningKey): GoogleAuth {
  const cacheKey = createHash('sha256')
    .update(serviceAccount.client_email)
    .update('\0')
    .update(serviceAccount.private_key)
    .digest('base64url');
  const cached = authClients.get(cacheKey);
  if (cached) {
    authClients.delete(cacheKey);
    authClients.set(cacheKey, cached);
    return cached;
  }

  if (authClients.size >= MAX_CACHED_AUTH_CLIENTS) {
    const evictedKey = authClients.keys().next().value;
    if (evictedKey !== undefined) authClients.delete(evictedKey);
  }

  const transporter = new gaxios.Gaxios({
    retryConfig: {
      retryBackoff: (error, backoffMs) =>
        delay(backoffMs, undefined, { signal: error.config.signal ?? undefined }),
    },
  });
  const request = transporter.request.bind(transporter);
  transporter.request = async <T>(options: gaxios.GaxiosOptions = {}) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TOKEN_EXCHANGE_TIMEOUT_MS);
    try {
      return await request<T>({ ...options, signal: controller.signal });
    } catch (error) {
      if (controller.signal.aborted) throw new GoogleServiceAccountTimeoutError();
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  };

  const auth = new GoogleAuth({
    credentials: serviceAccount,
    scopes: [GOOGLE_CLOUD_PLATFORM_SCOPE],
    clientOptions: { transporter },
  });
  authClients.set(cacheKey, auth);
  return auth;
}

export async function getGoogleServiceAccountAccessToken(
  serviceAccount: GoogleServiceAccountSigningKey
): Promise<string> {
  let accessToken;
  try {
    accessToken = await getAuthClient(serviceAccount).getAccessToken();
  } catch (error) {
    if (error instanceof GoogleServiceAccountTimeoutError) throw error;
    throw new Error('Google service account authentication failed');
  }
  if (!accessToken) {
    throw new Error('Google service account authentication returned no access token');
  }
  return accessToken;
}
