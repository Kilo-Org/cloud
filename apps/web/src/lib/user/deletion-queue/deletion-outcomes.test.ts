import { and, eq } from 'drizzle-orm';
import {
  user_deletion_activity,
  user_deletion_audit_events,
  user_deletion_requests,
  user_deletion_steps,
} from '@kilocode/db/schema';
import {
  UserDeletionAuditEventType,
  UserDeletionRequestStatus,
  UserDeletionStepKey,
  UserDeletionStepStatus,
} from '@kilocode/db/schema-types';
import { cleanupDbForTest, db } from '@/lib/drizzle';
import { enqueueUserDeletionTargets } from '@/lib/user/deletion-queue/deletion-enqueue';
import {
  markTaskManuallyVerified,
  persistRejectedPreflight,
  retryBlockedPreflight,
} from '@/lib/user/deletion-queue/deletion-outcomes';
import { runDeletionPreflight } from '@/lib/user/deletion-queue/deletion-preflight';
import { insertTestUser } from '@/tests/helpers/user.helper';

describe('markTaskManuallyVerified', () => {
  beforeEach(async () => {
    await cleanupDbForTest();
  });

  it('marks a stuck Customer.io step as manually verified', async () => {
    const { admin, requestId } = await enqueueStuckStep({
      stepKey: UserDeletionStepKey.Customerio,
      status: UserDeletionStepStatus.NeedsAttention,
    });

    const verified = await markTaskManuallyVerified({
      requestId,
      stepKey: UserDeletionStepKey.Customerio,
      actorKiloUserId: admin.id,
      reason: 'Confirmed in Customer.io UI',
      evidence: 'Customer.io deletion task 12345 succeeded',
    });

    expect(verified).toBe(true);
    const step = await loadStep(requestId, UserDeletionStepKey.Customerio);
    expect(step?.status).toBe(UserDeletionStepStatus.ManuallyVerified);
    expect(step?.manual_evidence_json).toMatchObject({
      reason: 'Confirmed in Customer.io UI',
      evidence: 'Customer.io deletion task 12345 succeeded',
      actor_kilo_user_id: admin.id,
    });
    const audits = await db
      .select()
      .from(user_deletion_audit_events)
      .where(
        and(
          eq(user_deletion_audit_events.request_id, requestId),
          eq(user_deletion_audit_events.event_type, UserDeletionAuditEventType.ManualAction),
          eq(user_deletion_audit_events.subject_key, 'customerio:manually_verified')
        )
      );
    expect(audits).toHaveLength(1);
  });

  it('marks a Kiloclaw manual_action_required step as manually verified', async () => {
    const { admin, requestId } = await enqueueStuckStep({
      stepKey: UserDeletionStepKey.KiloclawDestroy,
      status: UserDeletionStepStatus.ManualActionRequired,
    });

    const verified = await markTaskManuallyVerified({
      requestId,
      stepKey: UserDeletionStepKey.KiloclawDestroy,
      actorKiloUserId: admin.id,
      reason: 'Sandbox destroyed manually',
      evidence: 'Sandbox list no longer contains the target',
    });

    expect(verified).toBe(true);
    const step = await loadStep(requestId, UserDeletionStepKey.KiloclawDestroy);
    expect(step?.status).toBe(UserDeletionStepStatus.ManuallyVerified);
    expect(step?.manual_evidence_json?.reason).toBe('Sandbox destroyed manually');
  });

  it('does not mark a succeeded step', async () => {
    const { admin, requestId } = await enqueueStuckStep({
      stepKey: UserDeletionStepKey.Customerio,
      status: UserDeletionStepStatus.Succeeded,
    });

    const verified = await markTaskManuallyVerified({
      requestId,
      stepKey: UserDeletionStepKey.Customerio,
      actorKiloUserId: admin.id,
      reason: 'Already done',
      evidence: 'Should be ignored',
    });

    expect(verified).toBe(false);
    const step = await loadStep(requestId, UserDeletionStepKey.Customerio);
    expect(step?.status).toBe(UserDeletionStepStatus.Succeeded);
    expect(step?.manual_evidence_json).toBeNull();
  });

  it('throws when evidence contains @', async () => {
    const { admin, requestId } = await enqueueStuckStep({
      stepKey: UserDeletionStepKey.Customerio,
      status: UserDeletionStepStatus.NeedsAttention,
    });

    await expect(
      markTaskManuallyVerified({
        requestId,
        stepKey: UserDeletionStepKey.Customerio,
        actorKiloUserId: admin.id,
        reason: 'Confirmed',
        evidence: 'Deleted person@example.com in Customer.io',
      })
    ).rejects.toThrow('Manual verification evidence must not contain email addresses');
  });

  it('rejects manual verification of anonymize and does not complete the request', async () => {
    const { admin, requestId } = await enqueueStuckStep({
      stepKey: UserDeletionStepKey.Anonymize,
      status: UserDeletionStepStatus.NeedsAttention,
    });

    const verified = await markTaskManuallyVerified({
      requestId,
      stepKey: UserDeletionStepKey.Anonymize,
      actorKiloUserId: admin.id,
      reason: 'Confirmed in Cloud admin',
      evidence: 'User row is anonymized',
    });

    expect(verified).toBe(false);
    const step = await loadStep(requestId, UserDeletionStepKey.Anonymize);
    expect(step?.status).toBe(UserDeletionStepStatus.NeedsAttention);
    const [request] = await db
      .select()
      .from(user_deletion_requests)
      .where(eq(user_deletion_requests.id, requestId));
    expect(request?.anonymized_at).toBeNull();
    expect(request?.status).toBe(UserDeletionRequestStatus.Pending);
  });
});

