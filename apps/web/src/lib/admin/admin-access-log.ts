import 'server-only';
import type { User } from '@kilocode/db/schema';
import { logExceptInTest } from '@/lib/utils.server';

/**
 * Per-request, identity-attributed audit telemetry for Kilocode admin access.
 *
 * This is structured-log telemetry (shipped to the Axiom `vercel` dataset via
 * stdout, same mechanism as `admin_login_succeeded`), NOT a database table. It
 * closes the blind spot where a compromised admin API token could read data
 * leaving only anonymous edge request logs.
 *
 * Two choke points emit the identical event schema so a single Axiom query can
 * union both surfaces:
 *   - `surface: "rest"`  — emitted in `getUserFromAuth` for `/admin/api/*`.
 *   - `surface: "trpc"`  — emitted in the `adminProcedure` middleware.
 *
 * Security: never include the token itself, the Authorization header, cookies,
 * or any secret in this event.
 */

export type AdminAccessSurface = 'rest' | 'trpc';

export type AdminAccessEvent = {
  event: 'admin_access';
  surface: AdminAccessSurface;
  kiloUserId: string;
  email: string;
  adminTier: 'super_admin' | 'platform_admin';
  /**
   * `"token"` when the request authenticated via an API bearer token (any
   * `Authorization` header), else `"session"` (web-console cookie). This is the
   * compromise discriminator; `tokenSource` below adds finer granularity.
   */
  authVia: 'token' | 'session';
  /** Set only for tokens that carry a source (e.g. `cloud-agent`); else null. */
  tokenSource: string | null;
  route: string | null;
  method: string | null;
  ip: string | null;
};

export type AdminAccessSink = (event: AdminAccessEvent) => void;

const defaultSink: AdminAccessSink = event => logExceptInTest(JSON.stringify(event));

let currentSink: AdminAccessSink = defaultSink;

/**
 * Test-only seam. `logExceptInTest` is a no-op in automated tests, so a test
 * cannot observe the default sink. Override it to capture emitted events, and
 * pass `null` to restore the production sink.
 */
export function setAdminAccessSinkForTest(sink: AdminAccessSink | null): void {
  currentSink = sink ?? defaultSink;
}

/**
 * Build and emit an `admin_access` event. Called from both admin choke points.
 */
export function emitAdminAccessEvent(params: {
  surface: AdminAccessSurface;
  user: Pick<User, 'id' | 'google_user_email' | 'is_super_admin'>;
  authViaToken: boolean;
  tokenSource: string | null;
  route: string | null;
  method: string | null;
  ip: string | null;
}): void {
  currentSink({
    event: 'admin_access',
    surface: params.surface,
    kiloUserId: params.user.id,
    email: params.user.google_user_email,
    adminTier: params.user.is_super_admin ? 'super_admin' : 'platform_admin',
    authVia: params.authViaToken ? 'token' : 'session',
    tokenSource: params.tokenSource,
    route: params.route,
    method: params.method,
    ip: params.ip,
  });
}

/**
 * Extract the client IP from request headers. Prefers `x-forwarded-for`, with
 * `x-vercel-forwarded-for` as a fallback; returns the first hop or null.
 */
export function clientIpFromHeaders(headersList: Headers): string | null {
  const forwarded = headersList.get('x-forwarded-for') ?? headersList.get('x-vercel-forwarded-for');
  return forwarded?.split(',')[0]?.trim() || null;
}
