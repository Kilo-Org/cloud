import { and, eq, inArray, or, sql } from 'drizzle-orm';
import {
  user_deletion_requests,
  user_deletion_steps,
  type UserDeletionRequest,
  type UserDeletionStep,
} from '@kilocode/db/schema';
import {
  UserDeletionRequestStatus,
  UserDeletionStepKey,
  UserDeletionStepStatus,
} from '@kilocode/db/schema-types';
import { db, type DrizzleTransaction } from '@/lib/drizzle';
import {
  catalogEntryFor,
  catalogForVersion,
  UserDeletionPhase,
} from '@/lib/user/deletion-queue/deletion-catalog';
import { USER_DELETION_ANONYMIZE_MIN_REMAINING_MS } from '@/lib/user/deletion-queue/deletion-constants';
import { SUCCESSFUL_TASK_STATUSES } from '@/lib/user/deletion-queue/deletion-types';

export type SelectedDeletionTask = {
  request: UserDeletionRequest;
  step: UserDeletionStep;
};

export type ClaimedDeletionTask = SelectedDeletionTask & {
  claimToken: string;
};

const CLAIMABLE_STATUSES = [
  UserDeletionStepStatus.Pending,
  UserDeletionStepStatus.RetryWait,
  UserDeletionStepStatus.Running,
] as const;

export async function selectNextTaskForRequest(params: {
  requestId: string;
  remainingMs: number;
  excludeStepKeys?: readonly UserDeletionStepKey[];
}): Promise<SelectedDeletionTask | null> {
  return db.transaction(async tx => pickNextTaskForRequest(tx, params, { skipLocked: true }));
}

export async function claimNextTaskForRequest(params: {
  requestId: string;
  remainingMs: number;
  leaseMs: number;
  excludeStepKeys?: readonly UserDeletionStepKey[];
}): Promise<ClaimedDeletionTask | null> {
  return db.transaction(async tx => {
    const selected = await pickNextTaskForRequest(tx, params, { skipLocked: false });
    if (!selected) return null;

    const claimToken = crypto.randomUUID();
    const [claimed] = await tx
      .update(user_deletion_steps)
      .set({
        status: UserDeletionStepStatus.Running,
        claim_token: claimToken,
        claimed_until: sql`now() + interval '1 millisecond' * ${params.leaseMs}`,
      })
      .where(claimableStepWhere(selected.step.id))
      .returning();

    return claimed ? { request: selected.request, step: claimed, claimToken } : null;
  });
}

async function pickNextTaskForRequest(
  tx: DrizzleTransaction,
  params: {
    requestId: string;
    remainingMs: number;
    excludeStepKeys?: readonly UserDeletionStepKey[];
  },
  lock: { skipLocked: boolean }
): Promise<SelectedDeletionTask | null> {
  const requestQuery = tx
    .select()
    .from(user_deletion_requests)
    .where(eq(user_deletion_requests.id, params.requestId));
  const [request] = lock.skipLocked
    ? await requestQuery.for('update', { skipLocked: true })
    : await requestQuery.for('update');
  if (
    !request ||
    (request.status !== UserDeletionRequestStatus.InProgress &&
      request.status !== UserDeletionRequestStatus.Finalizing)
  ) {
    return null;
  }

  const steps = await tx
    .select()
    .from(user_deletion_steps)
    .where(eq(user_deletion_steps.request_id, params.requestId));

  const catalog = catalogForVersion(request.catalog_version);
  const successful = new Set(
    steps
      .filter(step => (SUCCESSFUL_TASK_STATUSES as readonly string[]).includes(step.status))
      .map(step => step.step_key)
  );

  const candidates = steps
    .filter(step => {
      if (params.excludeStepKeys?.includes(step.step_key)) return false;
      if (!CLAIMABLE_STATUSES.includes(step.status as (typeof CLAIMABLE_STATUSES)[number])) {
        return false;
      }
      if (new Date(step.available_at).getTime() > Date.now()) return false;
      if (
        step.status === UserDeletionStepStatus.Running &&
        step.claimed_until &&
        new Date(step.claimed_until).getTime() > Date.now()
      ) {
        return false;
      }
      const entry = catalogEntryFor(request.catalog_version, step.step_key);
      if (request.status === UserDeletionRequestStatus.InProgress) {
        if (entry.phase === UserDeletionPhase.Finalize) return false;
      } else if (entry.phase !== UserDeletionPhase.Finalize) {
        return false;
      }
      if (
        step.step_key === UserDeletionStepKey.Anonymize &&
        params.remainingMs < USER_DELETION_ANONYMIZE_MIN_REMAINING_MS
      ) {
        return false;
      }
      return entry.dependsOn.every(dep => successful.has(dep));
    })
    .sort((left, right) => {
      const leftOrder = catalog.findIndex(entry => entry.stepKey === left.step_key);
      const rightOrder = catalog.findIndex(entry => entry.stepKey === right.step_key);
      return leftOrder - rightOrder;
    });

  const step = candidates[0];
  return step ? { request, step } : null;
}

function claimableStepWhere(stepId: string) {
  return and(
    eq(user_deletion_steps.id, stepId),
    or(
      inArray(user_deletion_steps.status, [
        UserDeletionStepStatus.Pending,
        UserDeletionStepStatus.RetryWait,
      ]),
      and(
        eq(user_deletion_steps.status, UserDeletionStepStatus.Running),
        sql`${user_deletion_steps.claimed_until} <= now()`
      )
    )
  );
}
