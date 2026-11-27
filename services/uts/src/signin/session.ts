import { isRandomCredential } from '../token/credentials';

/**
 * The browser session of the sign-in pages (design 5.3): an opaque cookie on the issuer origin,
 * 32 random bytes, stored only as its SHA-256. `__Host-` keeps it to this host, over HTTPS, on
 * every path; `HttpOnly` keeps it from page script; `SameSite=Lax` keeps it off cross-site
 * subrequests and form posts. The row decides the session's life (14 days idle, 30 days at most);
 * the cookie lasts the 30 days.
 */
export const SESSION_COOKIE = '__Host-uts_session';

/** Design 5.3: a browser session lasts 30 days at most. */
const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

/** The session value the request's `Cookie` header carries, or null. */
export function sessionCookieValue(request: Request): string | null {
  const header = request.headers.get('Cookie');
  if (header === null) return null;
  const values = header
    .split(';')
    .map(part => part.trim())
    .filter(part => part.startsWith(`${SESSION_COOKIE}=`))
    .map(part => part.slice(SESSION_COOKIE.length + 1));
  // A second cookie of the same name is refused rather than guessed between.
  if (values.length !== 1) return null;
  const [value] = values;
  return isRandomCredential(value) ? value : null;
}

/** The `Set-Cookie` value that starts a session. */
export function sessionCookie(value: string): string {
  return `${SESSION_COOKIE}=${value}; Path=/; Max-Age=${SESSION_MAX_AGE_SECONDS}; Secure; HttpOnly; SameSite=Lax`;
}
