import type { WastelandEnv } from '../wasteland.worker';
/**
 * Auth middleware that validates Kilo user JWTs (signed with NEXTAUTH_SECRET).
 * Used for dashboard/user-facing routes where the Next.js app sends a
 * Bearer token on behalf of the logged-in user.
 *
 * Sets `kiloUserId` on the Hono context.
 */
export declare const kiloAuthMiddleware: any;
