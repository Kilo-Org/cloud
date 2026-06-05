import 'server-only';

import { captureException } from '@sentry/nextjs';
import { addDays } from 'date-fns';
import { insertKiloClawSubscriptionChangeLog } from '@kilocode/db';
import {
  auto_top_up_configs,
  coding_plan_subscriptions,
  credit_transactions,
  kilocode_users,
  kiloclaw_instances,
  kiloclaw_subscriptions,
  organization_seats_purchases,
  organizations,
  stripe_dispute_actions,
  stripe_dispute_cases,
  user_admin_notes,
  type KiloClawSubscription,
  type StripeDisputeCase,
} from '@kilocode/db/schema';
import {
  StripeDisputeActionStatus,
  StripeDisputeActionType,
  StripeDisputeCaseStatus,
  StripeDisputeOwnerClassification,
  type StripeDisputeActionStatus as DisputeActionStatus,
  type StripeDisputeActionType as DisputeActionType,
  type StripeDisputeCaseStatus as DisputeCaseStatus,
  type StripeDisputeOwnerClassification as OwnerClassification,
} from '@kilocode/db/schema-types';
import { and, desc, eq, inArray, isNotNull, isNull, like, lt, not, or, sql } from 'drizzle-orm';
import type Stripe from 'stripe';

import { reportEvents } from '@/lib/ai-gateway/abuse-service';
import { terminateCodingPlanImmediately } from '@/lib/coding-plans';
import { db, type DrizzleTransaction } from '@/lib/drizzle';
import { cancelAndRefundKiloPassForUser } from '@/lib/kilo-pass/cancel-and-refund';
import { createKiloClawAdminAuditLog } from '@/lib/kiloclaw/admin-audit-log';
import { workerInstanceId } from '@/lib/kiloclaw/instance-registry';
import { KiloClawInternalClient } from '@/lib/kiloclaw/kiloclaw-internal-client';
import { client } from '@/lib/stripe-client';
import { fromMicrodollars } from '@/lib/utils';
import { revokeWebSessions } from '@/lib/web-session-revocation';

type StripeReference = string | { id: string } | null | undefined;

type DisputeReference = Pick<
  Stripe.Dispute,
  | 'id'
  | 'amount'
  | 'charge'
  | 'created'
  | 'currency'
  | 'evidence_details'
  | 'payment_intent'
  | 'reason'
  | 'status'
>;

type ObserveStripeDisputeCreatedParams = {
  eventId: string;
  eventCreated: number;
  dispute: DisputeReference;
  preFetchedCharge?: Stripe.Charge | null;
};

type OwnerResolution = {
  classification: OwnerClassification;
  kiloUserId: string | null;
  organizationId: string | null;
  reason: string;
};

type DisputeCaseValues = {
  eventId: string;
  eventCreatedAt: string;
  disputeId: string;
  chargeId: string | null;
  paymentIntentId: string | null;
  customerId: string | null;
  amountMinorUnits: number | null;
  currency: string | null;
  disputeReason: string | null;
  stripeStatus: string | null;
  owner: OwnerResolution;
  status: DisputeCaseStatus;
  statusReason: string;
  stripeCreatedAt: string;
  evidenceDueBy: string | null;
};

type AdminActor = {
  id: string;
  google_user_email: string;
  google_user_name: string | null;
};

export type AcceptStripeDisputeResult = {
  status: 'accepted' | 'enforcement_failed';
  failures: string[];
};

export class StripeDisputeCaseActionError extends Error {
  name = 'StripeDisputeCaseActionError';
}

export function isStripeDisputeCaseActionError(
  error: unknown
): error is StripeDisputeCaseActionError {
  return error instanceof StripeDisputeCaseActionError;
}

const DISPUTE_ACTION_RETRY_DELAY_MS = 5 * 60 * 1000;
const DISPUTE_KILOCLAW_DESTRUCTION_GRACE_DAYS = 7;
const DISPUTE_ENFORCEMENT_REASON = 'stripe_dispute_accepted';

const actionableStripeStatusValues = ['needs_response', 'warning_needs_response'];
const actionableStripeStatuses = new Set(actionableStripeStatusValues);
const closedStripeStatuses = new Set(['lost', 'won', 'prevented', 'warning_closed']);

function stripeReferenceId(reference: StripeReference): string | null {
  if (typeof reference === 'string') {
    return reference || null;
  }

  return reference?.id || null;
}

function stripeTimestampToIso(timestamp: number | null | undefined): string | null {
  if (!timestamp) {
    return null;
  }

  return new Date(timestamp * 1000).toISOString();
}

function isAlreadyClosedStripeDisputeError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const normalizedMessage = message.toLowerCase();
  return (
    (normalizedMessage.includes('already') && normalizedMessage.includes('closed')) ||
    normalizedMessage.includes('already been closed') ||
    normalizedMessage.includes('not open')
  );
}

