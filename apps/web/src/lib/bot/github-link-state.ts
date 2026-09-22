import 'server-only';
import { createSignedToken, verifySignedToken } from '@/lib/signed-token';
import { z } from 'zod';

const STATE_TTL_SECONDS = 10 * 60;

export type VerifiedGitHubBotLinkState = {
  userId: string;
  installationId: string;
  callbackPath: string;
  githubAppType?: 'standard' | 'lite';
  platformIntegrationId?: string;
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
  if (
    payload.githubAppType !== undefined &&
    payload.githubAppType !== 'standard' &&
    payload.githubAppType !== 'lite'
  ) {
    return null;
  }
  if (
    payload.platformIntegrationId !== undefined &&
    !z.uuid().safeParse(payload.platformIntegrationId).success
  ) {
    return null;
  }
  return {
    userId: payload.userId,
    installationId: payload.installationId,
    callbackPath: payload.callbackPath,
    githubAppType: payload.githubAppType,
    platformIntegrationId: payload.platformIntegrationId as string | undefined,
  };
}

export function createGitHubBotLinkState(
  userId: string,
  installationId: string,
  callbackPath = '/github/link',
  githubAppType?: 'standard' | 'lite',
  platformIntegrationId?: string
): string {
  return createSignedToken({
    userId,
    installationId,
    callbackPath,
    githubAppType,
    platformIntegrationId,
  });
}

export function verifyGitHubBotLinkState(state: string | null): VerifiedGitHubBotLinkState | null {
  return verifySignedToken(state, {
    ttlSeconds: STATE_TTL_SECONDS,
    parse: parseGitHubBotLinkState,
  });
}
