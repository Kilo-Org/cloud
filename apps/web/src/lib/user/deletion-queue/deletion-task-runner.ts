import { captureException } from '@sentry/nextjs';
import { and, eq } from 'drizzle-orm';
import { user_deletion_requests, user_deletion_steps } from '@kilocode/db/schema';
import { UserDeletionStepKey, UserDeletionStepStatus } from '@kilocode/db/schema-types';
import { reportEvents } from '@/lib/ai-gateway/abuse-service';
import { db } from '@/lib/drizzle';
import { catalogEntryFor } from '@/lib/user/deletion-queue/deletion-catalog';
import { persistHandlerOutcome } from '@/lib/user/deletion-queue/deletion-outcomes';
import type {
  DeletionHandlerContext,
  DeletionHandlerOutcome,
  PersistTaskOutcomeResult,
} from '@/lib/user/deletion-queue/deletion-types';
import { getDeletionHandler } from '@/lib/user/deletion-queue/handlers';

export type RunClaimedDeletionTaskResult = PersistTaskOutcomeResult & {
  stepKey: UserDeletionStepKey | null;
};

export async function runClaimedDeletionTask(params: {
  stepId: string;
  claimToken: string;
  deadlineAt: number;
}): Promise<RunClaimedDeletionTaskResult> {
  const [claimed] = await db
    .select()
    .from(user_deletion_steps)
    .where(
      and(
        eq(user_deletion_steps.id, params.stepId),
        eq(user_deletion_steps.claim_token, params.claimToken),
        eq(user_deletion_steps.status, UserDeletionStepStatus.Running)
      )
    )
    .limit(1);
  if (!claimed) {
    return { kind: 'stale_claim', stepKey: null };
  }

  const [request] = await db
    .select()
    .from(user_deletion_requests)
    .where(eq(user_deletion_requests.id, claimed.request_id))
    .limit(1);
  if (!request) {
    return { kind: 'stale_claim', stepKey: claimed.step_key };
  }

  catalogEntryFor(request.catalog_version, claimed.step_key);
  const handler = getDeletionHandler(claimed.step_key);
  const controller = new AbortController();
  const context: DeletionHandlerContext = {
    requestId: request.id,
    stepKey: claimed.step_key,
    claimToken: params.claimToken,
    deadlineAt: params.deadlineAt,
    remainingMs: () => params.deadlineAt - Date.now(),
    signal: controller.signal,
  };

  let outcome: DeletionHandlerOutcome;
  try {
    if (params.deadlineAt - Date.now() <= 0) {
      controller.abort();
      outcome = { kind: 'retry', errorCode: 'handler_timeout', httpStatusClass: 'error' };
    } else {
      outcome = await runWithTaskDeadline(handler({ request, step: claimed, context }), {
        deadlineAt: params.deadlineAt,
        controller,
        requestId: request.id,
        stepId: claimed.id,
        stepKey: claimed.step_key,
      });
    }
  } catch (error) {
    captureException(error, {
      tags: { source: 'user-deletion-handler' },
      extra: {
        requestId: request.id,
        stepId: claimed.id,
        stepKey: claimed.step_key,
      },
    });
    outcome = { kind: 'retry', errorCode: 'handler_throw', httpStatusClass: 'error' };
  }

  const persisted = await persistHandlerOutcome({
    requestId: request.id,
    stepKey: claimed.step_key,
    claimToken: params.claimToken,
    outcome,
    handlerDeadlineAt: params.deadlineAt,
  });

  if (
    persisted.kind === 'applied' &&
    persisted.effectiveOutcome.kind === 'succeeded' &&
    claimed.step_key === UserDeletionStepKey.Anonymize &&
    persisted.anonymizedUserId
  ) {
    void reportEvents({
      events: [{ type: 'user.deleted', data: { kilo_user_id: persisted.anonymizedUserId } }],
    });
  }

  return { ...persisted, stepKey: claimed.step_key };
}

async function runWithTaskDeadline(
  handlerPromise: Promise<DeletionHandlerOutcome>,
  params: {
    deadlineAt: number;
    controller: AbortController;
    requestId: string;
    stepId: string;
    stepKey: UserDeletionStepKey;
  }
): Promise<DeletionHandlerOutcome> {
  const remainingMs = params.deadlineAt - Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<DeletionHandlerOutcome>(resolve => {
      timer = setTimeout(() => {
        params.controller.abort();
        resolve({ kind: 'retry', errorCode: 'handler_timeout', httpStatusClass: 'error' });
      }, remainingMs);
    });
    const winner = await Promise.race([handlerPromise, timeout]);
    if (winner.kind === 'retry' && winner.errorCode === 'handler_timeout') {
      observeLateHandlerRejection(handlerPromise, params);
    }
    return winner;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function observeLateHandlerRejection(
  handlerPromise: Promise<DeletionHandlerOutcome>,
  params: {
    requestId: string;
    stepId: string;
    stepKey: UserDeletionStepKey;
  }
): void {
  void handlerPromise.catch(error => {
    captureException(error, {
      tags: { source: 'user-deletion-handler' },
      extra: {
        requestId: params.requestId,
        stepId: params.stepId,
        stepKey: params.stepKey,
        lateRejection: true,
      },
    });
  });
}
