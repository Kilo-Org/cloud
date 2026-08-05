import type { TRPCContext } from '@/lib/trpc/init';
import { createCallerFactory } from '@/lib/trpc/init';
import { findUserById } from '@/lib/user';
import { rootRouter } from '@/routers/root-router';

/**
 * Test-only context factory that allows creating context with mock users
 */
const createTestTRPCContext = async (
  userId: string,
  deviceSessionId?: string
): Promise<TRPCContext> => {
  const user = await findUserById(userId);
  if (!user) {
    throw new Error(`Test user not found: ${userId}`);
  }
  return {
    user,
    deviceSessionId,
  };
};

const createCaller = createCallerFactory(rootRouter);

export async function createCallerForUser(userId: string, opts?: { deviceSessionId?: string }) {
  const ctx = await createTestTRPCContext(userId, opts?.deviceSessionId);
  return createCaller(ctx);
}
