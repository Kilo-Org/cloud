import 'server-only';
import {
  GitHubIdentityPreconditionSchema,
  type GitHubIdentityPrecondition,
} from '@kilocode/db/github-identity';

import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import {
  createOAuthState,
  OAUTH_STATE_TTL_SECONDS,
  verifyOAuthStateDetailed,
  type OAuthStateVerificationFailureReason,
} from '@/lib/integrations/oauth-state';
import { redisClient } from '@kilocode/web-shared/lib/redis';
import { githubUserAuthorizationPkceRedisKey } from '@kilocode/web-shared/lib/redis-keys';

const STATE_PREFIX = 'github-user-authorization:';
const PKCE_TTL_SECONDS = OAUTH_STATE_TTL_SECONDS + 5;
const StatePayloadSchema = z.object({
  verifierRef: z.string().min(1),
  expected: GitHubIdentityPreconditionSchema,
});

export type GitHubUserAuthorizationState = {
  state: string;
  codeChallenge: string;
};

export async function createGitHubUserAuthorizationState(
  userId: string,
  expected: GitHubIdentityPrecondition
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

  const encodedPayload = Buffer.from(JSON.stringify({ verifierRef, expected })).toString(
    'base64url'
  );
  const state = createOAuthState(`${STATE_PREFIX}${encodedPayload}`, userId, undefined, {
    provider: 'github',
  });
  const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');

  return { state, codeChallenge };
}

export type GitHubUserAuthorizationStateResult =
  | { status: 'consumed'; codeVerifier: string; expected: GitHubIdentityPrecondition }
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
  if (verified.state.provider !== 'github') {
    return { status: 'invalid', reason: 'flow_mismatch' };
  }
  if (verified.state.userId !== sessionUserId) {
    return { status: 'invalid', reason: 'user_mismatch' };
  }
  if (!verified.state.owner.startsWith(STATE_PREFIX)) {
    return { status: 'invalid', reason: 'flow_mismatch' };
  }

  const encodedPayload = verified.state.owner.slice(STATE_PREFIX.length);
  let payload: z.infer<typeof StatePayloadSchema>;
  try {
    const parsed = StatePayloadSchema.safeParse(
      JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'))
    );
    if (!parsed.success) return { status: 'invalid', reason: 'payload_invalid' };
    payload = parsed.data;
  } catch {
    return { status: 'invalid', reason: 'payload_invalid' };
  }

  // The signed state carries the precondition. Redis holds only the PKCE verifier.
  try {
    const codeVerifier = await redisClient.getdel<string>(
      githubUserAuthorizationPkceRedisKey(payload.verifierRef)
    );
    if (!codeVerifier) return { status: 'invalid', reason: 'verifier_missing' };
    return { status: 'consumed', codeVerifier, expected: payload.expected };
  } catch {
    return { status: 'storage_error', reason: 'storage_unavailable' };
  }
}
