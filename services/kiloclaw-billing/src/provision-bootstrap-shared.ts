import { and, eq, isNotNull, isNull } from 'drizzle-orm';
import {
  insertKiloClawSubscriptionChangeLog,
  kiloclaw_earlybird_purchases,
  kiloclaw_instances,
  kiloclaw_subscriptions,
  organizations,
  type KiloClawSubscription,
  type KiloClawSubscriptionChangeActor,
  type NewKiloClawSubscription,
  type WorkerDb,
} from '@kilocode/db';

const PERSONAL_TRIAL_DURATION_DAYS = 7;
const ORGANIZATION_TRIAL_DURATION_DAYS = 14;

export type BootstrapProvisionInput = {
  userId: string;
  instanceId: string;
  orgId: string | null;
};

type ChangeLogErrorParams = {
  subscriptionId: string;
  action: 'created';
  reason: string;
  error: unknown;
};

type BootstrapProvisionWithDbParams = {
  db: WorkerDb;
  input: BootstrapProvisionInput;
  actor: KiloClawSubscriptionChangeActor;
  onChangeLogError?: (params: ChangeLogErrorParams) => void;
};

async function insertSubscriptionIdempotent(
  db: WorkerDb,
  values: NewKiloClawSubscription & { instance_id: string }
): Promise<{ row: KiloClawSubscription; created: boolean }> {
  const [inserted] = await db
    .insert(kiloclaw_subscriptions)
    .values(values)
    .onConflictDoNothing({
      target: kiloclaw_subscriptions.instance_id,
      where: isNotNull(kiloclaw_subscriptions.instance_id),
    })
    .returning();

  if (inserted) {
    return { row: inserted, created: true };
  }

  const [existing] = await db
    .select()
    .from(kiloclaw_subscriptions)
    .where(eq(kiloclaw_subscriptions.instance_id, values.instance_id))
    .limit(1);

  if (!existing) {
    throw new Error('Subscription insert reported conflict but no row exists for instance_id');
  }
  return { row: existing, created: false };
}

async function writeBootstrapChangeLogBestEffort(params: {
  db: WorkerDb;
  actor: KiloClawSubscriptionChangeActor;
  subscriptionId: string;
  action: 'created';
  reason: string;
  after: KiloClawSubscription;
  onError?: (params: ChangeLogErrorParams) => void;
}) {
  try {
    await insertKiloClawSubscriptionChangeLog(params.db, {
      subscriptionId: params.subscriptionId,
      actor: params.actor,
      action: params.action,
      reason: params.reason,
      before: null,
      after: params.after,
    });
  } catch (error) {
    params.onError?.({
      subscriptionId: params.subscriptionId,
      action: params.action,
      reason: params.reason,
      error,
    });
  }
}

function isAccessGrantingSubscription(
  subscription: Pick<KiloClawSubscription, 'status' | 'suspended_at' | 'trial_ends_at'>,
  now: Date
): boolean {
  if (subscription.status === 'active') return true;
  if (subscription.status === 'past_due' && !subscription.suspended_at) return true;
  if (
    subscription.status === 'trialing' &&
    subscription.trial_ends_at &&
    new Date(subscription.trial_ends_at) > now
  ) {
    return true;
  }
  return false;
}

function getTrialEndsAt(startedAt: Date): string {
  return new Date(
    startedAt.getTime() + PERSONAL_TRIAL_DURATION_DAYS * 24 * 60 * 60 * 1000
  ).toISOString();
}

