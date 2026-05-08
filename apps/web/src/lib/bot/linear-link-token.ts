import 'server-only';
import crypto from 'node:crypto';
import { NEXTAUTH_SECRET } from '@/lib/config.server';

// Linear link tokens are embedded in public Linear issue comments, so anyone
// in the workspace can see the URL. We sign a short-lived payload that binds
// the link to a specific platform integration; the payload deliberately does
// NOT carry any Linear user id. The clicker proves which Linear identity to
// link by completing a fresh Linear OAuth round-trip from `/linear/link`.

const HMAC_ALGORITHM = 'sha256';
const TOKEN_TTL_SECONDS = 30 * 60;
const NONCE_BYTES = 16;

type LinearLinkTokenPayload = {
  platformIntegrationId: string;
  organizationId: string;
  iat: number;
  nonce: string;
};

export type VerifiedLinearLinkToken = {
  platformIntegrationId: string;
  organizationId: string;
};

function sign(data: string): string {
  return crypto.createHmac(HMAC_ALGORITHM, NEXTAUTH_SECRET).update(data).digest('base64url');
}

export function createLinearLinkToken(params: {
  platformIntegrationId: string;
  organizationId: string;
}): string {
  const payload: LinearLinkTokenPayload = {
    platformIntegrationId: params.platformIntegrationId,
    organizationId: params.organizationId,
    iat: Math.floor(Date.now() / 1000),
    nonce: crypto.randomBytes(NONCE_BYTES).toString('base64url'),
  };
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${encodedPayload}.${sign(encodedPayload)}`;
}

export function verifyLinearLinkToken(token: string | null): VerifiedLinearLinkToken | null {
  if (!token) return null;

  const dotIndex = token.indexOf('.');
  if (dotIndex === -1) return null;

  const encodedPayload = token.slice(0, dotIndex);
  const providedSig = token.slice(dotIndex + 1);
  const expectedSig = sign(encodedPayload);

  if (
    providedSig.length !== expectedSig.length ||
    !crypto.timingSafeEqual(Buffer.from(providedSig), Buffer.from(expectedSig))
  ) {
    return null;
  }

  try {
    const data = JSON.parse(
      Buffer.from(encodedPayload, 'base64url').toString('utf8')
    ) as Partial<LinearLinkTokenPayload>;

    if (typeof data.platformIntegrationId !== 'string' || data.platformIntegrationId.length === 0) {
      return null;
    }
    if (typeof data.organizationId !== 'string' || data.organizationId.length === 0) return null;
    if (typeof data.iat !== 'number') return null;
    if (typeof data.nonce !== 'string' || data.nonce.length === 0) return null;

    const ageSeconds = Math.floor(Date.now() / 1000) - data.iat;
    if (ageSeconds < 0 || ageSeconds > TOKEN_TTL_SECONDS) return null;

    return {
      platformIntegrationId: data.platformIntegrationId,
      organizationId: data.organizationId,
    };
  } catch {
    return null;
  }
}
