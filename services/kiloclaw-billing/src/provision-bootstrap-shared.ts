import { and, desc, eq, isNotNull, isNull } from 'drizzle-orm';
import {
  CURRENT_KILOCLAW_PRICE_VERSION,
  LEGACY_KILOCLAW_PRICE_VERSION,
  getKiloClawPricingCatalogEntry,
  insertKiloClawSubscriptionChangeLog,
  kiloclaw_earlybird_purchases,
  kiloclaw_instances,
  kiloclaw_subscriptions,
  organization_seats_purchases,
  organizations,
  type KiloClawPriceVersion,
  type KiloClawPricingCatalogEntry,
  type KiloClawSubscription,
  type KiloClawSubscriptionChangeActor,
  type NewKiloClawSubscription,
  type Organization,
  type OrganizationSeatsPurchase,
  type WorkerDb,
} from '@kilocode/db';
import { classifyOrganizationEntitlement } from '@kilocode/organization-entitlement';

const ORGANIZATION_TRIAL_DURATION_DAYS = 14;

export class OrganizationKiloClawProvisionEntitlementError extends Error {
  readonly status = 403;
  readonly code = 'organization_kiloclaw_entitlement_expired';

  constructor() {
    super('Organization KiloClaw entitlement has expired.');
    this.name = 'OrganizationKiloClawProvisionEntitlementError';
  }
}

