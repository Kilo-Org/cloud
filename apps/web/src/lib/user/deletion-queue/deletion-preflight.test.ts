import { eq } from 'drizzle-orm';
import { user_deletion_requests } from '@kilocode/db/schema';
import {
  UserDeletionCloudSubjectResolution,
  UserDeletionRequestStatus,
} from '@kilocode/db/schema-types';
import { cleanupDbForTest, db } from '@/lib/drizzle';
import { enqueueUserDeletionTargets } from '@/lib/user/deletion-queue/deletion-enqueue';
import { runDeletionPreflight } from '@/lib/user/deletion-queue/deletion-preflight';
import { resolveTicketEmail } from '@/lib/user/deletion-queue/deletion-ticket-resolve';
import { insertTestUser } from '@/tests/helpers/user.helper';

jest.mock('@/lib/user/deletion-queue/deletion-ticket-resolve', () => ({
  resolveTicketEmail: jest.fn(),
}));

const resolveTicketEmailMock = jest.mocked(resolveTicketEmail);

async function enqueueTicket(ticket = '#9001') {
  const admin = await insertTestUser({
    is_admin: true,
    google_user_email: `preflight-actor-${crypto.randomUUID()}@example.com`,
  });
  const [result] = await enqueueUserDeletionTargets({
    actor: { kiloUserId: admin.id, email: admin.google_user_email },
    targets: [{ pylonTicket: ticket }],
  });
  expect(result.status).toBe('enqueued');
  if (result.status !== 'enqueued') throw new Error('expected enqueued');
  return result.requestId;
}

