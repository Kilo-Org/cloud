import 'server-only';

import { GIT_TOKEN_SERVICE_API_URL } from '@/lib/config.server';
import { generateBoundedInternalServiceToken, TOKEN_EXPIRY } from '@/lib/tokens';
import { GITHUB_USER_AUTHORIZATION_DISCONNECT_AUDIENCE } from '@kilocode/worker-utils/internal-service-token-audiences';

export async function disconnectStoredGitHubUserAuthorization(kiloUserId: string): Promise<void> {
  if (!GIT_TOKEN_SERVICE_API_URL) {
    throw new Error('Git token service disconnect is not configured');
  }

  const token = generateBoundedInternalServiceToken(kiloUserId, {
    audience: GITHUB_USER_AUTHORIZATION_DISCONNECT_AUDIENCE,
    expiresIn: TOKEN_EXPIRY.fiveMinutes,
  });
  let response: Response;
  try {
    response = await fetch(
      `${GIT_TOKEN_SERVICE_API_URL}/internal/github-user-authorizations/disconnect`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      }
    );
  } catch {
    throw new Error('GitHub authorization disconnect request failed');
  }

  if (!response.ok) {
    throw new Error(`GitHub authorization disconnect failed (${response.status})`);
  }
}
