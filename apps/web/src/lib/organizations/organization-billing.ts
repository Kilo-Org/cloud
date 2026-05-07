import type { Organization, User } from '@kilocode/db/schema';
import { organizations, credit_transactions, transactional_email_log } from '@kilocode/db/schema';
import type { DrizzleTransaction } from '@/lib/drizzle';
import { db } from '@/lib/drizzle';
import { getOrganizationById, getOrganizationMembers } from '@/lib/organizations/organizations';
import { createStripeCustomer } from '@/lib/stripe-client';
import { and, eq, isNull, sql } from 'drizzle-orm';
import type Stripe from 'stripe';
import { resolveStripeReceiptUrl, type StripeConfig } from '@/lib/credits';
import { toMicrodollars } from '@/lib/utils';
import { logExceptInTest } from '@/lib/utils.server';
import { createAuditLog } from '@/lib/organizations/organization-audit-logs';
import { grantEntityCreditForCategory } from '@/lib/promotionalCredits';
import { findUserById } from '@/lib/user';
import { SYSTEM_AUTO_TOP_UP_USER_ID } from '@/lib/autoTopUpConstants';
import { captureException, captureMessage } from '@sentry/nextjs';
import { sendCreditsTopUpEmail } from '@/lib/email';
import { IS_IN_AUTOMATED_TEST } from '@/lib/config.server';
import { after } from 'next/server';

