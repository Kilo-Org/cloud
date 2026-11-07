import { db, cleanupDbForTest } from '@kilocode/web-shared/lib/drizzle';
import { createCallerForUser } from '@/routers/test-utils';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { createTestOrganization } from '@kilocode/web-shared/tests/helpers/organization.helper';
import {
  kiloclaw_admin_audit_logs,
  kiloclaw_instances,
  kiloclaw_subscription_change_log,
  kiloclaw_subscriptions,
} from '@kilocode/db/schema';
import type { User } from '@kilocode/db/schema';
import { eq, inArray } from 'drizzle-orm';
import { client as stripeMock } from '@kilocode/web-shared/lib/stripe-client';

let adminUser: User;
let targetUser: User;
let instanceCounter = 0;

const PRESERVED_FIELDS = [
  'status',
  'current_period_start',
  'current_period_end',
  'credit_renewal_at',
  'commit_ends_at',
  'trial_ends_at',
  'past_due_since',
  'suspended_at',
  'destruction_deadline',
] as const;

type SubscriptionInsert = typeof kiloclaw_subscriptions.$inferInsert;

async function insertSubscription(
  values: Omit<SubscriptionInsert, 'user_id' | 'instance_id'> & { organizationId?: string }
) {
  const { organizationId, ...subscriptionValues } = values;
  instanceCounter += 1;
  const [instance] = await db
    .insert(kiloclaw_instances)
    .values({
      user_id: targetUser.id,
      organization_id: organizationId ?? null,
      sandbox_id: `sandbox-bulk-cancel-${instanceCounter}`,
    })
    .returning();
  const [subscription] = await db
    .insert(kiloclaw_subscriptions)
    .values({ user_id: targetUser.id, instance_id: instance.id, ...subscriptionValues })
    .returning();
  return subscription;
}

async function loadSubscriptions(ids: string[]) {
  const rows = await db
    .select()
    .from(kiloclaw_subscriptions)
    .where(inArray(kiloclaw_subscriptions.id, ids));
  return new Map(rows.map(row => [row.id, row]));
}

function preservedSnapshot(row: typeof kiloclaw_subscriptions.$inferSelect) {
  return Object.fromEntries(PRESERVED_FIELDS.map(field => [field, row[field]]));
}

async function seedFleet() {
  const organization = await createTestOrganization('Bulk Cancel Org', targetUser.id, 0);

  const activeStripe = await insertSubscription({
    plan: 'standard',
    status: 'active',
    stripe_subscription_id: 'sub_bulk_active',
    stripe_schedule_id: 'sched_bulk_active',
    scheduled_plan: 'commit',
    scheduled_by: 'user',
    current_period_start: '2026-10-01T00:00:00.000Z',
    current_period_end: '2026-11-01T00:00:00.000Z',
  });
  const activeCredit = await insertSubscription({
    plan: 'standard',
    status: 'active',
    payment_source: 'credits',
    current_period_start: '2026-10-05T00:00:00.000Z',
    current_period_end: '2026-11-05T00:00:00.000Z',
    credit_renewal_at: '2026-11-05T00:00:00.000Z',
  });
  const pastDueStripe = await insertSubscription({
    plan: 'standard',
    status: 'past_due',
    stripe_subscription_id: 'sub_bulk_past_due',
    current_period_start: '2026-10-10T00:00:00.000Z',
    current_period_end: '2026-11-10T00:00:00.000Z',
    past_due_since: '2026-10-20T00:00:00.000Z',
  });
  const pastDueCredit = await insertSubscription({
    plan: 'commit',
    status: 'past_due',
    payment_source: 'credits',
    current_period_end: '2026-11-12T00:00:00.000Z',
    credit_renewal_at: '2026-11-12T00:00:00.000Z',
    commit_ends_at: '2027-01-12T00:00:00.000Z',
    past_due_since: '2026-10-22T00:00:00.000Z',
  });
  const suspendedPastDue = await insertSubscription({
    plan: 'standard',
    status: 'past_due',
    stripe_subscription_id: 'sub_bulk_suspended',
    current_period_end: '2026-10-15T00:00:00.000Z',
    past_due_since: '2026-10-01T00:00:00.000Z',
    suspended_at: '2026-10-16T00:00:00.000Z',
    destruction_deadline: '2026-11-16T00:00:00.000Z',
  });
  const orgManaged = await insertSubscription({
    plan: 'standard',
    status: 'active',
    payment_source: 'credits',
    organizationId: organization.id,
  });
  const trialing = await insertSubscription({
    plan: 'trial',
    status: 'trialing',
    trial_ends_at: '2026-11-03T00:00:00.000Z',
  });
  const canceled = await insertSubscription({
    plan: 'standard',
    status: 'canceled',
    current_period_end: '2026-10-01T00:00:00.000Z',
  });
  const alreadyCanceling = await insertSubscription({
    plan: 'standard',
    status: 'active',
    stripe_subscription_id: 'sub_bulk_already_canceling',
    cancel_at_period_end: true,
    current_period_end: '2026-11-20T00:00:00.000Z',
  });
  const transferTarget = await insertSubscription({
    plan: 'standard',
    status: 'canceled',
  });
  const transferred = await insertSubscription({
    plan: 'standard',
    status: 'active',
    stripe_subscription_id: 'sub_bulk_transferred',
    transferred_to_subscription_id: transferTarget.id,
    current_period_end: '2026-11-25T00:00:00.000Z',
  });

  return {
    eligible: {
      activeStripe,
      activeCredit,
      pastDueStripe,
      pastDueCredit,
      suspendedPastDue,
      orgManaged,
    },
    ineligible: { trialing, canceled, alreadyCanceling, transferTarget, transferred },
  };
}

