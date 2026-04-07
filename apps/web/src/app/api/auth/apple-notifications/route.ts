import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import jwt from 'jsonwebtoken';
import { createPublicKey } from 'node:crypto';
import { db } from '@/lib/drizzle';
import { user_auth_provider } from '@kilocode/db/schema';
import { and, eq } from 'drizzle-orm';
import { captureException } from '@sentry/nextjs';
import { logExceptInTest } from '@/lib/utils.server';
import { APPLE_CLIENT_ID } from '@/lib/config.server';

const APPLE_JWKS_URL = 'https://appleid.apple.com/auth/keys';

type AppleJWK = {
  kty: string;
  kid: string;
  use: string;
  alg: string;
  n: string;
  e: string;
};

type AppleEvent = {
  type: 'consent-revoked' | 'account-delete' | 'email-disabled' | 'email-enabled';
  sub: string;
  email?: string;
  is_private_email?: string;
  event_time: number;
};

let cachedKeys: { keys: AppleJWK[]; fetchedAt: number } | null = null;
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

async function getApplePublicKeys(): Promise<AppleJWK[]> {
  if (cachedKeys && Date.now() - cachedKeys.fetchedAt < CACHE_TTL_MS) {
    return cachedKeys.keys;
  }

  const response = await fetch(APPLE_JWKS_URL);
  if (!response.ok) {
    throw new Error(`Failed to fetch Apple JWKS: ${response.status}`);
  }

  const { keys } = (await response.json()) as { keys: AppleJWK[] };
  cachedKeys = { keys, fetchedAt: Date.now() };
  return keys;
}

function jwkToPem(jwk: AppleJWK): string {
  const key = createPublicKey({ key: jwk, format: 'jwk' });
  return key.export({ type: 'spki', format: 'pem' }) as string;
}

function verifyAppleJwt(token: string, pem: string): AppleEvent {
  const payload = jwt.verify(token, pem, {
    algorithms: ['RS256'],
    issuer: 'https://appleid.apple.com',
    audience: APPLE_CLIENT_ID,
  });
  if (typeof payload === 'string' || !payload) {
    throw new Error('Invalid JWT payload');
  }

  const events = (payload as Record<string, unknown>).events;
  if (typeof events === 'string') {
    return JSON.parse(events) as AppleEvent;
  }

  return events as AppleEvent;
}

async function handleAppleEvent(event: AppleEvent): Promise<void> {
  const { type, sub } = event;

  logExceptInTest(`Apple auth event: ${type} for sub=${sub}`);

  if (type === 'consent-revoked' || type === 'account-delete') {
    await db
      .delete(user_auth_provider)
      .where(
        and(
          eq(user_auth_provider.provider, 'apple'),
          eq(user_auth_provider.provider_account_id, sub)
        )
      );
    logExceptInTest(`Removed apple auth provider for sub=${sub} (${type})`);
  }
  // email-disabled and email-enabled are informational — no action needed
}

/**
 * Apple Sign in with Apple server-to-server notification endpoint.
 * Apple sends a POST with a signed JWT when users change their
 * account or email forwarding preferences.
 *
 * See: https://developer.apple.com/documentation/sign_in_with_apple/processing_changes_for_sign_in_with_apple_accounts
 */
export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();
    const payload = formData.get('payload');

    if (typeof payload !== 'string') {
      return NextResponse.json({ error: 'Missing payload' }, { status: 400 });
    }

    // Decode header to find the key ID
    const decoded = jwt.decode(payload, { complete: true });
    if (!decoded || typeof decoded === 'string') {
      return NextResponse.json({ error: 'Invalid JWT' }, { status: 400 });
    }

    const { kid } = decoded.header;
    if (!kid) {
      return NextResponse.json({ error: 'Missing kid in JWT header' }, { status: 400 });
    }

    // Fetch Apple's public keys and find the matching one
    const keys = await getApplePublicKeys();
    const matchingKey = keys.find(k => k.kid === kid);
    if (!matchingKey) {
      // Key not found — clear cache and retry once
      cachedKeys = null;
      const freshKeys = await getApplePublicKeys();
      const retryKey = freshKeys.find(k => k.kid === kid);
      if (!retryKey) {
        return NextResponse.json({ error: 'No matching Apple public key' }, { status: 400 });
      }
      const pem = jwkToPem(retryKey);
      const event = verifyAppleJwt(payload, pem);
      await handleAppleEvent(event);
      return NextResponse.json({ ok: true });
    }

    const pem = jwkToPem(matchingKey);
    const event = verifyAppleJwt(payload, pem);
    await handleAppleEvent(event);

    return NextResponse.json({ ok: true });
  } catch (error) {
    captureException(error);
    logExceptInTest(`Apple notification error: ${error}`);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
