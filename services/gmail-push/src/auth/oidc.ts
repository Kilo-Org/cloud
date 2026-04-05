import { jwtVerify, createRemoteJWKSet } from 'jose';

const GOOGLE_ISSUER = 'https://accounts.google.com';
const GOOGLE_JWKS_URL = new URL('https://www.googleapis.com/oauth2/v3/certs');

let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;

function getJwks() {
  if (!jwks) {
    jwks = createRemoteJWKSet(GOOGLE_JWKS_URL);
  }
  return jwks;
}

export type OidcResult = { valid: true; email: string } | { valid: false; error: string };

export async function validateOidcToken(
  authHeader: string | null | undefined,
  expectedAudience: string,
  allowedEmail: string
): Promise<OidcResult> {
  if (!authHeader) {
    return { valid: false, error: 'Missing authorization header' };
  }

  if (!authHeader.startsWith('Bearer ')) {
    return { valid: false, error: 'Invalid authorization scheme' };
  }

  const token = authHeader.slice(7).trim();
  if (!token) {
    return { valid: false, error: 'Empty token' };
  }

  try {
    const { payload } = await jwtVerify(token, getJwks(), {
      issuer: GOOGLE_ISSUER,
      audience: expectedAudience,
    });

    const email = payload.email as string | undefined;
    if (!email) {
      return { valid: false, error: 'Missing email claim' };
    }
    if (!payload.email_verified) {
      return { valid: false, error: 'Email not verified' };
    }
    if (email !== allowedEmail) {
      return { valid: false, error: `Unexpected email: ${email}` };
    }

    return { valid: true, email };
  } catch (err) {
    return { valid: false, error: err instanceof Error ? err.message : 'JWT verification failed' };
  }
}

/** Reset cached JWKS (for tests). */
export function _resetJwks(): void {
  jwks = null;
}
