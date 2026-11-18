import 'server-only';
import { createSignedToken, verifySignedToken } from '@/lib/signed-token';

// GitHub link tokens are embedded in public issue/PR comments, so we cannot
// rely on the URL being visible only to the mentioned user. Instead, we sign
// a short-lived payload that binds the link to a specific platform integration.
// `/github/link` rejects tampered or mismatched tokens before starting the
// GitHub OAuth flow.

const TOKEN_TTL_SECONDS = 30 * 60;

export type VerifiedGitHubLinkToken = {
  platformIntegrationId: string;
  installationId: string;
};

function parseGitHubLinkToken(payload: Record<string, unknown>): VerifiedGitHubLinkToken | null {
  if (
    typeof payload.platformIntegrationId !== 'string' ||
    payload.platformIntegrationId.length === 0
  ) {
    return null;
  }
  if (typeof payload.installationId !== 'string' || payload.installationId.length === 0) {
    return null;
  }
  return {
    platformIntegrationId: payload.platformIntegrationId,
    installationId: payload.installationId,
  };
}

export function createGitHubLinkToken(params: {
  platformIntegrationId: string;
  installationId: string;
}): string {
  return createSignedToken({
    platformIntegrationId: params.platformIntegrationId,
    installationId: params.installationId,
  });
}

export function verifyGitHubLinkToken(token: string | null): VerifiedGitHubLinkToken | null {
  return verifySignedToken(token, { ttlSeconds: TOKEN_TTL_SECONDS, parse: parseGitHubLinkToken });
}
