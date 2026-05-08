import 'server-only';
import crypto from 'node:crypto';
import { NEXTAUTH_SECRET } from '@/lib/config.server';

// GitHub link tokens are embedded in public issue/PR comments, so we cannot
// rely on the URL being visible only to the mentioned user. Instead, we sign
// a short-lived payload that binds the link to a specific platform integration.
// `/github/link` rejects tampered or mismatched tokens before starting the
// GitHub OAuth flow.

const HMAC_ALGORITHM = 'sha256';
const TOKEN_TTL_SECONDS = 30 * 60;
const NONCE_BYTES = 16;

type GitHubLinkTokenPayload = {
  platformIntegrationId: string;
  installationId: string;
  iat: number;
  nonce: string;
};

export type VerifiedGitHubLinkToken = {
  platformIntegrationId: string;
  installationId: string;
};

function sign(data: string): string {
  return crypto.createHmac(HMAC_ALGORITHM, NEXTAUTH_SECRET).update(data).digest('base64url');
}

export function createGitHubLinkToken(params: {
  platformIntegrationId: string;
  installationId: string;
}): string {
  const payload: GitHubLinkTokenPayload = {
    platformIntegrationId: params.platformIntegrationId,
    installationId: params.installationId,
    iat: Math.floor(Date.now() / 1000),
    nonce: crypto.randomBytes(NONCE_BYTES).toString('base64url'),
  };
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${encodedPayload}.${sign(encodedPayload)}`;
}

export function verifyGitHubLinkToken(token: string | null): VerifiedGitHubLinkToken | null {
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
    ) as Partial<GitHubLinkTokenPayload>;

    if (typeof data.platformIntegrationId !== 'string' || data.platformIntegrationId.length === 0) {
      return null;
    }
    if (typeof data.installationId !== 'string' || data.installationId.length === 0) return null;
    if (typeof data.iat !== 'number') return null;
    if (typeof data.nonce !== 'string' || data.nonce.length === 0) return null;

    const ageSeconds = Math.floor(Date.now() / 1000) - data.iat;
    if (ageSeconds < 0 || ageSeconds > TOKEN_TTL_SECONDS) return null;

    return {
      platformIntegrationId: data.platformIntegrationId,
      installationId: data.installationId,
    };
  } catch {
    return null;
  }
}