async function bootstrapOrganizationSubscription(params: BootstrapProvisionWithDbParams) {
  const { db, input } = params;
  if (!input.orgId) {
    throw new Error('Organization bootstrap requires orgId');
  }

  const now = new Date();
  const orgId = input.orgId;

  const [existing, organization] = await Promise.all([
    db
      .select()
      .from(kiloclaw_subscriptions)
      .where(eq(kiloclaw_subscriptions.instance_id, input.instanceId))
      .limit(1)
      .then(rows => rows[0] ?? null),
    db
      .select({
        createdAt: organizations.created_at,
        freeTrialEndAt: organizations.free_trial_end_at,
      })
      .from(organizations)
      .where(eq(organizations.id, orgId))
      .limit(1)
      .then(rows => rows[0] ?? null),
  ]);

  if (existing) {
    return existing;
  }
  if (!organization) {
    throw new Error('Organization not found during subscription bootstrap');
  }

  const hasManagedActiveAccess = true;

  const trialEndsAt =
    organization.freeTrialEndAt ??
    new Date(
      new Date(organization.createdAt).getTime() +
        ORGANIZATION_TRIAL_DURATION_DAYS * 24 * 60 * 60 * 1000
    ).toISOString();

  const { row: created, created: wasInserted } = await insertSubscriptionIdempotent(
    db,
    hasManagedActiveAccess
      ? {
          user_id: input.userId,
          instance_id: input.instanceId,
          plan: 'standard',
          status: 'active',
          payment_source: 'credits',
          cancel_at_period_end: false,
        }
      : {
          user_id: input.userId,
          instance_id: input.instanceId,
          plan: 'trial',
          status: new Date(trialEndsAt).getTime() > now.getTime() ? 'trialing' : 'canceled',
          access_origin: null,
          payment_source: null,
          cancel_at_period_end: false,
          trial_started_at: organization.createdAt,
          trial_ends_at: trialEndsAt,
        }
  );

  if (!wasInserted) {
    return created;
  }

  await writeBootstrapChangeLogBestEffort({
    db,
    actor: params.actor,
    subscriptionId: created.id,
    action: 'created',
    reason: hasManagedActiveAccess ? 'org_provision_managed' : 'org_provision_trial',
    after: created,
    onError: params.onChangeLogError,
  });

  return created;
}

function currentPersonalSubscriptions(
  subscriptions: KiloClawSubscription[],
  instancesById: Map<string, { destroyedAt: string | null; organizationId: string | null }>
): KiloClawSubscription[] {
  return subscriptions.filter(subscription => {
    if (subscription.transferred_to_subscription_id) {
      return false;
    }
    if (!subscription.instance_id) {
      return false;
    }
    const instance = instancesById.get(subscription.instance_id);
    return !!instance && instance.organizationId === null;
  });
}

function parseSubscriptionTimestamp(value: string | null | undefined): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function currentSubscriptionRecency(subscription: KiloClawSubscription): number {
  return Math.max(
    parseSubscriptionTimestamp(subscription.current_period_end),
    parseSubscriptionTimestamp(subscription.credit_renewal_at),
    parseSubscriptionTimestamp(subscription.trial_ends_at),
    parseSubscriptionTimestamp(subscription.updated_at),
    parseSubscriptionTimestamp(subscription.created_at)
  );
}

