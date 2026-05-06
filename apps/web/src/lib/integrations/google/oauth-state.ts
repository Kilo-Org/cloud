import 'server-only';

import { z } from 'zod';
import { createOAuthState, verifyOAuthState } from '@/lib/integrations/oauth-state';
import { GoogleCapabilitySchema } from './capabilities';

const GOOGLE_OAUTH_STATE_PREFIX = 'google:';

// Constrain returnTo to a relative path so it can never be hijacked into an
// open-redirect to an external host. Must start with `/`, may contain a
// non-protocol-style path, optionally followed by a query string. Fragments
// are disallowed — buildGoogleRedirectPath / appendQueryParam append the
// success/error param using a `?` or `&` separator, and a fragment in the
// returnTo would push the appended param past the `#` where browsers ignore
// it. Disallows `//` after the leading slash so we don't accidentally accept
// protocol-relative URLs like `//evil.example.com`.
const RETURN_TO_REGEX = /^\/(?!\/)[^?#]*(\?[^#]*)?$/;

const GoogleOAuthStatePayloadSchema = z.object({
  owner: z.discriminatedUnion('type', [
    z.object({ type: z.literal('user'), id: z.string().min(1) }),
    z.object({ type: z.literal('org'), id: z.string().uuid() }),
  ]),
  instanceId: z.string().uuid(),
  capabilities: z.array(GoogleCapabilitySchema).min(1),
  returnTo: z.string().regex(RETURN_TO_REGEX).max(2048).optional(),
});

export const GOOGLE_OAUTH_RETURN_TO_REGEX = RETURN_TO_REGEX;

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
