import { client } from '@kilocode/web-shared/lib/stripe-client';
import Stripe from 'stripe';
import { db } from '@kilocode/web-shared/lib/drizzle';
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
import { logExceptInTest, sentryLogger } from '@kilocode/web-shared/lib/utils.server';
import { failureResult, successResult, type Result } from '@kilocode/web-shared/lib/maybe-result';
import type { UserForBalance } from '@kilocode/web-shared/lib/user/balance-types';
import { findUserById } from '@kilocode/web-shared/lib/user/find-user-by-id';
import {
  getOrganizationById,
  getOrganizationMembers,
} from '@kilocode/web-shared/lib/organizations/organizations';
import { randomUUID } from 'crypto';
import { reportChargeAttempted } from '@kilocode/web-shared/lib/bouncer/credit-events';
import { decideCheckoutCharge } from '@kilocode/web-shared/lib/bouncer/charge-gate';
import { sendAutoTopUpFailedEmail } from '@kilocode/web-shared/lib/email';
import { getKiloPassStateForUser } from '@kilocode/web-shared/lib/kilo-pass/state';
import { isStripeSubscriptionEnded } from '@kilocode/web-shared/lib/kilo-pass/stripe-subscription-status';
import { KiloPassIssuanceItemKind } from '@kilocode/web-shared/lib/kilo-pass/enums';

import {
  AUTO_TOP_UP_ATTEMPT_LOCK_TIMEOUT_SECONDS,
  AUTO_TOP_UP_CHARGE_REFUSAL_COOLDOWN_SECONDS,
  AUTO_TOP_UP_THRESHOLD_DOLLARS,
  MAX_ORG_AUTO_TOP_UP_THRESHOLD_CENTS,
  parseOrgAutoTopUpThresholdCents,
  SYSTEM_AUTO_TOP_UP_USER_ID,
} from '@kilocode/web-shared/lib/autoTopUpConstants';
import {
  attachPreparedAutoTopUpInvoiceFee,
  mergeServiceFeeCommercialMetadata,
  prepareAutoTopUpInvoiceFee,
  type ServiceFeeCheckoutDependencies,
} from '@kilocode/web-shared/lib/service-fees/checkout';
import { createServiceFeeStores } from '@kilocode/web-shared/lib/service-fees/drizzle-store';
import { getEffectiveOrganizationServiceFeeExemption } from '@kilocode/web-shared/lib/service-fees/organization-exemptions';
import { getPaidCreditTerms } from '@kilocode/web-shared/lib/paidCreditPolicy.server';

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

export type AutoTopUpOrganization = Pick<
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

type BalanceFields = { total_microdollars_acquired: number; microdollars_used: number };

/** The USD balance of an account row, in the one definition the module uses. */
function balanceUsd(account: BalanceFields): number {
  return (account.total_microdollars_acquired - account.microdollars_used) / 1_000_000;
}

function entityBalanceUsd(entity: AutoTopUpEntity): number {
  return balanceUsd(entity.type === 'user' ? entity.user : entity.organization);
}

/**
 * The owner column, owner id and log/email label of an entity. `AutoTopUpEntity` is the
 * union that makes this narrowing, so it happens here once instead of in every caller.
 */
function entityIdentity(entity: AutoTopUpEntity): {
  ownerColumn:
    | typeof auto_top_up_configs.owned_by_user_id
    | typeof auto_top_up_configs.owned_by_organization_id;
  ownerId: string;
  label: string;
} {
  return entity.type === 'user'
    ? {
        ownerColumn: auto_top_up_configs.owned_by_user_id,
        ownerId: entity.user.id,
        label: `user ${entity.user.id}`,
      }
    : {
        ownerColumn: auto_top_up_configs.owned_by_organization_id,
        ownerId: entity.organization.id,
        label: `organization ${entity.organization.id}`,
      };
}

/**
 * The threshold in USD a charge is measured against: the stored org threshold, or the personal
 * constant for a user. `organizationThresholdCents` is ignored for a user.
 */
function autoTopUpThresholdUsd(
  entity: AutoTopUpEntity,
  organizationThresholdCents?: number | null
): number {
  return entity.type === 'user'
    ? AUTO_TOP_UP_THRESHOLD_DOLLARS
    : orgThresholdDollars(organizationThresholdCents);
}

/**
 * The ceiling the entry pre-check uses before the cheaper stored-threshold read: a user always
 * compares against the personal constant, and an org cannot have configured a higher threshold
 * than the constants allow.
 */
