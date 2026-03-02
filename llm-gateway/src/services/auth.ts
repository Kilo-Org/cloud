import jwt from 'jsonwebtoken';
import { eq } from 'drizzle-orm';
import { kilocode_users } from '@kilocode/db/schema';
import type { User } from '@kilocode/db/schema';
import type { WorkerDb } from '../lib/db.js';
import { logger } from '../logger.js';

type AuthResult =
  | {
      user: User;
      organizationId: string | undefined;
      botId: string | undefined;
      tokenSource: string | undefined;
    }
  | { error: string; status: number };

export async function authenticateRequest(
  authHeader: string | undefined,
  orgHeader: string | undefined,
  db: WorkerDb,
  secret: string
): Promise<AuthResult> {
  if (!authHeader?.startsWith('Bearer ')) {
    return { error: 'Missing or invalid Authorization header', status: 401 };
  }

  const token = authHeader.slice(7);

  let decoded: jwt.JwtPayload;
  try {
    decoded = jwt.verify(token, secret, { algorithms: ['HS256'] }) as jwt.JwtPayload;
  } catch (err) {
    logger.warn('JWT verification failed', { error: String(err) });
    return { error: 'Invalid or expired token', status: 401 };
  }

  const userId = decoded.sub;
  if (!userId) {
    return { error: 'Token missing sub claim', status: 401 };
  }

  // Look up user in the database
  const [user] = await db
    .select()
    .from(kilocode_users)
    .where(eq(kilocode_users.id, userId))
    .limit(1);

  if (!user) {
    return { error: 'User not found', status: 401 };
  }

  // Validate API token pepper if present
  if (decoded.pepper && user.api_token_pepper !== decoded.pepper) {
    return { error: 'Token has been revoked', status: 401 };
  }

  // Check if user is blocked
  if (user.blocked_reason) {
    return { error: 'Account is suspended', status: 403 };
  }

  const organizationId = orgHeader?.trim() || undefined;
  const botId = decoded.botId ?? undefined;
  const tokenSource = decoded.tokenSource ?? undefined;

  return { user, organizationId, botId, tokenSource };
}