function statusForObservedDispute(params: {
  stripeStatus: string | null;
  owner: OwnerResolution;
}): { status: DisputeCaseStatus; reason: string } {
  if (params.stripeStatus && closedStripeStatuses.has(params.stripeStatus)) {
    return {
      status: StripeDisputeCaseStatus.Closed,
      reason: `Stripe dispute is ${params.stripeStatus}`,
    };
  }

  if (!params.stripeStatus || !actionableStripeStatuses.has(params.stripeStatus)) {
    return {
      status: StripeDisputeCaseStatus.ReviewRequired,
      reason: params.stripeStatus
        ? `Stripe dispute is ${params.stripeStatus}; manual review required`
        : 'Stripe dispute status is unavailable; manual review required',
    };
  }

  if (
    params.owner.classification === StripeDisputeOwnerClassification.Personal ||
    params.owner.classification === StripeDisputeOwnerClassification.Organization
  ) {
    return {
      status: StripeDisputeCaseStatus.NeedsAction,
      reason: params.owner.reason,
    };
  }

  return {
    status: StripeDisputeCaseStatus.ReviewRequired,
    reason: params.owner.reason,
  };
}

async function resolveOwner(
  database: DrizzleTransaction,
  customerId: string | null
): Promise<OwnerResolution> {
  if (!customerId) {
    return {
      classification: StripeDisputeOwnerClassification.Unmatched,
      kiloUserId: null,
      organizationId: null,
      reason: 'Disputed charge has no Stripe customer; manual review required',
    };
  }

  const personalOwners = await database
    .select({ id: kilocode_users.id })
    .from(kilocode_users)
    .where(
      and(
        eq(kilocode_users.stripe_customer_id, customerId),
        or(
          isNull(kilocode_users.blocked_reason),
          not(like(kilocode_users.blocked_reason, 'soft-deleted at %'))
        )
      )
    )
    .limit(2)
    .for('update');
  const organizationOwners = await database
    .select({ id: organizations.id })
    .from(organizations)
    .where(and(eq(organizations.stripe_customer_id, customerId), isNull(organizations.deleted_at)))
    .limit(2)
    .for('update');

  if (personalOwners.length === 1 && organizationOwners.length === 0) {
    return {
      classification: StripeDisputeOwnerClassification.Personal,
      kiloUserId: personalOwners[0].id,
      organizationId: null,
      reason: 'Canonical personal owner matched; admin action required',
    };
  }

  if (personalOwners.length === 0 && organizationOwners.length === 1) {
    return {
      classification: StripeDisputeOwnerClassification.Organization,
      kiloUserId: null,
      organizationId: organizationOwners[0].id,
      reason: 'Canonical organization owner matched; admin action required',
    };
  }

  if (personalOwners.length === 0 && organizationOwners.length === 0) {
    return {
      classification: StripeDisputeOwnerClassification.Unmatched,
      kiloUserId: null,
      organizationId: null,
      reason: 'No canonical customer owner matched; manual review required',
    };
  }

  return {
    classification: StripeDisputeOwnerClassification.Ambiguous,
    kiloUserId: null,
    organizationId: null,
    reason: 'Canonical customer ownership is ambiguous; manual review required',
  };
}

async function upsertDisputeCase(
  database: DrizzleTransaction,
  values: DisputeCaseValues
): Promise<void> {
  const now = new Date().toISOString();
  const reviewRequiredAt =
    values.status === StripeDisputeCaseStatus.ReviewRequired ? now : undefined;
  const closedAt = values.status === StripeDisputeCaseStatus.Closed ? now : undefined;

  const caseValues = {
    stripe_dispute_id: values.disputeId,
    stripe_event_id: values.eventId,
    stripe_event_created_at: values.eventCreatedAt,
    stripe_charge_id: values.chargeId,
    stripe_payment_intent_id: values.paymentIntentId,
    stripe_customer_id: values.customerId,
    amount_minor_units: values.amountMinorUnits,
    currency: values.currency,
    dispute_reason: values.disputeReason,
    stripe_status: values.stripeStatus,
    owner_classification: values.owner.classification,
    kilo_user_id: values.owner.kiloUserId,
    organization_id: values.owner.organizationId,
    status: values.status,
    status_reason: values.statusReason,
    stripe_created_at: values.stripeCreatedAt,
    evidence_due_by: values.evidenceDueBy,
    synced_at: now,
    review_required_at: reviewRequiredAt,
    closed_at: closedAt,
  };

  await database
    .insert(stripe_dispute_cases)
    .values(caseValues)
    .onConflictDoNothing({ target: [stripe_dispute_cases.stripe_dispute_id] });

  const updateFilter = and(
    eq(stripe_dispute_cases.stripe_dispute_id, values.disputeId),
    not(
      inArray(stripe_dispute_cases.status, [
        StripeDisputeCaseStatus.Processing,
        StripeDisputeCaseStatus.Accepted,
        StripeDisputeCaseStatus.AcceptanceFailed,
        StripeDisputeCaseStatus.EnforcementFailed,
        StripeDisputeCaseStatus.Closed,
      ])
    ),
    or(
      isNull(stripe_dispute_cases.stripe_event_created_at),
      sql`${stripe_dispute_cases.stripe_event_created_at} <= ${values.eventCreatedAt}`
    )
  );

  await database.update(stripe_dispute_cases).set(caseValues).where(updateFilter);
}