beforeEach(async () => {
  await cleanupDbForTest();
  jest.restoreAllMocks();
  jest.spyOn(stripeMock.subscriptions, 'retrieve').mockResolvedValue({ schedule: null } as never);
  jest.spyOn(stripeMock.subscriptions, 'update').mockResolvedValue({} as never);
  jest.spyOn(stripeMock.subscriptions, 'cancel').mockResolvedValue({} as never);
  jest.spyOn(stripeMock.subscriptionSchedules, 'release').mockResolvedValue({} as never);

  adminUser = await insertTestUser({
    google_user_email: 'admin-kiloclaw-bulk-cancel@example.com',
    google_user_name: 'Bulk Admin',
    is_admin: true,
  });
  targetUser = await insertTestUser({
    google_user_email: 'target-kiloclaw-bulk-cancel@example.com',
    google_user_name: 'Bulk Target',
  });
});

afterAll(async () => {
  try {
    await cleanupDbForTest();
  } catch {
    // Database may already be torn down by the test runner.
  }
});

describe('admin.users.previewBulkCancelKiloClawSubscriptions', () => {
  it('counts eligible rows by status, ownership and funding', async () => {
    await seedFleet();
    const caller = await createCallerForUser(adminUser.id);

    const preview = await caller.admin.users.previewBulkCancelKiloClawSubscriptions();

    expect(preview).toEqual({
      total: 6,
      byStatus: { active: 3, past_due: 3 },
      byOwnership: { personal: 5, organization: 1 },
      byFunding: { stripe: 3, credits: 3 },
      noRenewalPeriod: 1,
    });
  });

  it('rejects non-admin callers', async () => {
    const caller = await createCallerForUser(targetUser.id);
    await expect(caller.admin.users.previewBulkCancelKiloClawSubscriptions()).rejects.toThrow();
  });
});

