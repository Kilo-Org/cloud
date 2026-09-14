import { z } from 'zod';

const jwtPayloadSchema = z.object({ kiloUserId: z.string().optional() });

/**
 * Best-effort read of the signed-in user id from a Kilo bearer token. The
 * token is a JWT whose payload carries `kiloUserId` (see `generateApiToken`
 * in apps/web/src/lib/tokens.ts). Decode-only: the server already accepted
 * the token, so the id is read without verifying the signature (the app has
 * no signing secret). Returns null for a non-JWT or malformed token so a
 * decode failure can never break sign-in.
 */
export function readUserIdFromToken(token: string): string | null {
  try {
    const segments = token.split('.');
    if (segments.length !== 3) {
      return null;
    }
    const payloadSegment = segments[1];
    if (payloadSegment === undefined) {
      return null;
    }
    const base64 = payloadSegment.replaceAll('-', '+').replaceAll('_', '/');
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=');
    const parsed = jwtPayloadSchema.safeParse(JSON.parse(atob(padded)));
    return parsed.success && parsed.data.kiloUserId ? parsed.data.kiloUserId : null;
  } catch {
    return null;
  }
}