export async function observeStripeDisputeCreated({
  eventId,
  eventCreated,
  dispute,
  preFetchedCharge,
}: ObserveStripeDisputeCreatedParams): Promise<void> {
  const chargeId = stripeReferenceId(dispute.charge);
  const eventCreatedAt = new Date(eventCreated * 1000).toISOString();
  const paymentIntentId =
    stripeReferenceId(dispute.payment_intent) ??
    stripeReferenceId(preFetchedCharge?.payment_intent);
  const customerId = stripeReferenceId(preFetchedCharge?.customer);
  const stripeCreatedAt = stripeTimestampToIso(dispute.created) ?? eventCreatedAt;
  const evidenceDueBy = stripeTimestampToIso(dispute.evidence_details?.due_by);

  await db.transaction(async tx => {
    const owner = await resolveOwner(tx, customerId);
    const observedStatus = statusForObservedDispute({
      stripeStatus: dispute.status ?? null,
      owner,
    });
    await upsertDisputeCase(tx, {
      eventId,
      eventCreatedAt,
      disputeId: dispute.id,
      chargeId,
      paymentIntentId,
      customerId,
      amountMinorUnits: dispute.amount ?? null,
      currency: dispute.currency ?? null,
      disputeReason: dispute.reason ?? null,
      stripeStatus: dispute.status ?? null,
      owner,
      status: observedStatus.status,
      statusReason: observedStatus.reason,
      stripeCreatedAt,
      evidenceDueBy,
    });
  });
}

type ActionOutcome = {
  status: Extract<DisputeActionStatus, 'completed' | 'skipped'>;
  resultCode: string;
  resultReferenceId?: string | null;
};

async function claimDisputeAction(params: {
  caseId: string;
  actionType: DisputeActionType;
  targetKey: string;
}): Promise<boolean> {
  const now = new Date().toISOString();
  return db.transaction(async tx => {
    await tx
      .insert(stripe_dispute_actions)
      .values({
        case_id: params.caseId,
        action_type: params.actionType,
        target_key: params.targetKey,
      })
      .onConflictDoNothing({
        target: [
          stripe_dispute_actions.case_id,
          stripe_dispute_actions.action_type,
          stripe_dispute_actions.target_key,
        ],
      });

    const [action] = await tx
      .select({ status: stripe_dispute_actions.status })
      .from(stripe_dispute_actions)
      .where(
        and(
          eq(stripe_dispute_actions.case_id, params.caseId),
          eq(stripe_dispute_actions.action_type, params.actionType),
          eq(stripe_dispute_actions.target_key, params.targetKey)
        )
      )
      .limit(1)
      .for('update');

    if (
      action?.status === StripeDisputeActionStatus.Completed ||
      action?.status === StripeDisputeActionStatus.Skipped
    ) {
      return false;
    }

    await tx
      .update(stripe_dispute_actions)
      .set({
        status: StripeDisputeActionStatus.Processing,
        attempt_count: sql`${stripe_dispute_actions.attempt_count} + 1`,
        claimed_at: now,
        last_attempt_at: now,
        next_retry_at: null,
        failure_context: null,
      })
      .where(
        and(
          eq(stripe_dispute_actions.case_id, params.caseId),
          eq(stripe_dispute_actions.action_type, params.actionType),
          eq(stripe_dispute_actions.target_key, params.targetKey)
        )
      );

    return true;
  });
}

async function completeDisputeAction(params: {
  caseId: string;
  actionType: DisputeActionType;
  targetKey: string;
  outcome: ActionOutcome;
}): Promise<void> {
  const now = new Date().toISOString();
  await db
    .update(stripe_dispute_actions)
    .set({
      status: params.outcome.status,
      completed_at: now,
      terminal_at: now,
      result_code: params.outcome.resultCode,
      result_reference_id: params.outcome.resultReferenceId ?? null,
      failure_context: null,
      next_retry_at: null,
    })
    .where(
      and(
        eq(stripe_dispute_actions.case_id, params.caseId),
        eq(stripe_dispute_actions.action_type, params.actionType),
        eq(stripe_dispute_actions.target_key, params.targetKey)
      )
    );
}

async function failDisputeAction(params: {
  caseId: string;
  actionType: DisputeActionType;
  targetKey: string;
  error: unknown;
}): Promise<void> {
  const now = new Date();
  await db
    .update(stripe_dispute_actions)
    .set({
      status: StripeDisputeActionStatus.Failed,
      terminal_at: now.toISOString(),
      result_code: 'failed',
      failure_context: params.error instanceof Error ? params.error.message : String(params.error),
      next_retry_at: new Date(now.getTime() + DISPUTE_ACTION_RETRY_DELAY_MS).toISOString(),
    })
    .where(
      and(
        eq(stripe_dispute_actions.case_id, params.caseId),
        eq(stripe_dispute_actions.action_type, params.actionType),
        eq(stripe_dispute_actions.target_key, params.targetKey)
      )
    );
}

async function runDisputeAction(params: {
  caseId: string;
  actionType: DisputeActionType;
  targetKey: string;
  run: () => Promise<ActionOutcome>;
}): Promise<void> {
  const shouldRun = await claimDisputeAction(params);
  if (!shouldRun) {
    return;
  }

  try {
    const outcome = await params.run();
    await completeDisputeAction({ ...params, outcome });
  } catch (error) {
    await failDisputeAction({ ...params, error });
    throw error;
  }
}

