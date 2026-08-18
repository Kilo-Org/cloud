import { createCallerFactory } from '@/lib/trpc/init';
import { findUserById } from '@/lib/user';
import { rootRouter } from '@/routers/root-router';

const createCaller = createCallerFactory(rootRouter);

/** Test-only caller bound to a real user row and an optional device session. */
export async function createCallerForUser(userId: string, opts?: { deviceSessionId?: string }) {
  const user = await findUserById(userId);
  if (!user) {
    throw new Error(`Test user not found: ${userId}`);
  }
  return createCaller({ user, deviceSessionId: opts?.deviceSessionId });
}
