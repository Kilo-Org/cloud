import { captureException } from '@sentry/nextjs';
import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import { user_deletion_requests } from '@kilocode/db/schema';
import type { DrizzleTransaction } from '@/lib/drizzle';
import { db } from '@/lib/drizzle';
import { hmacDeletionEmail } from '@/lib/user/deletion-queue/deletion-hmac';
import { normalizeDeletionEmail } from '@/lib/user/deletion-queue/deletion-intake';
import { ACTIVE_REQUEST_STATUSES } from '@/lib/user/deletion-queue/deletion-types';

export type ActiveDeletionFenceHit = {
  requestId: string;
  userId: string | null;
};

type FenceExecutor = Pick<typeof db, 'select'> | DrizzleTransaction;

export async function findActiveDeletionByEmail(params: {
  email: string;
  executor?: FenceExecutor;
}): Promise<ActiveDeletionFenceHit | null> {
  const executor = params.executor ?? db;
  const hmac = hmacDeletionEmail(normalizeDeletionEmail(params.email));

  const [row] = await executor
    .select({
      id: user_deletion_requests.id,
      user_id: user_deletion_requests.user_id,
    })
    .from(user_deletion_requests)
    .where(
      and(
        eq(user_deletion_requests.target_email_hmac, hmac),
        inArray(user_deletion_requests.status, ACTIVE_REQUEST_STATUSES)
      )
    )
    .limit(1);

  return row ? { requestId: row.id, userId: row.user_id } : null;
}

export async function findActiveDeletionByUserId(params: {
  userId: string;
  executor?: FenceExecutor;
}): Promise<ActiveDeletionFenceHit | null> {
  const executor = params.executor ?? db;
  const [row] = await executor
    .select({
      id: user_deletion_requests.id,
      user_id: user_deletion_requests.user_id,
    })
    .from(user_deletion_requests)
    .where(
      and(
        eq(user_deletion_requests.user_id, params.userId),
        inArray(user_deletion_requests.status, ACTIVE_REQUEST_STATUSES),
        isNotNull(user_deletion_requests.user_id)
      )
    )
    .limit(1);

  return row ? { requestId: row.id, userId: row.user_id } : null;
}

export async function assertNoActiveDeletionFence(params: {
  email: string;
  userId?: string;
  executor?: FenceExecutor;
}): Promise<void> {
  const executor = params.executor ?? db;
  const byEmail = await findActiveDeletionByEmail({
    email: params.email,
    executor,
  });
  if (byEmail) {
    throw new ActiveDeletionFenceError(byEmail.requestId);
  }
  if (params.userId) {
    const byUser = await findActiveDeletionByUserId({
      userId: params.userId,
      executor,
    });
    if (byUser) {
      throw new ActiveDeletionFenceError(byUser.requestId);
    }
  }
}

export async function authPassesDeletionFence(params: {
  email: string;
  userId?: string;
  executor?: FenceExecutor;
}): Promise<boolean> {
  try {
    await assertNoActiveDeletionFence(params);
    return true;
  } catch (error) {
    if (error instanceof ActiveDeletionFenceError) {
      return false;
    }
    captureException(error, { tags: { source: 'deletion-identity-fence' } });
    return true;
  }
}

export class ActiveDeletionFenceError extends Error {
  readonly requestId: string;

  constructor(requestId: string) {
    super('An active user deletion request already covers this identity');
    this.name = 'ActiveDeletionFenceError';
    this.requestId = requestId;
  }
}
