import 'server-only';
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

export type AppShellSession = { userId: string };

export function createAppShellSessionToken(userId: string): string {
  return createSignedToken({ userId });
}

export function verifyAppShellSessionToken(
  token: string | null | undefined
): AppShellSession | null {
  return verifySignedToken(token ?? null, {
    ttlSeconds: APP_SHELL_SESSION_TTL_SECONDS,
    parse: payload => {
      const userId = payload.userId;
      return typeof userId === 'string' && userId.length > 0 ? { userId } : null;
    },
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
  | { status: 'restricted' };

/**
 * The database row a shell credential names, after those gates. Both the
 * hand-off and every later read go through this, so a credential that names a
 * deleted, blocked or blocklisted account never becomes a user.
 */
export async function loadAppShellUser(userId: string): Promise<AppShellUserLookup> {
  const user = await findUserById(userId);
  if (!user) return { status: 'gone' };
  if (await isAppShellAccountRestricted(user)) return { status: 'restricted' };
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
  const lookup = await loadAppShellUser(session.userId);
  return lookup.status === 'active' ? lookup.user : null;
}
