import 'server-only';

import { and, asc, eq, inArray } from 'drizzle-orm';
import {
  user_deletion_requests,
  user_deletion_steps,
  type UserDeletionRequest,
  type UserDeletionStep,
} from '@kilocode/db/schema';
import { db } from '@/lib/drizzle';
import { ACTIVE_REQUEST_STATUSES } from '@/lib/user/deletion-queue/deletion-types';

export { SoftDeletePreconditionError } from '@/lib/user';
export { disableUserAccessForDeletion } from '@/lib/user/deletion-queue/deletion-access';

export async function getUserDeletionRequestForUser(
  userId: string
): Promise<{ request: UserDeletionRequest; steps: UserDeletionStep[] } | null> {
  const [request] = await db
    .select()
    .from(user_deletion_requests)
    .where(
      and(
        eq(user_deletion_requests.user_id, userId),
        inArray(user_deletion_requests.status, ACTIVE_REQUEST_STATUSES)
      )
    )
    .limit(1);

  if (!request) return null;
  return { request, steps: await loadStepsForRequest(request.id) };
}

export async function getUserDeletionRequestById(
  requestId: string
): Promise<{ request: UserDeletionRequest; steps: UserDeletionStep[] } | null> {
  const [request] = await db
    .select()
    .from(user_deletion_requests)
    .where(eq(user_deletion_requests.id, requestId))
    .limit(1);

  if (!request) return null;
  return { request, steps: await loadStepsForRequest(request.id) };
}

async function loadStepsForRequest(requestId: string): Promise<UserDeletionStep[]> {
  return db
    .select()
    .from(user_deletion_steps)
    .where(eq(user_deletion_steps.request_id, requestId))
    .orderBy(asc(user_deletion_steps.created_at));
}