function maxAutoTopUpThresholdUsd(entity: AutoTopUpEntity): number {
  return entity.type === 'user'
    ? AUTO_TOP_UP_THRESHOLD_DOLLARS
    : MAX_ORG_AUTO_TOP_UP_THRESHOLD_CENTS / 100;
}

function orgThresholdDollars(thresholdCents: number | null | undefined): number {
  return parseOrgAutoTopUpThresholdCents(thresholdCents) / 100;
}

async function readOrganizationAutoTopUpThresholdCents(
  organizationId: string
): Promise<number | null | undefined> {
  const config = await db.query.auto_top_up_configs.findFirst({
    columns: { threshold_cents: true },
    where: eq(auto_top_up_configs.owned_by_organization_id, organizationId),
  });
  return config?.threshold_cents;
}

/**
 * Whether bouncer refused this payer's charge recently enough that the standing question is
 * suppressed. The comparison runs in SQL so the stored text shape never becomes a JS date; a
 * payer with no config row has never been refused.
 */
async function chargeRefusalIsFresh(entity: AutoTopUpEntity): Promise<boolean> {
  const { ownerColumn, ownerId } = entityIdentity(entity);
  const [config] = await db
    .select({
      refused: sql<boolean>`coalesce(${auto_top_up_configs.charge_refused_at} > NOW() - INTERVAL '${sql.raw(String(AUTO_TOP_UP_CHARGE_REFUSAL_COOLDOWN_SECONDS))} second', false)`,
    })
    .from(auto_top_up_configs)
    .where(eq(ownerColumn, ownerId))
    .limit(1);
  return config?.refused ?? false;
}

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
  return await maybePerformAutoTopUpForEntity({ type: 'user', user });
}

/**
 * Performs auto-top-up for an organization if balance is below threshold.
 * Entry point for organization auto-top-up, called from token usage ingestion.
 */
export async function maybePerformOrganizationAutoTopUp(
  organization: AutoTopUpOrganization
): Promise<void> {
  return await maybePerformAutoTopUpForEntity({ type: 'organization', organization });
}

