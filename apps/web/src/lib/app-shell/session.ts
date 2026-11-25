import 'server-only';
import crypto from 'node:crypto';
import { cookies } from 'next/headers';
import type { User } from '@kilocode/db/schema';
import { findUserById } from '@kilocode/web-shared/lib/user/find-user-by-id';
import { isBlockedAccount } from '@kilocode/web-shared/lib/user/account-status';
import { isUserBlacklistedByDomain } from '@kilocode/web-shared/lib/user/domain-gates';
import { IS_DEVELOPMENT } from '@kilocode/web-shared/lib/constants';
import { createSignedToken, verifySignedToken } from '@/lib/signed-token';
import { APP_SHELL_PREFIX } from './shell-paths';

/**
 * The shell session cookie. Its `Path` is the shell prefix, so the browser only
 * presents it to `/app-shell/...` routes: the full web app, the OAuth callbacks
 * and the main tRPC entry point never receive it.
 */
export const APP_SHELL_SESSION_COOKIE = 'kilo_app_shell_session';

/** How long one hand-off keeps the shell open. */
export const APP_SHELL_SESSION_TTL_SECONDS = 60 * 60;

/**
 * A shell credential: the user it names and a digest of that user's
 * `web_session_pepper` when it was minted. Rotating the pepper (an API-key
 * reset, "sign out everywhere", account recovery) ends every shell credential
 * minted before it, the same way it ends every browser session. The cookie
 * carries only the digest because the pepper itself never leaves the server.
 */
export type AppShellSession = { userId: string; webSessionBinding: string | null };

function webSessionBinding(webSessionPepper: string | null): string | null {
  return webSessionPepper === null
    ? null
    : crypto.createHash('sha256').update(webSessionPepper).digest('base64url');
}

export function bindAppShellSession(
  userId: string,
  webSessionPepper: string | null
): AppShellSession {
  return { userId, webSessionBinding: webSessionBinding(webSessionPepper) };
}

/**
 * The session a signed shell payload names, or null when it is malformed. A
 * payload without the binding was minted before shell credentials were bound
 * to the pepper and is refused; the app opens the shell with a new hand-off.
 */
export function parseAppShellSession(payload: Record<string, unknown>): AppShellSession | null {
  const { userId, webSessionBinding: binding } = payload;
  if (typeof userId !== 'string' || userId.length === 0) return null;
  if (binding !== null && typeof binding !== 'string') return null;
  return { userId, webSessionBinding: binding };
}

export function createAppShellSessionToken(session: AppShellSession): string {
  return createSignedToken(session);
}

export function verifyAppShellSessionToken(
  token: string | null | undefined
): AppShellSession | null {
  return verifySignedToken(token ?? null, {
    ttlSeconds: APP_SHELL_SESSION_TTL_SECONDS,
    parse: parseAppShellSession,
  });
}

export function appShellSessionCookieOptions(): {
  path: string;
  httpOnly: true;
  sameSite: 'lax';
  secure: boolean;
  maxAge: number;
} {
  return {
    path: APP_SHELL_PREFIX,
    httpOnly: true,
    sameSite: 'lax',
    secure: !IS_DEVELOPMENT,
    maxAge: APP_SHELL_SESSION_TTL_SECONDS,
  };
}

/**
 * The account gates the web session path applies to every request: `R0` for an
 * email domain on the blocklist and `R1` for a blocked account. A shell
 * credential outlives the hand-off that minted it, so a block recorded after
 * that hand-off must still end the shell at its next read.
 */
async function isAppShellAccountRestricted(user: User): Promise<boolean> {
  return isBlockedAccount(user) || (await isUserBlacklistedByDomain(user));
}

export type AppShellUserLookup =
  | { status: 'active'; user: User }
  | { status: 'gone' }
  | { status: 'restricted' }
  | { status: 'revoked' };

/**
 * The database row a shell credential names, after those gates and the
 * web-session pepper check. The hand-off, every later read and the OAuth
 * callbacks go through this, so a credential that names a deleted, blocked or
 * blocklisted account, or one minted before the pepper last rotated, never
 * becomes a user.
 */
export async function loadAppShellUser(session: AppShellSession): Promise<AppShellUserLookup> {
  const user = await findUserById(session.userId);
  if (!user) return { status: 'gone' };
  if (await isAppShellAccountRestricted(user)) return { status: 'restricted' };
  if (session.webSessionBinding !== webSessionBinding(user.web_session_pepper)) {
    return { status: 'revoked' };
  }
  return { status: 'active', user };
}

/** The shell session named by the request's cookies, when it is valid. */
export async function readAppShellSession(): Promise<AppShellSession | null> {
  const store = await cookies();
  return verifyAppShellSessionToken(store.get(APP_SHELL_SESSION_COOKIE)?.value);
}

/**
 * The signed-in shell user, or null when there is no valid shell session or the
 * account the session names is gone or restricted. Shell pages never fall back
 * to a full web session.
 */
export async function requireAppShellUser(): Promise<User | null> {
  const session = await readAppShellSession();
  if (!session) return null;
  const lookup = await loadAppShellUser(session);
  return lookup.status === 'active' ? lookup.user : null;
}
