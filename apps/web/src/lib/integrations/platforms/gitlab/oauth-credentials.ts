import 'server-only';

import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { OAUTH_STATE_TTL_SECONDS } from '@/lib/integrations/oauth-state';
import { redisGet, redisSet } from '@/lib/redis';
import { gitLabOAuthCredentialsRedisKey } from '@/lib/redis-keys';
import type { GitLabOAuthCredentials } from './adapter';

const GITLAB_OAUTH_CREDENTIAL_REF_BYTES = 16;
// The Redis write completes before signed state is issued, so keep credentials
// available slightly longer than state to avoid a deadline-edge cache miss.
const GITLAB_OAUTH_CREDENTIALS_TTL_SECONDS = OAUTH_STATE_TTL_SECONDS + 5;

const GitLabOAuthCredentialsSchema = z.object({
  clientId: z.string().min(1),
  clientSecret: z.string().min(1),
});

export async function storeGitLabOAuthCredentials(
  credentials: GitLabOAuthCredentials
): Promise<string | null> {
  const credentialRef = randomBytes(GITLAB_OAUTH_CREDENTIAL_REF_BYTES).toString('base64url');
  const stored = await redisSet(
    gitLabOAuthCredentialsRedisKey(credentialRef),
    JSON.stringify(credentials),
    GITLAB_OAUTH_CREDENTIALS_TTL_SECONDS
  );

  return stored ? credentialRef : null;
}

export async function getGitLabOAuthCredentials(
  credentialRef: string
): Promise<GitLabOAuthCredentials | null> {
  const rawCredentials = await redisGet(gitLabOAuthCredentialsRedisKey(credentialRef));
  if (!rawCredentials) return null;

  try {
    const parsed = GitLabOAuthCredentialsSchema.safeParse(JSON.parse(rawCredentials));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
