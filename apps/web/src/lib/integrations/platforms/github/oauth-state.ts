import 'server-only';
import crypto from 'node:crypto';
import { GITHUB_OAUTH_STATE_SECRET } from '@/lib/config.server';

const HMAC_ALGORITHM = 'sha256';

/** Maximum age of a state token in seconds (10 minutes). */
const STATE_TTL_SECONDS = 10 * 60;

/** Number of random bytes for the nonce (16 bytes = 128 bits). */
const NONCE_BYTES = 16;

function sign(data: string): string {
  return crypto
    .createHmac(HMAC_ALGORITHM, GITHUB_OAUTH_STATE_SECRET)
    .update(data)
    .digest('base64url');
}

export type OAuthStatePayload = {
  kilo_user_id: string;
  app_type: 'standard' | 'lite';
  return_to: string;
  nonce: string;
  expires_at: number;
};

/**
 * Build a signed OAuth state parameter for the GitHub user-connect flow.
 *
 * The state binds the flow to the Kilo user who initiated it and carries
 * the return path. Format:
 *
 *   base64url(payload) . HMAC-SHA256(payload, secret)
 */
export function createOAuthState({
  kilo_user_id,
  app_type,
  return_to,
}: {
  kilo_user_id: string;
  app_type: 'standard' | 'lite';
  return_to?: string;
}): string {
  const expires_at = Math.floor(Date.now() / 1000) + STATE_TTL_SECONDS;
  const nonce = crypto.randomBytes(NONCE_BYTES).toString('base64url');
  const payloadObj: OAuthStatePayload = {
    kilo_user_id,
    app_type,
    return_to: safeReturnTo(return_to),
    nonce,
    expires_at,
  };
  const payload = Buffer.from(JSON.stringify(payloadObj)).toString('base64url');
  const signature = sign(payload);
  return `${payload}.${signature}`;
}

/**
 * Verify a signed OAuth state parameter and return the decoded payload.
 *
 * Returns `null` if the state is missing, malformed, the signature is
 * invalid, or the token has expired.
 */
export function verifyOAuthState(state: string | null): OAuthStatePayload | null {
  if (!state) return null;

  const dotIndex = state.indexOf('.');
  if (dotIndex === -1) return null;

  const payload = state.slice(0, dotIndex);
  const providedSig = state.slice(dotIndex + 1);

  const expectedSig = sign(payload);
  if (
    providedSig.length !== expectedSig.length ||
    !crypto.timingSafeEqual(Buffer.from(providedSig), Buffer.from(expectedSig))
  ) {
    return null;
  }

  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      kilo_user_id?: string;
      app_type?: string;
      return_to?: string;
      nonce?: string;
      expires_at?: number;
    };

    if (
      typeof data.kilo_user_id !== 'string' ||
      typeof data.nonce !== 'string' ||
      data.nonce.length === 0 ||
      typeof data.expires_at !== 'number' ||
      (data.app_type !== 'standard' && data.app_type !== 'lite')
    ) {
      return null;
    }

    if (Math.floor(Date.now() / 1000) > data.expires_at) {
      return null;
    }

    return {
      kilo_user_id: data.kilo_user_id,
      app_type: data.app_type,
      return_to: safeReturnTo(data.return_to),
      nonce: data.nonce,
      expires_at: data.expires_at,
    };
  } catch {
    return null;
  }
}

/**
 * Validate a return-to path for open-redirect protection.
 *
 * Only relative paths starting with `/` are accepted. Everything else
 * falls back to `/account/integrations`.
 */
export function safeReturnTo(return_to: string | undefined | null): string {
  if (typeof return_to !== 'string') return '/account/integrations';
  if (!return_to.startsWith('/')) return '/account/integrations';
  // Reject protocol-relative, javascript:, data:, etc.
  if (return_to.startsWith('//')) return '/account/integrations';
  try {
    const parsed = new URL(return_to, 'http://localhost');
    if (parsed.protocol !== 'http:' || parsed.host !== 'localhost') {
      // If the string parsed into an absolute URL with a different host,
      // it means it contained something like `https://evil.com/…`
      return '/account/integrations';
    }
    return return_to;
  } catch {
    return '/account/integrations';
  }
}
