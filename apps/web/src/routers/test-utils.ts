import { createCallerFactory } from '@kilocode/web-shared/lib/trpc/init';
import { findUserById } from '@kilocode/web-shared/lib/user/find-user-by-id';
import { rootRouter } from '@/routers/root-router';
import { generateApiToken } from '@kilocode/web-shared/lib/tokens';

const createCaller = createCallerFactory(rootRouter);

/** Test-only caller bound to a real user row and an optional device session. */
export async function createCallerForUser(userId: string, opts?: { deviceSessionId?: string }) {
  const user = await findUserById(userId);
  if (!user) {
    throw new Error(`Test user not found: ${userId}`);
  }
  return createCaller({
    user,
    deviceSessionId: opts?.deviceSessionId,
    headersList: new Headers({ Authorization: `Bearer ${generateApiToken(user)}` }),
  });
}

/** Test-only caller that represents a browser session, not a bearer token. */
export async function createSessionCallerForUser(
  userId: string,
  opts?: { webSessionId?: string; webSessionPepper?: string | null }
) {
  const user = await findUserById(userId);
  if (!user) {
    throw new Error(`Test user not found: ${userId}`);
  }
  return createCaller({
    user,
    credential: 'session',
    authViaToken: false,
    webSessionId: opts?.webSessionId ?? 'test-web-session',
    webSessionPepper: opts?.webSessionPepper ?? user.web_session_pepper,
    headersList: new Headers(),
  });
}

/** Test-only caller with an explicit bearer credential and provenance. */
export async function createBearerCallerForUser(userId: string) {
  const user = await findUserById(userId);
  if (!user) {
    throw new Error(`Test user not found: ${userId}`);
  }
  return createCaller({
    user,
    credential: 'human_bearer',
    authViaToken: true,
    headersList: new Headers({ Authorization: `Bearer ${generateApiToken(user)}` }),
  });
}