describe('runDeletionPreflight ticket resolution', () => {
  beforeEach(async () => {
    await cleanupDbForTest();
    resolveTicketEmailMock.mockReset();
  });

  it('parks delete-ready missing as attention', async () => {
    resolveTicketEmailMock.mockResolvedValue({
      kind: 'attention',
      code: 'delete_ready_missing',
    });
    const requestId = await enqueueTicket();

    const result = await runDeletionPreflight(requestId);

    expect(result).toEqual({ kind: 'attention', code: 'delete_ready_missing' });
    const [request] = await db
      .select()
      .from(user_deletion_requests)
      .where(eq(user_deletion_requests.id, requestId));
    expect(request?.status).toBe(UserDeletionRequestStatus.Pending);
    expect(request?.preflight_attention_code).toBe('delete_ready_missing');
    expect(request?.target_email).toBeNull();
  });

  it('writes the resolved email and promotes with no Cloud user', async () => {
    resolveTicketEmailMock.mockResolvedValue({
      kind: 'resolved',
      email: 'relay-user@example.com',
    });
    const requestId = await enqueueTicket();

    const result = await runDeletionPreflight(requestId);

    expect(result).toEqual({ kind: 'promoted', userId: null });
    const [request] = await db
      .select()
      .from(user_deletion_requests)
      .where(eq(user_deletion_requests.id, requestId));
    expect(request?.status).toBe(UserDeletionRequestStatus.InProgress);
    expect(request?.target_email).toBe('relay-user@example.com');
    expect(request?.user_id).toBeNull();
    expect(request?.cloud_subject_resolution).toBe(
      UserDeletionCloudSubjectResolution.AuthoritativeAbsence
    );
    expect(request?.preflight_attention_code).toBeNull();
  });

  it('refuses a resolved relay target', async () => {
    resolveTicketEmailMock.mockResolvedValue({
      kind: 'attention',
      code: 'relay_or_internal_email',
    });
    const requestId = await enqueueTicket();

    const result = await runDeletionPreflight(requestId);

    expect(result).toEqual({ kind: 'attention', code: 'relay_or_internal_email' });
    const [request] = await db
      .select()
      .from(user_deletion_requests)
      .where(eq(user_deletion_requests.id, requestId));
    expect(request?.status).toBe(UserDeletionRequestStatus.Pending);
    expect(request?.preflight_attention_code).toBe('relay_or_internal_email');
    expect(request?.target_email).toBeNull();
  });

  it('retries 429 without writing an attention code', async () => {
    resolveTicketEmailMock.mockResolvedValue({ kind: 'retryable' });
    const requestId = await enqueueTicket();

    const result = await runDeletionPreflight(requestId);

    expect(result).toEqual({ kind: 'skipped', reason: 'retryable' });
    const [request] = await db
      .select()
      .from(user_deletion_requests)
      .where(eq(user_deletion_requests.id, requestId));
    expect(request?.status).toBe(UserDeletionRequestStatus.Pending);
    expect(request?.preflight_attention_code).toBeNull();
    expect(request?.target_email).toBeNull();
  });

  it('parks a collision with an already-active request', async () => {
    const admin = await insertTestUser({ is_admin: true });
    const user = await insertTestUser({ google_user_email: 'same-person@example.com' });
    const [existing] = await enqueueUserDeletionTargets({
      actor: { kiloUserId: admin.id },
      targets: [{ email: user.google_user_email, trustedUserId: user.id }],
    });
    expect(existing.status).toBe('enqueued');

    resolveTicketEmailMock.mockResolvedValue({
      kind: 'resolved',
      email: 'same-person@example.com',
    });
    const requestId = await enqueueTicket('#9002');

    const result = await runDeletionPreflight(requestId);

    expect(result).toEqual({ kind: 'attention', code: 'duplicate_of_active_request' });
    const [request] = await db
      .select()
      .from(user_deletion_requests)
      .where(eq(user_deletion_requests.id, requestId));
    expect(request?.status).toBe(UserDeletionRequestStatus.Pending);
    expect(request?.preflight_attention_code).toBe('duplicate_of_active_request');
    expect(request?.target_email).toBeNull();
    if (existing.status === 'enqueued') {
      const [other] = await db
        .select()
        .from(user_deletion_requests)
        .where(eq(user_deletion_requests.id, existing.requestId));
      expect(other?.status).toBe(UserDeletionRequestStatus.Pending);
    }
  });

  it('parks a ticket that resolves to the enqueue actor as protected_self', async () => {
    const admin = await insertTestUser({
      is_admin: true,
      google_user_email: `preflight-self-${crypto.randomUUID()}@example.com`,
    });
    const [enqueued] = await enqueueUserDeletionTargets({
      actor: { kiloUserId: admin.id, email: admin.google_user_email },
      targets: [{ pylonTicket: '#9003' }],
    });
    expect(enqueued.status).toBe('enqueued');
    if (enqueued.status !== 'enqueued') throw new Error('expected enqueued');

    resolveTicketEmailMock.mockResolvedValue({
      kind: 'resolved',
      email: admin.google_user_email,
    });

    const result = await runDeletionPreflight(enqueued.requestId);

    expect(result).toEqual({ kind: 'attention', code: 'protected_self' });
    const [request] = await db
      .select()
      .from(user_deletion_requests)
      .where(eq(user_deletion_requests.id, enqueued.requestId));
    expect(request?.status).toBe(UserDeletionRequestStatus.Pending);
    expect(request?.preflight_attention_code).toBe('protected_self');
  });

  it('promotes a ticket that resolves to a current Cloud user', async () => {
    const user = await insertTestUser({ google_user_email: 'ticket-user@example.com' });
    resolveTicketEmailMock.mockResolvedValue({
      kind: 'resolved',
      email: 'ticket-user@example.com',
    });
    const requestId = await enqueueTicket();

    const result = await runDeletionPreflight(requestId);

    expect(result).toEqual({ kind: 'promoted', userId: user.id });
    const [request] = await db
      .select()
      .from(user_deletion_requests)
      .where(eq(user_deletion_requests.id, requestId));
    expect(request?.user_id).toBe(user.id);
    expect(request?.target_email).toBe('ticket-user@example.com');
    expect(request?.cloud_subject_resolution).toBe(UserDeletionCloudSubjectResolution.CurrentUser);
  });
});
