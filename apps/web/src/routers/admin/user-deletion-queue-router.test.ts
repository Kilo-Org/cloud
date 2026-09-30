import { eq, inArray, sql } from 'drizzle-orm';
import {
  kilocode_users,
  kiloclaw_subscriptions,
  user_deletion_audit_events,
  user_deletion_requests,
  user_deletion_steps,
  type User,
} from '@kilocode/db/schema';
import {
  UserDeletionAuditEventType,
  UserDeletionCloudSubjectResolution,
  UserDeletionRequestStatus,
  UserDeletionStepKey,
  UserDeletionStepStatus,
} from '@kilocode/db/schema-types';
import { db } from '@/lib/drizzle';
import { findUserById } from '@/lib/user';
import {
  USER_DELETION_CATALOG_VERSION,
  USER_DELETION_ID_ONLY_CATALOG_VERSION,
} from '@/lib/user/deletion-queue/deletion-constants';
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
  let historicalUserIds: string[] = [];

  async function historicalUser(id = `oauth/GitHub/CaseSensitive+${crypto.randomUUID()}`) {
    const user = await insertTestUser({
      id,
      google_user_email: `deleted+${id}@deleted.invalid`,
      blocked_reason: 'soft-deleted at 2026-08-26T00:00:00.000Z',
      api_token_pepper: 'historical-api-pepper',
      web_session_pepper: 'historical-web-pepper',
    });
    historicalUserIds.push(user.id);
    return user;
  }

  async function queueState() {
    return {
      requests: await db.select().from(user_deletion_requests).orderBy(user_deletion_requests.id),
      steps: await db.select().from(user_deletion_steps).orderBy(user_deletion_steps.id),
      audits: await db
        .select()
        .from(user_deletion_audit_events)
        .orderBy(user_deletion_audit_events.id),
    };
  }

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
    jest.restoreAllMocks();
    if (requestIds.length > 0) {
      await db.delete(user_deletion_requests).where(inArray(user_deletion_requests.id, requestIds));
      requestIds = [];
    }
    if (historicalUserIds.length > 0) {
      await db
        .delete(kiloclaw_subscriptions)
        .where(inArray(kiloclaw_subscriptions.user_id, historicalUserIds));
      await db.delete(kilocode_users).where(inArray(kilocode_users.id, historicalUserIds));
      historicalUserIds = [];
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

  describe('historical users', () => {
    beforeEach(() => {
      jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected external request'));
    });

    describe.each(['previewHistoricalUsers', 'submitHistoricalUsers'] as const)('%s', method => {
      it('requires admin access', async () => {
        const caller = await createCallerForUser(regularUser.id);
        await expect(
          caller.admin.userDeletionQueue[method]({ userIds: [targetUser.id] })
        ).rejects.toThrow('Admin access required');
      });

      it('rejects invalid batches before writing any queue records', async () => {
        const user = await historicalUser();
        const caller = await createCallerForUser(admin.id);
        const before = await queueState();
        const invalidIds = [
          '',
          '   ',
          'x'.repeat(1025),
          '\nuser',
          'user\n',
          'user\r\nother',
          'user\tother',
          'user\u0000other',
          'user\u001fother',
          'user\u007fother',
          'user\u0085other',
          'user\u009fother',
          'user\u2028other',
          'user\u2029other',
        ];
        const invalidBatches = [
          [],
          Array<string>(101).fill(user.id),
          ...invalidIds.map(id => [user.id, id]),
        ];
        for (const userIds of invalidBatches) {
          await expect(caller.admin.userDeletionQueue[method]({ userIds })).rejects.toMatchObject({
            code: 'BAD_REQUEST',
          });
        }
        expect(await queueState()).toEqual(before);
        expect(fetch).not.toHaveBeenCalled();
      });

      it('rejects caller-supplied admin IDs, catalogues, steps, and execution flags', async () => {
        const user = await historicalUser();
        const caller = await createCallerForUser(admin.id);
        const before = await queueState();
        for (const overrides of [
          { adminUserId: regularUser.id },
          { catalogVersion: 2 },
          { stepKeys: [UserDeletionStepKey.CompletionEmail] },
          { execute: true },
        ]) {
          const input = { userIds: [user.id], ...overrides };
          await expect(caller.admin.userDeletionQueue[method](input)).rejects.toMatchObject({
            code: 'BAD_REQUEST',
          });
        }
        expect(await queueState()).toEqual(before);
      });

      it('accepts 100 input IDs and a 1024-character opaque ID', async () => {
        const caller = await createCallerForUser(admin.id);
        const userId = 'oauth/Provider/'.padEnd(1024, 'x');
        await expect(
          caller.admin.userDeletionQueue[method]({ userIds: Array<string>(100).fill(userId) })
        ).resolves.toEqual([{ userId, status: 'refused', code: 'user_not_found' }]);
      });
    });

    it('preview exposes eligible, refused, and terminal existing results without writes or providers', async () => {
      const user = await historicalUser();
      const completedUser = await historicalUser();
      const caller = await createCallerForUser(admin.id);
      const [enqueued] = await caller.admin.userDeletionQueue.submitHistoricalUsers({
        userIds: [completedUser.id],
      });
      if (enqueued?.status !== 'enqueued') throw new Error('expected enqueued');
      requestIds.push(enqueued.requestId);
      await db.transaction(tx =>
        scrubControlPlanePii(tx, enqueued.requestId, UserDeletionRequestStatus.Completed)
      );
      const before = await queueState();

      const result = await caller.admin.userDeletionQueue.previewHistoricalUsers({
        userIds: [user.id, regularUser.id, completedUser.id],
      });
      expect(result).toEqual([
        { userId: user.id, status: 'eligible' },
        { userId: regularUser.id, status: 'refused', code: 'not_canonical_soft_deleted_user' },
        {
          userId: completedUser.id,
          status: 'existing',
          requestId: enqueued.requestId,
          requestStatus: UserDeletionRequestStatus.Completed,
        },
      ]);
      expect(await queueState()).toEqual(before);
      expect(await findUserById(user.id)).toEqual(user);
      expect(fetch).not.toHaveBeenCalled();
    });

    it('submit attributes one V3 user-ID-only request to the authenticated admin without notifications', async () => {
      const user = await historicalUser();
      const caller = await createCallerForUser(admin.id);
      const result = await caller.admin.userDeletionQueue.submitHistoricalUsers({
        userIds: [user.id, ` ${user.id} `, user.id],
      });
      const [enqueued] = result;
      if (enqueued?.status !== 'enqueued') throw new Error('expected enqueued');
      requestIds.push(enqueued.requestId);
      expect(result).toEqual([
        { userId: user.id, status: 'enqueued', requestId: enqueued.requestId },
      ]);

      const requests = await db
        .select()
        .from(user_deletion_requests)
        .where(eq(user_deletion_requests.user_id, user.id));
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({
        id: enqueued.requestId,
        user_id: user.id,
        target_email: user.google_user_email,
        requested_by_kilo_user_id: admin.id,
        status: UserDeletionRequestStatus.InProgress,
        catalog_version: USER_DELETION_ID_ONLY_CATALOG_VERSION,
        cloud_subject_resolution: UserDeletionCloudSubjectResolution.CurrentUser,
        pylon_ticket_ref: null,
      });
      const steps = await db
        .select()
        .from(user_deletion_steps)
        .where(eq(user_deletion_steps.request_id, enqueued.requestId));
      expect(steps).toHaveLength(6);
      expect(
        steps
          .filter(step => step.status === UserDeletionStepStatus.Pending)
          .map(step => step.step_key)
          .sort()
      ).toEqual(
        [
          UserDeletionStepKey.KiloclawDestroy,
          UserDeletionStepKey.CliV1Blobs,
          UserDeletionStepKey.CliV2Sessions,
          UserDeletionStepKey.UsagePromptPrefixes,
          UserDeletionStepKey.Posthog,
          UserDeletionStepKey.Anonymize,
        ].sort()
      );
      const audits = await db
        .select()
        .from(user_deletion_audit_events)
        .where(eq(user_deletion_audit_events.request_id, enqueued.requestId));
      expect(audits).toEqual([
        expect.objectContaining({
          event_type: UserDeletionAuditEventType.RequestCreated,
          actor_kilo_user_id: admin.id,
          details_json: {
            catalog_version: USER_DELETION_ID_ONLY_CATALOG_VERSION,
            code: 'user_id_only_backfill_2026_08_26',
          },
        }),
      ]);
      expect(await findUserById(user.id)).toEqual(user);
      expect(fetch).not.toHaveBeenCalled();
    });

    it('trims and deduplicates IDs without folding case or removing internal spaces', async () => {
      const user = await historicalUser();
      const differentlyCased = await historicalUser(user.id.toLowerCase());
      const opaqueUser = await historicalUser(`external|Opaque ID:${crypto.randomUUID()}`);
      const caller = await createCallerForUser(admin.id);
      await expect(
        caller.admin.userDeletionQueue.previewHistoricalUsers({
          userIds: [` ${user.id} `, user.id, differentlyCased.id, ` ${opaqueUser.id} `],
        })
      ).resolves.toEqual([
        { userId: user.id, status: 'eligible' },
        { userId: differentlyCased.id, status: 'eligible' },
        { userId: opaqueUser.id, status: 'eligible' },
      ]);
    });

    it('submit revalidates subscriptions added after preview', async () => {
      const user = await historicalUser();
      const caller = await createCallerForUser(admin.id);
      await expect(
        caller.admin.userDeletionQueue.previewHistoricalUsers({ userIds: [user.id] })
      ).resolves.toEqual([{ userId: user.id, status: 'eligible' }]);
      await db.insert(kiloclaw_subscriptions).values({
        user_id: user.id,
        plan: 'standard',
        status: 'active',
        cancel_at_period_end: true,
      });
      const before = await queueState();
      await expect(
        caller.admin.userDeletionQueue.submitHistoricalUsers({ userIds: [user.id] })
      ).resolves.toEqual([{ userId: user.id, status: 'refused', code: 'live_subscription' }]);
      expect(await queueState()).toEqual(before);
      expect(await findUserById(user.id)).toEqual(user);
      expect(fetch).not.toHaveBeenCalled();
    });

    it.each([{ is_admin: false }, { blocked_reason: 'blocked' }])(
      'rechecks the authenticated admin against current database state: %j',
      async overrides => {
        const user = await historicalUser();
        const caller = await createCallerForUser(admin.id);
        await expect(
          caller.admin.userDeletionQueue.previewHistoricalUsers({ userIds: [user.id] })
        ).resolves.toEqual([{ userId: user.id, status: 'eligible' }]);
        const before = await queueState();
        await db.update(kilocode_users).set(overrides).where(eq(kilocode_users.id, admin.id));
        try {
          for (const method of ['previewHistoricalUsers', 'submitHistoricalUsers'] as const) {
            await expect(
              caller.admin.userDeletionQueue[method]({ userIds: [user.id] })
            ).resolves.toEqual([
              { userId: user.id, status: 'refused', code: 'active_admin_required' },
            ]);
          }
          expect(await queueState()).toEqual(before);
        } finally {
          await db
            .update(kilocode_users)
            .set({ is_admin: admin.is_admin, blocked_reason: admin.blocked_reason })
            .where(eq(kilocode_users.id, admin.id));
        }
      }
    );

    it('submit isolates unexpected failures and preserves sequential partial outcomes without logging errors', async () => {
      const firstUser = await historicalUser();
      const failedUser = await historicalUser();
      const lastUser = await historicalUser();
      const caller = await createCallerForUser(admin.id);
      const transaction = db.transaction.bind(db);
      const order: string[] = [];
      jest
        .spyOn(db, 'transaction')
        .mockImplementationOnce(async (...args) => {
          const result = await transaction(...args);
          order.push('first_completed');
          return result;
        })
        .mockImplementationOnce(async () => {
          order.push('second_failed');
          throw new Error('Private database failure details');
        });
      const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);

      const results = await caller.admin.userDeletionQueue.submitHistoricalUsers({
        userIds: [firstUser.id, failedUser.id, regularUser.id, lastUser.id],
      });
      for (const result of results) {
        if (result.status === 'enqueued') requestIds.push(result.requestId);
      }
      expect(results).toEqual([
        { userId: firstUser.id, status: 'enqueued', requestId: expect.any(String) },
        { userId: failedUser.id, status: 'failed' },
        { userId: regularUser.id, status: 'refused', code: 'not_canonical_soft_deleted_user' },
        { userId: lastUser.id, status: 'enqueued', requestId: expect.any(String) },
      ]);
      const requests = await db
        .select({ userId: user_deletion_requests.user_id })
        .from(user_deletion_requests)
        .where(inArray(user_deletion_requests.user_id, historicalUserIds));
      expect(requests.map(request => request.userId).sort()).toEqual(
        [firstUser.id, lastUser.id].sort()
      );
      expect(order).toEqual(['first_completed', 'second_failed']);
      expect(errorSpy).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
    });
  });
});
