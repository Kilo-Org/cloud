import { createMiddleware } from 'hono/factory';
import { getWorkerDb } from '@kilocode/db/client';
import { kilocode_users } from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';
import { extractBearerToken, getCachedSecret, verifyKiloChatToken } from '@kilocode/worker-utils';
import { logger } from './util/logger';

export type AuthContext = {
  callerId: string;
  callerKind: 'user';
};

async function findUserPepper(
  connectionString: string,
  userId: string
): Promise<string | null | undefined> {
  const db = getWorkerDb(connectionString);
  const rows = await db
    .select({ api_token_pepper: kilocode_users.api_token_pepper })
    .from(kilocode_users)
    .where(eq(kilocode_users.id, userId))
    .limit(1);
  const row = rows[0];
  return row ? (row.api_token_pepper ?? null) : undefined;
}

/**
 * Public HTTP auth for the notifications worker — humans only. The bearer is
 * a Kilo JWT verified with NEXTAUTH_SECRET.
 *
 * The worker also exposes RPC methods to other workers (e.g. kilo-chat). RPC
 * callers don't go through this middleware; HTTP traffic is JWT-only.
 */
export const authMiddleware = createMiddleware<{
  Bindings: Env;
  Variables: AuthContext;
}>(async (c, next) => {
  const token = extractBearerToken(c.req.header('authorization'));
  if (!token) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  try {
    const jwtSecret = await getCachedSecret(c.env.NEXTAUTH_SECRET, 'NEXTAUTH_SECRET');
    const payload = await verifyKiloChatToken(token, jwtSecret, c.env.WORKER_ENV);
    const currentPepper = await findUserPepper(c.env.HYPERDRIVE.connectionString, payload.userId);
    if (currentPepper === undefined || currentPepper !== payload.pepper) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    c.set('callerId', payload.userId);
    c.set('callerKind', 'user');
    logger.setTags({ callerId: payload.userId, callerKind: 'user' });
    return next();
  } catch {
    return c.json({ error: 'Unauthorized' }, 401);
  }
});
