import 'server-only';
import crypto from 'node:crypto';
import { NEXTAUTH_SECRET } from '@/lib/config.server';

const HMAC_ALGORITHM = 'sha256';
const TOKEN_TTL_SECONDS = 30 * 60;
const NONCE_BYTES = 16;

type GitLabLinkTokenPayload = {
  platformIntegrationId: string;
  integrationId: string;
  iat: number;
  nonce: string;
};

export type VerifiedGitLabLinkToken = {
  platformIntegrationId: string;
  integrationId: string;
};

function sign(data: string): string {
  return crypto.createHmac(HMAC_ALGORITHM, NEXTAUTH_SECRET).update(data).digest('base64url');
}

export function createGitLabLinkToken(params: {
  platformIntegrationId: string;
  integrationId: string;
}): string {
  const payload: GitLabLinkTokenPayload = {
    platformIntegrationId: params.platformIntegrationId,
    integrationId: params.integrationId,
    iat: Math.floor(Date.now() / 1000),
    nonce: crypto.randomBytes(NONCE_BYTES).toString('base64url'),
  };
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${encodedPayload}.${sign(encodedPayload)}`;
}

export function verifyGitLabLinkToken(token: string | null): VerifiedGitLabLinkToken | null {
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
    ) as Partial<GitLabLinkTokenPayload>;

    if (typeof data.platformIntegrationId !== 'string' || data.platformIntegrationId.length === 0) {
      return null;
    }
    if (typeof data.integrationId !== 'string' || data.integrationId.length === 0) return null;
    if (typeof data.iat !== 'number') return null;
    if (typeof data.nonce !== 'string' || data.nonce.length === 0) return null;

    const ageSeconds = Math.floor(Date.now() / 1000) - data.iat;
    if (ageSeconds < 0 || ageSeconds > TOKEN_TTL_SECONDS) return null;

    return {
      platformIntegrationId: data.platformIntegrationId,
      integrationId: data.integrationId,
    };
  } catch {
    return null;
  }
}
