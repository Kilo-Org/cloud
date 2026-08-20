import { captureException } from '@sentry/nextjs';
import { and, eq } from 'drizzle-orm';
import { user_deletion_requests, user_deletion_steps } from '@kilocode/db/schema';
import {
  UserDeletionRequestStatus,
  UserDeletionStepKey,
  UserDeletionStepStatus,
} from '@kilocode/db/schema-types';
import { cleanupDbForTest, db } from '@/lib/drizzle';
import { enqueueUserDeletionTargets } from '@/lib/user/deletion-queue/deletion-enqueue';
import { runClaimedDeletionTask } from '@/lib/user/deletion-queue/deletion-task-runner';
import { getDeletionHandler } from '@/lib/user/deletion-queue/handlers';
import type { DeletionHandler } from '@/lib/user/deletion-queue/handlers/common';
import { insertTestUser } from '@/tests/helpers/user.helper';

jest.mock('@sentry/nextjs', () => ({
  captureException: jest.fn(),
}));

jest.mock('@/lib/user/deletion-queue/handlers', () => ({
  getDeletionHandler: jest.fn(),
}));

const captureExceptionMock = jest.mocked(captureException);
const getDeletionHandlerMock = jest.mocked(getDeletionHandler);

describe('runClaimedDeletionTask', () => {
  beforeEach(async () => {
    await cleanupDbForTest();
    captureExceptionMock.mockClear();
    getDeletionHandlerMock.mockReset();
  });

  it('times out a handler that never settles and persists handler_timeout', async () => {
    const { stepId, claimToken } = await claimRunningStep();
    let contextSignal: AbortSignal | undefined;
    getDeletionHandlerMock.mockReturnValue((async ({ context }) => {
      contextSignal = context.signal;
      return new Promise(() => undefined);
    }) as DeletionHandler);

    const started = Date.now();
    const result = await runClaimedDeletionTask({
      stepId,
      claimToken,
      // Keep the budget comfortably above the claim/request lookup overhead so
      // the handler always starts before the deadline fires.
      deadlineAt: started + 500,
    });

    expect(Date.now() - started).toBeLessThan(2_000);
    expect(result.kind).toBe('applied');
    if (result.kind === 'applied') {
      expect(result.effectiveOutcome).toEqual({
        kind: 'retry',
        errorCode: 'handler_timeout',
        httpStatusClass: 'error',
      });
    }
    expect(contextSignal?.aborted).toBe(true);
    const [step] = await db
      .select()
      .from(user_deletion_steps)
      .where(eq(user_deletion_steps.id, stepId));
    expect(step?.status).toBe(UserDeletionStepStatus.RetryWait);
    expect(step?.last_error_code).toBe('handler_timeout');
    expect(step?.claim_token).toBeNull();
  });

  it('captures the original thrown handler error and persists handler_throw', async () => {
    const { stepId, claimToken, requestId } = await claimRunningStep();
    const thrown = new Error('sentinel handler failure');
    getDeletionHandlerMock.mockReturnValue((() => {
      throw thrown;
    }) as DeletionHandler);

    const result = await runClaimedDeletionTask({
      stepId,
      claimToken,
      deadlineAt: Date.now() + 60_000,
    });

    expect(result.kind).toBe('applied');
    if (result.kind === 'applied') {
      expect(result.effectiveOutcome).toEqual({
        kind: 'retry',
        errorCode: 'handler_throw',
        httpStatusClass: 'error',
      });
    }
    expect(captureExceptionMock).toHaveBeenCalledWith(thrown, {
      tags: { source: 'user-deletion-handler' },
      extra: {
        requestId,
        stepId,
        stepKey: UserDeletionStepKey.Customerio,
      },
    });
    const [step] = await db
      .select()
      .from(user_deletion_steps)
      .where(eq(user_deletion_steps.id, stepId));
    expect(step?.last_error_code).toBe('handler_throw');
  });

  it('persists the original outcome when the handler finishes before the deadline', async () => {
    const { stepId, claimToken } = await claimRunningStep();
    getDeletionHandlerMock.mockReturnValue((async () => ({
      kind: 'succeeded' as const,
    })) as DeletionHandler);

    const result = await runClaimedDeletionTask({
      stepId,
      claimToken,
      deadlineAt: Date.now() + 60_000,
    });

    expect(result.kind).toBe('applied');
    if (result.kind === 'applied') {
      expect(result.effectiveOutcome).toEqual({ kind: 'succeeded' });
    }
    const [step] = await db
      .select()
      .from(user_deletion_steps)
      .where(eq(user_deletion_steps.id, stepId));
    expect(step?.status).toBe(UserDeletionStepStatus.Succeeded);
    expect(captureExceptionMock).not.toHaveBeenCalled();
  });

  it('observes a late rejection after timeout without a second state transition', async () => {
    const { stepId, claimToken, requestId } = await claimRunningStep();
    const late = new Error('late handler rejection');
    getDeletionHandlerMock.mockReturnValue(
      (({ context }) =>
        new Promise((_resolve, reject) => {
          // Reject a fixed delay after the deadline so the timeout always wins
          // regardless of how long the claim/request lookups took.
          const msUntilDeadline = Math.max(0, context.deadlineAt - Date.now());
          setTimeout(() => reject(late), msUntilDeadline + 200);
        })) as DeletionHandler
    );

    // Keep the budget comfortably above the claim/request lookup overhead so
    // the handler always starts before the deadline fires.
    const result = await runClaimedDeletionTask({
      stepId,
      claimToken,
      deadlineAt: Date.now() + 500,
    });

    expect(result.kind).toBe('applied');
    await new Promise(resolve => setTimeout(resolve, 500));
    expect(captureExceptionMock).toHaveBeenCalledWith(late, {
      tags: { source: 'user-deletion-handler' },
      extra: {
        requestId,
        stepId,
        stepKey: UserDeletionStepKey.Customerio,
        lateRejection: true,
      },
    });
    const [step] = await db
      .select()
      .from(user_deletion_steps)
      .where(eq(user_deletion_steps.id, stepId));
    expect(step?.last_error_code).toBe('handler_timeout');
  });

  it('does not invoke the handler when the budget is already exhausted', async () => {
    const { stepId, claimToken } = await claimRunningStep();
    const handler = jest.fn(async () => ({ kind: 'succeeded' as const }));
    getDeletionHandlerMock.mockReturnValue(handler as DeletionHandler);

    const result = await runClaimedDeletionTask({
      stepId,
      claimToken,
      deadlineAt: Date.now() - 1,
    });

    expect(handler).not.toHaveBeenCalled();
    expect(result.kind).toBe('applied');
    if (result.kind === 'applied') {
      expect(result.effectiveOutcome).toEqual({
        kind: 'retry',
        errorCode: 'handler_timeout',
        httpStatusClass: 'error',
      });
    }
  });
});

