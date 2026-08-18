import { and, eq, inArray } from 'drizzle-orm';
import {
  user_deletion_activity,
  user_deletion_audit_events,
  user_deletion_requests,
  user_deletion_steps,
  type UserDeletionRequest,
  type UserDeletionStep,
} from '@kilocode/db/schema';
import {
  UserDeletionAuditEventType,
  UserDeletionCloudSubjectResolution,
  UserDeletionRequestStatus,
  UserDeletionStepKey,
  UserDeletionStepStatus,
} from '@kilocode/db/schema-types';
import { reportEvents } from '@/lib/ai-gateway/abuse-service';
import { cleanupDbForTest, db } from '@/lib/drizzle';
import { anonymizeCloudUserData } from '@/lib/user';
import { catalogForVersion, teardownStepKeys } from '@/lib/user/deletion-queue/deletion-catalog';
import { USER_DELETION_CATALOG_VERSION } from '@/lib/user/deletion-queue/deletion-constants';
import { enqueueUserDeletionTargets } from '@/lib/user/deletion-queue/deletion-enqueue';
import { hmacDeletionEmail } from '@/lib/user/deletion-queue/deletion-hmac';
import { persistHandlerOutcome } from '@/lib/user/deletion-queue/deletion-outcomes';
import { runClaimedDeletionTask } from '@/lib/user/deletion-queue/deletion-task-runner';
import { handleAnonymize } from '@/lib/user/deletion-queue/handlers/anonymize';
import type { DeletionHandlerContext } from '@/lib/user/deletion-queue/deletion-types';
import { insertTestUser } from '@/tests/helpers/user.helper';

jest.mock('@/lib/ai-gateway/abuse-service', () => ({
  reportEvents: jest.fn(async () => undefined),
}));

jest.mock('@/lib/user', () => ({
  anonymizeCloudUserData: jest.fn(async () => undefined),
}));

const reportEventsMock = jest.mocked(reportEvents);
const anonymizeCloudUserDataMock = jest.mocked(anonymizeCloudUserData);

describe('handleAnonymize', () => {
  beforeEach(async () => {
    await cleanupDbForTest();
    reportEventsMock.mockClear();
    anonymizeCloudUserDataMock.mockClear();
  });

  it('does not mark the step terminal or write generic disposition evidence', async () => {
    const { request, step, claimToken } = await prepareRunningAnonymize(
      `anon-handler-${crypto.randomUUID()}@example.com`
    );

    const outcome = await handleAnonymize({
      request,
      step,
      context: handlerContext(request.id, claimToken),
    });

    expect(outcome).toEqual({ kind: 'succeeded' });
    expect(anonymizeCloudUserDataMock).not.toHaveBeenCalled();
    const [updated] = await db
      .select()
      .from(user_deletion_steps)
      .where(eq(user_deletion_steps.id, step.id));
    expect(updated?.status).toBe(UserDeletionStepStatus.Running);
    expect(updated?.claim_token).toBe(claimToken);
    const audits = await db
      .select()
      .from(user_deletion_audit_events)
      .where(eq(user_deletion_audit_events.request_id, request.id));
    expect(
      audits.some(
        event =>
          event.event_type === UserDeletionAuditEventType.TaskDisposition ||
          event.event_type === UserDeletionAuditEventType.Anonymized
      )
    ).toBe(false);
    expect(reportEventsMock).not.toHaveBeenCalled();
  });

  it('does not emit user.deleted when the Cloud subject is authoritatively absent', async () => {
    const admin = await insertTestUser({ is_admin: true });
    const email = `absent-${crypto.randomUUID()}@example.com`;
    const hmac = hmacDeletionEmail(email);
    const [created] = await db
      .insert(user_deletion_requests)
      .values({
        status: UserDeletionRequestStatus.InProgress,
        catalog_version: USER_DELETION_CATALOG_VERSION,
        requested_by_kilo_user_id: admin.id,
        target_email: email,
        target_email_hmac: hmac,
        cloud_subject_resolution: UserDeletionCloudSubjectResolution.AuthoritativeAbsence,
      })
      .returning({ id: user_deletion_requests.id });
    if (!created) throw new Error('expected absent-subject request');
    await db.insert(user_deletion_steps).values(
      catalogForVersion(USER_DELETION_CATALOG_VERSION).map(entry => ({
        request_id: created.id,
        step_key: entry.stepKey,
      }))
    );

    const { request, step } = await loadRequestAndStep(created.id);
    const outcome = await handleAnonymize({
      request,
      step,
      context: handlerContext(request.id, crypto.randomUUID()),
    });

    expect(outcome).toEqual({ kind: 'not_applicable', errorCode: 'authoritative_absence' });
    expect(anonymizeCloudUserDataMock).not.toHaveBeenCalled();
    expect(reportEventsMock).not.toHaveBeenCalled();
  });
});