async function blockUserForAcceptedDispute(params: {
  caseRow: StripeDisputeCase;
  actor: AdminActor;
}): Promise<ActionOutcome> {
  const userId = params.caseRow.kilo_user_id;
  if (!userId) {
    return { status: StripeDisputeActionStatus.Skipped, resultCode: 'no_user' };
  }

  const reason = `${DISPUTE_ENFORCEMENT_REASON}:${params.caseRow.stripe_dispute_id}`;
  let didBlock = false;
  await db.transaction(async tx => {
    const [user] = await tx
      .select({ blocked_reason: kilocode_users.blocked_reason })
      .from(kilocode_users)
      .where(eq(kilocode_users.id, userId))
      .limit(1)
      .for('update');

    if (!user) {
      return;
    }

    if (!user.blocked_reason) {
      didBlock = true;
      await tx
        .update(kilocode_users)
        .set({
          blocked_reason: reason,
          blocked_at: new Date().toISOString(),
          blocked_by_kilo_user_id: params.actor.id,
        })
        .where(eq(kilocode_users.id, userId));
    }

    await tx.insert(user_admin_notes).values({
      kilo_user_id: userId,
      admin_kilo_user_id: params.actor.id,
      note_content: didBlock
        ? `Account blocked after accepting Stripe dispute ${params.caseRow.stripe_dispute_id}.`
        : `Stripe dispute ${params.caseRow.stripe_dispute_id} accepted; account was already blocked.`,
    });
  });

  await revokeWebSessions(userId);

  if (didBlock) {
    void reportEvents({
      events: [
        {
          type: 'user.blocked',
          data: {
            kilo_user_id: userId,
            reason,
            actor_email: params.actor.google_user_email,
          },
        },
      ],
    });
  }

  return {
    status: StripeDisputeActionStatus.Completed,
    resultCode: didBlock ? 'blocked' : 'already_blocked',
  };
}

async function disableAutoTopUpForAcceptedDispute(params: {
  caseRow: StripeDisputeCase;
}): Promise<ActionOutcome> {
  const reason = `${DISPUTE_ENFORCEMENT_REASON}:${params.caseRow.stripe_dispute_id}`;
  const ownerFilter = params.caseRow.kilo_user_id
    ? eq(auto_top_up_configs.owned_by_user_id, params.caseRow.kilo_user_id)
    : params.caseRow.organization_id
      ? eq(auto_top_up_configs.owned_by_organization_id, params.caseRow.organization_id)
      : null;
  if (!ownerFilter) {
    return { status: StripeDisputeActionStatus.Skipped, resultCode: 'no_owner' };
  }

  const disabledRows = await db.transaction(async tx => {
    const configResult = await tx
      .update(auto_top_up_configs)
      .set({
        disabled_reason: reason,
        attempt_started_at: null,
      })
      .where(ownerFilter);

    const ownerResult = params.caseRow.kilo_user_id
      ? await tx
          .update(kilocode_users)
          .set({ auto_top_up_enabled: false })
          .where(eq(kilocode_users.id, params.caseRow.kilo_user_id))
      : params.caseRow.organization_id
        ? await tx
            .update(organizations)
            .set({ auto_top_up_enabled: false })
            .where(eq(organizations.id, params.caseRow.organization_id))
        : null;

    return (configResult.rowCount ?? 0) + (ownerResult?.rowCount ?? 0);
  });

  return {
    status:
      disabledRows > 0 ? StripeDisputeActionStatus.Completed : StripeDisputeActionStatus.Skipped,
    resultCode: disabledRows > 0 ? 'disabled' : 'not_configured',
  };
}

async function resetUserCreditBalanceForAcceptedDispute(params: {
  caseRow: StripeDisputeCase;
}): Promise<ActionOutcome> {
  const userId = params.caseRow.kilo_user_id;
  if (!userId) {
    return { status: StripeDisputeActionStatus.Skipped, resultCode: 'no_user' };
  }

  const resetAmountUsd = await db.transaction(async tx => {
    const [user] = await tx
      .select({
        microdollars_used: kilocode_users.microdollars_used,
        total_microdollars_acquired: kilocode_users.total_microdollars_acquired,
      })
      .from(kilocode_users)
      .where(eq(kilocode_users.id, userId))
      .limit(1)
      .for('update');

    if (!user) {
      return null;
    }

    const balanceMicrodollars = user.total_microdollars_acquired - user.microdollars_used;
    if (balanceMicrodollars <= 0) {
      return 0;
    }

    await tx.insert(credit_transactions).values({
      kilo_user_id: userId,
      organization_id: null,
      is_free: true,
      amount_microdollars: -balanceMicrodollars,
      credit_category: 'stripe-dispute-enforcement',
      description: `Balance zeroed after accepting Stripe dispute ${params.caseRow.stripe_dispute_id}`,
      original_baseline_microdollars_used: user.microdollars_used,
    });
    await tx
      .update(kilocode_users)
      .set({
        total_microdollars_acquired: sql`${kilocode_users.total_microdollars_acquired} - ${balanceMicrodollars}`,
      })
      .where(eq(kilocode_users.id, userId));

    return fromMicrodollars(balanceMicrodollars);
  });

  if (resetAmountUsd === null) {
    return { status: StripeDisputeActionStatus.Skipped, resultCode: 'user_missing' };
  }

  return {
    status:
      resetAmountUsd > 0 ? StripeDisputeActionStatus.Completed : StripeDisputeActionStatus.Skipped,
    resultCode: resetAmountUsd > 0 ? 'reset' : 'zero_balance',
  };
}