async function claimRunningStep() {
  const admin = await insertTestUser({ is_admin: true });
  const user = await insertTestUser({
    google_user_email: `runner-${crypto.randomUUID()}@example.com`,
  });
  const [enqueued] = await enqueueUserDeletionTargets({
    actor: { kiloUserId: admin.id },
    targets: [{ email: user.google_user_email, trustedUserId: user.id }],
  });
  expect(enqueued.status).toBe('enqueued');
  if (enqueued.status !== 'enqueued') throw new Error('expected enqueued');

  const claimToken = crypto.randomUUID();
  await db
    .update(user_deletion_requests)
    .set({ status: UserDeletionRequestStatus.InProgress })
    .where(eq(user_deletion_requests.id, enqueued.requestId));
  const [step] = await db
    .update(user_deletion_steps)
    .set({
      status: UserDeletionStepStatus.Running,
      claim_token: claimToken,
      claimed_until: new Date(Date.now() + 60_000).toISOString(),
    })
    .where(
      and(
        eq(user_deletion_steps.request_id, enqueued.requestId),
        eq(user_deletion_steps.step_key, UserDeletionStepKey.Customerio)
      )
    )
    .returning();
  if (!step) throw new Error('expected claimed step');

  return {
    requestId: enqueued.requestId,
    stepId: step.id,
    claimToken,
  };
}
