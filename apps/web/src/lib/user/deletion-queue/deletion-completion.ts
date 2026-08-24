import { and, asc, eq, gt, inArray, or, sql } from 'drizzle-orm';
import { user_deletion_requests, user_deletion_steps } from '@kilocode/db/schema';
import {
  UserDeletionAuditEventType,
  UserDeletionRequestStatus,
  UserDeletionStepStatus,
  type UserDeletionStepKey,
} from '@kilocode/db/schema-types';
import { db } from '@/lib/drizzle';
import {
  catalogEntryFor,
  catalogForVersion,
  preReplyStepKeys,
} from '@/lib/user/deletion-queue/deletion-catalog';
import { USER_DELETION_STOP_STARTING_RESERVE_MS } from '@/lib/user/deletion-queue/deletion-constants';
import {
  writeDeletionActivity,
  writeDeletionAudit,
} from '@/lib/user/deletion-queue/deletion-audit';
import { scrubControlPlanePii } from '@/lib/user/deletion-queue/deletion-enqueue';
import { deletionRequestAuditHmac } from '@/lib/user/deletion-queue/deletion-hmac';
import { selectNextTaskForRequest } from '@/lib/user/deletion-queue/deletion-task-selector';
import { SUCCESSFUL_TASK_STATUSES } from '@/lib/user/deletion-queue/deletion-types';

export async function advanceDeletionGates(requestId: string): Promise<void> {
  await tryAdvancePreReplyGate(requestId);
  await tryCompleteRequest(requestId);
}

export async function tryAdvancePreReplyGate(requestId: string): Promise<boolean> {
  return db.transaction(async tx => {
    const [request] = await tx
      .select()
      .from(user_deletion_requests)
      .where(eq(user_deletion_requests.id, requestId))
      .for('update');
    if (!request || request.status !== UserDeletionRequestStatus.InProgress) {
      return false;
    }
    const steps = await tx
      .select()
      .from(user_deletion_steps)
      .where(eq(user_deletion_steps.request_id, requestId))
      .for('update');

    if (
      !catalogTasksReady(request.catalog_version, steps, preReplyStepKeys(request.catalog_version))
    ) {
      return false;
    }

    await writeDeletionAudit(tx, {
      requestId: request.id,
      eventType: UserDeletionAuditEventType.ReadyForCustomerReply,
      targetEmailHmac: deletionRequestAuditHmac({
        targetEmailHmac: request.target_email_hmac,
        pylonTicketRef: request.pylon_ticket_ref,
      }),
      subjectKey: 'request',
    });
    await writeDeletionActivity(tx, {
      requestId: request.id,
      eventType: 'finalizing',
    });
    await tx
      .update(user_deletion_requests)
      .set({
        status: UserDeletionRequestStatus.Finalizing,
        last_progress_at: sql`now()`,
      })
      .where(eq(user_deletion_requests.id, requestId));
    return true;
  });
}

export async function tryCompleteRequest(requestId: string): Promise<boolean> {
  return db.transaction(async tx => {
    const [request] = await tx
      .select()
      .from(user_deletion_requests)
      .where(eq(user_deletion_requests.id, requestId))
      .for('update');
    if (!request || request.status !== UserDeletionRequestStatus.Finalizing) {
      return false;
    }
    const steps = await tx
      .select()
      .from(user_deletion_steps)
      .where(eq(user_deletion_steps.request_id, requestId))
      .for('update');

    const required = catalogForVersion(request.catalog_version).map(entry => entry.stepKey);
    if (!catalogTasksReady(request.catalog_version, steps, required)) {
      return false;
    }

    await writeDeletionAudit(tx, {
      requestId: request.id,
      eventType: UserDeletionAuditEventType.Completed,
      targetEmailHmac: deletionRequestAuditHmac({
        targetEmailHmac: request.target_email_hmac,
        pylonTicketRef: request.pylon_ticket_ref,
      }),
      subjectKey: 'request',
    });
    await writeDeletionActivity(tx, {
      requestId: request.id,
      eventType: 'completed',
    });
    await scrubControlPlanePii(tx, request.id, UserDeletionRequestStatus.Completed);
    return true;
  });
}

function catalogTasksReady(
  catalogVersion: number,
  steps: (typeof user_deletion_steps.$inferSelect)[],
  requiredKeys: readonly UserDeletionStepKey[]
): boolean {
  if (new Set(steps.map(step => step.step_key)).size !== steps.length) {
    return false;
  }
  for (const key of requiredKeys) {
    const matches = steps.filter(step => step.step_key === key);
    if (matches.length !== 1) return false;
    const step = matches[0];
    if (!(SUCCESSFUL_TASK_STATUSES as readonly string[]).includes(step.status)) {
      return false;
    }
    if (step.status === UserDeletionStepStatus.ManuallyVerified) {
      const entry = catalogEntryFor(catalogVersion, key);
      if (!entry.allowsManualVerification || !step.manual_evidence_json) {
        return false;
      }
    }
    if (step.claim_token || step.claimed_until) return false;
  }
  return true;
}

const SWEEP_PAGE_SIZE = 25;

type SweepCandidate = {
  id: string;
  lastProgressAt: string;
};

export async function sweepUnclaimableDeletionGates(deadlineAt: number): Promise<void> {
  let cursor: SweepCandidate | null = null;

  while (deadlineAt - Date.now() >= USER_DELETION_STOP_STARTING_RESERVE_MS) {
    const candidates: SweepCandidate[] = await db
      .select({
        id: user_deletion_requests.id,
        lastProgressAt: user_deletion_requests.last_progress_at,
      })
      .from(user_deletion_requests)
      .where(
        and(
          inArray(user_deletion_requests.status, [
            UserDeletionRequestStatus.InProgress,
            UserDeletionRequestStatus.Finalizing,
          ]),
          cursor
            ? or(
                gt(user_deletion_requests.last_progress_at, cursor.lastProgressAt),
                and(
                  eq(user_deletion_requests.last_progress_at, cursor.lastProgressAt),
                  gt(user_deletion_requests.id, cursor.id)
                )
              )
            : sql`true`
        )
      )
      .orderBy(asc(user_deletion_requests.last_progress_at), asc(user_deletion_requests.id))
      .limit(SWEEP_PAGE_SIZE);

    if (candidates.length === 0) break;

    for (const candidate of candidates) {
      if (deadlineAt - Date.now() < USER_DELETION_STOP_STARTING_RESERVE_MS) {
        return;
      }
      const claimable = await selectNextTaskForRequest({
        requestId: candidate.id,
        remainingMs: Math.max(0, deadlineAt - Date.now()),
      });
      if (claimable) continue;
      await advanceDeletionGates(candidate.id);
    }

    if (candidates.length < SWEEP_PAGE_SIZE) break;
    const last = candidates[candidates.length - 1];
    if (!last) break;
    cursor = { lastProgressAt: last.lastProgressAt, id: last.id };
  }
}
