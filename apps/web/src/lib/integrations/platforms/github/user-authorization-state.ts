import 'server-only';

import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import {
  createOAuthState,
  OAUTH_STATE_TTL_SECONDS,
  verifyOAuthStateDetailed,
  type OAuthStateVerificationFailureReason,
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

export type GitHubUserAuthorizationStateResult =
  | { status: 'consumed'; codeVerifier: string }
  | {
      status: 'invalid';
      reason:
        | OAuthStateVerificationFailureReason
        | 'user_mismatch'
        | 'flow_mismatch'
        | 'payload_invalid'
        | 'verifier_missing';
    }
  | { status: 'storage_error'; reason: 'storage_unavailable' };

export async function consumeGitHubUserAuthorizationState(
  state: string | null,
  sessionUserId: string
): Promise<GitHubUserAuthorizationStateResult> {
  const verified = verifyOAuthStateDetailed(state);
  if (verified.status === 'invalid') return verified;
  if (verified.state.userId !== sessionUserId) {
    return { status: 'invalid', reason: 'user_mismatch' };
  }
  if (!verified.state.owner.startsWith(STATE_PREFIX)) {
    return { status: 'invalid', reason: 'flow_mismatch' };
  }

  const encodedPayload = verified.state.owner.slice(STATE_PREFIX.length);
  let verifierRef: string;
  try {
    const parsed = StatePayloadSchema.safeParse(
      JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'))
    );
    if (!parsed.success) return { status: 'invalid', reason: 'payload_invalid' };
    verifierRef = parsed.data.verifierRef;
  } catch {
    return { status: 'invalid', reason: 'payload_invalid' };
  }

  try {
    const codeVerifier = await redisClient.getdel<string>(
      githubUserAuthorizationPkceRedisKey(verifierRef)
    );
    return codeVerifier
      ? { status: 'consumed', codeVerifier }
      : { status: 'invalid', reason: 'verifier_missing' };
  } catch {
    return { status: 'storage_error', reason: 'storage_unavailable' };
  }
}