export type BootstrapProvisionInput = {
  userId: string;
  instanceId: string;
  orgId: string | null;
  expectedPriceVersion?: KiloClawPriceVersion;
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
  db: Pick<WorkerDb, 'insert' | 'select'>,
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

function getTrialEndsAt(startedAt: Date, trialDurationDays: number): string {
  return new Date(startedAt.getTime() + trialDurationDays * 24 * 60 * 60 * 1000).toISOString();
}

type ProvisionEntitlement = {
  priceVersion: KiloClawPriceVersion;
  selfServiceInstanceType: KiloClawPricingCatalogEntry['selfServiceInstanceType'];
};

function getProvisionEntitlementForPriceVersion(priceVersion: KiloClawPriceVersion) {
  const entry = getKiloClawPricingCatalogEntry(priceVersion);
  return {
    priceVersion: entry.priceVersion,
    selfServiceInstanceType: entry.selfServiceInstanceType,
  } satisfies ProvisionEntitlement;
}

function assertExpectedPriceVersion(params: {
  actual: KiloClawPriceVersion;
  expected: KiloClawPriceVersion | undefined;
  context: string;
}) {
  if (params.expected && params.expected !== params.actual) {
    throw new Error(
      `KiloClaw price-version drift during ${params.context}: expected ${params.expected}, got ${params.actual}`
    );
  }
}

type OrganizationEntitlementReader = Pick<WorkerDb, 'select'>;

type OrganizationProvisionEntitlementContext = {
  organization: Pick<
    Organization,
    'created_at' | 'free_trial_end_at' | 'require_seats' | 'settings'
  >;
  latestSeatPurchaseStatus: OrganizationSeatsPurchase['subscription_status'] | null;
};

async function loadOrganizationProvisionEntitlementContext(params: {
  executor: OrganizationEntitlementReader;
  missingOrganizationMessage: string;
  orgId: string;
}): Promise<OrganizationProvisionEntitlementContext> {
  const [organization] = await params.executor
    .select({
      created_at: organizations.created_at,
      free_trial_end_at: organizations.free_trial_end_at,
      require_seats: organizations.require_seats,
      settings: organizations.settings,
    })
    .from(organizations)
    .where(eq(organizations.id, params.orgId))
    .limit(1);

  if (!organization) {
    throw new Error(params.missingOrganizationMessage);
  }

  const [latestSeatPurchase] = await params.executor
    .select({ subscriptionStatus: organization_seats_purchases.subscription_status })
    .from(organization_seats_purchases)
    .where(eq(organization_seats_purchases.organization_id, params.orgId))
    .orderBy(desc(organization_seats_purchases.created_at))
    .limit(1);

  return {
    organization,
    latestSeatPurchaseStatus: latestSeatPurchase?.subscriptionStatus ?? null,
  };
}

async function requireOrganizationProvisionEntitlement(params: {
  executor: OrganizationEntitlementReader;
  missingOrganizationMessage: string;
  now: Date;
  orgId: string;
}): Promise<OrganizationProvisionEntitlementContext> {
  const context = await loadOrganizationProvisionEntitlementContext(params);
  const classification = classifyOrganizationEntitlement({
    organization: context.organization,
    latestSeatPurchaseStatus: context.latestSeatPurchaseStatus,
    now: params.now,
  });

  if (!classification.hasEntitlement) {
    throw new OrganizationKiloClawProvisionEntitlementError();
  }

  return context;
}

type OrgBootstrapWriter = Pick<WorkerDb, 'insert' | 'select' | 'update'>;

type OrgSubscriptionRow = {
  subscription: KiloClawSubscription;
  instance: {
    id: string;
    destroyedAt: string | null;
  };
};

type TransferUpdate = {
  before: KiloClawSubscription;
  transferredToSubscriptionId: string | null;
};

function compareSubscriptionsByCreatedAtAndId(
  left: KiloClawSubscription,
  right: KiloClawSubscription
): number {
  if (left.created_at === right.created_at) {
    return left.id.localeCompare(right.id);
  }
  return left.created_at.localeCompare(right.created_at);
}

function buildTransferUpdates(subscriptions: KiloClawSubscription[]): TransferUpdate[] {
  const orderedSubscriptions = [...subscriptions].sort(compareSubscriptionsByCreatedAtAndId);
  const updates: TransferUpdate[] = [];

  for (const [index, subscription] of orderedSubscriptions.entries()) {
    const nextSubscription = orderedSubscriptions[index + 1];
    const desiredTransferredTo = nextSubscription?.id ?? null;
    if (subscription.transferred_to_subscription_id === desiredTransferredTo) {
      continue;
    }
    updates.push({
      before: subscription,
      transferredToSubscriptionId: desiredTransferredTo,
    });
  }

  return updates;
}

function currentOrganizationSubscriptionRows(rows: OrgSubscriptionRow[]): OrgSubscriptionRow[] {
  return rows.filter(row => row.subscription.transferred_to_subscription_id === null);
}

function transferredToUnchangedWhere(subscription: KiloClawSubscription) {
  return subscription.transferred_to_subscription_id === null
    ? isNull(kiloclaw_subscriptions.transferred_to_subscription_id)
    : eq(
        kiloclaw_subscriptions.transferred_to_subscription_id,
        subscription.transferred_to_subscription_id
      );
}

async function listOrganizationSubscriptionRowsForTransfer(
  executor: OrgBootstrapWriter,
  userId: string,
  orgId: string
): Promise<OrgSubscriptionRow[]> {
  return await executor
    .select({
      subscription: kiloclaw_subscriptions,
      instance: {
        id: kiloclaw_instances.id,
        destroyedAt: kiloclaw_instances.destroyed_at,
      },
    })
    .from(kiloclaw_subscriptions)
    .innerJoin(kiloclaw_instances, eq(kiloclaw_instances.id, kiloclaw_subscriptions.instance_id))
    .where(
      and(
        eq(kiloclaw_subscriptions.user_id, userId),
        eq(kiloclaw_instances.user_id, userId),
        eq(kiloclaw_instances.organization_id, orgId)
      )
    )
    .orderBy(kiloclaw_subscriptions.created_at, kiloclaw_subscriptions.id)
    .for('update');
}

async function transferDestroyedOrganizationPredecessors(params: {
  actor: KiloClawSubscriptionChangeActor;
  executor: OrgBootstrapWriter;
  orgId: string;
  targetSubscription: KiloClawSubscription;
  targetWasInserted: boolean;
  userId: string;
}) {
  const rows = await listOrganizationSubscriptionRowsForTransfer(
    params.executor,
    params.userId,
    params.orgId
  );
  const targetRow = rows.find(row => row.subscription.id === params.targetSubscription.id);

  if (!targetRow || targetRow.instance.destroyedAt !== null) {
    if (params.targetWasInserted) {
      throw new Error('New organization bootstrap target row is missing or destroyed');
    }
    return;
  }

  const currentRows = currentOrganizationSubscriptionRows(rows);
  const liveCurrentRows = currentRows.filter(row => row.instance.destroyedAt === null);
  if (liveCurrentRows.length > 1) {
    throw new Error('Multiple current organization subscription rows found during bootstrap');
  }

  if (!liveCurrentRows.some(row => row.subscription.id === params.targetSubscription.id)) {
    if (params.targetWasInserted) {
      throw new Error('New organization bootstrap target row is not the current live row');
    }
    return;
  }

  const destroyedCurrentRows = currentRows.filter(row => row.instance.destroyedAt !== null);
  if (destroyedCurrentRows.length === 0) {
    return;
  }

  const orderedSubscriptions = [...rows.map(row => row.subscription)].sort(
    compareSubscriptionsByCreatedAtAndId
  );
  if (orderedSubscriptions.at(-1)?.id !== params.targetSubscription.id) {
    if (params.targetWasInserted) {
      throw new Error('New organization bootstrap target row is not the newest org row');
    }
    return;
  }

  const updates = buildTransferUpdates(orderedSubscriptions);
  if (updates.length === 0) {
    return;
  }

  for (const update of updates) {
    const [after] = await params.executor
      .update(kiloclaw_subscriptions)
      .set({
        transferred_to_subscription_id: update.transferredToSubscriptionId,
      })
      .where(
        and(
          eq(kiloclaw_subscriptions.id, update.before.id),
          transferredToUnchangedWhere(update.before)
        )
      )
      .returning();

    if (!after) {
      throw new Error(
        `Failed to transfer organization bootstrap predecessor subscription ${update.before.id}`
      );
    }

    await insertKiloClawSubscriptionChangeLog(params.executor, {
      subscriptionId: after.id,
      actor: params.actor,
      action: 'reassigned',
      reason: 'org_provision_transfer_destroyed_predecessor',
      before: update.before,
      after,
    });
  }
}

async function bootstrapOrganizationSubscription(params: BootstrapProvisionWithDbParams) {
  const { db, input } = params;
  if (!input.orgId) {
    throw new Error('Organization bootstrap requires orgId');
  }

  const now = new Date();
  const orgId = input.orgId;

  return await db.transaction(async tx => {
    const [targetInstance] = await tx
      .select({
        id: kiloclaw_instances.id,
        destroyedAt: kiloclaw_instances.destroyed_at,
      })
      .from(kiloclaw_instances)
      .where(
        and(
          eq(kiloclaw_instances.id, input.instanceId),
          eq(kiloclaw_instances.user_id, input.userId),
          eq(kiloclaw_instances.organization_id, orgId)
        )
      )
      .limit(1)
      .for('update');

    if (!targetInstance) {
      throw new Error('Organization instance not found during subscription bootstrap');
    }
    if (targetInstance.destroyedAt !== null) {
      throw new Error('Cannot bootstrap organization subscription on destroyed instance');
    }

    const { organization } = await requireOrganizationProvisionEntitlement({
      executor: tx,
      missingOrganizationMessage: 'Organization not found during subscription bootstrap',
      now,
      orgId,
    });

    const hasManagedActiveAccess = true;
    const trialEndsAt =
      organization.free_trial_end_at ??
      new Date(
        new Date(organization.created_at).getTime() +
          ORGANIZATION_TRIAL_DURATION_DAYS * 24 * 60 * 60 * 1000
      ).toISOString();

    const { row: created, created: wasInserted } = await insertSubscriptionIdempotent(
      tx,
      hasManagedActiveAccess
        ? {
            user_id: input.userId,
            instance_id: input.instanceId,
            plan: 'standard',
            status: 'active',
            payment_source: 'credits',
            kiloclaw_price_version: LEGACY_KILOCLAW_PRICE_VERSION,
            cancel_at_period_end: false,
          }
        : {
            user_id: input.userId,
            instance_id: input.instanceId,
            plan: 'trial',
            status: new Date(trialEndsAt).getTime() > now.getTime() ? 'trialing' : 'canceled',
            kiloclaw_price_version: LEGACY_KILOCLAW_PRICE_VERSION,
            access_origin: null,
            payment_source: null,
            cancel_at_period_end: false,
            trial_started_at: organization.created_at,
            trial_ends_at: trialEndsAt,
          }
    );
    assertExpectedPriceVersion({
      actual: created.kiloclaw_price_version,
      expected: input.expectedPriceVersion,
      context: 'organization provision bootstrap',
    });

    if (wasInserted) {
      await insertKiloClawSubscriptionChangeLog(tx, {
        subscriptionId: created.id,
        actor: params.actor,
        action: 'created',
        reason: hasManagedActiveAccess ? 'org_provision_managed' : 'org_provision_trial',
        before: null,
        after: created,
      });
    }

    await transferDestroyedOrganizationPredecessors({
      actor: params.actor,
      executor: tx,
      orgId,
      targetSubscription: created,
      targetWasInserted: wasInserted,
      userId: input.userId,
    });

    return created;
  });
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
        kiloclaw_price_version: before.kiloclaw_price_version,
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

async function loadPersonalBootstrapContext(params: {
  db: WorkerDb;
  userId: string;
  instanceId?: string;
}) {
  const existingForInstancePromise = params.instanceId
    ? params.db
        .select()
        .from(kiloclaw_subscriptions)
        .where(eq(kiloclaw_subscriptions.instance_id, params.instanceId))
        .limit(1)
        .then(rows => rows[0] ?? null)
    : Promise.resolve(null);

  const [existingForInstance, subscriptions, instances, legacyEarlybirdPurchase] =
    await Promise.all([
      existingForInstancePromise,
      params.db
        .select()
        .from(kiloclaw_subscriptions)
        .where(eq(kiloclaw_subscriptions.user_id, params.userId)),
      params.db
        .select({
          id: kiloclaw_instances.id,
          destroyedAt: kiloclaw_instances.destroyed_at,
          organizationId: kiloclaw_instances.organization_id,
        })
        .from(kiloclaw_instances)
        .where(eq(kiloclaw_instances.user_id, params.userId)),
      params.db
        .select({ id: kiloclaw_earlybird_purchases.id })
        .from(kiloclaw_earlybird_purchases)
        .where(eq(kiloclaw_earlybird_purchases.user_id, params.userId))
        .limit(1)
        .then(rows => rows[0] ?? null),
    ]);

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

  return {
    existingForInstance,
    instancesById,
    legacyEarlybirdPurchase,
    personalSubscriptions,
  };
}

function resolvePersonalProvisionEntitlementFromContext(params: {
  instancesById: Map<string, { destroyedAt: string | null; organizationId: string | null }>;
  legacyEarlybirdPurchase: { id: string } | null;
  now: Date;
  personalSubscriptions: KiloClawSubscription[];
}): ProvisionEntitlement {
  const currentPersonalSubscription = resolveExactCurrentPersonalSubscription(
    params.personalSubscriptions,
    params.instancesById,
    params.now
  );
  if (currentPersonalSubscription) {
    const currentInstance = currentPersonalSubscription.instance_id
      ? params.instancesById.get(currentPersonalSubscription.instance_id)
      : null;
    if (
      currentInstance?.destroyedAt &&
      isAccessGrantingSubscription(currentPersonalSubscription, params.now)
    ) {
      return getProvisionEntitlementForPriceVersion(
        currentPersonalSubscription.kiloclaw_price_version
      );
    }
    if (
      !currentInstance?.destroyedAt &&
      isAccessGrantingSubscription(currentPersonalSubscription, params.now)
    ) {
      throw new Error('Cannot provision fresh personal instance with existing live subscription');
    }
  }

  const detachedAccessGrantingSubscription = resolveDetachedAccessGrantingPersonalSubscription(
    params.personalSubscriptions,
    params.now
  );
  if (detachedAccessGrantingSubscription) {
    return getProvisionEntitlementForPriceVersion(
      detachedAccessGrantingSubscription.kiloclaw_price_version
    );
  }

  if (params.legacyEarlybirdPurchase) {
    throw new Error(
      'Cannot bootstrap personal subscription for legacy earlybird purchase without canonical row'
    );
  }

  return getProvisionEntitlementForPriceVersion(CURRENT_KILOCLAW_PRICE_VERSION);
}

export async function resolveProvisionEntitlementWithDb(params: {
  db: WorkerDb;
  input: { userId: string; orgId: string | null };
}): Promise<ProvisionEntitlement> {
  if (params.input.orgId) {
    await requireOrganizationProvisionEntitlement({
      executor: params.db,
      missingOrganizationMessage: 'Organization not found during provision entitlement resolution',
      now: new Date(),
      orgId: params.input.orgId,
    });
    return getProvisionEntitlementForPriceVersion(LEGACY_KILOCLAW_PRICE_VERSION);
  }

  const context = await loadPersonalBootstrapContext({
    db: params.db,
    userId: params.input.userId,
  });
  return resolvePersonalProvisionEntitlementFromContext({
    instancesById: context.instancesById,
    legacyEarlybirdPurchase: context.legacyEarlybirdPurchase,
    now: new Date(),
    personalSubscriptions: context.personalSubscriptions,
  });
}

async function bootstrapPersonalSubscription(params: BootstrapProvisionWithDbParams) {
  const { db, input } = params;
  const now = new Date();
  const context = await loadPersonalBootstrapContext({
    db,
    userId: input.userId,
    instanceId: input.instanceId,
  });

  if (context.existingForInstance) {
    assertExpectedPriceVersion({
      actual: context.existingForInstance.kiloclaw_price_version,
      expected: input.expectedPriceVersion,
      context: 'personal provision bootstrap idempotency',
    });
    return context.existingForInstance;
  }

  const currentPersonalSubscription = resolveExactCurrentPersonalSubscription(
    context.personalSubscriptions,
    context.instancesById,
    now
  );
  if (currentPersonalSubscription) {
    if (
      currentPersonalSubscription.instance_id &&
      currentPersonalSubscription.instance_id === input.instanceId
    ) {
      assertExpectedPriceVersion({
        actual: currentPersonalSubscription.kiloclaw_price_version,
        expected: input.expectedPriceVersion,
        context: 'personal provision bootstrap current row',
      });
      return currentPersonalSubscription;
    }

    const currentInstance = currentPersonalSubscription.instance_id
      ? context.instancesById.get(currentPersonalSubscription.instance_id)
      : null;
    if (
      currentInstance?.destroyedAt &&
      isAccessGrantingSubscription(currentPersonalSubscription, now)
    ) {
      assertExpectedPriceVersion({
        actual: currentPersonalSubscription.kiloclaw_price_version,
        expected: input.expectedPriceVersion,
        context: 'personal successor transfer',
      });
      return await createSuccessorPersonalSubscription({
        ...params,
        source: currentPersonalSubscription,
      });
    }
  }

  const detachedAccessGrantingSubscription = resolveDetachedAccessGrantingPersonalSubscription(
    context.personalSubscriptions,
    now
  );
  if (detachedAccessGrantingSubscription) {
    assertExpectedPriceVersion({
      actual: detachedAccessGrantingSubscription.kiloclaw_price_version,
      expected: input.expectedPriceVersion,
      context: 'detached personal successor transfer',
    });
    return await createSuccessorPersonalSubscription({
      ...params,
      source: detachedAccessGrantingSubscription,
    });
  }

  if (context.legacyEarlybirdPurchase) {
    throw new Error(
      'Cannot bootstrap personal subscription for legacy earlybird purchase without canonical row'
    );
  }

  const currentCatalogEntry = getKiloClawPricingCatalogEntry(CURRENT_KILOCLAW_PRICE_VERSION);
  assertExpectedPriceVersion({
    actual: currentCatalogEntry.priceVersion,
    expected: input.expectedPriceVersion,
    context: 'personal fresh trial bootstrap',
  });
  const { row: created, created: wasInserted } = await insertSubscriptionIdempotent(db, {
    user_id: input.userId,
    instance_id: input.instanceId,
    plan: 'trial',
    status: 'trialing',
    kiloclaw_price_version: currentCatalogEntry.priceVersion,
    access_origin: null,
    payment_source: null,
    cancel_at_period_end: false,
    trial_started_at: now.toISOString(),
    trial_ends_at: getTrialEndsAt(now, currentCatalogEntry.trialDurationDays),
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
