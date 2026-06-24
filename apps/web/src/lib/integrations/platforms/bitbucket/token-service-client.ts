import 'server-only';

import { z } from 'zod';
import { GIT_TOKEN_SERVICE_API_URL } from '@/lib/config.server';
import {
  BITBUCKET_REPOSITORY_LIST_AUDIENCE,
  generateInternalServiceToken,
  TOKEN_EXPIRY,
} from '@/lib/tokens';

export const BitbucketRepositorySchema = z
  .object({
    id: z.uuid(),
    workspaceUuid: z.uuid(),
    name: z.string().min(1),
    fullName: z.string().min(3),
    private: z.boolean(),
    defaultBranch: z.string().min(1).optional(),
  })
  .strict();

export const BitbucketRepositoryListResultSchema = z.discriminatedUnion('status', [
  z
    .object({ status: z.literal('available'), repositories: z.array(BitbucketRepositorySchema) })
    .strict(),
  z.object({ status: z.literal('invalid_request') }).strict(),
  z.object({ status: z.literal('not_connected') }).strict(),
  z.object({ status: z.literal('reconnect_required') }).strict(),
  z.object({ status: z.literal('insufficient_permissions') }).strict(),
  z.object({ status: z.literal('temporarily_unavailable') }).strict(),
]);

export type BitbucketRepository = z.infer<typeof BitbucketRepositorySchema>;
export type BitbucketRepositoryListResult = z.infer<typeof BitbucketRepositoryListResultSchema>;

export async function fetchBitbucketRepositoriesFromTokenService(
  kiloUserId: string,
  organizationId?: string
): Promise<BitbucketRepositoryListResult> {
  if (!GIT_TOKEN_SERVICE_API_URL) return { status: 'temporarily_unavailable' };
  const serviceToken = generateInternalServiceToken(kiloUserId, {
    expiresIn: TOKEN_EXPIRY.fiveMinutes,
    audience: BITBUCKET_REPOSITORY_LIST_AUDIENCE,
    organizationId,
  });

  let response: Response;
  try {
    response = await fetch(`${GIT_TOKEN_SERVICE_API_URL}/internal/bitbucket/repositories`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${serviceToken}`,
      },
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    return { status: 'temporarily_unavailable' };
  }
  if (!response.ok) return { status: 'temporarily_unavailable' };

  try {
    const parsed = BitbucketRepositoryListResultSchema.safeParse(await response.json());
    return parsed.success ? parsed.data : { status: 'temporarily_unavailable' };
  } catch {
    return { status: 'temporarily_unavailable' };
  }
}

export function fetchBitbucketWorkspaceAccessTokenRepositoriesFromTokenService(
  kiloUserId: string,
  organizationId: string
): Promise<BitbucketRepositoryListResult> {
  return fetchBitbucketRepositoriesFromTokenService(kiloUserId, organizationId);
}