async function cancelKiloPassForAcceptedDispute(params: {
  caseRow: StripeDisputeCase;
  actor: AdminActor;
}): Promise<ActionOutcome> {
  const userId = params.caseRow.kilo_user_id;
  if (!userId) {
    return { status: StripeDisputeActionStatus.Skipped, resultCode: 'no_user' };
  }

  const result = await cancelAndRefundKiloPassForUser({
    db,
    stripe: client,
    userId,
    adminKiloUserId: params.actor.id,
    reason: `${DISPUTE_ENFORCEMENT_REASON}:${params.caseRow.stripe_dispute_id}`,
    refundLatestPayment: false,
    noteSuffix: `Dispute case: ${params.caseRow.id}.`,
  });

  if (result.status === 'skipped') {
    if (result.reason.kind === 'store_managed_subscription') {
      throw new Error('Store-managed Kilo Pass subscription requires manual cancellation');
    }

    return {
      status: StripeDisputeActionStatus.Skipped,
      resultCode: result.reason.kind,
    };
  }

  return {
    status: StripeDisputeActionStatus.Completed,
    resultCode: result.status,
  };
}

async function releaseKiloClawScheduleIfPresent(scheduleId: string | null): Promise<boolean> {
  if (!scheduleId) {
    return false;
  }

  try {
    await client.subscriptionSchedules.release(scheduleId);
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const alreadyInactive =
      message.includes('not active') ||
      message.includes('released') ||
      message.includes('canceled') ||
      message.includes('completed');
    if (!alreadyInactive) {
      throw error;
    }
    return true;
  }
}

