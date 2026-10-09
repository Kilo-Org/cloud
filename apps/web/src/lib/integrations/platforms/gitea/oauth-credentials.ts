import 'server-only';

import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { OAUTH_STATE_TTL_SECONDS } from '@/lib/integrations/oauth-state';
import { redisClient } from '@kilocode/web-shared/lib/redis';
import { giteaOAuthCredentialsRedisKey } from '@kilocode/web-shared/lib/redis-keys';
import type { GiteaOAuthCredentials } from './adapter';

const GITEA_OAUTH_CREDENTIAL_REF_BYTES = 16;
const GITEA_OAUTH_CREDENTIALS_TTL_SECONDS = OAUTH_STATE_TTL_SECONDS + 5;

const GiteaOAuthCredentialsSchema = z.object({
  clientId: z.string().min(1),
  clientSecret: z.string().min(1),
});

export async function storeGiteaOAuthCredentials(
  credentials: GiteaOAuthCredentials
): Promise<string | null> {
  const credentialRef = randomBytes(GITEA_OAUTH_CREDENTIAL_REF_BYTES).toString('base64url');
  const stored = await redisClient.set(
    giteaOAuthCredentialsRedisKey(credentialRef),
    JSON.stringify(credentials),
    { ex: GITEA_OAUTH_CREDENTIALS_TTL_SECONDS }
  );

  return stored ? credentialRef : null;
}

export async function getGiteaOAuthCredentials(
  credentialRef: string
): Promise<GiteaOAuthCredentials | null> {
  const rawCredentials = await redisClient.get<string>(
    giteaOAuthCredentialsRedisKey(credentialRef)
  );
  if (!rawCredentials) return null;

  try {
    const parsed = GiteaOAuthCredentialsSchema.safeParse(JSON.parse(rawCredentials));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
