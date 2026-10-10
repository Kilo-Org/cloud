import 'server-only';

import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { OAUTH_STATE_TTL_SECONDS } from '@/lib/integrations/oauth-state';
import { redisClient } from '@kilocode/web-shared/lib/redis';
import { forgejoOAuthCredentialsRedisKey } from '@kilocode/web-shared/lib/redis-keys';
import type { ForgejoOAuthCredentials } from './adapter';

const FORGEJO_OAUTH_CREDENTIAL_REF_BYTES = 16;
const FORGEJO_OAUTH_CREDENTIALS_TTL_SECONDS = OAUTH_STATE_TTL_SECONDS + 5;

const ForgejoOAuthCredentialsSchema = z.object({
  clientId: z.string().min(1),
  clientSecret: z.string().min(1),
});

export async function storeForgejoOAuthCredentials(
  credentials: ForgejoOAuthCredentials
): Promise<string | null> {
  const credentialRef = randomBytes(FORGEJO_OAUTH_CREDENTIAL_REF_BYTES).toString('base64url');
  const stored = await redisClient.set(
    forgejoOAuthCredentialsRedisKey(credentialRef),
    JSON.stringify(credentials),
    { ex: FORGEJO_OAUTH_CREDENTIALS_TTL_SECONDS }
  );

  return stored ? credentialRef : null;
}

export async function getForgejoOAuthCredentials(
  credentialRef: string
): Promise<ForgejoOAuthCredentials | null> {
  const rawCredentials = await redisClient.get<string>(
    forgejoOAuthCredentialsRedisKey(credentialRef)
  );
  if (!rawCredentials) return null;

  try {
    const parsed = ForgejoOAuthCredentialsSchema.safeParse(JSON.parse(rawCredentials));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
