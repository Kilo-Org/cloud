import { cleanupDbForTest, db } from '@/lib/drizzle';
import {
  device_auth_requests,
  device_sessions,
  kilocode_users,
  user_deletion_requests,
  user_deletion_steps,
} from '@kilocode/db/schema';
import {
  UserDeletionCloudSubjectResolution,
  UserDeletionRequestStatus,
  UserDeletionStepKey,
} from '@kilocode/db/schema-types';
import { eq } from 'drizzle-orm';
import { insertTestUser } from '@/tests/helpers/user.helper';
import { disableUserAccessForDeletion, getUserDeletionRequestById } from '@/lib/user/deletion';
import { hmacDeletionEmail } from '@/lib/user/deletion-queue/deletion-hmac';

describe('disableUserAccessForDeletion', () => {
  beforeEach(async () => {
    await cleanupDbForTest();
  });

  it('rotates peppers, denies device auth, and revokes device sessions', async () => {
    const admin = await insertTestUser();
    const user = await insertTestUser({
      api_token_pepper: 'api-pepper-before',
      web_session_pepper: 'web-pepper-before',
    });
    const [session] = await db
      .insert(device_sessions)
      .values({ kilo_user_id: user.id, user_agent: 'DeletionTest/1.0' })
      .returning({ id: device_sessions.id });
    const [authRequest] = await db
      .insert(device_auth_requests)
      .values({
        code: `code-${user.id}`,
        kilo_user_id: user.id,
        status: 'pending',
        expires_at: new Date(Date.now() + 60_000).toISOString(),
      })
      .returning({ id: device_auth_requests.id });

    await db.transaction(async tx => {
      await disableUserAccessForDeletion(tx, {
        userId: user.id,
        requestedByKiloUserId: admin.id,
        nowIso: new Date().toISOString(),
      });
    });

    const after = await db.query.kilocode_users.findFirst({
      where: eq(kilocode_users.id, user.id),
    });
    expect(after?.blocked_reason).toMatch(/^deletion-in-progress at /);
    expect(after?.blocked_at).not.toBeNull();
    expect(after?.blocked_by_kilo_user_id).toBe(admin.id);
    expect(after?.api_token_pepper).not.toBe('api-pepper-before');
    expect(after?.web_session_pepper).not.toBe('web-pepper-before');
    expect(after?.api_token_pepper).toEqual(expect.any(String));
    expect(after?.web_session_pepper).toEqual(expect.any(String));

    const afterSession = await db.query.device_sessions.findFirst({
      where: eq(device_sessions.id, session.id),
    });
    expect(afterSession?.revoked_at).not.toBeNull();
    expect(afterSession?.revoked_reason).toBe('user_deletion');

    const afterAuth = await db.query.device_auth_requests.findFirst({
      where: eq(device_auth_requests.id, authRequest.id),
    });
    expect(afterAuth?.status).toBe('denied');
  });

  it('overwrites an existing block instead of using blockUser semantics', async () => {
    const admin = await insertTestUser();
    const user = await insertTestUser({
      blocked_reason: 'already blocked',
      api_token_pepper: 'api-pepper-before',
      web_session_pepper: 'web-pepper-before',
    });

    await db.transaction(async tx => {
      await disableUserAccessForDeletion(tx, {
        userId: user.id,
        requestedByKiloUserId: admin.id,
        nowIso: new Date().toISOString(),
      });
    });

    const after = await db.query.kilocode_users.findFirst({
      where: eq(kilocode_users.id, user.id),
    });
    expect(after?.blocked_reason).toMatch(/^deletion-in-progress at /);
    expect(after?.api_token_pepper).not.toBe('api-pepper-before');
    expect(after?.web_session_pepper).not.toBe('web-pepper-before');
  });
});

describe('getUserDeletionRequestById', () => {
  beforeEach(async () => {
    await cleanupDbForTest();
  });

  it('returns the request and its steps', async () => {
    const user = await insertTestUser({ google_user_email: 'delete-me@example.com' });
    const request = await insertDeletionRequest(user);

    const loaded = await getUserDeletionRequestById(request.id);

    expect(loaded?.request.id).toBe(request.id);
    expect(loaded?.request.user_id).toBe(user.id);
    expect(loaded?.request.target_email).toBe('delete-me@example.com');
    expect(loaded?.steps.map(step => step.step_key)).toEqual([UserDeletionStepKey.Anonymize]);
  });

  it('returns null when the request does not exist', async () => {
    await expect(
      getUserDeletionRequestById('00000000-0000-4000-8000-000000000000')
    ).resolves.toBeNull();
  });
});

async function insertDeletionRequest(user: { id: string; google_user_email: string }) {
  const email = user.google_user_email.toLowerCase();
  const hmac = hmacDeletionEmail(email);
  const [request] = await db
    .insert(user_deletion_requests)
    .values({
      user_id: user.id,
      status: UserDeletionRequestStatus.Pending,
      catalog_version: 1,
      requested_by_kilo_user_id: null,
      target_email: email,
      target_email_hmac: hmac,
      cloud_subject_resolution: UserDeletionCloudSubjectResolution.CurrentUser,
    })
    .returning();
  if (!request) throw new Error('expected deletion request');
  await db.insert(user_deletion_steps).values({
    request_id: request.id,
    step_key: UserDeletionStepKey.Anonymize,
  });
  return request;
}
