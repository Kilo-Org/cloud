import 'server-only';

import { z } from 'zod';
import { createOAuthState, verifyOAuthState } from '@/lib/integrations/oauth-state';
import { GoogleCapabilitySchema } from './capabilities';

const GOOGLE_OAUTH_STATE_PREFIX = 'google:';

const GoogleOAuthStatePayloadSchema = z.object({
  owner: z.discriminatedUnion('type', [
    z.object({ type: z.literal('user'), id: z.string().min(1) }),
    z.object({ type: z.literal('org'), id: z.string().uuid() }),
  ]),
  instanceId: z.string().uuid(),
  capabilities: z.array(GoogleCapabilitySchema).min(1),
});

export type GoogleOAuthStatePayload = z.infer<typeof GoogleOAuthStatePayloadSchema>;

export type VerifiedGoogleOAuthState = GoogleOAuthStatePayload & {
  userId: string;
};

export function createGoogleOAuthState(payload: GoogleOAuthStatePayload, userId: string): string {
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return createOAuthState(`${GOOGLE_OAUTH_STATE_PREFIX}${encodedPayload}`, userId);
}

export function verifyGoogleOAuthState(state: string | null): VerifiedGoogleOAuthState | null {
  const verified = verifyOAuthState(state);
  if (!verified) return null;

  if (!verified.owner.startsWith(GOOGLE_OAUTH_STATE_PREFIX)) {
    return null;
  }

  const encodedPayload = verified.owner.slice(GOOGLE_OAUTH_STATE_PREFIX.length);
  if (!encodedPayload) return null;

  try {
    const decodedJson = Buffer.from(encodedPayload, 'base64url').toString('utf8');
    const parsed = GoogleOAuthStatePayloadSchema.safeParse(JSON.parse(decodedJson));
    if (!parsed.success) return null;

    return {
      ...parsed.data,
      userId: verified.userId,
    };
  } catch {
    return null;
  }
}