export async function getOrCreateStripeCustomerIdForOrganization(
  organizationId: Organization['id'],
  mockCreateStripeCustomer?: (params: {
    metadata: { organizationId: string };
  }) => Promise<Stripe.Customer>
): Promise<string> {
  const org = await getOrganizationById(organizationId);
  if (!org) {
    throw new Error('Organization not found');
  }
  if (org.stripe_customer_id != null) {
    logExceptInTest(
      `Found existing Stripe customer ID for organization ${organizationId}: ${org.stripe_customer_id}`
    );
    return org.stripe_customer_id;
  }

  // Serialize customer creation per organization using an advisory lock
  // to prevent concurrent requests from creating duplicate Stripe customers.
  return await db.transaction(async tx => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${organizationId}))`);

    // Re-check after acquiring lock — another process may have set it
    const [freshOrg] = await tx
      .select({ stripe_customer_id: organizations.stripe_customer_id })
      .from(organizations)
      .where(eq(organizations.id, organizationId));

    if (freshOrg?.stripe_customer_id != null) {
      return freshOrg.stripe_customer_id;
    }

    const stripeCustomerFn = mockCreateStripeCustomer || createStripeCustomer;
    const customer = await stripeCustomerFn({
      metadata: { organizationId },
    });

    try {
      const rows = await tx
        .update(organizations)
        .set({ stripe_customer_id: customer.id })
        .where(and(eq(organizations.id, organizationId), isNull(organizations.stripe_customer_id)))
        .returning();

      if (!rows.length || !rows[0].stripe_customer_id) {
        // Another process won despite the advisory lock (should be unreachable).
        throw new Error('Failed to create Stripe customer for organization');
      }
      return rows[0].stripe_customer_id;
    } catch (error) {
      logExceptInTest(
        `Orphaned Stripe customer ${customer.id} created for org ${organizationId} — manual cleanup required`
      );
      throw error;
    }
  });
}

type Config = StripeConfig;
type ProcessTopupForOrganizationOptions = {
  isAutoTopUp?: boolean;
};
const ORGANIZATION_CREDITS_TOP_UP_CONFIRMATION_EMAIL_TYPE =
  'organization_credits_top_up_confirmation';

export async function getTopUpConfirmationRecipientsForOrganization(
  organizationId: Organization['id']
): Promise<string[]> {
  const members = await getTopUpConfirmationRecipientMembersForOrganization(organizationId);
  return members.map(member => member.email);
}

async function getTopUpConfirmationRecipientMembersForOrganization(
  organizationId: Organization['id']
): Promise<Array<{ id: User['id']; email: string }>> {
  const members = await getOrganizationMembers(organizationId);
  const recipientsByEmail = new Map<string, { id: User['id']; email: string }>();

  for (const member of members) {
    if (
      member.status === 'active' &&
      (member.role === 'owner' || member.role === 'billing_manager')
    ) {
      recipientsByEmail.set(member.email, { id: member.id, email: member.email });
    }
  }

  return [...recipientsByEmail.values()];
}

export async function maybeSendOrganizationTopUpConfirmationEmail(params: {
  userId: User['id'];
  organization: Organization;
  amountInCents: number;
  stripeChargeOrInvoiceId: string;
  isAutoTopUp: boolean;
  purchaseDate?: Date;
}): Promise<void> {
  const {
    userId,
    organization,
    amountInCents,
    stripeChargeOrInvoiceId,
    isAutoTopUp,
    purchaseDate,
  } = params;

  let insertedMarker = false;

  try {
    const insertResult = await db
      .insert(transactional_email_log)
      .values({
        user_id: userId === SYSTEM_AUTO_TOP_UP_USER_ID ? null : userId,
        organization_id: organization.id,
        email_type: ORGANIZATION_CREDITS_TOP_UP_CONFIRMATION_EMAIL_TYPE,
        idempotency_key: stripeChargeOrInvoiceId,
      })
      .onConflictDoNothing();

    insertedMarker = (insertResult.rowCount ?? 0) > 0;
  } catch (error) {
    captureException(error, {
      tags: { source: 'organization_credits_topup_email', failure_type: 'marker_insert' },
      extra: {
        user_id: userId,
        organization_id: organization.id,
        stripeChargeOrInvoiceId,
        isAutoTopUp,
      },
    });
    return;
  }

  if (!insertedMarker) return;

  let recipients: Array<{ id: User['id']; email: string }>;
  try {
    recipients = await getTopUpConfirmationRecipientMembersForOrganization(organization.id);
  } catch (error) {
    captureException(error, {
      tags: { source: 'organization_credits_topup_email', failure_type: 'recipient_lookup' },
      extra: {
        user_id: userId,
        organization_id: organization.id,
        stripeChargeOrInvoiceId,
        isAutoTopUp,
      },
    });
    await deleteOrganizationTopUpEmailMarkerBestEffort({
      stripeChargeOrInvoiceId,
      userId,
      organizationId: organization.id,
      isAutoTopUp,
      cleanupReason: 'recipient_lookup',
    });
    return;
  }

  if (recipients.length === 0) {
    captureMessage('Organization top-up confirmation email skipped: no eligible recipients', {
      level: 'warning',
      tags: { source: 'organization_credits_topup_email' },
      extra: { user_id: userId, organization_id: organization.id, stripeChargeOrInvoiceId },
    });
    return;
  }

  let receiptUrl: string | null;
  try {
    receiptUrl = await resolveStripeReceiptUrl(stripeChargeOrInvoiceId);
  } catch (error) {
    captureException(error, {
      tags: { source: 'organization_credits_topup_email', failure_type: 'receipt_lookup' },
      extra: {
        user_id: userId,
        organization_id: organization.id,
        stripeChargeOrInvoiceId,
        isAutoTopUp,
      },
    });
    await deleteOrganizationTopUpEmailMarkerBestEffort({
      stripeChargeOrInvoiceId,
      userId,
      organizationId: organization.id,
      isAutoTopUp,
      cleanupReason: 'receipt_lookup',
    });
    return;
  }

  let sentEmails = 0;
  let retryableFailures = 0;

  for (const [recipientIndex, recipient] of recipients.entries()) {
    try {
      const sendResult = await sendCreditsTopUpEmail({
        to: recipient.email,
        variant: isAutoTopUp ? 'org_auto' : 'org_manual',
        amountCents: amountInCents,
        creditsCents: amountInCents,
        purchaseDate: purchaseDate ?? new Date(),
        receiptUrl,
        organizationId: organization.id,
        organizationName: organization.name,
      });

      if (sendResult.sent) {
        sentEmails += 1;
      } else if (sendResult.reason === 'neverbounce_rejected') {
        captureMessage('Organization top-up confirmation email recipient rejected', {
          level: 'warning',
          tags: {
            source: 'organization_credits_topup_email',
            reason: sendResult.reason,
          },
          extra: {
            user_id: userId,
            organization_id: organization.id,
            stripeChargeOrInvoiceId,
            isAutoTopUp,
            recipient_index: recipientIndex + 1,
            recipient_total: recipients.length,
          },
        });
      } else {
        retryableFailures += 1;
        captureMessage('Organization top-up confirmation email send failed', {
          level: 'warning',
          tags: {
            source: 'organization_credits_topup_email',
            reason: sendResult.reason,
          },
          extra: {
            user_id: userId,
            organization_id: organization.id,
            stripeChargeOrInvoiceId,
            isAutoTopUp,
            recipient_index: recipientIndex + 1,
            recipient_total: recipients.length,
          },
        });
      }
    } catch (error) {
      retryableFailures += 1;
      captureException(error, {
        tags: { source: 'organization_credits_topup_email', failure_type: 'recipient_send' },
        extra: {
          user_id: userId,
          organization_id: organization.id,
          stripeChargeOrInvoiceId,
          isAutoTopUp,
          recipient_index: recipientIndex + 1,
          recipient_total: recipients.length,
        },
      });
    }
  }

  if (sentEmails === 0 && retryableFailures > 0) {
    await deleteOrganizationTopUpEmailMarkerBestEffort({
      stripeChargeOrInvoiceId,
      userId,
      organizationId: organization.id,
      isAutoTopUp,
      cleanupReason: 'all_retryable_failures',
    });
  }
}

async function deleteOrganizationTopUpEmailMarkerBestEffort(params: {
  stripeChargeOrInvoiceId: string;
  userId: User['id'];
  organizationId: Organization['id'];
  isAutoTopUp: boolean;
  cleanupReason: 'recipient_lookup' | 'receipt_lookup' | 'all_retryable_failures';
}): Promise<void> {
  const { stripeChargeOrInvoiceId, userId, organizationId, isAutoTopUp, cleanupReason } = params;

  try {
    await deleteOrganizationTopUpEmailMarker(stripeChargeOrInvoiceId);
  } catch (error) {
    captureException(error, {
      tags: {
        source: 'organization_credits_topup_email',
        failure_type: 'marker_cleanup',
        cleanup_reason: cleanupReason,
      },
      extra: {
        user_id: userId,
        organization_id: organizationId,
        stripeChargeOrInvoiceId,
        isAutoTopUp,
      },
    });
  }
}

async function deleteOrganizationTopUpEmailMarker(stripeChargeOrInvoiceId: string): Promise<void> {
  await db
    .delete(transactional_email_log)
    .where(
      and(
        eq(transactional_email_log.email_type, ORGANIZATION_CREDITS_TOP_UP_CONFIRMATION_EMAIL_TYPE),
        eq(transactional_email_log.idempotency_key, stripeChargeOrInvoiceId)
      )
    );
}

export async function processTopupForOrganization(
  kiloUserId: User['id'],
  organizationId: Organization['id'],
  amountInCents: number,
  config: Config,
  options: ProcessTopupForOrganizationOptions = {}
) {
  const { isAutoTopUp = false } = options;
  const organization = await getOrganizationById(organizationId);
  if (!organization) throw new Error('Organization not found: ' + organizationId);

  let user: User | undefined;
  if (kiloUserId !== SYSTEM_AUTO_TOP_UP_USER_ID) {
    user = (await findUserById(kiloUserId)) ?? undefined;
    if (!user) {
      logExceptInTest(`User ${kiloUserId} not found for organization top-up ${organizationId}`);
    }
  }

  const creditDescription = `Organization top-up via ${config.type}`;
  const creditAmountInMicrodollars = toMicrodollars(amountInCents / 100);

  const didInsertCreditTransaction = await db.transaction(async (tx: DrizzleTransaction) => {
    logExceptInTest(
      `processing topup for ${organization.id} - ${amountInCents} in transaction with payment id ${config.stripe_payment_id}`
    );

    const result = await tx
      .insert(credit_transactions)
      .values({
        kilo_user_id: kiloUserId,
        organization_id: organization.id,
        is_free: false,
        amount_microdollars: creditAmountInMicrodollars,
        description: creditDescription,
        stripe_payment_id: config.stripe_payment_id,
        original_baseline_microdollars_used: organization.microdollars_used,
      })
      .onConflictDoNothing();

    if (result.rowCount === 0) {
      logExceptInTest(
        `Skipping duplicate topup for ${organization.id} - payment id ${config.stripe_payment_id} already processed`
      );
      return false;
    }

    // Update organization balance
    await tx
      .update(organizations)
      .set({
        total_microdollars_acquired: sql`${organizations.total_microdollars_acquired} + ${Math.round(creditAmountInMicrodollars)}`,
        microdollars_balance: sql`${organizations.microdollars_balance} + ${Math.round(creditAmountInMicrodollars)}`,
      })
      .where(eq(organizations.id, organization.id));

    await createAuditLog({
      action: 'organization.purchase_credits',
      actor_id: kiloUserId,
      actor_email: user?.google_user_email || 'unknown',
      actor_name: user?.google_user_name || 'unknown',
      organization_id: organization.id,
      message: `Purchased $${(amountInCents / 100).toFixed(2)} credit via ${config.type}`,
      tx,
    });

    return true;
  });

  if (!didInsertCreditTransaction) {
    const existingCreditTransaction = await getExistingOrganizationTopUpCreditTransaction({
      organizationId: organization.id,
      stripeChargeOrInvoiceId: config.stripe_payment_id,
      expectedAmountMicrodollars: creditAmountInMicrodollars,
    });

    if (!existingCreditTransaction) {
      return;
    }

    await recoverOrganizationTopUpConfirmationEmailIfMissing({
      userId: kiloUserId,
      organization,
      amountInCents,
      stripeChargeOrInvoiceId: config.stripe_payment_id,
      isAutoTopUp,
      purchaseDate: new Date(existingCreditTransaction.createdAt),
    });
    return;
  }

  if (process.env.NODE_ENV === 'test') {
    // 2025-12-03: temporarily disable this promo until devrel decides it's time to go live with it.
    if (user) {
      await grantEntityCreditForCategory(
        { organization, user },
        { credit_category: 'team-topup-bonus-2025', counts_as_selfservice: false }
      );
    }
  }

  await scheduleOrganizationTopUpConfirmationEmail({
    userId: kiloUserId,
    organization,
    amountInCents,
    stripeChargeOrInvoiceId: config.stripe_payment_id,
    isAutoTopUp,
  });
}

async function recoverOrganizationTopUpConfirmationEmailIfMissing(params: {
  userId: User['id'];
  organization: Organization;
  amountInCents: number;
  stripeChargeOrInvoiceId: string;
  isAutoTopUp: boolean;
  purchaseDate: Date;
}): Promise<void> {
  await scheduleOrganizationTopUpConfirmationEmail(params);
}

async function getExistingOrganizationTopUpCreditTransaction(params: {
  organizationId: Organization['id'];
  stripeChargeOrInvoiceId: string;
  expectedAmountMicrodollars: number;
}): Promise<{ createdAt: string } | undefined> {
  const [creditTransaction] = await db
    .select({
      organizationId: credit_transactions.organization_id,
      amountMicrodollars: credit_transactions.amount_microdollars,
      createdAt: credit_transactions.created_at,
    })
    .from(credit_transactions)
    .where(eq(credit_transactions.stripe_payment_id, params.stripeChargeOrInvoiceId))
    .limit(1);

  if (
    !creditTransaction ||
    creditTransaction.organizationId !== params.organizationId ||
    creditTransaction.amountMicrodollars !== params.expectedAmountMicrodollars
  ) {
    captureMessage('Organization top-up duplicate payment id mismatch', {
      level: 'error',
      tags: { source: 'organization_credits_topup_email' },
      extra: {
        organization_id: params.organizationId,
        stripeChargeOrInvoiceId: params.stripeChargeOrInvoiceId,
        existing_organization_id: creditTransaction?.organizationId,
        existing_amount_microdollars: creditTransaction?.amountMicrodollars,
        expected_amount_microdollars: params.expectedAmountMicrodollars,
      },
    });
    return undefined;
  }

  return { createdAt: creditTransaction.createdAt };
}

async function scheduleOrganizationTopUpConfirmationEmail(params: {
  userId: User['id'];
  organization: Organization;
  amountInCents: number;
  stripeChargeOrInvoiceId: string;
  isAutoTopUp: boolean;
  purchaseDate?: Date;
}): Promise<void> {
  if (IS_IN_AUTOMATED_TEST) {
    await maybeSendOrganizationTopUpConfirmationEmail(params);
    return;
  }

  after(() => maybeSendOrganizationTopUpConfirmationEmail(params));
}