describe('anonymize shared persistence', () => {
  beforeEach(async () => {
    await cleanupDbForTest();
    reportEventsMock.mockClear();
    anonymizeCloudUserDataMock.mockClear();
  });

  it('commits the Cloud scrub, anonymized_at, terminal step, audits, and activity together', async () => {
    const { user, request, claimToken } = await prepareRunningAnonymize(
      `anon-runner-${crypto.randomUUID()}@example.com`
    );

    const result = await runClaimedDeletionTask({
      stepId: (await loadRequestAndStep(request.id)).step.id,
      claimToken,
      deadlineAt: Date.now() + 60_000,
    });

    expect(result.kind).toBe('applied');
    expect(anonymizeCloudUserDataMock).toHaveBeenCalledTimes(1);
    const [updated] = await db
      .select()
      .from(user_deletion_requests)
      .where(eq(user_deletion_requests.id, request.id));
    expect(updated?.anonymized_at).toBeTruthy();
    const step = await loadRequestAndStep(request.id);
    expect(step.step.status).toBe(UserDeletionStepStatus.Succeeded);
    expect(step.step.claim_token).toBeNull();
    const audits = await db
      .select()
      .from(user_deletion_audit_events)
      .where(eq(user_deletion_audit_events.request_id, request.id));
    expect(audits.some(event => event.event_type === UserDeletionAuditEventType.Anonymized)).toBe(
      true
    );
    expect(
      audits.some(
        event =>
          event.event_type === UserDeletionAuditEventType.TaskDisposition &&
          event.subject_key === `${UserDeletionStepKey.Anonymize}:succeeded`
      )
    ).toBe(true);
    const activities = await db
      .select()
      .from(user_deletion_activity)
      .where(eq(user_deletion_activity.request_id, request.id));
    expect(activities.some(event => event.event_type === 'succeeded')).toBe(true);
    expect(reportEventsMock).toHaveBeenCalledWith({
      events: [{ type: 'user.deleted', data: { kilo_user_id: user.id } }],
    });
  });

  it('rolls back request writes when anonymizeCloudUserData throws', async () => {
    const { request, step, claimToken } = await prepareRunningAnonymize(
      `anon-throw-${crypto.randomUUID()}@example.com`
    );
    anonymizeCloudUserDataMock.mockRejectedValueOnce(new Error('scrub failed'));

    await expect(
      persistHandlerOutcome({
        requestId: request.id,
        stepKey: UserDeletionStepKey.Anonymize,
        claimToken,
        outcome: { kind: 'succeeded' },
        handlerDeadlineAt: Date.now() + 60_000,
      })
    ).rejects.toThrow('scrub failed');

    const [updatedRequest] = await db
      .select()
      .from(user_deletion_requests)
      .where(eq(user_deletion_requests.id, request.id));
    expect(updatedRequest?.anonymized_at).toBeNull();
    const [updatedStep] = await db
      .select()
      .from(user_deletion_steps)
      .where(eq(user_deletion_steps.id, step.id));
    expect(updatedStep?.status).toBe(UserDeletionStepStatus.Running);
    expect(updatedStep?.claim_token).toBe(claimToken);
    expect(reportEventsMock).not.toHaveBeenCalled();
  });

  it('does not scrub or emit when the claim is lost', async () => {
    const { request } = await prepareRunningAnonymize(
      `anon-lost-${crypto.randomUUID()}@example.com`
    );

    const result = await persistHandlerOutcome({
      requestId: request.id,
      stepKey: UserDeletionStepKey.Anonymize,
      claimToken: crypto.randomUUID(),
      outcome: { kind: 'succeeded' },
      handlerDeadlineAt: Date.now() + 60_000,
    });

    expect(result).toEqual({ kind: 'stale_claim' });
    expect(anonymizeCloudUserDataMock).not.toHaveBeenCalled();
    expect(reportEventsMock).not.toHaveBeenCalled();
  });

  it('records teardown_incomplete without scrubbing when teardown is no longer complete', async () => {
    const { request, claimToken } = await prepareRunningAnonymize(
      `anon-teardown-${crypto.randomUUID()}@example.com`
    );
    await db
      .update(user_deletion_steps)
      .set({ status: UserDeletionStepStatus.Pending })
      .where(
        and(
          eq(user_deletion_steps.request_id, request.id),
          eq(user_deletion_steps.step_key, UserDeletionStepKey.Customerio)
        )
      );

    const result = await persistHandlerOutcome({
      requestId: request.id,
      stepKey: UserDeletionStepKey.Anonymize,
      claimToken,
      outcome: { kind: 'succeeded' },
      handlerDeadlineAt: Date.now() + 60_000,
    });

    expect(result.kind).toBe('applied');
    if (result.kind === 'applied') {
      expect(result.effectiveOutcome).toEqual({
        kind: 'needs_attention',
        errorCode: 'teardown_incomplete',
      });
    }
    expect(anonymizeCloudUserDataMock).not.toHaveBeenCalled();
    expect(reportEventsMock).not.toHaveBeenCalled();
  });

  it('does not emit user.deleted when replaying an already-terminal step', async () => {
    const { request, claimToken } = await prepareRunningAnonymize(
      `anon-replay-${crypto.randomUUID()}@example.com`
    );
    const first = await persistHandlerOutcome({
      requestId: request.id,
      stepKey: UserDeletionStepKey.Anonymize,
      claimToken,
      outcome: { kind: 'succeeded' },
      handlerDeadlineAt: Date.now() + 60_000,
    });
    expect(first.kind).toBe('applied');
    reportEventsMock.mockClear();
    anonymizeCloudUserDataMock.mockClear();

    const replay = await persistHandlerOutcome({
      requestId: request.id,
      stepKey: UserDeletionStepKey.Anonymize,
      claimToken,
      outcome: { kind: 'succeeded' },
      handlerDeadlineAt: Date.now() + 60_000,
    });
    expect(replay.kind).toBe('already_terminal');
    expect(anonymizeCloudUserDataMock).not.toHaveBeenCalled();
    expect(reportEventsMock).not.toHaveBeenCalled();
  });
});