async function createSuccessorPersonalSubscription(
  params: BootstrapProvisionWithDbParams & {
    source: KiloClawSubscription;
  }
) {
  const { db, input, source } = params;
  return await db.transaction(async tx => {
    const [before] = await tx
      .select()
      .from(kiloclaw_subscriptions)
      .where(
        and(
          eq(kiloclaw_subscriptions.id, source.id),
          isNull(kiloclaw_subscriptions.transferred_to_subscription_id)
        )
      )
      .limit(1)
      .for('update');

    if (!before) {
      throw new Error('Failed to load source subscription for successor transfer');
    }

    const [lockedTargetInstance] = await tx
      .select({ id: kiloclaw_instances.id })
      .from(kiloclaw_instances)
      .where(
        and(
          eq(kiloclaw_instances.id, input.instanceId),
          eq(kiloclaw_instances.user_id, before.user_id),
          isNull(kiloclaw_instances.organization_id)
        )
      )
      .limit(1)
      .for('update');

    if (!lockedTargetInstance) {
      throw new Error('Failed to lock target personal instance for successor transfer');
    }

    const [existingTargetRow] = await tx
      .select({ id: kiloclaw_subscriptions.id })
      .from(kiloclaw_subscriptions)
      .where(eq(kiloclaw_subscriptions.instance_id, input.instanceId))
      .limit(1)
      .for('update');

    if (existingTargetRow) {
      throw new Error('Target instance already has a subscription row');
    }

    const [insertedSuccessor] = await tx
      .insert(kiloclaw_subscriptions)
      .values({
        user_id: before.user_id,
        instance_id: input.instanceId,
        stripe_subscription_id: null,
        stripe_schedule_id: null,
        access_origin: before.access_origin,
        payment_source: before.payment_source,
        plan: before.plan,
        scheduled_plan: before.scheduled_plan,
        scheduled_by: before.scheduled_by,
        status: before.status,
        cancel_at_period_end: before.cancel_at_period_end,
        pending_conversion: before.pending_conversion,
        trial_started_at: before.trial_started_at,
        trial_ends_at: before.trial_ends_at,
        current_period_start: before.current_period_start,
        current_period_end: before.current_period_end,
        credit_renewal_at: before.credit_renewal_at,
        commit_ends_at: before.commit_ends_at,
        past_due_since: before.past_due_since,
        suspended_at: before.suspended_at,
        destruction_deadline: before.destruction_deadline,
        auto_resume_requested_at: before.auto_resume_requested_at,
        auto_resume_retry_after: before.auto_resume_retry_after,
        auto_resume_attempt_count: before.auto_resume_attempt_count,
        auto_top_up_triggered_for_period: before.auto_top_up_triggered_for_period,
      })
      .returning();

    if (!insertedSuccessor) {
      throw new Error('Failed to create successor personal subscription row');
    }

    const [predecessor] = await tx
      .update(kiloclaw_subscriptions)
      .set({
        status: 'canceled',
        transferred_to_subscription_id: insertedSuccessor.id,
        payment_source: 'credits',
        stripe_subscription_id: null,
        stripe_schedule_id: null,
        credit_renewal_at: null,
        cancel_at_period_end: false,
        pending_conversion: false,
        scheduled_plan: null,
        scheduled_by: null,
        auto_resume_requested_at: null,
        auto_resume_retry_after: null,
        auto_resume_attempt_count: 0,
        auto_top_up_triggered_for_period: null,
        destruction_deadline: null,
      })
      .where(eq(kiloclaw_subscriptions.id, before.id))
      .returning();

    if (!predecessor) {
      throw new Error('Failed to update predecessor personal subscription row');
    }

    const successor =
      before.stripe_subscription_id || before.stripe_schedule_id
        ? await tx
            .update(kiloclaw_subscriptions)
            .set({
              stripe_subscription_id: before.stripe_subscription_id,
              stripe_schedule_id: before.stripe_schedule_id,
            })
            .where(eq(kiloclaw_subscriptions.id, insertedSuccessor.id))
            .returning()
            .then(rows => rows[0] ?? null)
        : insertedSuccessor;

    if (!successor) {
      throw new Error('Failed to restore successor Stripe ownership');
    }

    await insertKiloClawSubscriptionChangeLog(tx, {
      subscriptionId: predecessor.id,
      actor: params.actor,
      action: 'reassigned',
      reason: 'subscription_transfer_out',
      before,
      after: predecessor,
    });

    await insertKiloClawSubscriptionChangeLog(tx, {
      subscriptionId: successor.id,
      actor: params.actor,
      action: 'created',
      reason: 'subscription_transfer_in',
      before: null,
      after: successor,
    });

    return successor;
  });
}

function resolveExactCurrentPersonalSubscription(
  subscriptions: KiloClawSubscription[],
  instancesById: Map<string, { destroyedAt: string | null; organizationId: string | null }>,
  now: Date
): KiloClawSubscription | null {
  const currentRows = currentPersonalSubscriptions(subscriptions, instancesById);
  const liveRows = currentRows.filter(row => {
    const instance = row.instance_id ? instancesById.get(row.instance_id) : null;
    return !instance?.destroyedAt;
  });
  if (liveRows.length > 1) {
    throw new Error('Multiple current personal subscription rows found during bootstrap');
  }
  if (liveRows[0]) {
    return liveRows[0];
  }

  const destroyedAccessRows = currentRows.filter(row => {
    const instance = row.instance_id ? instancesById.get(row.instance_id) : null;
    return !!instance?.destroyedAt && isAccessGrantingSubscription(row, now);
  });
  if (destroyedAccessRows.length === 0) {
    return null;
  }
  if (destroyedAccessRows.length > 1) {
    throw new Error('Multiple current personal subscription rows found during bootstrap');
  }
  return (
    [...destroyedAccessRows].sort((left, right) => {
      const recencyDiff = currentSubscriptionRecency(right) - currentSubscriptionRecency(left);
      if (recencyDiff !== 0) {
        return recencyDiff;
      }
      return right.id.localeCompare(left.id);
    })[0] ?? null
  );
}

