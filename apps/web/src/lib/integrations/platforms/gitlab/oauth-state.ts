import 'server-only';

import { z } from 'zod';
import { createOAuthState, verifyOAuthState } from '@/lib/integrations/oauth-state';
import { validateReturnPath } from '@/lib/integrations/validate-return-path';

const GITLAB_OAUTH_STATE_PREFIX = 'gitlab:';

export const DEFAULT_GITLAB_OAUTH_INSTANCE_URL = 'https://gitlab.com';

function isHttpInstanceUrl(value: string): boolean {
  try {
    const protocol = new URL(value).protocol;
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

const GitLabOAuthStatePayloadSchema = z.object({
  owner: z.discriminatedUnion('type', [
    z.object({ type: z.literal('user'), id: z.string().min(1) }),
    z.object({ type: z.literal('org'), id: z.string().min(1) }),
  ]),
  instanceUrl: z.string().url().refine(isHttpInstanceUrl).optional(),
  customCredentialsRef: z.string().min(1).optional(),
  returnTo: z
    .string()
    .refine(value => validateReturnPath(value) !== null)
    .optional(),
});

export type GitLabOAuthStatePayload = z.infer<typeof GitLabOAuthStatePayloadSchema>;

export type VerifiedGitLabOAuthState = Omit<GitLabOAuthStatePayload, 'instanceUrl'> & {
  instanceUrl: string;
  userId: string;
};

export function createGitLabOAuthState(payload: GitLabOAuthStatePayload, userId: string): string {
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return createOAuthState(`${GITLAB_OAUTH_STATE_PREFIX}${encodedPayload}`, userId);
}

export function verifyGitLabOAuthState(state: string | null): VerifiedGitLabOAuthState | null {
  const verified = verifyOAuthState(state);
  if (!verified?.owner.startsWith(GITLAB_OAUTH_STATE_PREFIX)) return null;

  const encodedPayload = verified.owner.slice(GITLAB_OAUTH_STATE_PREFIX.length);
  if (!encodedPayload) return null;

  try {
    const decodedJson = Buffer.from(encodedPayload, 'base64url').toString('utf8');
    const parsed = GitLabOAuthStatePayloadSchema.safeParse(JSON.parse(decodedJson));
    if (!parsed.success) return null;

    return {
      ...parsed.data,
      instanceUrl: parsed.data.instanceUrl ?? DEFAULT_GITLAB_OAUTH_INSTANCE_URL,
      userId: verified.userId,
    };
  } catch {
    return null;
  }
}
