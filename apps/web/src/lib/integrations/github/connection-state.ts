import 'server-only';

import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import {
  createOAuthState,
  OAUTH_STATE_TTL_SECONDS,
  verifyOAuthStateDetailed,
} from '@/lib/integrations/oauth-state';
import { redisClient } from '@/lib/redis';
import { githubConnectionPkceRedisKey } from '@/lib/redis-keys';

const PREFIX = 'github-connection:';
const Payload = z.object({
  attemptId: z.uuid(),
  stage: z.enum(['discover', 'confirm']),
  verifierRef: z.string().min(1),
});

export async function createGitHubConnectionOAuthState(input: {
  attemptId: string;
  userId: string;
  stage: 'discover' | 'confirm';
}) {
  const verifier = randomBytes(32).toString('base64url');
  const verifierRef = randomBytes(16).toString('base64url');
  const stored = await redisClient.set(githubConnectionPkceRedisKey(verifierRef), verifier, {
    ex: OAUTH_STATE_TTL_SECONDS + 5,
  });
  if (!stored) throw new Error('GitHub connection requires configured transient state storage');
  const payload = Buffer.from(
    JSON.stringify({ attemptId: input.attemptId, stage: input.stage, verifierRef })
  ).toString('base64url');
  return {
    state: createOAuthState(`${PREFIX}${payload}`, input.userId),
    codeChallenge: createHash('sha256').update(verifier).digest('base64url'),
  };
}

export async function consumeGitHubConnectionOAuthState(state: string | null, userId: string) {
  const verified = verifyOAuthStateDetailed(state);
  if (
    verified.status === 'invalid' ||
    verified.state.userId !== userId ||
    !verified.state.owner.startsWith(PREFIX)
  )
    return null;
  try {
    const parsed = Payload.safeParse(
      JSON.parse(
        Buffer.from(verified.state.owner.slice(PREFIX.length), 'base64url').toString('utf8')
      )
    );
    if (!parsed.success) return null;
    const codeVerifier = await redisClient.getdel<string>(
      githubConnectionPkceRedisKey(parsed.data.verifierRef)
    );
    return codeVerifier ? { ...parsed.data, codeVerifier } : null;
  } catch {
    return null;
  }
}