describe('shared preflight outcomes', () => {
  beforeEach(async () => {
    await cleanupDbForTest();
  });

  it('writes attention code, one preflight_disposition audit, and request-level activity', async () => {
    const requestId = await enqueueMismatchedIdentityPreflight();

    const result = await runDeletionPreflight(requestId);

    expect(result).toEqual({ kind: 'attention', code: 'user_identity_mismatch' });
    const [request] = await db
      .select()
      .from(user_deletion_requests)
      .where(eq(user_deletion_requests.id, requestId));
    expect(request?.preflight_attention_code).toBe('user_identity_mismatch');
    const audits = await db
      .select()
      .from(user_deletion_audit_events)
      .where(
        and(
          eq(user_deletion_audit_events.request_id, requestId),
          eq(user_deletion_audit_events.event_type, UserDeletionAuditEventType.PreflightDisposition)
        )
      );
    expect(audits).toHaveLength(1);
    expect(audits[0]?.details_json).toEqual({
      disposition: 'needs_attention',
      code: 'user_identity_mismatch',
    });
    const activities = await db
      .select()
      .from(user_deletion_activity)
      .where(eq(user_deletion_activity.request_id, requestId));
    expect(
      activities.some(
        event =>
          event.event_type === 'preflight_needs_attention' &&
          event.details_json.error_code === 'user_identity_mismatch'
      )
    ).toBe(true);
  });

  it('clears the current blocker on manual retry without erasing prior evidence', async () => {
    const { admin, requestId } = await enqueueStuckPreflight();

    const retried = await retryBlockedPreflight({
      requestId,
      actorKiloUserId: admin.id,
      reason: 'Rechecked identity',
    });

    expect(retried).toBe(true);
    const [request] = await db
      .select()
      .from(user_deletion_requests)
      .where(eq(user_deletion_requests.id, requestId));
    expect(request?.preflight_attention_code).toBeNull();
    const audits = await db
      .select()
      .from(user_deletion_audit_events)
      .where(eq(user_deletion_audit_events.request_id, requestId));
    expect(
      audits.some(event => event.event_type === UserDeletionAuditEventType.PreflightDisposition)
    ).toBe(true);
    expect(audits.some(event => event.event_type === UserDeletionAuditEventType.ManualRetry)).toBe(
      true
    );
    const activities = await db
      .select()
      .from(user_deletion_activity)
      .where(eq(user_deletion_activity.request_id, requestId));
    expect(activities.some(event => event.event_type === 'preflight_needs_attention')).toBe(true);
    expect(activities.some(event => event.event_type === 'manual_retry')).toBe(true);
  });

  it('converts a rejected preflight into durable preflight_throw attention', async () => {
    const requestId = await enqueuePendingRequest();

    const persisted = await persistRejectedPreflight(requestId);

    expect(persisted).toBe(true);
    const [request] = await db
      .select()
      .from(user_deletion_requests)
      .where(eq(user_deletion_requests.id, requestId));
    expect(request?.preflight_attention_code).toBe('preflight_throw');
    const audits = await db
      .select()
      .from(user_deletion_audit_events)
      .where(
        and(
          eq(user_deletion_audit_events.request_id, requestId),
          eq(user_deletion_audit_events.event_type, UserDeletionAuditEventType.PreflightDisposition)
        )
      );
    expect(audits).toHaveLength(1);
    expect(audits[0]?.details_json.code).toBe('preflight_throw');
  });

  it('does not overwrite a request that is no longer pending', async () => {
    const requestId = await enqueuePendingRequest();
    await db
      .update(user_deletion_requests)
      .set({ status: UserDeletionRequestStatus.InProgress })
      .where(eq(user_deletion_requests.id, requestId));

    expect(await persistRejectedPreflight(requestId)).toBe(false);
    const [request] = await db
      .select()
      .from(user_deletion_requests)
      .where(eq(user_deletion_requests.id, requestId));
    expect(request?.preflight_attention_code).toBeNull();
  });
});

