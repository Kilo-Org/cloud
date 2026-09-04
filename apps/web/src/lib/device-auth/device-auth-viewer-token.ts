import 'server-only';
import { createSignedToken, verifySignedToken } from '@/lib/signed-token';

const VIEWER_TOKEN_TTL_SECONDS = 10 * 60;

export type VerifiedDeviceAuthViewerToken = {
  code: string;
  userId: string;
};

function parseDeviceAuthViewerToken(
  payload: Record<string, unknown>
): VerifiedDeviceAuthViewerToken | null {
  if (typeof payload.code !== 'string' || payload.code.length === 0) return null;
  if (typeof payload.userId !== 'string' || payload.userId.length === 0) return null;
  return { code: payload.code, userId: payload.userId };
}

export function createDeviceAuthViewerToken(code: string, userId: string): string {
  return createSignedToken({ code, userId });
}

export function verifyDeviceAuthViewerToken(
  token: string | null
): VerifiedDeviceAuthViewerToken | null {
  return verifySignedToken(token, {
    ttlSeconds: VIEWER_TOKEN_TTL_SECONDS,
    parse: parseDeviceAuthViewerToken,
  });
}
