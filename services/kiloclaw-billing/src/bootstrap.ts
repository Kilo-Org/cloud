import { desc, eq } from 'drizzle-orm';
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

function chooseAdoptablePersonalSubscription(
  subscriptions: KiloClawSubscription[],
  instancesById: Map<string, { destroyedAt: string | null; organizationId: string | null }>,
  now: Date
): KiloClawSubscription | null {
  const candidates = subscriptions.filter(subscription => {
    if (!isAccessGrantingSubscription(subscription, now)) {
      return false;
    }
    if (subscription.instance_id === null) {
      return true;
    }
    const instance = instancesById.get(subscription.instance_id);
    return !!instance && instance.organizationId === null && !!instance.destroyedAt;
  });

  if (candidates.length === 0) {
    return null;
  }

  return (
    [...candidates].sort((left, right) => {
      if (left.plan !== right.plan) {
        return left.plan === 'trial' ? 1 : -1;
      }
      return right.created_at.localeCompare(left.created_at);
    })[0] ?? null
  );
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

  const adoptable = chooseAdoptablePersonalSubscription(personalSubscriptions, instancesById, now);
  if (adoptable) {
    const before = adoptable;
    const [updated] = await db
      .update(kiloclaw_subscriptions)
      .set({ instance_id: input.instanceId })
      .where(eq(kiloclaw_subscriptions.id, adoptable.id))
      .returning();

    if (!updated) {
      throw new Error('Failed to reassign provision bootstrap subscription');
    }

    await writeBootstrapChangeLogBestEffort(env, {
      subscriptionId: updated.id,
      actor: BOOTSTRAP_ACTOR,
      action: 'reassigned',
      reason:
        before.instance_id === null
          ? 'personal_provision_adopt_detached'
          : 'personal_provision_reassign_destroyed',
      before,
      after: updated,
    });

    return updated;
  }

  if (personalSubscriptions.length > 0) {
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
