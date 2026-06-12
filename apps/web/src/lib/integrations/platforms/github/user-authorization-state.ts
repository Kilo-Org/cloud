import 'server-only';

import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import {
  createOAuthState,
  OAUTH_STATE_TTL_SECONDS,
  verifyOAuthState,
} from '@/lib/integrations/oauth-state';
import { redisClient } from '@/lib/redis';
import { githubUserAuthorizationPkceRedisKey } from '@/lib/redis-keys';

const STATE_PREFIX = 'github-user-authorization:';
const PKCE_TTL_SECONDS = OAUTH_STATE_TTL_SECONDS + 5;
const StatePayloadSchema = z.object({
  verifierRef: z.string().min(1),
});

export type GitHubUserAuthorizationState = {
  state: string;
  codeChallenge: string;
};

export async function createGitHubUserAuthorizationState(
  userId: string
): Promise<GitHubUserAuthorizationState> {
  const codeVerifier = randomBytes(32).toString('base64url');
  const verifierRef = randomBytes(16).toString('base64url');
  const stored = await redisClient.set(
    githubUserAuthorizationPkceRedisKey(verifierRef),
    codeVerifier,
    { ex: PKCE_TTL_SECONDS }
  );
  if (!stored) {
    throw new Error('GitHub user authorization requires configured transient state storage');
  }

  const encodedPayload = Buffer.from(JSON.stringify({ verifierRef })).toString('base64url');
  const state = createOAuthState(`${STATE_PREFIX}${encodedPayload}`, userId);
  const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');

  return { state, codeChallenge };
}

export async function consumeGitHubUserAuthorizationState(
  state: string | null,
  sessionUserId: string
): Promise<{ codeVerifier: string } | null> {
  const verified = verifyOAuthState(state);
  if (!verified || verified.userId !== sessionUserId || !verified.owner.startsWith(STATE_PREFIX)) {
    return null;
  }

  const encodedPayload = verified.owner.slice(STATE_PREFIX.length);
  try {
    const parsed = StatePayloadSchema.safeParse(
      JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'))
    );
    if (!parsed.success) return null;

    const codeVerifier = await redisClient.getdel<string>(
      githubUserAuthorizationPkceRedisKey(parsed.data.verifierRef)
    );
    return codeVerifier ? { codeVerifier } : null;
  } catch {
    return null;
  }
}
