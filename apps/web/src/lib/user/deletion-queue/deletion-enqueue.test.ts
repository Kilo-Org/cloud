import { and, eq } from 'drizzle-orm';
import {
  user_deletion_audit_events,
  user_deletion_requests,
  user_deletion_steps,
} from '@kilocode/db/schema';
import {
  UserDeletionAuditEventType,
  UserDeletionCloudSubjectResolution,
  UserDeletionRequestStatus,
  UserDeletionStepKey,
  UserDeletionStepStatus,
  type UserDeletionManualEvidence,
} from '@kilocode/db/schema-types';
import { cleanupDbForTest, db } from '@/lib/drizzle';
import { catalogForVersion } from '@/lib/user/deletion-queue/deletion-catalog';
import {
  cancelPendingDeletionRequest,
  enqueueUserDeletionTargets,
  scrubControlPlanePii,
} from '@/lib/user/deletion-queue/deletion-enqueue';
import { insertTestUser } from '@/tests/helpers/user.helper';

describe('enqueueUserDeletionTargets', () => {
  beforeEach(async () => {
    await cleanupDbForTest();
  });

  it('creates one request with nine catalog tasks', async () => {
    const admin = await insertTestUser({ is_admin: true });
    const user = await insertTestUser({ google_user_email: 'queue-target@example.com' });

    const [result] = await enqueueUserDeletionTargets({
      actor: { kiloUserId: admin.id },
      targets: [{ email: user.google_user_email, trustedUserId: user.id }],
    });

    expect(result.status).toBe('enqueued');
    if (result.status !== 'enqueued') return;
    const [request] = await db
      .select()
      .from(user_deletion_requests)
      .where(eq(user_deletion_requests.id, result.requestId));
    expect(request?.status).toBe(UserDeletionRequestStatus.Pending);
    expect(request?.user_id).toBe(user.id);
    expect(request?.target_email).toBe('queue-target@example.com');
    expect(request?.cloud_subject_resolution).toBe(UserDeletionCloudSubjectResolution.CurrentUser);

    const steps = await db
      .select()
      .from(user_deletion_steps)
      .where(eq(user_deletion_steps.request_id, result.requestId));
    expect(steps).toHaveLength(catalogForVersion(1).length);
  });

  it('persists the Cloud user raw email and treats case variants as the same target', async () => {
    const admin = await insertTestUser({ is_admin: true });
    const user = await insertTestUser({ google_user_email: 'User@Example.com' });

    const [first] = await enqueueUserDeletionTargets({
      actor: { kiloUserId: admin.id },
      targets: [{ email: 'user@example.com', trustedUserId: user.id }],
    });
    expect(first.status).toBe('enqueued');
    if (first.status !== 'enqueued') return;

    const [request] = await db
      .select()
      .from(user_deletion_requests)
      .where(eq(user_deletion_requests.id, first.requestId));
    expect(request?.target_email).toBe('User@Example.com');

    const [second] = await enqueueUserDeletionTargets({
      actor: { kiloUserId: admin.id },
      targets: [{ email: 'USER@example.com' }],
    });
    expect(second).toMatchObject({
      status: 'already_active',
      requestId: first.requestId,
    });
  });

  it('refuses email-only targets with no Cloud user', async () => {
    const admin = await insertTestUser({ is_admin: true });
    const [result] = await enqueueUserDeletionTargets({
      actor: { kiloUserId: admin.id },
      targets: [{ email: '  User@Example.com  ' }],
    });
    expect(result).toEqual({ status: 'refused', code: 'no_cloud_user' });
    const requests = await db.select().from(user_deletion_requests);
    expect(requests).toHaveLength(0);
  });

  it('returns already_active for a duplicate email', async () => {
    const admin = await insertTestUser({ is_admin: true });
    const user = await insertTestUser({ google_user_email: 'dup@example.com' });
    const first = await enqueueUserDeletionTargets({
      actor: { kiloUserId: admin.id },
      targets: [{ email: 'dup@example.com', trustedUserId: user.id }],
    });
    const second = await enqueueUserDeletionTargets({
      actor: { kiloUserId: admin.id },
      targets: [{ email: 'DUP@example.com' }],
    });
    expect(first[0]?.status).toBe('enqueued');
    expect(second[0]).toMatchObject({
      status: 'already_active',
      requestId: first[0] && first[0].status === 'enqueued' ? first[0].requestId : undefined,
    });
  });

  it('returns already_active when the email HMAC no longer matches but the user does', async () => {
    const admin = await insertTestUser({ is_admin: true });
    const user = await insertTestUser({ google_user_email: 'userid-dup@example.com' });
    const [first] = await enqueueUserDeletionTargets({
      actor: { kiloUserId: admin.id },
      targets: [{ email: user.google_user_email, trustedUserId: user.id }],
    });
    expect(first.status).toBe('enqueued');
    if (first.status !== 'enqueued') return;

    await db
      .update(user_deletion_requests)
      .set({ target_email_hmac: `dummy-${crypto.randomUUID()}` })
      .where(eq(user_deletion_requests.id, first.requestId));

    const [second] = await enqueueUserDeletionTargets({
      actor: { kiloUserId: admin.id },
      targets: [{ email: user.google_user_email }],
    });
    expect(second).toMatchObject({
      status: 'already_active',
      requestId: first.requestId,
    });
  });

  it('refuses self-deletion without creating a request', async () => {
    const admin = await insertTestUser({
      is_admin: true,
      google_user_email: 'self-delete@example.com',
    });
    const [result] = await enqueueUserDeletionTargets({
      actor: { kiloUserId: admin.id, email: admin.google_user_email },
      targets: [{ email: admin.google_user_email }],
    });
    expect(result).toEqual({ status: 'refused', code: 'protected_self' });
    const requests = await db.select().from(user_deletion_requests);
    expect(requests).toHaveLength(0);
    const audits = await db.select().from(user_deletion_audit_events);
    expect(
      audits.some(event => event.event_type === UserDeletionAuditEventType.IntakeRefused)
    ).toBe(true);
  });

  it('enqueues another staff-domain user', async () => {
    const admin = await insertTestUser({
      is_admin: true,
      google_user_email: 'actor@kilocode.ai',
    });
    const staff = await insertTestUser({ google_user_email: 'cx@kilo.ai' });
    const [result] = await enqueueUserDeletionTargets({
      actor: { kiloUserId: admin.id, email: admin.google_user_email },
      targets: [{ email: staff.google_user_email }],
    });
    expect(result.status).toBe('enqueued');
    if (result.status === 'enqueued') {
      await db
        .delete(user_deletion_requests)
        .where(eq(user_deletion_requests.id, result.requestId));
    }
  });

  it('returns already_active when another active request holds the same Pylon ticket', async () => {
    const admin = await insertTestUser({ is_admin: true });
    const firstUser = await insertTestUser({ google_user_email: 'ticket-one@example.com' });
    const secondUser = await insertTestUser({ google_user_email: 'ticket-two@example.com' });
    const [first] = await enqueueUserDeletionTargets({
      actor: { kiloUserId: admin.id },
      targets: [
        {
          email: firstUser.google_user_email,
          pylonTicket: '#iss-shared',
          trustedUserId: firstUser.id,
        },
      ],
    });
    expect(first.status).toBe('enqueued');
    if (first.status !== 'enqueued') return;

    const [second] = await enqueueUserDeletionTargets({
      actor: { kiloUserId: admin.id },
      targets: [
        {
          email: secondUser.google_user_email,
          pylonTicket: 'iss-shared',
          trustedUserId: secondUser.id,
        },
      ],
    });
    expect(second).toMatchObject({
      status: 'already_active',
      requestId: first.requestId,
    });
  });

  it('rejects a mismatched trusted user-id hint', async () => {
    const admin = await insertTestUser({ is_admin: true });
    const user = await insertTestUser({ google_user_email: 'hint@example.com' });
    const other = await insertTestUser({ google_user_email: 'other-hint@example.com' });
    const [result] = await enqueueUserDeletionTargets({
      actor: { kiloUserId: admin.id },
      targets: [{ email: user.google_user_email, trustedUserId: other.id }],
    });
    expect(result).toEqual({ status: 'invalid', code: 'user_hint_mismatch' });
  });

  it('cancels only a pending request and scrubs the raw email', async () => {
    const admin = await insertTestUser({ is_admin: true });
    const user = await insertTestUser({ google_user_email: 'cancel-me@example.com' });
    const [enqueued] = await enqueueUserDeletionTargets({
      actor: { kiloUserId: admin.id },
      targets: [{ email: user.google_user_email, trustedUserId: user.id }],
    });
    expect(enqueued.status).toBe('enqueued');
    if (enqueued.status !== 'enqueued') return;
    const cancelled = await cancelPendingDeletionRequest({
      requestId: enqueued.requestId,
      actorKiloUserId: admin.id,
    });
    expect(cancelled).toEqual({ cancelled: true });
    const [request] = await db
      .select()
      .from(user_deletion_requests)
      .where(eq(user_deletion_requests.id, enqueued.requestId));
    expect(request?.status).toBe(UserDeletionRequestStatus.Cancelled);
    expect(request?.target_email).toBeNull();
    expect(request?.user_id).toBeNull();
    expect(request?.cancelled_at).toBeTruthy();
  });
});

