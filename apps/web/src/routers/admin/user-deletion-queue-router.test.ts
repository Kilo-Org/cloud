import { eq, inArray, sql } from 'drizzle-orm';
import {
  kilocode_users,
  user_deletion_requests,
  user_deletion_steps,
  type User,
} from '@kilocode/db/schema';
import { UserDeletionRequestStatus } from '@kilocode/db/schema-types';
import { db } from '@/lib/drizzle';
import { USER_DELETION_CATALOG_VERSION } from '@/lib/user/deletion-queue/deletion-constants';
import { catalogForVersion } from '@/lib/user/deletion-queue/deletion-catalog';
import { scrubControlPlanePii } from '@/lib/user/deletion-queue/deletion-enqueue';
import type { inferRouterInputs } from '@trpc/server';
import { createCallerForUser } from '@/routers/test-utils';
import type { RootRouter } from '@/routers/root-router';
import { insertTestUser } from '@/tests/helpers/user.helper';

type DeletionQueueInputs = inferRouterInputs<RootRouter>['admin']['userDeletionQueue'];
type _AssertNoSetPaused = 'setPaused' extends keyof DeletionQueueInputs ? never : true;
const _noSetPaused: _AssertNoSetPaused = true;
void _noSetPaused;

const CATALOG_KEYS = catalogForVersion(USER_DELETION_CATALOG_VERSION).map(entry => entry.stepKey);