async function cancelStripeSubscriptionIfPresent(subscriptionId: string | null): Promise<boolean> {
  if (!subscriptionId) {
    return false;
  }

  try {
    await client.subscriptions.cancel(subscriptionId, {
      invoice_now: false,
      prorate: false,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const normalizedMessage = message.toLowerCase();
    const alreadyCanceled =
      (normalizedMessage.includes('already') && normalizedMessage.includes('cancel')) ||
      normalizedMessage.includes('has been canceled') ||
      normalizedMessage.includes('is canceled');
    if (!alreadyCanceled) {
      throw error;
    }
  }
  return true;
}

async function releaseAttachedSubscriptionScheduleIfPresent(
  subscriptionId: string
): Promise<boolean> {
  const subscription = await client.subscriptions.retrieve(subscriptionId, {
    expand: ['schedule'],
  });
  const scheduleRef = subscription.schedule;
  if (!scheduleRef) {
    return false;
  }

  const schedule =
    typeof scheduleRef === 'string'
      ? await client.subscriptionSchedules.retrieve(scheduleRef)
      : scheduleRef;
  if (schedule.status !== 'active' && schedule.status !== 'not_started') {
    return false;
  }

  await client.subscriptionSchedules.release(schedule.id);
  return true;
}

async function suspendKiloClawSubscriptionForAcceptedDispute(params: {
  caseRow: StripeDisputeCase;
  actor: AdminActor;
  subscription: KiloClawSubscription;
}): Promise<ActionOutcome> {
  const now = new Date().toISOString();
  const destructionDeadline = addDays(
    new Date(),
    DISPUTE_KILOCLAW_DESTRUCTION_GRACE_DAYS
  ).toISOString();
  const [existing] = await db
    .select()
    .from(kiloclaw_subscriptions)
    .where(eq(kiloclaw_subscriptions.id, params.subscription.id))
    .limit(1);

  if (!existing) {
    return { status: StripeDisputeActionStatus.Skipped, resultCode: 'subscription_missing' };
  }

  const alreadyLocallySuspended = existing.status === 'canceled' && existing.destruction_deadline;
  const scheduleReleased = alreadyLocallySuspended
    ? false
    : await releaseKiloClawScheduleIfPresent(existing.stripe_schedule_id);
  const stripeCanceled = alreadyLocallySuspended
    ? false
    : await cancelStripeSubscriptionIfPresent(existing.stripe_subscription_id);

  const updated = await db.transaction(async tx => {
    const [current] = await tx
      .select()
      .from(kiloclaw_subscriptions)
      .where(eq(kiloclaw_subscriptions.id, params.subscription.id))
      .limit(1)
      .for('update');

    if (!current) {
      return null;
    }

    if (current.status === 'canceled' && current.destruction_deadline) {
      return { before: current, after: current, changed: false };
    }

    const [after] = await tx
      .update(kiloclaw_subscriptions)
      .set({
        status: 'canceled',
        cancel_at_period_end: false,
        pending_conversion: false,
        stripe_schedule_id: null,
        scheduled_plan: null,
        scheduled_by: null,
        current_period_end: now,
        credit_renewal_at: now,
        trial_ends_at: current.status === 'trialing' ? now : current.trial_ends_at,
        past_due_since: null,
        suspended_at: now,
        destruction_deadline: destructionDeadline,
        auto_resume_requested_at: null,
        auto_resume_retry_after: null,
        auto_resume_attempt_count: 0,
      })
      .where(eq(kiloclaw_subscriptions.id, current.id))
      .returning();

    if (!after) {
      throw new Error(`Failed to update KiloClaw subscription ${current.id}`);
    }

    await insertKiloClawSubscriptionChangeLog(tx, {
      subscriptionId: current.id,
      actor: { actorType: 'user', actorId: params.actor.id },
      action: 'canceled',
      reason: DISPUTE_ENFORCEMENT_REASON,
      before: current,
      after,
    });

    await createKiloClawAdminAuditLog({
      action: 'kiloclaw.subscription.admin_cancel',
      actor_id: params.actor.id,
      actor_email: params.actor.google_user_email,
      actor_name: params.actor.google_user_name,
      target_user_id: current.user_id,
      message: `KiloClaw subscription ${current.id} canceled after accepting Stripe dispute ${params.caseRow.stripe_dispute_id}`,
      metadata: {
        disputeCaseId: params.caseRow.id,
        stripeDisputeId: params.caseRow.stripe_dispute_id,
        stripeCanceled,
        scheduleReleased,
        destructionDeadline,
      },
      tx,
    });

    return { before: current, after, changed: true };
  });

  if (!updated) {
    return { status: StripeDisputeActionStatus.Skipped, resultCode: 'subscription_missing' };
  }

  if (updated.after.instance_id) {
    const [instance] = await db
      .select({
        id: kiloclaw_instances.id,
        sandbox_id: kiloclaw_instances.sandbox_id,
      })
      .from(kiloclaw_instances)
      .where(
        and(
          eq(kiloclaw_instances.id, updated.after.instance_id),
          isNull(kiloclaw_instances.destroyed_at)
        )
      )
      .limit(1);

    if (instance) {
      try {
        const kiloclawClient = new KiloClawInternalClient();
        await kiloclawClient.stop(updated.after.user_id, workerInstanceId(instance), {
          reason: 'admin_request',
        });
      } catch (error) {
        captureException(error, {
          tags: { source: 'stripe_dispute_kiloclaw_stop' },
          extra: {
            stripe_dispute_id: params.caseRow.stripe_dispute_id,
            subscription_id: updated.after.id,
            instance_id: instance.id,
          },
        });
        throw error;
      }
    }
  }

  return {
    status: StripeDisputeActionStatus.Completed,
    resultCode: updated.changed ? 'canceled' : 'already_canceled',
    resultReferenceId: updated.after.id,
  };
}

async function terminateCodingPlanForAcceptedDispute(
  subscriptionId: string
): Promise<ActionOutcome> {
  try {
    await terminateCodingPlanImmediately(subscriptionId, 'administrative_termination');
    return {
      status: StripeDisputeActionStatus.Completed,
      resultCode: 'terminated',
      resultReferenceId: subscriptionId,
    };
  } catch (error) {
    if (error instanceof Error && error.message === 'No live subscription found.') {
      return {
        status: StripeDisputeActionStatus.Skipped,
        resultCode: 'not_live',
        resultReferenceId: subscriptionId,
      };
    }
    throw error;
  }
}

async function enforcePersonalDisputeCase(params: {
  caseRow: StripeDisputeCase;
  actor: AdminActor;
}): Promise<string[]> {
  const failures: string[] = [];
  const userId = params.caseRow.kilo_user_id;
  if (!userId) {
    return ['personal dispute case has no user owner'];
  }

  const actionRuns: Array<{
    actionType: DisputeActionType;
    targetKey: string;
    run: () => Promise<ActionOutcome>;
  }> = [
    {
      actionType: StripeDisputeActionType.UserBlock,
      targetKey: 'personal_owner',
      run: () => blockUserForAcceptedDispute(params),
    },
    {
      actionType: StripeDisputeActionType.AutoTopUpDisable,
      targetKey: 'personal_auto_top_up',
      run: () => disableAutoTopUpForAcceptedDispute({ caseRow: params.caseRow }),
    },
    {
      actionType: StripeDisputeActionType.SubscriptionCancellation,
      targetKey: 'personal_kilo_pass',
      run: () => cancelKiloPassForAcceptedDispute(params),
    },
    {
      actionType: StripeDisputeActionType.CreditBalanceReset,
      targetKey: 'personal_credits',
      run: () => resetUserCreditBalanceForAcceptedDispute({ caseRow: params.caseRow }),
    },
  ];

  const codingPlanSubscriptions = await db
    .select({ id: coding_plan_subscriptions.id })
    .from(coding_plan_subscriptions)
    .where(
      and(
        eq(coding_plan_subscriptions.user_id, userId),
        inArray(coding_plan_subscriptions.status, ['active', 'past_due'])
      )
    );
  for (const subscription of codingPlanSubscriptions) {
    actionRuns.push({
      actionType: StripeDisputeActionType.AccessTermination,
      targetKey: `coding_plan:${subscription.id}`,
      run: () => terminateCodingPlanForAcceptedDispute(subscription.id),
    });
  }

  const kiloClawSubscriptions = await db
    .select({ subscription: kiloclaw_subscriptions })
    .from(kiloclaw_subscriptions)
    .innerJoin(kiloclaw_instances, eq(kiloclaw_instances.id, kiloclaw_subscriptions.instance_id))
    .where(
      and(
        eq(kiloclaw_subscriptions.user_id, userId),
        isNull(kiloclaw_instances.organization_id),
        isNull(kiloclaw_subscriptions.transferred_to_subscription_id),
        or(
          inArray(kiloclaw_subscriptions.status, ['active', 'past_due', 'unpaid', 'trialing']),
          and(
            eq(kiloclaw_subscriptions.status, 'canceled'),
            isNotNull(kiloclaw_subscriptions.suspended_at),
            isNotNull(kiloclaw_subscriptions.destruction_deadline)
          )
        )
      )
    );
  for (const { subscription } of kiloClawSubscriptions) {
    actionRuns.push({
      actionType: StripeDisputeActionType.KiloClawSuspension,
      targetKey: `kiloclaw_subscription:${subscription.id}`,
      run: () =>
        suspendKiloClawSubscriptionForAcceptedDispute({
          caseRow: params.caseRow,
          actor: params.actor,
          subscription,
        }),
    });
  }

  for (const actionRun of actionRuns) {
    try {
      await runDisputeAction({
        caseId: params.caseRow.id,
        actionType: actionRun.actionType,
        targetKey: actionRun.targetKey,
        run: actionRun.run,
      });
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    }
  }

  return failures;
}

async function cancelOrganizationSeatsForAcceptedDispute(params: {
  caseRow: StripeDisputeCase;
  subscriptionStripeId: string;
  billingCycle: 'monthly' | 'yearly';
}): Promise<ActionOutcome> {
  const organizationId = params.caseRow.organization_id;
  if (!organizationId) {
    return { status: StripeDisputeActionStatus.Skipped, resultCode: 'organization_missing' };
  }

  await releaseAttachedSubscriptionScheduleIfPresent(params.subscriptionStripeId);
  await cancelStripeSubscriptionIfPresent(params.subscriptionStripeId);
  const now = new Date().toISOString();
  const idempotencyKey = `stripe_dispute:${params.caseRow.id}:organization_seats:${params.subscriptionStripeId}`;
  const insertedPurchase = await db.transaction(async tx => {
    const [purchase] = await tx
      .insert(organization_seats_purchases)
      .values({
        organization_id: organizationId,
        subscription_stripe_id: params.subscriptionStripeId,
        seat_count: 0,
        amount_usd: 0,
        starts_at: now,
        expires_at: now,
        subscription_status: 'ended',
        billing_cycle: params.billingCycle,
        idempotency_key: idempotencyKey,
      })
      .onConflictDoNothing({ target: [organization_seats_purchases.idempotency_key] })
      .returning({ id: organization_seats_purchases.id });

    await tx
      .update(organizations)
      .set({ seat_count: 0 })
      .where(eq(organizations.id, organizationId));

    return purchase;
  });

  return {
    status: StripeDisputeActionStatus.Completed,
    resultCode: insertedPurchase ? 'ended' : 'already_ended',
    resultReferenceId: params.subscriptionStripeId,
  };
}

async function enforceOrganizationDisputeCase(params: {
  caseRow: StripeDisputeCase;
}): Promise<string[]> {
  const failures: string[] = [];
  const organizationId = params.caseRow.organization_id;
  if (!organizationId) {
    return ['organization dispute case has no organization owner'];
  }

  const actionRuns: Array<{
    actionType: DisputeActionType;
    targetKey: string;
    run: () => Promise<ActionOutcome>;
  }> = [
    {
      actionType: StripeDisputeActionType.AutoTopUpDisable,
      targetKey: `auto_top_up:organization:${organizationId}`,
      run: () => disableAutoTopUpForAcceptedDispute({ caseRow: params.caseRow }),
    },
  ];

  const seatPurchases = await db
    .select({
      id: organization_seats_purchases.id,
      subscriptionStripeId: organization_seats_purchases.subscription_stripe_id,
      billingCycle: organization_seats_purchases.billing_cycle,
    })
    .from(organization_seats_purchases)
    .where(
      and(
        eq(organization_seats_purchases.organization_id, organizationId),
        not(
          inArray(organization_seats_purchases.subscription_status, [
            'ended',
            'canceled',
            'incomplete_expired',
          ])
        )
      )
    )
    .orderBy(desc(organization_seats_purchases.created_at));

  const subscriptionBillingCycles = new Map<string, 'monthly' | 'yearly'>();
  for (const purchase of seatPurchases) {
    if (!subscriptionBillingCycles.has(purchase.subscriptionStripeId)) {
      subscriptionBillingCycles.set(purchase.subscriptionStripeId, purchase.billingCycle);
    }
  }

  for (const [subscriptionStripeId, billingCycle] of subscriptionBillingCycles) {
    actionRuns.push({
      actionType: StripeDisputeActionType.SubscriptionCancellation,
      targetKey: `organization_seats_subscription:${subscriptionStripeId}`,
      run: () =>
        cancelOrganizationSeatsForAcceptedDispute({
          caseRow: params.caseRow,
          subscriptionStripeId,
          billingCycle,
        }),
    });
  }

  for (const actionRun of actionRuns) {
    try {
      await runDisputeAction({
        caseId: params.caseRow.id,
        actionType: actionRun.actionType,
        targetKey: actionRun.targetKey,
        run: actionRun.run,
      });
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    }
  }

  return failures;
}

async function closeStripeDispute(caseRow: StripeDisputeCase): Promise<void> {
  await runDisputeAction({
    caseId: caseRow.id,
    actionType: StripeDisputeActionType.StripeAcceptance,
    targetKey: `stripe_dispute:${caseRow.stripe_dispute_id}`,
    run: async () => {
      let dispute: Stripe.Dispute | null = null;
      try {
        dispute = await client.disputes.close(caseRow.stripe_dispute_id);
      } catch (error) {
        if (!isAlreadyClosedStripeDisputeError(error)) {
          throw error;
        }
        dispute = await client.disputes.retrieve(caseRow.stripe_dispute_id);
        if (dispute.status !== 'lost') {
          throw new StripeDisputeCaseActionError(
            `Stripe dispute is already closed with status ${dispute.status}; manual review required`
          );
        }
      }

      await db
        .update(stripe_dispute_cases)
        .set({
          stripe_status: dispute?.status ?? caseRow.stripe_status,
          accepted_at: new Date().toISOString(),
        })
        .where(eq(stripe_dispute_cases.id, caseRow.id));

      return {
        status: StripeDisputeActionStatus.Completed,
        resultCode: dispute?.status ?? 'already_closed',
        resultReferenceId: dispute?.id ?? caseRow.stripe_dispute_id,
      };
    },
  });
}

export async function acceptStripeDisputeCase(params: {
  caseId: string;
  actor: AdminActor;
}): Promise<AcceptStripeDisputeResult> {
  const now = new Date();
  const nowIso = now.toISOString();
  const nextRetryAt = new Date(now.getTime() + DISPUTE_ACTION_RETRY_DELAY_MS).toISOString();
  const staleProcessingCutoff = new Date(
    now.getTime() - DISPUTE_ACTION_RETRY_DELAY_MS
  ).toISOString();
  const [caseRow] = await db
    .update(stripe_dispute_cases)
    .set({
      status: StripeDisputeCaseStatus.Processing,
      accepted_by_kilo_user_id: params.actor.id,
      acceptance_started_at: nowIso,
      failure_context: null,
      next_retry_at: nextRetryAt,
    })
    .where(
      and(
        eq(stripe_dispute_cases.id, params.caseId),
        or(
          inArray(stripe_dispute_cases.status, [
            StripeDisputeCaseStatus.NeedsAction,
            StripeDisputeCaseStatus.AcceptanceFailed,
            StripeDisputeCaseStatus.EnforcementFailed,
          ]),
          and(
            eq(stripe_dispute_cases.status, StripeDisputeCaseStatus.Processing),
            or(
              lt(stripe_dispute_cases.next_retry_at, nowIso),
              lt(stripe_dispute_cases.acceptance_started_at, staleProcessingCutoff)
            )
          )
        )
      )
    )
    .returning();

  if (!caseRow) {
    throw new StripeDisputeCaseActionError('Dispute case is not actionable');
  }

  if (
    caseRow.owner_classification !== StripeDisputeOwnerClassification.Personal &&
    caseRow.owner_classification !== StripeDisputeOwnerClassification.Organization
  ) {
    await db
      .update(stripe_dispute_cases)
      .set({
        status: StripeDisputeCaseStatus.ReviewRequired,
        review_required_at: new Date().toISOString(),
        failure_context: 'Accept requires exactly one matched owner',
        next_retry_at: null,
      })
      .where(eq(stripe_dispute_cases.id, caseRow.id));
    throw new StripeDisputeCaseActionError('Dispute case does not have exactly one matched owner');
  }

  if (
    (caseRow.owner_classification === StripeDisputeOwnerClassification.Personal &&
      !caseRow.kilo_user_id) ||
    (caseRow.owner_classification === StripeDisputeOwnerClassification.Organization &&
      !caseRow.organization_id)
  ) {
    await db
      .update(stripe_dispute_cases)
      .set({
        status: StripeDisputeCaseStatus.ReviewRequired,
        review_required_at: new Date().toISOString(),
        failure_context: 'Accept requires the matched owner link to still exist',
        next_retry_at: null,
      })
      .where(eq(stripe_dispute_cases.id, caseRow.id));
    throw new StripeDisputeCaseActionError('Dispute case owner link is missing');
  }

  try {
    await closeStripeDispute(caseRow);
  } catch (error) {
    await db
      .update(stripe_dispute_cases)
      .set({
        status: StripeDisputeCaseStatus.AcceptanceFailed,
        failure_context: error instanceof Error ? error.message : String(error),
        next_retry_at: new Date(Date.now() + DISPUTE_ACTION_RETRY_DELAY_MS).toISOString(),
      })
      .where(eq(stripe_dispute_cases.id, caseRow.id));
    throw error;
  }

  const failures =
    caseRow.owner_classification === StripeDisputeOwnerClassification.Personal
      ? await enforcePersonalDisputeCase({ caseRow, actor: params.actor })
      : await enforceOrganizationDisputeCase({ caseRow });

  if (failures.length > 0) {
    await db
      .update(stripe_dispute_cases)
      .set({
        status: StripeDisputeCaseStatus.EnforcementFailed,
        failure_context: failures.join('\n'),
        next_retry_at: new Date(Date.now() + DISPUTE_ACTION_RETRY_DELAY_MS).toISOString(),
      })
      .where(eq(stripe_dispute_cases.id, caseRow.id));
    return { status: 'enforcement_failed', failures };
  }

  await db
    .update(stripe_dispute_cases)
    .set({
      status: StripeDisputeCaseStatus.Accepted,
      enforcement_completed_at: new Date().toISOString(),
      failure_context: null,
      next_retry_at: null,
    })
    .where(eq(stripe_dispute_cases.id, caseRow.id));

  return { status: 'accepted', failures: [] };
}

export function stripeDisputeDashboardUrl(stripeDisputeId: string): string {
  const envPrefix = process.env.NODE_ENV === 'development' ? 'test/' : '';
  return `https://dashboard.stripe.com/${envPrefix}disputes/${encodeURIComponent(stripeDisputeId)}`;
}