describe('scrubControlPlanePii', () => {
  beforeEach(async () => {
    await cleanupDbForTest();
  });

  it('clears manual evidence text and last_error_code without nulling evidence', async () => {
    const admin = await insertTestUser({ is_admin: true });
    const user = await insertTestUser({
      google_user_email: `scrub-${crypto.randomUUID()}@example.com`,
    });
    const [enqueued] = await enqueueUserDeletionTargets({
      actor: { kiloUserId: admin.id },
      targets: [{ email: user.google_user_email, trustedUserId: user.id }],
    });
    expect(enqueued.status).toBe('enqueued');
    if (enqueued.status !== 'enqueued') {
      throw new Error('expected enqueued deletion request');
    }

    const recordedAt = new Date().toISOString();
    const evidence = {
      reason: 'Jane Doe confirmed deletion in the provider UI',
      evidence: 'Support agent Jane Doe saw the account gone',
      actor_kilo_user_id: admin.id,
      recorded_at: recordedAt,
    } satisfies UserDeletionManualEvidence;

    await db
      .update(user_deletion_steps)
      .set({
        status: UserDeletionStepStatus.ManuallyVerified,
        last_error_code: 'provider_timeout',
        manual_evidence_json: evidence,
      })
      .where(
        and(
          eq(user_deletion_steps.request_id, enqueued.requestId),
          eq(user_deletion_steps.step_key, UserDeletionStepKey.Customerio)
        )
      );

    await db.transaction(async tx => {
      await scrubControlPlanePii(tx, enqueued.requestId, UserDeletionRequestStatus.Completed);
    });

    const [verified] = await db
      .select()
      .from(user_deletion_steps)
      .where(
        and(
          eq(user_deletion_steps.request_id, enqueued.requestId),
          eq(user_deletion_steps.step_key, UserDeletionStepKey.Customerio)
        )
      );
    expect(verified?.last_error_code).toBeNull();
    expect(verified?.manual_evidence_json).toEqual({
      reason: '',
      evidence: '',
      actor_kilo_user_id: admin.id,
      recorded_at: recordedAt,
    });
  });
});
