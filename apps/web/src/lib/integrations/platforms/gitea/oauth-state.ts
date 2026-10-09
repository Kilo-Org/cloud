import 'server-only';

import { z } from 'zod';
import { createOAuthState, verifyOAuthState } from '@/lib/integrations/oauth-state';
import { validateReturnPath } from '@/lib/integrations/validate-return-path';

const GITEA_OAUTH_STATE_PREFIX = 'gitea:';

export const DEFAULT_GITEA_OAUTH_INSTANCE_URL = 'https://gitea.com';

function isHttpsInstanceUrl(value: string): boolean {
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

const GiteaOAuthStatePayloadSchema = z.object({
  owner: z.discriminatedUnion('type', [
    z.object({ type: z.literal('user'), id: z.string().min(1) }),
    z.object({ type: z.literal('org'), id: z.string().min(1) }),
  ]),
  instanceUrl: z.string().url().refine(isHttpsInstanceUrl).optional(),
  customCredentialsRef: z.string().min(1).optional(),
  returnTo: z
    .string()
    .refine(value => validateReturnPath(value) !== null)
    .optional(),
});

export type GiteaOAuthStatePayload = z.infer<typeof GiteaOAuthStatePayloadSchema>;

export type VerifiedGiteaOAuthState = Omit<GiteaOAuthStatePayload, 'instanceUrl'> & {
  instanceUrl: string;
  userId: string;
};

export function createGiteaOAuthState(payload: GiteaOAuthStatePayload, userId: string): string {
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return createOAuthState(`${GITEA_OAUTH_STATE_PREFIX}${encodedPayload}`, userId);
}

export function verifyGiteaOAuthState(state: string | null): VerifiedGiteaOAuthState | null {
  const verified = verifyOAuthState(state);
  if (!verified?.owner.startsWith(GITEA_OAUTH_STATE_PREFIX)) return null;

  const encodedPayload = verified.owner.slice(GITEA_OAUTH_STATE_PREFIX.length);
  if (!encodedPayload) return null;

  try {
    const decodedJson = Buffer.from(encodedPayload, 'base64url').toString('utf8');
    const parsed = GiteaOAuthStatePayloadSchema.safeParse(JSON.parse(decodedJson));
    if (!parsed.success) return null;

    return {
      ...parsed.data,
      instanceUrl: parsed.data.instanceUrl ?? DEFAULT_GITEA_OAUTH_INSTANCE_URL,
      userId: verified.userId,
    };
  } catch {
    return null;
  }
}