function resolveDetachedAccessGrantingPersonalSubscription(
  subscriptions: KiloClawSubscription[],
  now: Date
): KiloClawSubscription | null {
  const detachedRows = subscriptions.filter(
    subscription =>
      !subscription.transferred_to_subscription_id &&
      subscription.instance_id === null &&
      isAccessGrantingSubscription(subscription, now)
  );
  if (detachedRows.length === 0) {
    return null;
  }
  if (detachedRows.length > 1) {
    throw new Error('Multiple detached access-granting personal subscription rows found');
  }
  return detachedRows[0] ?? null;
}

async function bootstrapPersonalSubscription(params: BootstrapProvisionWithDbParams) {
  const { db, input } = params;
  const now = new Date();

  const [existingForInstance, subscriptions, instances, legacyEarlybirdPurchase] =
    await Promise.all([
      db
        .select()
        .from(kiloclaw_subscriptions)
        .where(eq(kiloclaw_subscriptions.instance_id, input.instanceId))
        .limit(1)
        .then(rows => rows[0] ?? null),
      db
        .select()
        .from(kiloclaw_subscriptions)
        .where(eq(kiloclaw_subscriptions.user_id, input.userId)),
      db
        .select({
          id: kiloclaw_instances.id,
          destroyedAt: kiloclaw_instances.destroyed_at,
          organizationId: kiloclaw_instances.organization_id,
        })
        .from(kiloclaw_instances)
        .where(eq(kiloclaw_instances.user_id, input.userId)),
      db
        .select({ id: kiloclaw_earlybird_purchases.id })
        .from(kiloclaw_earlybird_purchases)
        .where(eq(kiloclaw_earlybird_purchases.user_id, input.userId))
        .limit(1)
        .then(rows => rows[0] ?? null),
    ]);

  if (existingForInstance) {
    return existingForInstance;
  }

  const instancesById = new Map(
    instances.map(instance => [
      instance.id,
      {
        destroyedAt: instance.destroyedAt,
        organizationId: instance.organizationId,
      },
    ])
  );
  const personalSubscriptions = subscriptions.filter(subscription => {
    if (subscription.instance_id === null) {
      return true;
    }

    const instance = instancesById.get(subscription.instance_id);
    return !instance || instance.organizationId === null;
  });

  const currentPersonalSubscription = resolveExactCurrentPersonalSubscription(
    personalSubscriptions,
    instancesById,
    now
  );
  if (currentPersonalSubscription) {
    if (
      currentPersonalSubscription.instance_id &&
      currentPersonalSubscription.instance_id === input.instanceId
    ) {
      return currentPersonalSubscription;
    }

    const currentInstance = currentPersonalSubscription.instance_id
      ? instancesById.get(currentPersonalSubscription.instance_id)
      : null;
    if (
      currentInstance?.destroyedAt &&
      isAccessGrantingSubscription(currentPersonalSubscription, now)
    ) {
      return await createSuccessorPersonalSubscription({
        ...params,
        source: currentPersonalSubscription,
      });
    }
  }

  const detachedAccessGrantingSubscription = resolveDetachedAccessGrantingPersonalSubscription(
    personalSubscriptions,
    now
  );
  if (detachedAccessGrantingSubscription) {
    return await createSuccessorPersonalSubscription({
      ...params,
      source: detachedAccessGrantingSubscription,
    });
  }

  if (personalSubscriptions.length > 0) {
    throw new Error(
      'Cannot bootstrap personal subscription with existing non-access-granting rows'
    );
  }

  if (legacyEarlybirdPurchase) {
    throw new Error(
      'Cannot bootstrap personal subscription for legacy earlybird purchase without canonical row'
    );
  }

  const { row: created, created: wasInserted } = await insertSubscriptionIdempotent(db, {
    user_id: input.userId,
    instance_id: input.instanceId,
    plan: 'trial',
    status: 'trialing',
    access_origin: null,
    payment_source: null,
    cancel_at_period_end: false,
    trial_started_at: now.toISOString(),
    trial_ends_at: getTrialEndsAt(now),
  });

  if (!wasInserted) {
    return created;
  }

  await writeBootstrapChangeLogBestEffort({
    db,
    actor: params.actor,
    subscriptionId: created.id,
    action: 'created',
    reason: 'personal_provision_trial',
    after: created,
    onError: params.onChangeLogError,
  });

  return created;
}

export async function bootstrapProvisionSubscriptionWithDb(params: BootstrapProvisionWithDbParams) {
  if (params.input.orgId) {
    return await bootstrapOrganizationSubscription(params);
  }
  return await bootstrapPersonalSubscription(params);
}