async function enqueueStuckStep(params: {
  stepKey: UserDeletionStepKey;
  status: UserDeletionStepStatus;
}) {
  const admin = await insertTestUser({ is_admin: true });
  const user = await insertTestUser({
    google_user_email: `mark-done-${params.stepKey}-${crypto.randomUUID()}@example.com`,
  });
  const [result] = await enqueueUserDeletionTargets({
    actor: { kiloUserId: admin.id },
    targets: [{ email: user.google_user_email, trustedUserId: user.id }],
  });
  expect(result.status).toBe('enqueued');
  if (result.status !== 'enqueued') throw new Error('expected enqueued');
  await db
    .update(user_deletion_steps)
    .set({
      status: params.status,
      last_error_code: 'stuck',
    })
    .where(
      and(
        eq(user_deletion_steps.request_id, result.requestId),
        eq(user_deletion_steps.step_key, params.stepKey)
      )
    );
  return { admin, requestId: result.requestId };
}

async function loadStep(requestId: string, stepKey: UserDeletionStepKey) {
  const [step] = await db
    .select()
    .from(user_deletion_steps)
    .where(
      and(eq(user_deletion_steps.request_id, requestId), eq(user_deletion_steps.step_key, stepKey))
    );
  return step;
}

async function enqueuePendingRequest() {
  const admin = await insertTestUser({ is_admin: true });
  const user = await insertTestUser({
    google_user_email: `preflight-${crypto.randomUUID()}@example.com`,
  });
  const [result] = await enqueueUserDeletionTargets({
    actor: { kiloUserId: admin.id },
    targets: [{ email: user.google_user_email, trustedUserId: user.id }],
  });
  expect(result.status).toBe('enqueued');
  if (result.status !== 'enqueued') throw new Error('expected enqueued');
  return result.requestId;
}

async function enqueueMismatchedIdentityPreflight() {
  const requestId = await enqueuePendingRequest();
  const other = await insertTestUser({
    google_user_email: `other-${crypto.randomUUID()}@example.com`,
  });
  await db
    .update(user_deletion_requests)
    .set({ user_id: other.id })
    .where(eq(user_deletion_requests.id, requestId));
  return requestId;
}

async function enqueueStuckPreflight() {
  const admin = await insertTestUser({ is_admin: true });
  const user = await insertTestUser({
    google_user_email: `preflight-stuck-${crypto.randomUUID()}@example.com`,
  });
  const [result] = await enqueueUserDeletionTargets({
    actor: { kiloUserId: admin.id },
    targets: [{ email: user.google_user_email, trustedUserId: user.id }],
  });
  expect(result.status).toBe('enqueued');
  if (result.status !== 'enqueued') throw new Error('expected enqueued');
  const other = await insertTestUser({
    google_user_email: `other-${crypto.randomUUID()}@example.com`,
  });
  await db
    .update(user_deletion_requests)
    .set({ user_id: other.id })
    .where(eq(user_deletion_requests.id, result.requestId));
  await runDeletionPreflight(result.requestId);
  return { admin, requestId: result.requestId };
}