function handlerContext(requestId: string, claimToken: string): DeletionHandlerContext {
  return {
    requestId,
    stepKey: UserDeletionStepKey.Anonymize,
    claimToken,
    deadlineAt: Date.now() + 60_000,
    remainingMs: () => 60_000,
    signal: new AbortController().signal,
  };
}

async function loadRequestAndStep(
  requestId: string
): Promise<{ request: UserDeletionRequest; step: UserDeletionStep }> {
  const [request] = await db
    .select()
    .from(user_deletion_requests)
    .where(eq(user_deletion_requests.id, requestId));
  const [step] = await db
    .select()
    .from(user_deletion_steps)
    .where(
      and(
        eq(user_deletion_steps.request_id, requestId),
        eq(user_deletion_steps.step_key, UserDeletionStepKey.Anonymize)
      )
    );
  if (!request || !step) throw new Error('expected deletion request and anonymize step');
  return { request, step };
}

async function prepareRunningAnonymize(userEmail: string) {
  const admin = await insertTestUser({ is_admin: true });
  const user = await insertTestUser({ google_user_email: userEmail });
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
  await db
    .update(user_deletion_steps)
    .set({ status: UserDeletionStepStatus.Succeeded })
    .where(
      and(
        eq(user_deletion_steps.request_id, enqueued.requestId),
        inArray(user_deletion_steps.step_key, [...teardownStepKeys()])
      )
    );
  await db
    .update(user_deletion_steps)
    .set({
      status: UserDeletionStepStatus.Running,
      claim_token: claimToken,
      claimed_until: new Date(Date.now() + 60_000).toISOString(),
    })
    .where(
      and(
        eq(user_deletion_steps.request_id, enqueued.requestId),
        eq(user_deletion_steps.step_key, UserDeletionStepKey.Anonymize)
      )
    );

  const { request, step } = await loadRequestAndStep(enqueued.requestId);
  return { user, request, step, claimToken };
}