describe('adminUserDeletionQueueRouter', () => {
  let admin: User;
  let regularUser: User;
  let targetUser: User;
  let requestIds: string[] = [];

  beforeAll(async () => {
    const suffix = `${Date.now()}-${crypto.randomUUID()}`;
    admin = await insertTestUser({
      google_user_email: `deletion-queue-admin-${suffix}@example.com`,
      is_admin: true,
    });
    regularUser = await insertTestUser({
      google_user_email: `deletion-queue-regular-${suffix}@example.com`,
    });
    targetUser = await insertTestUser({
      google_user_email: `deletion-queue-target-${suffix}@example.com`,
    });
  });

  afterEach(async () => {
    if (requestIds.length > 0) {
      await db.delete(user_deletion_requests).where(inArray(user_deletion_requests.id, requestIds));
      requestIds = [];
    }
  });

  afterAll(async () => {
    await db
      .delete(kilocode_users)
      .where(inArray(kilocode_users.id, [admin.id, regularUser.id, targetUser.id]));
  });

  it('requires admin access', async () => {
    const caller = await createCallerForUser(regularUser.id);
    await expect(
      caller.admin.userDeletionQueue.preview({ entries: [{ email: targetUser.google_user_email }] })
    ).rejects.toThrow('Admin access required');
  });

  it('preview returns normalized targets without provider calls or DB writes', async () => {
    const fetchSpy = jest.spyOn(globalThis, 'fetch');
    const [{ count: before }] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(user_deletion_requests);
    const caller = await createCallerForUser(admin.id);

    const result = await caller.admin.userDeletionQueue.preview({
      entries: [
        { email: '  Person@Example.com ', pylonTicket: '#99' },
        { email: 'staff@kilocode.ai' },
      ],
    });

    expect(result.rejected).toEqual([]);
    expect(result.accepted.map(entry => entry.email)).toEqual([
      'person@example.com',
      'staff@kilocode.ai',
    ]);
    expect(fetchSpy).not.toHaveBeenCalled();
    const [{ count: after }] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(user_deletion_requests);
    expect(after).toBe(before);
    fetchSpy.mockRestore();
  });

  it('submit creates catalog tasks when intake is enabled', async () => {
    const caller = await createCallerForUser(admin.id);
    const [result] = await caller.admin.userDeletionQueue.submit({
      entries: [{ email: targetUser.google_user_email, pylonTicket: '#ticket-1' }],
    });
    expect(result?.status).toBe('enqueued');
    if (result?.status !== 'enqueued') throw new Error('expected enqueued');
    requestIds.push(result.requestId);

    const steps = await db
      .select({ stepKey: user_deletion_steps.step_key })
      .from(user_deletion_steps)
      .where(eq(user_deletion_steps.request_id, result.requestId));
    expect(steps.map(step => step.stepKey).sort()).toEqual([...CATALOG_KEYS].sort());
    expect(steps).toHaveLength(CATALOG_KEYS.length);
  });

  it('submit returns already_active for a duplicate target', async () => {
    const caller = await createCallerForUser(admin.id);
    const first = await caller.admin.userDeletionQueue.submit({
      entries: [{ email: targetUser.google_user_email }],
    });
    expect(first[0]?.status).toBe('enqueued');
    if (first[0]?.status === 'enqueued') requestIds.push(first[0].requestId);

    const second = await caller.admin.userDeletionQueue.submit({
      entries: [{ email: targetUser.google_user_email }],
    });
    expect(second[0]).toEqual({
      status: 'already_active',
      requestId: first[0]?.status === 'enqueued' ? first[0].requestId : undefined,
    });
  });

  it('refuses self-deletion without creating a request', async () => {
    const caller = await createCallerForUser(admin.id);
    const [{ count: before }] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(user_deletion_requests);
    const [result] = await caller.admin.userDeletionQueue.submit({
      entries: [{ email: admin.google_user_email }],
    });
    expect(result).toEqual({ status: 'refused', code: 'protected_self' });
    const [{ count: after }] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(user_deletion_requests);
    expect(after).toBe(before);
  });

  it('completed requests are not searchable by userId while detail by id still works', async () => {
    const caller = await createCallerForUser(admin.id);
    const [enqueued] = await caller.admin.userDeletionQueue.submit({
      entries: [{ email: targetUser.google_user_email }],
    });
    expect(enqueued?.status).toBe('enqueued');
    if (enqueued?.status !== 'enqueued') throw new Error('expected enqueued');
    requestIds.push(enqueued.requestId);

    await db.transaction(async tx => {
      await scrubControlPlanePii(tx, enqueued.requestId, UserDeletionRequestStatus.Completed);
    });

    const byUserId = await db
      .select({ id: user_deletion_requests.id })
      .from(user_deletion_requests)
      .where(eq(user_deletion_requests.user_id, targetUser.id));
    expect(byUserId).toHaveLength(0);

    const detail = await caller.admin.userDeletionQueue.detail({ requestId: enqueued.requestId });
    expect(detail.request.id).toBe(enqueued.requestId);
    expect(detail.request.status).toBe('completed');
    expect(detail.request.email).toBeNull();
    expect(detail.request.userId).toBeNull();
    expect(detail.tasks).toHaveLength(CATALOG_KEYS.length);

    const listed = await caller.admin.userDeletionQueue.list({
      tab: 'completed',
      searchEmail: targetUser.google_user_email,
    });
    expect(listed.rows.some(row => row.id === enqueued.requestId)).toBe(true);
    const listedRow = listed.rows.find(row => row.id === enqueued.requestId);
    expect(listedRow?.email).toBeNull();
    expect(listedRow?.userId).toBeNull();
  });

  it('preview rejects an already queued email and the actor themselves', async () => {
    const caller = await createCallerForUser(admin.id);
    const [enqueued] = await caller.admin.userDeletionQueue.submit({
      entries: [{ email: targetUser.google_user_email }],
    });
    if (enqueued?.status === 'enqueued') requestIds.push(enqueued.requestId);

    const result = await caller.admin.userDeletionQueue.preview({
      entries: [{ email: targetUser.google_user_email }, { email: admin.google_user_email }],
    });
    expect(result.accepted).toEqual([]);
    expect(result.rejected.map(entry => entry.code).sort()).toEqual([
      'already_active',
      'protected_self',
    ]);
  });

  it('summary counts queued, needs-attention, and recent completions', async () => {
    const caller = await createCallerForUser(admin.id);
    const before = await caller.admin.userDeletionQueue.summary();

    const [enqueued] = await caller.admin.userDeletionQueue.submit({
      entries: [{ email: targetUser.google_user_email }],
    });
    expect(enqueued?.status).toBe('enqueued');
    if (enqueued?.status !== 'enqueued') throw new Error('expected enqueued');
    requestIds.push(enqueued.requestId);

    const afterQueue = await caller.admin.userDeletionQueue.summary();
    expect(afterQueue.queued).toBe(before.queued + 1);
    expect(afterQueue.needsAttention).toBe(before.needsAttention);

    await db
      .update(user_deletion_requests)
      .set({ preflight_attention_code: 'missing_target_email' })
      .where(eq(user_deletion_requests.id, enqueued.requestId));

    const afterAttention = await caller.admin.userDeletionQueue.summary();
    expect(afterAttention.needsAttention).toBe(before.needsAttention + 1);

    await db.transaction(async tx => {
      await scrubControlPlanePii(tx, enqueued.requestId, UserDeletionRequestStatus.Completed);
    });

    const afterComplete = await caller.admin.userDeletionQueue.summary();
    expect(afterComplete.queued).toBe(before.queued);
    expect(afterComplete.needsAttention).toBe(before.needsAttention);
    expect(afterComplete.completedLast7Days).toBe(before.completedLast7Days + 1);
    expect(afterComplete.completedWindowDays).toBe(7);
  });

  it('does not expose pause on the serialized request or router', async () => {
    const caller = await createCallerForUser(admin.id);
    const [enqueued] = await caller.admin.userDeletionQueue.submit({
      entries: [{ email: targetUser.google_user_email }],
    });
    expect(enqueued?.status).toBe('enqueued');
    if (enqueued?.status !== 'enqueued') throw new Error('expected enqueued');
    requestIds.push(enqueued.requestId);

    const detail = await caller.admin.userDeletionQueue.detail({ requestId: enqueued.requestId });
    expect(detail.request).not.toHaveProperty('pausedAt');
  });
});
