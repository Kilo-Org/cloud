import 'server-only';

import { z } from 'zod';
import { createOAuthState, verifyOAuthState } from '@/lib/integrations/oauth-state';
import { validateReturnPath } from '@/lib/integrations/validate-return-path';

const FORGEJO_OAUTH_STATE_PREFIX = 'forgejo:';

export const DEFAULT_FORGEJO_OAUTH_INSTANCE_URL = 'https://codeberg.org';

function isHttpsInstanceUrl(value: string): boolean {
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

const ForgejoOAuthStatePayloadSchema = z.object({
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

export type ForgejoOAuthStatePayload = z.infer<typeof ForgejoOAuthStatePayloadSchema>;

export type VerifiedForgejoOAuthState = Omit<ForgejoOAuthStatePayload, 'instanceUrl'> & {
  instanceUrl: string;
  userId: string;
};

export function createForgejoOAuthState(payload: ForgejoOAuthStatePayload, userId: string): string {
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return createOAuthState(`${FORGEJO_OAUTH_STATE_PREFIX}${encodedPayload}`, userId);
}

export function verifyForgejoOAuthState(state: string | null): VerifiedForgejoOAuthState | null {
  const verified = verifyOAuthState(state);
  if (!verified?.owner.startsWith(FORGEJO_OAUTH_STATE_PREFIX)) return null;

  const encodedPayload = verified.owner.slice(FORGEJO_OAUTH_STATE_PREFIX.length);
  if (!encodedPayload) return null;

  try {
    const decodedJson = Buffer.from(encodedPayload, 'base64url').toString('utf8');
    const parsed = ForgejoOAuthStatePayloadSchema.safeParse(JSON.parse(decodedJson));
    if (!parsed.success) return null;

    return {
      ...parsed.data,
      instanceUrl: parsed.data.instanceUrl ?? DEFAULT_FORGEJO_OAUTH_INSTANCE_URL,
      userId: verified.userId,
    };
  } catch {
    return null;
  }
}