async function maybePerformAutoTopUpForEntity(entity: AutoTopUpEntity): Promise<void> {
  const autoTopUpEnabled =
    entity.type === 'user'
      ? entity.user.auto_top_up_enabled
      : entity.organization.auto_top_up_enabled;
  if (!autoTopUpEnabled) {
    return;
  }

  const initialBalance_USD = entityBalanceUsd(entity);
  if (initialBalance_USD >= maxAutoTopUpThresholdUsd(entity)) {
    return;
  }
  const threshold =
    entity.type === 'user'
      ? autoTopUpThresholdUsd(entity, null)
      : autoTopUpThresholdUsd(
          entity,
          await readOrganizationAutoTopUpThresholdCents(entity.organization.id)
        );
  if (initialBalance_USD >= threshold) {
    return;
  }

  // If the user has an active Kilo Pass and has NOT received their bonus credits for the current
  // period/month yet, do not auto-top-up. (Only applies to users, not organizations.)
  if (entity.type === 'user') {
    const shouldWait = await shouldWaitForKiloPassBonusCredits(entity.user.id);
    if (shouldWait) {
      return;
    }
  }

  if (await chargeRefusalIsFresh(entity)) {
    const { ownerId, label: entityLabel } = entityIdentity(entity);
    logExceptInTest(`Auto-top-up skipped for ${entityLabel}: a standing refusal was recent`, {
      entity_type: entity.type,
      entity_id: ownerId,
    });
    return;
  }

  const traceId = randomUUID();

  const { ownerId: entityId, label: entityLabel } = entityIdentity(entity);

  sentryLogger('auto-topup', 'info')('Auto-top-up triggered', {
    traceId,
    userId: entity.type === 'user' ? entity.user.id : undefined,
    organizationId: entity.type === 'organization' ? entity.organization.id : undefined,
    reason: 'balance_below_threshold',
    balance_USD: initialBalance_USD,
    threshold_USD: threshold,
  });

  const result = await performAutoTopUpForEntity(entity, traceId);

  if (!result.success && result.error === 'concurrent_attempt_in_progress') {
    logExceptInTest(`Auto-top-up skipped for ${entityLabel}: concurrent attempt in progress`, {
      traceId,
    });
    return;
  }

  if (!result.success && result.error === 'charge_refused') {
    logExceptInTest(`Auto-top-up charge refused for ${entityLabel}`, {
      traceId,
      entity_type: entity.type,
      entity_id: entityId,
    });
    return;
  }

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

/**
 * Generalized auto-top-up logic that works for both users and organizations.
 */
async function performAutoTopUpForEntity(
  entity: AutoTopUpEntity,
  traceId: string
): Promise<AutoTopUpResult> {
  const { ownerColumn, ownerId, label: entityLabel } = entityIdentity(entity);

  // Atomically check and acquire lock in a single query using SQL NOW()
  const [config] = await db
    .update(auto_top_up_configs)
    .set({ attempt_started_at: sql`NOW()` })
    .where(
      and(
        eq(ownerColumn, ownerId),
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
      threshold_cents: auto_top_up_configs.threshold_cents,
      attempt_started_at: auto_top_up_configs.attempt_started_at,
      created_by_user_id: auto_top_up_configs.created_by_user_id,
    });

  if (!config) {
    // Either no config exists, or concurrent attempt in progress
    // Check which case it is
    const existingConfig = await db.query.auto_top_up_configs.findFirst({
      where: eq(ownerColumn, ownerId),
    });

    if (!existingConfig) {
      await disableAutoTopUpForEntity(entity, 'no_payment_method_saved');
      return failureResult('no_payment_method_saved');
    }
    return failureResult('concurrent_attempt_in_progress');
  }

  // Every exit below releases the lock, except a paid invoice: that one stays held until the
  // `invoice.paid` webhook posts the credits.
  let holdAttemptLock = false;
  try {
    // Re-check under the lock: another request may have funded the account.
    const {
      currentBalance_USD,
      stripe_customer_id,
      accountCreatedAt,
      accountUsedMicrodollars,
      autoTopUpEnabled,
    } = await getEntityBalanceAndStripeCustomer(entity);
    const threshold = autoTopUpThresholdUsd(entity, config.threshold_cents);
    if (!autoTopUpEnabled || currentBalance_USD >= threshold) {
      return failureResult(
        autoTopUpEnabled ? 'balance_already_sufficient' : 'auto_top_up_disabled'
      );
    }

    if (!stripe_customer_id) {
      await disableAutoTopUpForEntity(entity, 'no_stripe_customer');
      return failureResult('no_stripe_customer');
    }

    const amountCents = config.amount_cents;
    // Bouncer's payer for an org charge is the org; the user id is the org's billing actor.
    const bouncerUserId =
      entity.type === 'user'
        ? entity.user.id
        : (config.created_by_user_id ?? SYSTEM_AUTO_TOP_UP_USER_ID);
    const bouncerOrgId = entity.type === 'organization' ? entity.organization.id : undefined;

    const chargeVerdict = await decideCheckoutCharge({
      userId: bouncerUserId,
      organizationId: bouncerOrgId,
      flow: 'auto_topup',
      requestId: `auto_topup:${config.id}:${traceId}`,
    });
    if (chargeVerdict?.enforced) {
      await db
        .update(auto_top_up_configs)
        .set({ charge_refused_at: sql`NOW()` })
        .where(eq(auto_top_up_configs.id, config.id));
      return failureResult('charge_refused');
    }

    try {
      // Create a proper invoice (with PDF) and pay it off-session.
      // Credit application is handled by the `invoice.paid` webhook.
      const invoiceMetadata: Record<string, string> =
        entity.type === 'user'
          ? { type: 'auto-topup', kiloUserId: entity.user.id, traceId }
          : { type: 'org-auto-topup', organizationId: entity.organization.id, traceId };
      invoiceMetadata.paid_credit_policy = getPaidCreditTerms('stripe', new Date());

      const flow = entity.type === 'user' ? 'personal_auto_top_up' : 'organization_auto_top_up';
      const baseMetadata: Record<string, string> = {
        ...invoiceMetadata,
        serviceFeePrincipalMinor: String(amountCents),
      };
      const invoice = await client.invoices.create({
        customer: stripe_customer_id,
        auto_advance: false,
        metadata: { ...baseMetadata, serviceFeeFlow: flow },
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
          metadata: mergeServiceFeeCommercialMetadata(baseMetadata, preparedFee.commercialMetadata),
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
      await reportChargeAttempted({
        flow: 'auto_topup',
        userId: bouncerUserId,
        orgId: bouncerOrgId,
        amountCents,
        accountCreatedAt,
        accountUsedMicrodollars,
      });
      const paidInvoice = await client.invoices.pay(invoice.id, {
        payment_method: config.stripe_payment_method_id,
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
        holdAttemptLock = true;
        return successResult({ stripe_id: invoice.id });
      }

      // Payment did not complete successfully (e.g. requires authentication). The reason is the
      // stable key `failureReasonMessages` owns; the raw status is diagnosis, not a message key.
      logExceptInTest(`Auto-top-up invoice not paid for ${entityLabel}`, {
        traceId,
        entity_type: entity.type,
        entity_id: ownerId,
        invoice_id: invoice.id,
        invoice_status: paidInvoice.status,
      });
      await disableAutoTopUpForEntity(entity, 'unexpected_invoice_status');
      return failureResult('unexpected_invoice_status');
    } catch (error) {
      // StripeCardError = card was declined (insufficient funds, expired, etc.)
      // These are expected user-facing events, not engineering problems.
      const isCardDecline = error instanceof Stripe.errors.StripeCardError;
      const code = isCardDecline
        ? error.decline_code || error.code || 'unknown_error'
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

      await disableAutoTopUpForEntity(entity, code);
      return failureResult(code);
    }
  } finally {
    if (!holdAttemptLock) {
      await db
        .update(auto_top_up_configs)
        .set({ attempt_started_at: null })
        .where(eq(auto_top_up_configs.id, config.id));
    }
  }
}

/**
 * Get fresh balance and stripe customer ID for an entity.
 */
async function getEntityBalanceAndStripeCustomer(entity: AutoTopUpEntity): Promise<{
  currentBalance_USD: number;
  stripe_customer_id: string | null;
  accountCreatedAt: string;
  accountUsedMicrodollars: number;
  autoTopUpEnabled: boolean;
}> {
  if (entity.type === 'user') {
    const freshUser = await findUserById(entity.user.id);
    if (!freshUser) throw new Error('User not found:' + entity.user.id);
    const currentBalance_USD = balanceUsd(freshUser);
    return {
      currentBalance_USD,
      stripe_customer_id: freshUser.stripe_customer_id,
      accountCreatedAt: freshUser.created_at,
      accountUsedMicrodollars: freshUser.microdollars_used,
      autoTopUpEnabled: freshUser.auto_top_up_enabled,
    };
  } else {
    const freshOrg = await getOrganizationById(entity.organization.id);
    if (!freshOrg) throw new Error('Organization not found:' + entity.organization.id);
    const currentBalance_USD = balanceUsd(freshOrg);
    return {
      currentBalance_USD,
      stripe_customer_id: freshOrg.stripe_customer_id,
      accountCreatedAt: freshOrg.created_at,
      accountUsedMicrodollars: freshOrg.microdollars_used,
      autoTopUpEnabled: freshOrg.auto_top_up_enabled,
    };
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
 * Stripe decline codes arrive as an open string, so one lookup decides both the message and
 * whether the code is catalogued. Own keys only: an inherited name such as `toString` is not a
 * failure reason, and the catalog owns the fallback message.
 */
function isKnownFailureReason(reason: string): reason is KnownFailureReason {
  return Object.hasOwn(failureReasonMessages, reason);
}

function resolveFailureReason(reason: string): { message: string; isUnmappedCode: boolean } {
  return isKnownFailureReason(reason)
    ? { message: failureReasonMessages[reason], isUnmappedCode: false }
    : { message: failureReasonMessages.unknown_error, isUnmappedCode: true };
}

/**
 * Disable auto-top-up for an entity (user or organization).
 */
async function disableAutoTopUpForEntity(entity: AutoTopUpEntity, reason: string): Promise<void> {
  const { message, isUnmappedCode } = resolveFailureReason(reason);
  const { ownerColumn, ownerId, label: entityLabel } = entityIdentity(entity);

  sentryLogger('auto-topup', 'info')(`Disabling auto-top-up for ${entityLabel}: ${reason}`, {
    ...(isUnmappedCode && { unmapped_code: reason }),
  });

  // Update auto_top_up_configs (shared for both entity types)
  await db
    .update(auto_top_up_configs)
    .set({ disabled_reason: reason })
    .where(eq(ownerColumn, ownerId));

  if (entity.type === 'user') {
    await db
      .update(kilocode_users)
      .set({ auto_top_up_enabled: false })
      .where(eq(kilocode_users.id, entity.user.id));

    // Send email notification for users
    const user = await findUserById(entity.user.id);
    if (user?.google_user_email) {
      await sendAutoTopUpFailedEmail(user.google_user_email, { reason: message });
    }
  } else {
    await db
      .update(organizations)
      .set({ auto_top_up_enabled: false })
      .where(eq(organizations.id, entity.organization.id));

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
