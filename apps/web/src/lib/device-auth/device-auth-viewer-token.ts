import 'server-only';
import crypto from 'node:crypto';
import { NEXTAUTH_SECRET } from '@/lib/config.server';

const HMAC_ALGORITHM = 'sha256';
const VIEWER_TOKEN_TTL_SECONDS = 10 * 60;
const NONCE_BYTES = 16;

type DeviceAuthViewerTokenPayload = {
  code: string;
  userId: string;
  iat: number;
  nonce: string;
};

export type VerifiedDeviceAuthViewerToken = {
  code: string;
  userId: string;
};

function sign(data: string): string {
  return crypto.createHmac(HMAC_ALGORITHM, NEXTAUTH_SECRET).update(data).digest('base64url');
}

export function createDeviceAuthViewerToken(code: string, userId: string): string {
  const payload: DeviceAuthViewerTokenPayload = {
    code,
    userId,
    iat: Math.floor(Date.now() / 1000),
    nonce: crypto.randomBytes(NONCE_BYTES).toString('base64url'),
  };
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${encodedPayload}.${sign(encodedPayload)}`;
}

export function verifyDeviceAuthViewerToken(
  token: string | null
): VerifiedDeviceAuthViewerToken | null {
  if (!token) return null;

  const dotIndex = token.indexOf('.');
  if (dotIndex === -1) return null;

  const payload = token.slice(0, dotIndex);
  const providedSig = token.slice(dotIndex + 1);
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
    ) as Partial<DeviceAuthViewerTokenPayload>;

    if (typeof data.code !== 'string' || data.code.length === 0) return null;
    if (typeof data.userId !== 'string' || data.userId.length === 0) return null;
    if (typeof data.iat !== 'number') return null;
    if (typeof data.nonce !== 'string' || data.nonce.length === 0) return null;

    const ageSeconds = Math.floor(Date.now() / 1000) - data.iat;
    if (ageSeconds < 0 || ageSeconds > VIEWER_TOKEN_TTL_SECONDS) return null;

    return {
      code: data.code,
      userId: data.userId,
    };
  } catch {
    return null;
  }
}
