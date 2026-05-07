import 'server-only';

import { z } from 'zod';
import { createOAuthState, verifyOAuthState } from '@/lib/integrations/oauth-state';
import { GoogleCapabilitySchema } from './capabilities';

const GOOGLE_OAUTH_STATE_PREFIX = 'google:';

// Constrain returnTo to a relative path so it can never be hijacked into an
// open-redirect to an external host. Must start with `/`, may contain a
// non-protocol-style path, optionally followed by a query string. Fragments
// are disallowed because the helpers in callback/route.ts append the
// success/error param using a `?`/`&` separator and a fragment in the
// returnTo would push the appended param past `#` where browsers ignore it.
// `//` and `/\` after the leading slash are disallowed to block protocol-
// relative URLs and backslash-injection paths (WHATWG URL parsing for the
// https scheme treats `\` as a path separator, so `/\evil.example.com/x`
// would normalize to https://evil.example.com/x). Backslashes anywhere in
// the body are also rejected for the same reason.
const RETURN_TO_REGEX = /^\/(?![\\/])[^\\?#]*(\?[^#]*)?$/;

/**
 * Defense-in-depth check that catches percent-encoded path-traversal
 * segments which the regex alone would let through. Even though
 * RETURN_TO_REGEX rejects external hosts, a crafted `/foo/../admin` or
 * `/foo/%2e%2e/admin` would still resolve to `/admin` after URL
 * normalization in the callback. Decoding once before splitting catches
 * `%2e`, `%2E`, and any other encoded variant.
 */
export function returnToHasPathTraversal(value: string): boolean {
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    // Malformed percent-encoding is itself suspicious — treat as traversal
    // so the value is rejected.
    return true;
  }
  const pathOnly = decoded.split('?')[0] ?? '';
  return pathOnly.split('/').some(segment => segment === '..' || segment === '.');
}

// C0 control characters (U+0000–U+001F) and DEL (U+007F). WHATWG URL parsing
// strips these silently, so a crafted `/%0A/evil.example.com/path` would
// pass a string-shape check yet normalize to `https://evil.example.com/path`
// after `new URL(value, APP_URL)` in the callback.
// eslint-disable-next-line no-control-regex
const RETURN_TO_CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/**
 * Single source of truth for whether a `returnTo` value is safe to bake
 * into the signed OAuth state and later pass through `new URL(...)` in the
 * callback. The connect route and the Zod state schema both call this so
 * validation cannot drift between them.
 */
export function isSafeGoogleOAuthReturnTo(value: string): boolean {
  return (
    value.length <= 2048 &&
    RETURN_TO_REGEX.test(value) &&
    !RETURN_TO_CONTROL_CHARS.test(value) &&
    !returnToHasPathTraversal(value)
  );
}

const GoogleOAuthStatePayloadSchema = z.object({
  owner: z.discriminatedUnion('type', [
    z.object({ type: z.literal('user'), id: z.string().min(1) }),
    z.object({ type: z.literal('org'), id: z.string().uuid() }),
  ]),
  instanceId: z.string().uuid(),
  capabilities: z.array(GoogleCapabilitySchema).min(1),
  returnTo: z
    .string()
    .refine(isSafeGoogleOAuthReturnTo, 'returnTo failed safety validation')
    .optional(),
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
