import 'server-only';
import { createSignedToken, verifySignedToken } from '@/lib/signed-token';

const STATE_TTL_SECONDS = 10 * 60;

export type VerifiedGitHubBotLinkState = {
  userId: string;
  installationId: string;
  callbackPath: string;
};

function parseGitHubBotLinkState(
  payload: Record<string, unknown>
): VerifiedGitHubBotLinkState | null {
  if (typeof payload.userId !== 'string') return null;
  if (typeof payload.installationId !== 'string' || payload.installationId.length === 0) {
    return null;
  }
  if (typeof payload.callbackPath !== 'string' || !payload.callbackPath.startsWith('/')) {
    return null;
  }
  return {
    userId: payload.userId,
    installationId: payload.installationId,
    callbackPath: payload.callbackPath,
  };
}

export function createGitHubBotLinkState(
  userId: string,
  installationId: string,
  callbackPath = '/github/link'
): string {
  return createSignedToken({ userId, installationId, callbackPath });
}

export function verifyGitHubBotLinkState(state: string | null): VerifiedGitHubBotLinkState | null {
  return verifySignedToken(state, {
    ttlSeconds: STATE_TTL_SECONDS,
    parse: parseGitHubBotLinkState,
  });
}