describe('admin.users.bulkCancelKiloClawSubscriptions', () => {
  it('requires the exact confirmation literal and admin access', async () => {
    const adminCaller = await createCallerForUser(adminUser.id);
    await expect(
      adminCaller.admin.users.bulkCancelKiloClawSubscriptions({ confirm: 'stop renewals' } as never)
    ).rejects.toThrow();

    const userCaller = await createCallerForUser(targetUser.id);
    await expect(
      userCaller.admin.users.bulkCancelKiloClawSubscriptions({ confirm: 'STOP RENEWALS' })
    ).rejects.toThrow();
  });

  it('flags only active and past-due current rows and preserves dates and status', async () => {
    const fleet = await seedFleet();
    const eligibleIds = Object.values(fleet.eligible).map(row => row.id);
    const ineligibleIds = Object.values(fleet.ineligible).map(row => row.id);
    const before = await loadSubscriptions([...eligibleIds, ...ineligibleIds]);

    const caller = await createCallerForUser(adminUser.id);
    const result = await caller.admin.users.bulkCancelKiloClawSubscriptions({
      confirm: 'STOP RENEWALS',
    });

    expect(result.total).toBe(6);
    expect(result.updated).toBe(6);
    expect(result.skipped).toBe(0);
    expect(result.failed).toEqual([]);
    expect(result.noRenewalPeriod).toEqual([
      { subscriptionId: fleet.eligible.orgManaged.id, userId: targetUser.id },
    ]);

    const after = await loadSubscriptions([...eligibleIds, ...ineligibleIds]);
    for (const id of eligibleIds) {
      const row = after.get(id);
      expect(row?.cancel_at_period_end).toBe(true);
      expect(row?.stripe_schedule_id).toBeNull();
      expect(row?.scheduled_plan).toBeNull();
      expect(row?.scheduled_by).toBeNull();
      expect(preservedSnapshot(row!)).toEqual(preservedSnapshot(before.get(id)!));
    }
    for (const id of ineligibleIds) {
      expect(after.get(id)).toEqual(before.get(id));
    }

    expect(stripeMock.subscriptionSchedules.release).toHaveBeenCalledTimes(1);
    expect(stripeMock.subscriptionSchedules.release).toHaveBeenCalledWith('sched_bulk_active');
    const updateCalls = jest.mocked(stripeMock.subscriptions.update).mock.calls;
    expect(updateCalls.map(call => call[0]).sort()).toEqual(
      ['sub_bulk_active', 'sub_bulk_past_due', 'sub_bulk_suspended'].sort()
    );
    for (const call of updateCalls) {
      expect(call).toHaveLength(2);
      expect(call[1]).toStrictEqual({ cancel_at_period_end: true });
    }
    expect(stripeMock.subscriptions.cancel).not.toHaveBeenCalled();

    const perRowAudits = await db
      .select()
      .from(kiloclaw_admin_audit_logs)
      .where(eq(kiloclaw_admin_audit_logs.action, 'kiloclaw.subscription.admin_cancel'));
    expect(perRowAudits).toHaveLength(6);
    for (const audit of perRowAudits) {
      expect(audit.metadata?.bulkRunId).toBe(result.bulkRunId);
      expect(audit.metadata?.reconciliationStatus).toBe('updated');
      expect(audit.metadata?.outcome).toBe('updated');
    }
    const orgAudit = perRowAudits.find(
      audit => audit.metadata?.subscriptionId === fleet.eligible.orgManaged.id
    );
    expect(orgAudit?.metadata?.noRenewalPeriod).toBe(true);

    const [summary] = await db
      .select()
      .from(kiloclaw_admin_audit_logs)
      .where(
        eq(kiloclaw_admin_audit_logs.action, 'kiloclaw.subscription.bulk_cancel_at_period_end')
      );
    expect(summary.actor_id).toBe(adminUser.id);
    expect(summary.metadata).toEqual(
      expect.objectContaining({
        bulkRunId: result.bulkRunId,
        total: 6,
        updated: 6,
        skipped: 0,
        failedCount: 0,
        failedSubscriptionIds: [],
      })
    );

    const changeLogs = await db
      .select()
      .from(kiloclaw_subscription_change_log)
      .where(inArray(kiloclaw_subscription_change_log.subscription_id, eligibleIds));
    expect(changeLogs).toHaveLength(6);
  });

  it('isolates a Stripe failure, audits it, and stays idempotent on re-run', async () => {
    const fleet = await seedFleet();
    jest.mocked(stripeMock.subscriptions.update).mockImplementation((async (id: string) => {
      if (id === 'sub_bulk_past_due') throw new Error('Stripe is unavailable');
      return {};
    }) as never);

    const caller = await createCallerForUser(adminUser.id);
    const result = await caller.admin.users.bulkCancelKiloClawSubscriptions({
      confirm: 'STOP RENEWALS',
    });

    expect(result.updated).toBe(5);
    expect(result.failed).toEqual([
      {
        subscriptionId: fleet.eligible.pastDueStripe.id,
        userId: targetUser.id,
        error: 'Stripe is unavailable',
      },
    ]);

    const after = await loadSubscriptions([fleet.eligible.pastDueStripe.id]);
    expect(after.get(fleet.eligible.pastDueStripe.id)?.cancel_at_period_end).toBe(false);

    const failureAudits = (
      await db
        .select()
        .from(kiloclaw_admin_audit_logs)
        .where(eq(kiloclaw_admin_audit_logs.action, 'kiloclaw.subscription.admin_cancel'))
    ).filter(audit => audit.metadata?.outcome === 'failed');
    expect(failureAudits).toHaveLength(1);
    expect(failureAudits[0].target_user_id).toBe(targetUser.id);
    expect(failureAudits[0].metadata).toEqual(
      expect.objectContaining({
        bulkRunId: result.bulkRunId,
        subscriptionId: fleet.eligible.pastDueStripe.id,
        outcome: 'failed',
        error: 'Stripe is unavailable',
        noRenewalPeriod: false,
      })
    );

    jest.mocked(stripeMock.subscriptions.update).mockResolvedValue({} as never);
    jest.mocked(stripeMock.subscriptions.update).mockClear();
    const retry = await caller.admin.users.bulkCancelKiloClawSubscriptions({
      confirm: 'STOP RENEWALS',
    });
    expect(retry.total).toBe(1);
    expect(retry.updated).toBe(1);
    expect(stripeMock.subscriptions.update).toHaveBeenCalledTimes(1);

    jest.mocked(stripeMock.subscriptions.update).mockClear();
    jest.mocked(stripeMock.subscriptions.retrieve).mockClear();
    const noop = await caller.admin.users.bulkCancelKiloClawSubscriptions({
      confirm: 'STOP RENEWALS',
    });
    expect(noop).toEqual(expect.objectContaining({ total: 0, updated: 0, skipped: 0, failed: [] }));
    expect(stripeMock.subscriptions.update).not.toHaveBeenCalled();
    expect(stripeMock.subscriptions.retrieve).not.toHaveBeenCalled();
  });
});
