import { client } from '@/lib/stripe-client';
import Stripe from 'stripe';
import { db } from '@/lib/drizzle';
import {
  kilocode_users,
  auto_top_up_configs,
  organizations,
  kilo_pass_issuance_items,
  kilo_pass_issuances,
} from '@kilocode/db/schema';
import type { Organization } from '@kilocode/db/schema';
import { and, desc, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import { captureException } from '@sentry/nextjs';
import { logExceptInTest, sentryLogger } from '@/lib/utils.server';
import { failureResult, successResult, type Result } from '@/lib/maybe-result';
import type { UserForBalance } from '@/lib/user/balance-types';
import { findUserById } from '@/lib/user';
import { getOrganizationById, getOrganizationMembers } from '@/lib/organizations/organizations';
import { randomUUID } from 'crypto';
import { sendAutoTopUpFailedEmail } from '@/lib/email';
import { getKiloPassStateForUser } from '@/lib/kilo-pass/state';
import { isStripeSubscriptionEnded } from '@/lib/kilo-pass/stripe-subscription-status';
import { KiloPassIssuanceItemKind } from '@/lib/kilo-pass/enums';

import {
  AUTO_TOP_UP_ATTEMPT_LOCK_TIMEOUT_SECONDS,
  AUTO_TOP_UP_THRESHOLD_DOLLARS,
  ORG_AUTO_TOP_UP_THRESHOLD_DOLLARS,
} from '@/lib/autoTopUpConstants';
import {
  attachPreparedAutoTopUpInvoiceFee,
  mergeServiceFeeCommercialMetadata,
  prepareAutoTopUpInvoiceFee,
  type ServiceFeeCheckoutDependencies,
} from '@/lib/service-fees/checkout';
import { createServiceFeeStores } from '@/lib/service-fees/drizzle-store';
import { getEffectiveOrganizationServiceFeeExemption } from '@/lib/service-fees/organization-exemptions';

function createAutoTopUpFeeDeps(): ServiceFeeCheckoutDependencies {
  const stores = createServiceFeeStores();
  return {
    store: stores.assessments,
    findEffectiveExemption: async (organizationId, at) =>
      getEffectiveOrganizationServiceFeeExemption({
        store: stores.exemptions,
        organizationId,
        at,
      }),
    stripe: client,
    createInvoiceItem: params => client.invoiceItems.create(params),
  };
}

type AutoTopUpResult = Result<{ stripe_id: string }, string>;

type AutoTopUpOrganization = Pick<
  Organization,
  'id' | 'auto_top_up_enabled' | 'total_microdollars_acquired' | 'microdollars_used'
>;

/**
 * Entity that can have auto-top-up: either a user or an organization.
 * Follows the CreditEntity pattern from promotionalCredits.ts.
 * Only minimal fields needed - fresh data is fetched inside performAutoTopUpForEntity.
 */
export type AutoTopUpEntity =
  | { type: 'user'; user: UserForBalance }
  | { type: 'organization'; organization: AutoTopUpOrganization };

export type AutoTopUpReservation = {
  entity: AutoTopUpEntity;
  traceId: string;
  config: {
    id: string;
  };
  attemptStartedAt: string;
  stripeCustomerId: string;
};

async function shouldWaitForKiloPassBonusCredits(kiloUserId: string): Promise<boolean> {
  const subscription = await getKiloPassStateForUser(db, kiloUserId);
  if (!subscription) return false;
  if (isStripeSubscriptionEnded(subscription.status)) return false;

  const lastIssuance = await db
    .select({ id: kilo_pass_issuances.id })
    .from(kilo_pass_issuances)
    .where(eq(kilo_pass_issuances.kilo_pass_subscription_id, subscription.subscriptionId))
    .orderBy(desc(kilo_pass_issuances.issue_month))
    .limit(1);

  const issuanceId = lastIssuance[0]?.id;
  if (!issuanceId) {
    // No issuance row yet (e.g. Stripe invoice.paid hasn't been processed),
    // so treat bonus credits as not yet received.
    return true;
  }

  const unlockedItem = await db.query.kilo_pass_issuance_items.findFirst({
    columns: { id: true },
    where: and(
      eq(kilo_pass_issuance_items.kilo_pass_issuance_id, issuanceId),
      inArray(kilo_pass_issuance_items.kind, [
        KiloPassIssuanceItemKind.Bonus,
        KiloPassIssuanceItemKind.PromoFirstMonth50Pct,
        KiloPassIssuanceItemKind.ReferralBonus,
      ])
    ),
  });

  return !unlockedItem;
}

/**
 * Performs a non-interactive auto-top-up using the user's saved payment method.
 *
 * This creates a Stripe invoice (so the customer gets a PDF invoice) and pays it off-session.
 *
 * Credit application is handled by the `invoice.paid` Stripe webhook.
 */
export async function maybePerformAutoTopUp(user: UserForBalance): Promise<void> {
  const reservation = await reserveAutoTopUp(user);
  if (reservation) await performReservedAutoTopUp(reservation);
}

/**
 * Performs auto-top-up for an organization if balance is below threshold.
 * Entry point for organization auto-top-up, called from token usage ingestion.
 */
export async function maybePerformOrganizationAutoTopUp(
  organization: AutoTopUpOrganization
): Promise<void> {
  const reservation = await reserveOrganizationAutoTopUp(organization);
  if (reservation) await performReservedAutoTopUp(reservation);
}

export async function reserveAutoTopUp(
  user: UserForBalance
): Promise<AutoTopUpReservation | undefined> {
  return await reserveAutoTopUpForEntity({ type: 'user', user });
}

export async function reserveOrganizationAutoTopUp(
  organization: AutoTopUpOrganization
): Promise<AutoTopUpReservation | undefined> {
  return await reserveAutoTopUpForEntity({ type: 'organization', organization });
}

async function reserveAutoTopUpForEntity(
  entity: AutoTopUpEntity
): Promise<AutoTopUpReservation | undefined> {
  const { auto_top_up_enabled, initialBalance_USD } =
    entity.type === 'user'
      ? {
          auto_top_up_enabled: entity.user.auto_top_up_enabled,
          initialBalance_USD:
            (entity.user.total_microdollars_acquired - entity.user.microdollars_used) / 1_000_000,
        }
      : {
          auto_top_up_enabled: entity.organization.auto_top_up_enabled,
          initialBalance_USD:
            (entity.organization.total_microdollars_acquired -
              entity.organization.microdollars_used) /
            1_000_000,
        };
  // Only for users with auto-top-up enabled
  if (!auto_top_up_enabled) {
    return undefined;
  }

  // Only trigger if balance is below threshold
  const threshold =
    entity.type === 'user' ? AUTO_TOP_UP_THRESHOLD_DOLLARS : ORG_AUTO_TOP_UP_THRESHOLD_DOLLARS;
  if (initialBalance_USD >= threshold) {
    return undefined;
  }

  // If the user has an active Kilo Pass and has NOT received their bonus credits for the current
  // period/month yet, do not auto-top-up. (Only applies to users, not organizations.)
  if (entity.type === 'user') {
    const shouldWait = await shouldWaitForKiloPassBonusCredits(entity.user.id);
    if (shouldWait) {
      return undefined;
    }
  }

  const traceId = randomUUID();

  const entityId = entity.type === 'user' ? entity.user.id : entity.organization.id;
  const entityLabel = entity.type === 'user' ? `user ${entityId}` : `organization ${entityId}`;

  // Log auto-top-up trigger
  sentryLogger('auto-topup', 'info')('Auto-top-up triggered', {
    traceId,
    userId: entity.type === 'user' ? entity.user.id : undefined,
    organizationId: entity.type === 'organization' ? entity.organization.id : undefined,
    reason: 'balance_below_threshold',
    balance_USD: initialBalance_USD,
    threshold_USD: threshold,
  });

  const ownerColumn =
    entity.type === 'user'
      ? auto_top_up_configs.owned_by_user_id
      : auto_top_up_configs.owned_by_organization_id;
  const ownerId = entity.type === 'user' ? entity.user.id : entity.organization.id;
  const ownerEnabled =
    entity.type === 'user'
      ? sql`EXISTS (
          SELECT 1 FROM ${kilocode_users}
          WHERE ${kilocode_users.id} = ${ownerId}
            AND ${kilocode_users.auto_top_up_enabled} = TRUE
        )`
      : sql`EXISTS (
          SELECT 1 FROM ${organizations}
          WHERE ${organizations.id} = ${ownerId}
            AND ${organizations.auto_top_up_enabled} = TRUE
        )`;

  // Atomically check and acquire lock in a single query using SQL NOW()
  const [config] = await db
    .update(auto_top_up_configs)
    .set({ attempt_started_at: sql`NOW()` })
    .where(
      and(
        eq(ownerColumn, ownerId),
        isNull(auto_top_up_configs.disabled_reason),
        ownerEnabled,
        or(
          isNull(auto_top_up_configs.attempt_started_at),
          lt(
            auto_top_up_configs.attempt_started_at,
            sql`NOW() - INTERVAL '${sql.raw(String(AUTO_TOP_UP_ATTEMPT_LOCK_TIMEOUT_SECONDS))} second'`
          )
        )
      )
    )
    .returning({
      id: auto_top_up_configs.id,
      stripe_payment_method_id: auto_top_up_configs.stripe_payment_method_id,
      amount_cents: auto_top_up_configs.amount_cents,
      attempt_started_at: auto_top_up_configs.attempt_started_at,
    });

  if (!config) {
    // Either no config exists, or concurrent attempt in progress
    // Check which case it is
    const existingConfig = await db.query.auto_top_up_configs.findFirst({
      where: eq(ownerColumn, ownerId),
    });

    if (!existingConfig) {
      await disableAutoTopUpForEntity(entity, 'no_payment_method_saved');
      return undefined;
    }
    logExceptInTest(`Auto-top-up skipped for ${entityLabel}: concurrent attempt in progress`, {
      traceId,
    });
    return undefined;
  }

  // Re-check balance after acquiring lock to prevent duplicate top-ups
  // (another request may have completed a top-up while we were waiting for the lock)
  // We fetch fresh data from DB and compute balance directly to avoid
  // calling getBalanceForUser which would create a cycle (it calls maybePerformAutoTopUp)
  if (!config.attempt_started_at) {
    throw new Error(`Auto Top-Up reservation ${config.id} has no attempt timestamp`);
  }
  let currentBalance_USD: number;
  let stripe_customer_id: string | null;
  try {
    ({ currentBalance_USD, stripe_customer_id } = await getEntityBalanceAndStripeCustomer(entity));
  } catch (error) {
    await releaseAutoTopUpReservation(config.id, config.attempt_started_at);
    throw error;
  }
  if (currentBalance_USD >= threshold) {
    // Balance is now sufficient, release lock and exit
    await releaseAutoTopUpReservation(config.id, config.attempt_started_at);
    return undefined;
  }

  if (!stripe_customer_id) {
    await disableAutoTopUpForEntity(entity, 'no_stripe_customer', {
      configId: config.id,
      attemptStartedAt: config.attempt_started_at,
    });
    return undefined;
  }

  return {
    entity,
    traceId,
    config: {
      id: config.id,
    },
    attemptStartedAt: config.attempt_started_at,
    stripeCustomerId: stripe_customer_id,
  };
}

export async function performReservedAutoTopUp(reservation: AutoTopUpReservation): Promise<void> {
  const result = await chargeReservedAutoTopUp(reservation);
  const { entity, traceId } = reservation;
  const entityId = entity.type === 'user' ? entity.user.id : entity.organization.id;
  const entityLabel = entity.type === 'user' ? `user ${entityId}` : `organization ${entityId}`;

  if (result.success) {
    logExceptInTest(`Auto-top-up successful for ${entityLabel}`, {
      traceId,
      entity_type: entity.type,
      entity_id: entityId,
      stripe_id: result.stripe_id,
    });
  } else {
    sentryLogger('auto-topup', 'warning')(`Auto-top-up failed for ${entityLabel}`, {
      ...result,
      traceId,
    });
  }
}

async function chargeReservedAutoTopUp(
  reservation: AutoTopUpReservation
): Promise<AutoTopUpResult> {
  const {
    attemptStartedAt,
    config,
    entity,
    stripeCustomerId: stripe_customer_id,
    traceId,
  } = reservation;
  const ownerId = entity.type === 'user' ? entity.user.id : entity.organization.id;
  const ownerEnabled =
    entity.type === 'user'
      ? sql`EXISTS (
          SELECT 1 FROM ${kilocode_users}
          WHERE ${kilocode_users.id} = ${ownerId}
            AND ${kilocode_users.auto_top_up_enabled} = TRUE
        )`
      : sql`EXISTS (
          SELECT 1 FROM ${organizations}
          WHERE ${organizations.id} = ${ownerId}
            AND ${organizations.auto_top_up_enabled} = TRUE
        )`;
  const [ownedReservation] = await db
    .update(auto_top_up_configs)
    .set({ attempt_started_at: sql`NOW()` })
    .where(
      and(
        eq(auto_top_up_configs.id, config.id),
        eq(auto_top_up_configs.attempt_started_at, attemptStartedAt),
        isNull(auto_top_up_configs.disabled_reason),
        ownerEnabled
      )
    )
    .returning({
      amount_cents: auto_top_up_configs.amount_cents,
      attempt_started_at: auto_top_up_configs.attempt_started_at,
      stripe_payment_method_id: auto_top_up_configs.stripe_payment_method_id,
    });
  if (!ownedReservation) return failureResult('reservation_no_longer_owned');
  if (!ownedReservation.attempt_started_at) {
    throw new Error(`Auto Top-Up reservation ${config.id} lost its execution timestamp`);
  }
  const executionStartedAt = ownedReservation.attempt_started_at;
  let currentBalance_USD: number;
  try {
    ({ currentBalance_USD } = await getEntityBalanceAndStripeCustomer(entity));
  } catch (error) {
    await releaseAutoTopUpReservation(config.id, executionStartedAt);
    throw error;
  }
  const threshold =
    entity.type === 'user' ? AUTO_TOP_UP_THRESHOLD_DOLLARS : ORG_AUTO_TOP_UP_THRESHOLD_DOLLARS;
  if (currentBalance_USD >= threshold) {
    await releaseAutoTopUpReservation(config.id, executionStartedAt);
    return failureResult('balance_already_sufficient');
  }

  const amountCents = ownedReservation.amount_cents;
  const entityLabel = entity.type === 'user' ? `user ${ownerId}` : `organization ${ownerId}`;

  try {
    // Create a proper invoice (with PDF) and pay it off-session.
    // Credit application is handled by the `invoice.paid` webhook.
    const invoiceMetadata: Record<string, string> =
      entity.type === 'user'
        ? { type: 'auto-topup', kiloUserId: entity.user.id, traceId }
        : { type: 'org-auto-topup', organizationId: entity.organization.id, traceId };

    const flow = entity.type === 'user' ? 'personal_auto_top_up' : 'organization_auto_top_up';
    const invoice = await client.invoices.create({
      customer: stripe_customer_id,
      auto_advance: false,
      metadata: {
        ...invoiceMetadata,
        serviceFeePrincipalMinor: String(amountCents),
        serviceFeeFlow: flow,
      },
      description: 'Kilo automatic top up',
    });

    const feeDeps = createAutoTopUpFeeDeps();
    const preparedFee = await prepareAutoTopUpInvoiceFee({
      flow,
      invoiceId: invoice.id,
      principalMinor: amountCents,
      kiloUserId: entity.type === 'user' ? entity.user.id : undefined,
      organizationId: entity.type === 'organization' ? entity.organization.id : undefined,
      stripeCustomerId: stripe_customer_id,
      invoiceCreated: invoice.created ? new Date(invoice.created * 1000) : undefined,
      taxPrincipal: { kind: 'inline' },
      deps: feeDeps,
    });

    try {
      await client.invoices.update(invoice.id, {
        metadata: mergeServiceFeeCommercialMetadata(
          {
            ...invoiceMetadata,
            serviceFeePrincipalMinor: String(amountCents),
          },
          preparedFee.commercialMetadata
        ),
      });
    } catch (metadataError) {
      captureException(metadataError, {
        tags: { source: 'auto_top_up_service_fee_metadata' },
        extra: { invoice_id: invoice.id, flow },
      });
    }

    // Attach the line item directly to this invoice.
    // (Creating a pending invoice item and then creating an invoice can produce a $0 invoice,
    // depending on Stripe's pending_invoice_items_behavior defaults.)
    await client.invoiceItems.create({
      customer: stripe_customer_id,
      invoice: invoice.id,
      amount: amountCents,
      currency: 'usd',
      description: 'Kilo automatic top up',
    });
    await attachPreparedAutoTopUpInvoiceFee({
      prepared: preparedFee,
      deps: feeDeps,
    });

    // Pay the invoice. The PaymentIntent is created during payment, not finalization.
    const paidInvoice = await client.invoices.pay(invoice.id, {
      payment_method: ownedReservation.stripe_payment_method_id,
      off_session: true,
    });

    if (paidInvoice.status === 'paid') {
      // NOTE: We intentionally do NOT synchronously credit the balance here.
      // The `invoice.paid` webhook is the single source of truth for crediting.
      // We also intentionally keep the attempt_started_at lock held until the webhook processes
      // the charge, to avoid multiple invoices/charges being created before the credit lands.
      logExceptInTest(`Auto-top-up invoice paid for ${entityLabel}, webhook will apply credits`, {
        traceId,
        entity_type: entity.type,
        entity_id: ownerId,
        invoice_id: invoice.id,
        amount_cents: amountCents,
      });
      return successResult({ stripe_id: invoice.id });
    }

    // Payment did not complete successfully (e.g. requires authentication).
    const errorStatus = `unexpected_status_${paidInvoice.status}`;
    await disableAutoTopUpForEntity(entity, errorStatus, {
      configId: config.id,
      attemptStartedAt: executionStartedAt,
    });
    return failureResult(errorStatus);
  } catch (error) {
    // StripeCardError = card was declined (insufficient funds, expired, etc.)
    // These are expected user-facing events, not engineering problems.
    const isCardDecline = error instanceof Stripe.errors.StripeCardError;
    const code = isCardDecline
      ? (error.decline_code ?? error.code ?? 'unknown_error')
      : 'unknown_error';

    if (isCardDecline) {
      logExceptInTest(`Auto-top-up card declined for ${entityLabel}`, {
        traceId,
        code,
        reason: error.message,
      });
    } else {
      captureException(error, {
        tags: { source: 'auto_top_up' },
        extra: { entity_type: entity.type, entity_id: ownerId },
      });
    }

    await disableAutoTopUpForEntity(entity, code, {
      configId: config.id,
      attemptStartedAt: executionStartedAt,
    });
    return failureResult(code);
  }
}

type AutoTopUpReservationOwnership = {
  configId: string;
  attemptStartedAt: string;
};

async function releaseAutoTopUpReservation(
  configId: string,
  attemptStartedAt: string
): Promise<boolean> {
  const released = await db
    .update(auto_top_up_configs)
    .set({ attempt_started_at: null })
    .where(
      and(
        eq(auto_top_up_configs.id, configId),
        eq(auto_top_up_configs.attempt_started_at, attemptStartedAt)
      )
    )
    .returning({ id: auto_top_up_configs.id });
  return released.length === 1;
}

/**
 * Get fresh balance and stripe customer ID for an entity.
 */
async function getEntityBalanceAndStripeCustomer(
  entity: AutoTopUpEntity
): Promise<{ currentBalance_USD: number; stripe_customer_id: string | null }> {
  if (entity.type === 'user') {
    const freshUser = await findUserById(entity.user.id);
    if (!freshUser) throw new Error('User not found:' + entity.user.id);
    const currentBalance_USD =
      (freshUser.total_microdollars_acquired - freshUser.microdollars_used) / 1_000_000;
    return { currentBalance_USD, stripe_customer_id: freshUser.stripe_customer_id };
  } else {
    const freshOrg = await getOrganizationById(entity.organization.id);
    if (!freshOrg) throw new Error('Organization not found:' + entity.organization.id);
    const currentBalance_USD =
      (freshOrg.total_microdollars_acquired - freshOrg.microdollars_used) / 1_000_000;
    return { currentBalance_USD, stripe_customer_id: freshOrg.stripe_customer_id };
  }
}

/**
 * Human-readable messages for known failure reasons.
 * See https://stripe.com/docs/declines/codes for Stripe decline codes.
 */
const failureReasonMessages = {
  // Internal reasons
  no_payment_method_saved: 'No payment method is saved for auto-top-up.',
  unexpected_invoice_status: 'The payment requires additional verification.',
  unknown_error: '',
  // Stripe decline codes (observed in production)
  insufficient_funds: 'Your card has insufficient funds.',
  card_declined: 'Your card was declined.',
  generic_decline: 'Your card was declined.',
  do_not_honor: 'Your bank declined the transaction.',
  try_again_later: 'The payment processor is temporarily unavailable. Please try again later.',
  payment_intent_payment_attempt_failed: 'The payment attempt failed. Please try again.',
  card_velocity_exceeded: 'Your card has exceeded its transaction limit.',
  transaction_not_allowed: 'This transaction is not allowed by your card.',
  expired_card: 'Your card has expired.',
  processing_error: 'There was a processing error with your card.',
} as const;

type KnownFailureReason = keyof typeof failureReasonMessages;

/**
 * Disable auto-top-up for an entity (user or organization).
 */
async function disableAutoTopUpForEntity(
  entity: AutoTopUpEntity,
  reason: string,
  ownership?: AutoTopUpReservationOwnership
): Promise<void> {
  const message =
    failureReasonMessages[reason as KnownFailureReason] ?? failureReasonMessages.unknown_error;
  const isUnmappedCode = !(reason in failureReasonMessages);
  const entityLabel =
    entity.type === 'user' ? `user ${entity.user.id}` : `organization ${entity.organization.id}`;

  const ownerColumn =
    entity.type === 'user'
      ? auto_top_up_configs.owned_by_user_id
      : auto_top_up_configs.owned_by_organization_id;
  const ownerId = entity.type === 'user' ? entity.user.id : entity.organization.id;

  const disabled = await db.transaction(async tx => {
    if (ownership) {
      const ownedConfig = await tx
        .update(auto_top_up_configs)
        .set({ attempt_started_at: null, disabled_reason: reason })
        .where(
          and(
            eq(auto_top_up_configs.id, ownership.configId),
            eq(auto_top_up_configs.attempt_started_at, ownership.attemptStartedAt)
          )
        )
        .returning({ id: auto_top_up_configs.id });
      if (ownedConfig.length === 0) return false;
    } else {
      await tx
        .update(auto_top_up_configs)
        .set({ disabled_reason: reason })
        .where(eq(ownerColumn, ownerId));
    }

    if (entity.type === 'user') {
      await tx
        .update(kilocode_users)
        .set({ auto_top_up_enabled: false })
        .where(eq(kilocode_users.id, entity.user.id));
    } else {
      await tx
        .update(organizations)
        .set({ auto_top_up_enabled: false })
        .where(eq(organizations.id, entity.organization.id));
    }
    return true;
  });
  if (!disabled) return;

  sentryLogger('auto-topup', 'info')(`Disabling auto-top-up for ${entityLabel}: ${reason}`, {
    ...(isUnmappedCode && { unmapped_code: reason }),
  });

  if (entity.type === 'user') {
    // Send email notification for users
    const user = await findUserById(entity.user.id);
    if (user?.google_user_email) {
      await sendAutoTopUpFailedEmail(user.google_user_email, { reason: message });
    }
  } else {
    // Send email notification to org owners and billing managers
    const members = await getOrganizationMembers(entity.organization.id);
    const ownerEmails = members
      .filter(m => (m.role === 'owner' || m.role === 'billing_manager') && m.status === 'active')
      .map(m => m.email);
    for (const email of ownerEmails) {
      await sendAutoTopUpFailedEmail(email, {
        reason: message,
        organizationId: entity.organization.id,
      });
    }
  }
}
