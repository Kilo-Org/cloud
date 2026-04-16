import { and, desc, eq, isNull } from 'drizzle-orm';
import {
  getWorkerDb,
  insertKiloClawSubscriptionChangeLog,
  kiloclaw_earlybird_purchases,
  kiloclaw_instances,
  kiloclaw_subscriptions,
  organizations,
  organization_seats_purchases,
  type KiloClawSubscription,
} from '@kilocode/db';
import type { BillingWorkerEnv } from './types.js';

const KILOCLAW_EARLYBIRD_EXPIRY_DATE = '2026-09-26';
const PERSONAL_TRIAL_DURATION_DAYS = 7;
const ORGANIZATION_TRIAL_DURATION_DAYS = 14;
const BOOTSTRAP_ACTOR = {
  actorType: 'system',
  actorId: 'kiloclaw-billing-bootstrap',
} as const;

type BootstrapProvisionInput = {
  userId: string;
  instanceId: string;
  orgId: string | null;
};

async function writeBootstrapChangeLogBestEffort(
  env: BillingWorkerEnv,
  input: Parameters<typeof insertKiloClawSubscriptionChangeLog>[1]
) {
  try {
    const db = getWorkerDb(env.HYPERDRIVE.connectionString);
    await insertKiloClawSubscriptionChangeLog(db, input);
  } catch (error) {
    console.error('[kiloclaw-billing/bootstrap] Failed to write subscription change log', {
      subscriptionId: input.subscriptionId,
      action: input.action,
      reason: input.reason,
      error: error instanceof Error ? error.message : String(error),
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

async function bootstrapOrganizationSubscription(
  env: BillingWorkerEnv,
  input: BootstrapProvisionInput
) {
  if (!input.orgId) {
    throw new Error('Organization bootstrap requires orgId');
  }

  const db = getWorkerDb(env.HYPERDRIVE.connectionString);
  const now = new Date();
  const orgId = input.orgId;

  const [existing, organization, latestSeatPurchase] = await Promise.all([
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
        requireSeats: organizations.require_seats,
        settings: organizations.settings,
      })
      .from(organizations)
      .where(eq(organizations.id, orgId))
      .limit(1)
      .then(rows => rows[0] ?? null),
    db
      .select({
        subscriptionStatus: organization_seats_purchases.subscription_status,
      })
      .from(organization_seats_purchases)
      .where(eq(organization_seats_purchases.organization_id, orgId))
      .orderBy(desc(organization_seats_purchases.created_at))
      .limit(1)
      .then(rows => rows[0] ?? null),
  ]);

  if (existing) {
    return existing;
  }
  if (!organization) {
    throw new Error('Organization not found during subscription bootstrap');
  }

  const hasManagedActiveAccess =
    latestSeatPurchase?.subscriptionStatus === 'active' ||
    !organization.requireSeats ||
    organization.settings.oss_sponsorship_tier != null ||
    !!organization.settings.suppress_trial_messaging;
  const trialEndsAt =
    organization.freeTrialEndAt ??
    new Date(
      new Date(organization.createdAt).getTime() +
        ORGANIZATION_TRIAL_DURATION_DAYS * 24 * 60 * 60 * 1000
    ).toISOString();

  const [created] = await db
    .insert(kiloclaw_subscriptions)
    .values(
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
    )
    .returning();

  if (!created) {
    throw new Error('Failed to create organization subscription row');
  }

  await writeBootstrapChangeLogBestEffort(env, {
    subscriptionId: created.id,
    actor: BOOTSTRAP_ACTOR,
    action: 'created',
    reason: hasManagedActiveAccess ? 'org_provision_managed' : 'org_provision_trial',
    before: null,
    after: created,
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
    return !instance || instance.organizationId === null;
  });
}

async function createSuccessorPersonalSubscription(params: {
  db: ReturnType<typeof getWorkerDb>;
  env: BillingWorkerEnv;
  source: KiloClawSubscription;
  targetInstanceId: string;
}) {
  return await params.db.transaction(async tx => {
    const [before] = await tx
      .select()
      .from(kiloclaw_subscriptions)
      .where(
        and(
          eq(kiloclaw_subscriptions.id, params.source.id),
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
          eq(kiloclaw_instances.id, params.targetInstanceId),
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
      .where(eq(kiloclaw_subscriptions.instance_id, params.targetInstanceId))
      .limit(1)
      .for('update');

    if (existingTargetRow) {
      throw new Error('Target instance already has a subscription row');
    }

    const [insertedSuccessor] = await tx
      .insert(kiloclaw_subscriptions)
      .values({
        user_id: before.user_id,
        instance_id: params.targetInstanceId,
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
      actor: BOOTSTRAP_ACTOR,
      action: 'reassigned',
      reason: 'subscription_transfer_out',
      before,
      after: predecessor,
    });

    await insertKiloClawSubscriptionChangeLog(tx, {
      subscriptionId: successor.id,
      actor: BOOTSTRAP_ACTOR,
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
  instancesById: Map<string, { destroyedAt: string | null; organizationId: string | null }>
): KiloClawSubscription | null {
  const currentRows = currentPersonalSubscriptions(subscriptions, instancesById);
  if (currentRows.length === 0) {
    return null;
  }
  if (currentRows.length > 1) {
    throw new Error('Multiple current personal subscription rows found during bootstrap');
  }
  return currentRows[0] ?? null;
}

async function bootstrapPersonalSubscription(
  env: BillingWorkerEnv,
  input: BootstrapProvisionInput
) {
  const db = getWorkerDb(env.HYPERDRIVE.connectionString);
  const now = new Date();

  const [existingForInstance, subscriptions, instances, earlybirdPurchase] = await Promise.all([
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
      .select({
        id: kiloclaw_earlybird_purchases.id,
        createdAt: kiloclaw_earlybird_purchases.created_at,
      })
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
    instancesById
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
        db,
        env,
        source: currentPersonalSubscription,
        targetInstanceId: input.instanceId,
      });
    }
  }

  const hasActiveEarlybirdAccess =
    !!earlybirdPurchase && new Date(KILOCLAW_EARLYBIRD_EXPIRY_DATE).getTime() > now.getTime();

  if (personalSubscriptions.length > 0 && !hasActiveEarlybirdAccess) {
    throw new Error(
      'Cannot bootstrap personal subscription with existing non-access-granting rows'
    );
  }

  const [created] = await db
    .insert(kiloclaw_subscriptions)
    .values(
      earlybirdPurchase
        ? {
            user_id: input.userId,
            instance_id: input.instanceId,
            plan: 'trial',
            status:
              new Date(KILOCLAW_EARLYBIRD_EXPIRY_DATE).getTime() > now.getTime()
                ? 'trialing'
                : 'canceled',
            access_origin: 'earlybird',
            payment_source: null,
            cancel_at_period_end: false,
            trial_started_at: earlybirdPurchase.createdAt,
            trial_ends_at: KILOCLAW_EARLYBIRD_EXPIRY_DATE,
          }
        : {
            user_id: input.userId,
            instance_id: input.instanceId,
            plan: 'trial',
            status: 'trialing',
            access_origin: null,
            payment_source: null,
            cancel_at_period_end: false,
            trial_started_at: now.toISOString(),
            trial_ends_at: getTrialEndsAt(now),
          }
    )
    .returning();

  if (!created) {
    throw new Error('Failed to create personal provision subscription row');
  }

  await writeBootstrapChangeLogBestEffort(env, {
    subscriptionId: created.id,
    actor: BOOTSTRAP_ACTOR,
    action: 'created',
    reason: earlybirdPurchase ? 'personal_provision_earlybird' : 'personal_provision_trial',
    before: null,
    after: created,
  });

  return created;
}

export async function bootstrapProvisionSubscription(
  env: BillingWorkerEnv,
  input: BootstrapProvisionInput
) {
  if (input.orgId) {
    return await bootstrapOrganizationSubscription(env, input);
  }
  return await bootstrapPersonalSubscription(env, input);
}
