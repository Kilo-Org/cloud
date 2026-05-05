import 'server-only';
import crypto from 'node:crypto';
import { NEXTAUTH_SECRET } from '@/lib/config.server';

const HMAC_ALGORITHM = 'sha256';
const STATE_TTL_SECONDS = 10 * 60;
const NONCE_BYTES = 16;

type GitHubBotLinkStatePayload = {
  userId: string;
  installationId: string;
  callbackPath: string;
  iat: number;
  nonce: string;
};

export type VerifiedGitHubBotLinkState = {
  userId: string;
  installationId: string;
  callbackPath: string;
};

function sign(data: string): string {
  return crypto.createHmac(HMAC_ALGORITHM, NEXTAUTH_SECRET).update(data).digest('base64url');
}

export function createGitHubBotLinkState(
  userId: string,
  installationId: string,
  callbackPath = '/github/link'
): string {
  const payload: GitHubBotLinkStatePayload = {
    userId,
    installationId,
    callbackPath,
    iat: Math.floor(Date.now() / 1000),
    nonce: crypto.randomBytes(NONCE_BYTES).toString('base64url'),
  };
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${encodedPayload}.${sign(encodedPayload)}`;
}

export function verifyGitHubBotLinkState(state: string | null): VerifiedGitHubBotLinkState | null {
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
    const data = JSON.parse(
      Buffer.from(payload, 'base64url').toString('utf8')
    ) as Partial<GitHubBotLinkStatePayload>;

    if (typeof data.userId !== 'string') return null;
    if (typeof data.installationId !== 'string' || data.installationId.length === 0) return null;
    if (typeof data.callbackPath !== 'string' || !data.callbackPath.startsWith('/')) return null;
    if (typeof data.iat !== 'number') return null;
    if (typeof data.nonce !== 'string' || data.nonce.length === 0) return null;

    const ageSeconds = Math.floor(Date.now() / 1000) - data.iat;
    if (ageSeconds < 0 || ageSeconds > STATE_TTL_SECONDS) return null;

    return {
      userId: data.userId,
      installationId: data.installationId,
      callbackPath: data.callbackPath,
    };
  } catch {
    return null;
  }
}
