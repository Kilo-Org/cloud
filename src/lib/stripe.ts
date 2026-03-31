import { getEnvVariable } from '@/lib/dotenvx';
import 'server-only'; // This file imports the database and can therefore only be used on the server side.
import Stripe from 'stripe';
import { client } from './stripe-client';
import { captureException } from '@sentry/nextjs';
import { db, auto_deleted_at } from '@/lib/drizzle';
import type { User, PaymentMethod, Organization } from '@kilocode/db/schema';
import {
  kilo_pass_scheduled_changes,
  payment_methods,
  kilocode_users,
  auto_top_up_configs,
  organizations,
  kiloclaw_earlybird_purchases,
} from '@kilocode/db/schema';
import { and, eq, inArray, isNull, ne, not, or, sql } from 'drizzle-orm';
import { randomUUID } from 'crypto';
import type { FraudDetectionHeaders } from './utils';
import { EmptyFraudDetectionHeaders, toNonNullish } from './utils';
import { logExceptInTest, sentryLogger, warnExceptInTest } from '@/lib/utils.server';
import { APP_URL } from './constants';
import {
  AUTO_TOP_UP_THRESHOLD_DOLLARS,
  DEFAULT_ORG_AUTO_TOP_UP_AMOUNT_CENTS,
  SYSTEM_AUTO_TOP_UP_USER_ID,
} from './autoTopUpConstants';
import { findUserByStripeCustomerId } from './user';
import type { UnifiedInvoice } from '@/types/billing';
import type { StripeConfig } from '@/lib/credits';
import { processTopUp } from '@/lib/credits';
import { processTopupForOrganization } from '@/lib/organizations/organization-billing';
import {
  STRIPE_SUB_QUERY_STRING_KEY,
  TOPUP_CANCELED_QUERY_STRING_KEY,
} from '@/lib/organizations/constants';
import type { SubscriptionMetadata } from '@/lib/organizations/organization-seats';
import { handleSubscriptionEvent } from '@/lib/organizations/organization-seats';
import {
  handleKiloPassInvoicePaid,
  handleKiloPassSubscriptionEvent,
} from '@/lib/kilo-pass/stripe-handlers';
import {
  KiloPassAuditLogAction,
  KiloPassAuditLogResult,
  KiloPassScheduledChangeStatus,
} from '@/lib/kilo-pass/enums';
import { appendKiloPassAuditLog } from '@/lib/kilo-pass/issuance';
import { maybeMapStripeScheduleStatusToDb } from '@/lib/kilo-pass/scheduled-change-release';
import { invoiceLooksLikeKiloPassByPriceId } from '@/lib/kilo-pass/stripe-invoice-classifier.server';
import {
  handleKiloClawSubscriptionCreated,
  handleKiloClawSubscriptionUpdated,
  handleKiloClawSubscriptionDeleted,
  handleKiloClawScheduleEvent,
  handleKiloClawInvoicePaid,
} from '@/lib/kiloclaw/stripe-handlers';
import { invoiceLooksLikeKiloClawByPriceId } from '@/lib/kiloclaw/stripe-invoice-classifier.server';
import {
  STRIPE_TEAMS_MONTHLY_PRICE_ID,
  STRIPE_TEAMS_ANNUAL_PRICE_ID,
  STRIPE_ENTERPRISE_MONTHLY_PRICE_ID,
  STRIPE_ENTERPRISE_ANNUAL_PRICE_ID,
} from '@/lib/config.server';
import type { OrganizationPlan, BillingCycle } from '@/lib/organizations/organization-types';
import { successResult } from '@/lib/maybe-result';
import { getRewardfulReferral } from '@/lib/rewardful';

if (!APP_URL) throw new Error('APP_URL constant is not set');

export async function isCardFingerprintEligibleForFreeCredits(
  fingerprint: string | null | undefined,
  kiloUserId: string
): Promise<boolean> {
  return (
    !!fingerprint &&
    (await db.query.payment_methods.findFirst({
      columns: { id: true },
      where: and(
        eq(payment_methods.stripe_fingerprint, fingerprint),
        ne(payment_methods.user_id, kiloUserId)
      ),
    })) === undefined
  );
}

export type StripeTopupMetadata = {
  type?: string;
  kiloUserId?: User['id'];
  organizationId?: Organization['id'] | null;
};

export async function detachAllPaymentMethods(user: User) {
  const paymentMethods = await client.paymentMethods.list({
    customer: user.stripe_customer_id,
    type: 'card',
  });

  await Promise.all(
    (paymentMethods?.data || []).map(async paymentMethod => {
      console.log(`Detaching payment method for user ${user.id}`, paymentMethod);
      await client.paymentMethods.detach(paymentMethod.id);
    })
  );

  // Also clear auto-top-up settings
  await db
    .update(kilocode_users)
    .set({
      auto_top_up_enabled: false,
    })
    .where(eq(kilocode_users.id, user.id));

  await db.delete(auto_top_up_configs).where(eq(auto_top_up_configs.owned_by_user_id, user.id));
}

export async function ensurePaymentMethodStored(
  kiloUserId: string,
  paymentMethod: Stripe.PaymentMethod,
  headers: FraudDetectionHeaders = EmptyFraudDetectionHeaders,
  organizationId?: Organization['id']
): Promise<PaymentMethod | null> {
  const { http_user_agent: _http_user_agent, ...headersWithoutUserAgent } = headers;

  const currentPaymentMethod = await db.query.payment_methods.findFirst({
    where: and(
      eq(payment_methods.user_id, kiloUserId),
      eq(payment_methods.stripe_id, paymentMethod.id),
      organizationId ? eq(payment_methods.organization_id, organizationId) : undefined
    ), // ... but explicitly DON'T check deleted_at
  });

  if (currentPaymentMethod) {
    // Update with concurrency check using timestamp range; and some fuzziness likely due to JS date inaccuracy
    const updated_at_ms = new Date(currentPaymentMethod.updated_at).getTime();
    const updateResult = await db
      .update(payment_methods)
      .set({
        ...headersWithoutUserAgent,
        ...asDbPaymentMethodProps(paymentMethod),
        deleted_at: null,
      })
      .where(
        and(
          eq(payment_methods.id, currentPaymentMethod.id),
          sql`tstzrange(${new Date(updated_at_ms - 10).toISOString()}, ${new Date(updated_at_ms + 10).toISOString()}, '[]') @> updated_at`
        )
      )
      .returning();

    if (updateResult.length !== 1)
      throw new Error(
        `Failed to update payment method for user ${kiloUserId} with id ${currentPaymentMethod.id}; CONCURRENT UPDATE DETECTED!`
      );

    return updateResult[0];
  }

  // Check if fingerprint exists for other users
  const eligible_for_free_credits = await isCardFingerprintEligibleForFreeCredits(
    paymentMethod.card?.fingerprint,
    kiloUserId
  );

  const newPaymentMethod = {
    id: randomUUID(),
    ...headersWithoutUserAgent,
    ...asDbPaymentMethodProps(paymentMethod),
    user_id: kiloUserId,
    eligible_for_free_credits: eligible_for_free_credits,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    deleted_at: null,
    organization_id: organizationId ?? null, // Allow organization_id to be optional
  };

  try {
    await db.insert(payment_methods).values(newPaymentMethod);
    logExceptInTest(
      'Payment method attached and saved for ' +
        kiloUserId +
        'with fingerprint ' +
        newPaymentMethod.stripe_fingerprint
    );
    return newPaymentMethod;
  } catch (error) {
    const context = {
      tags: { source: 'stripe_payment_method_storage' },
      extra: { kiloUserId, paymentMethod, organizationId },
    };
    captureException(error, context);
    if (process.env.NODE_ENV !== 'test')
      console.error('Error saving payment method for user ' + kiloUserId, error, context);
    return null;
  }
}

function asDbPaymentMethodProps(paymentMethod: Stripe.PaymentMethod) {
  return {
    stripe_data: paymentMethod,
    stripe_fingerprint: paymentMethod.card?.fingerprint ?? null,
    stripe_id: paymentMethod.id,
    type: paymentMethod.type,
    last4: paymentMethod.card?.last4 ?? null,
    brand: paymentMethod.card?.brand ?? null,
    three_d_secure_supported: paymentMethod.card?.three_d_secure_usage?.supported ?? null,
    funding: paymentMethod.card?.funding ?? null,
    regulated_status: paymentMethod.card?.regulated_status ?? null,
    address_line1_check_status: paymentMethod.card?.checks?.address_line1_check ?? null,
    postal_code_check_status: paymentMethod.card?.checks?.address_postal_code_check ?? null,
    name: paymentMethod.billing_details?.name ?? null,
    address_line1: paymentMethod.billing_details?.address?.line1 ?? null,
    address_line2: paymentMethod.billing_details?.address?.line2 ?? null,
    address_city: paymentMethod.billing_details?.address?.city ?? null,
    address_state: paymentMethod.billing_details?.address?.state ?? null,
    address_zip: paymentMethod.billing_details?.address?.postal_code ?? null,
    address_country: paymentMethod.billing_details?.address?.country ?? null,
  } satisfies Omit<typeof payment_methods.$inferInsert, 'user_id' | 'organization_id'>;
}

/**
 * Finds a User by their Stripe customer ID if the customer field is a string
 * @param customer - The customer field from a Stripe object (could be string or Stripe.Customer object)
 * @returns Promise<User | null> - The user if found, null otherwise
 */
async function findUserByStripeCustomer(
  customer: string | Stripe.Customer | Stripe.DeletedCustomer | null
): Promise<User | null> {
  if (typeof customer !== 'string') {
    return null;
  }

  return (
    (await db.query.kilocode_users.findFirst({
      where: eq(kilocode_users.stripe_customer_id, customer),
    })) || null
  );
}

/**
 * Handles the initial auto-top-up setup charge.
 * Saves the payment method, enables auto-top-up, and credits the initial payment.
 */
async function handleAutoTopUpSetup(
  user: User,
  paymentIntent: Stripe.PaymentIntent,
  creditAmountInCents: number,
  config: StripeConfig
) {
  logExceptInTest(
    `Processing auto-topup-setup for user ${user.id} from payment intent ${paymentIntent.id}`
  );

  // Save the payment method for future auto-top-ups
  const paymentMethodId =
    typeof paymentIntent.payment_method === 'string'
      ? paymentIntent.payment_method
      : paymentIntent.payment_method?.id;

  if (!paymentMethodId) {
    sentryLogger('stripe', 'error')(
      'Missing auto top-up payment method despite setup_future_usage: "off_session"',
      {
        kilo_user_id: user.id,
        paymentIntent,
        ...config,
      }
    );
    throw new Error('Missing auto top-up payment method despite setup_future_usage: "off_session"');
  }

  const amountCents = paymentIntent.metadata.amountCents
    ? parseInt(paymentIntent.metadata.amountCents, 10)
    : 5000;

  await db
    .insert(auto_top_up_configs)
    .values({
      owned_by_user_id: user.id,
      stripe_payment_method_id: paymentMethodId,
      amount_cents: amountCents,
      disabled_reason: null,
    })
    .onConflictDoUpdate({
      target: auto_top_up_configs.owned_by_user_id,
      set: {
        stripe_payment_method_id: paymentMethodId,
        amount_cents: amountCents,
        disabled_reason: null,
      },
      // `owned_by_user_id` uniqueness is enforced by a partial unique index.
      // Include the predicate so Postgres can match the conflict target.
      targetWhere: sql`${auto_top_up_configs.owned_by_user_id} IS NOT NULL`,
    });

  // Enable auto-top-up for the user
  await db
    .update(kilocode_users)
    .set({
      auto_top_up_enabled: true,
    })
    .where(eq(kilocode_users.id, user.id));

  // Credit the initial payment to the user's balance
  const setupTopUpOk = await processTopUp(user, creditAmountInCents, config);
  if (!setupTopUpOk) {
    sentryLogger('stripe', 'info')('Auto-topup-setup already registered or failed to insert', {
      kilo_user_id: user.id,
      ...config,
    });
  }
}

async function handleOrgAutoTopUpSetup(
  organizationId: string,
  kiloUserId: string,
  paymentIntent: Stripe.PaymentIntent,
  config: StripeConfig
) {
  logExceptInTest(
    `Processing org-auto-topup-setup for organization ${organizationId} from payment intent ${paymentIntent.id}`
  );

  const paymentMethodId =
    typeof paymentIntent.payment_method === 'string'
      ? paymentIntent.payment_method
      : paymentIntent.payment_method?.id;

  if (!paymentMethodId) {
    sentryLogger('stripe', 'error')(
      'Missing org auto top-up payment method despite setup_future_usage: "off_session"',
      {
        organizationId,
        paymentIntent,
        ...config,
      }
    );
    return;
  }

  const amountCents = paymentIntent.metadata.amountCents
    ? parseInt(paymentIntent.metadata.amountCents, 10)
    : DEFAULT_ORG_AUTO_TOP_UP_AMOUNT_CENTS;

  await db
    .insert(auto_top_up_configs)
    .values({
      owned_by_organization_id: organizationId,
      stripe_payment_method_id: paymentMethodId,
      amount_cents: amountCents,
      disabled_reason: null,
      created_by_user_id: kiloUserId,
    })
    .onConflictDoUpdate({
      target: auto_top_up_configs.owned_by_organization_id,
      set: {
        stripe_payment_method_id: paymentMethodId,
        amount_cents: amountCents,
        disabled_reason: null,
        created_by_user_id: kiloUserId,
      },
      targetWhere: sql`${auto_top_up_configs.owned_by_organization_id} IS NOT NULL`,
    });

  await db
    .update(organizations)
    .set({
      auto_top_up_enabled: true,
    })
    .where(eq(organizations.id, organizationId));
}

async function handleSuccessfulCharge(event: Stripe.ChargeSucceededEvent) {
  const paymentIntentUnion = toNonNullish(event.data.object.payment_intent);
  const paymentIntent =
    typeof paymentIntentUnion === 'string'
      ? await client.paymentIntents.retrieve(paymentIntentUnion, { expand: ['payment_method'] })
      : paymentIntentUnion;

  return await handleSuccessfulChargeWithPayment(event.data.object, paymentIntent);
}

export async function handleSuccessfulChargeWithPayment(
  charge: Stripe.Charge,
  paymentIntent: Stripe.PaymentIntent
) {
  // NOTE: (bmc) PLEASE NOTE this is called for ALL successful charges, including subscriptions and org purchases
  // the user topup flow and credit application stuff should only apply the charge is not from an organization
  const config: StripeConfig = { type: 'stripe', stripe_payment_id: charge.id };
  const creditAmountInCents = charge.amount;

  const organizationId = paymentIntent.metadata.organizationId;
  const kiloUserId = paymentIntent.metadata.kiloUserId;

  // process organization top-ups if its an org toup first as the flow is much less complex
  if (organizationId) {
    if (!kiloUserId) {
      sentryLogger('stripe', 'warning')('Org top-up missing kiloUserId in PaymentIntent metadata', {
        payment_intent_id: paymentIntent.id,
        charge_id: charge.id,
        metadata: paymentIntent.metadata,
      });
      return;
    }
    logExceptInTest(
      `Processing top-up for organization ${organizationId} from charge ${charge.id}`
    );
    config.stripe_payment_id = paymentIntent.id;
    await processTopupForOrganization(kiloUserId, organizationId, creditAmountInCents, config);

    if (paymentIntent.metadata.type === 'org-auto-topup-setup') {
      await handleOrgAutoTopUpSetup(organizationId, kiloUserId, paymentIntent, config);
    }

    // Save payment method for organization (for future auto-top-ups)
    const paymentMethodId =
      typeof paymentIntent.payment_method === 'string'
        ? paymentIntent.payment_method
        : paymentIntent.payment_method?.id;
    if (paymentMethodId) {
      const paymentMethod = await client.paymentMethods.retrieve(paymentMethodId);
      await ensurePaymentMethodStored(
        kiloUserId,
        paymentMethod,
        EmptyFraudDetectionHeaders,
        organizationId
      );
    }
    return;
  }
  const user = await findUserByStripeCustomerId(charge.customer as string);
  if (!user) {
    warnExceptInTest(
      `No user found for charge ${charge.id} with customer ID ${charge.customer as string}. Skipping processing.`,
      paymentIntent,
      charge
    );
    return;
  }

  // If this charge did not originate from our stripe-checkout-powered top-up flow,
  // check if it's an auto-topup-setup.
  if (!paymentIntent || paymentIntent.metadata.type !== 'stripe-checkout-topup') {
    // Auto-topup-setup is the initial $15 charge when user enables auto-top-up
    const isAutoTopUpSetup = paymentIntent?.metadata?.type === 'auto-topup-setup';

    // KiloClaw earlybird purchases are handled separately - not a credit top-up
    const isKiloclawEarlybird = paymentIntent?.metadata?.type === 'kiloclaw-earlybird';

    // Invoice-based auto-top-ups are handled by `invoice.payment_succeeded` webhook,
    // which has direct access to invoice metadata. Skip them here to avoid duplicate processing.
    const invoiceId =
      'invoice' in charge && typeof charge.invoice === 'string' ? charge.invoice : null;

    if (invoiceId) {
      // This charge is from an invoice payment. Auto-top-ups are handled by
      // `invoice.payment_succeeded` which has direct access to invoice metadata.
      // Skip processing here to avoid duplicate credit application.
      logExceptInTest(
        `Skipping invoice-based charge ${charge.id} in charge.succeeded - will be handled by invoice.payment_succeeded`
      );
    } else if (isAutoTopUpSetup) {
      await handleAutoTopUpSetup(user, paymentIntent, creditAmountInCents, config);
    } else if (isKiloclawEarlybird) {
      await recordKiloclawEarlybirdPurchase(user, charge);
    } else {
      // Unknown charge type - log warning but don't process
      warnExceptInTest(
        'Unknown charge type (not stripe-checkout-topup, not auto-topup-setup). Ignoring.',
        charge.customer,
        charge,
        paymentIntent
      );
    }
    return;
  }

  const topUpOk = await processTopUp(user, creditAmountInCents, config);
  if (!topUpOk) {
    sentryLogger('stripe', 'warning')('Ignoring already registered top-up', {
      kilo_user_id: user.id,
      ...config,
    });
  }
}

async function recordKiloclawEarlybirdPurchase(user: User, charge: Stripe.Charge) {
  const result = await db
    .insert(kiloclaw_earlybird_purchases)
    .values({
      user_id: user.id,
      stripe_charge_id: charge.id,
      amount_cents: charge.amount,
    })
    .onConflictDoNothing()
    .returning({ id: kiloclaw_earlybird_purchases.id });

  if (result.length > 0) {
    logExceptInTest(
      `Recorded kiloclaw-earlybird purchase for user ${user.id}, charge ${charge.id}`
    );
  } else {
    logExceptInTest(
      `Duplicate kiloclaw-earlybird charge skipped for user ${user.id}, charge ${charge.id}`
    );
  }
}

export async function getStripeInvoices(
  stripeCustomerId: string,
  dateThreshold?: Date | null
): Promise<UnifiedInvoice[]> {
  const listParams: Stripe.InvoiceListParams = {
    customer: stripeCustomerId,
    limit: 100,
    expand: ['data.payment_intent', 'data.lines.data'],
  };

  if (dateThreshold) {
    listParams.created = {
      gte: Math.floor(dateThreshold.getTime() / 1000), // Convert to Unix timestamp
    };
  }

  const invoices = await client.invoices.list(listParams);
  const invoiceData: Stripe.Invoice[] = invoices.data;

  return invoiceData.map(invoice => {
    // Classify as 'seats' if any line item has seats metadata or a known paid seat price ID
    const isSeatInvoice =
      invoice.lines?.data?.some(line => {
        const hasSeatsMetadata =
          line.metadata != null && Object.prototype.hasOwnProperty.call(line.metadata, 'seats');
        const priceId = line.pricing?.price_details?.price;
        const hasSeatPriceId = priceId != null && KNOWN_SEAT_PRICE_IDS.has(priceId);
        return hasSeatsMetadata || hasSeatPriceId;
      }) ?? false;

    const firstLineDescription = invoice.lines?.data?.[0]?.description || null;

    return {
      id: invoice.id || '',
      number: invoice.number,
      status: invoice.status || 'unknown',
      amount_due: invoice.amount_due || 0,
      currency: invoice.currency || 'usd',
      created: invoice.created || 0,
      hosted_invoice_url: invoice.hosted_invoice_url || null,
      invoice_pdf: invoice.invoice_pdf || null,
      invoice_type: isSeatInvoice ? 'seats' : 'topup',
      description: firstLineDescription,
    };
  });
}

async function handlePaymentMethodEvent(
  event:
    | Stripe.PaymentMethodAttachedEvent
    | Stripe.PaymentMethodDetachedEvent
    | Stripe.PaymentMethodUpdatedEvent
) {
  const paymentMethod = event.data.object;
  const user = await findUserByStripeCustomer(paymentMethod.customer);
  if (process.env.NODE_ENV !== 'test') console.log(event.type, user?.id, paymentMethod);

  if (!user) return;

  if (event.type === 'payment_method.detached') {
    // Soft delete using Drizzle - set deleted_at timestamp
    await db
      .update(payment_methods)
      .set({ ...auto_deleted_at })
      .where(
        and(eq(payment_methods.stripe_id, paymentMethod.id), eq(payment_methods.user_id, user.id))
      );
  } else {
    await ensurePaymentMethodStored(user.id, paymentMethod);
  }
}

type AutoTopUpOwner = { type: 'user'; id: string } | { type: 'organization'; id: string };

async function releaseAutoTopUpAttemptLock(owner: AutoTopUpOwner): Promise<void> {
  if (owner.type === 'user') {
    await db
      .update(auto_top_up_configs)
      .set({ attempt_started_at: null })
      .where(eq(auto_top_up_configs.owned_by_user_id, owner.id));
    return;
  }

  await db
    .update(auto_top_up_configs)
    .set({ attempt_started_at: null })
    .where(eq(auto_top_up_configs.owned_by_organization_id, owner.id));
}

async function markAutoTopUpCompleted(owner: AutoTopUpOwner): Promise<void> {
  if (owner.type === 'user') {
    await db
      .update(auto_top_up_configs)
      .set({ last_auto_top_up_at: sql`NOW()`, attempt_started_at: null })
      .where(eq(auto_top_up_configs.owned_by_user_id, owner.id));
    return;
  }

  await db
    .update(auto_top_up_configs)
    .set({ last_auto_top_up_at: sql`NOW()`, attempt_started_at: null })
    .where(eq(auto_top_up_configs.owned_by_organization_id, owner.id));
}

export async function processStripePaymentEventHook(event: Stripe.Event) {
  switch (event.type) {
    case 'checkout.session.completed':
      // no handling necessary now that we removed the hold
      break;

    // charge.succeeded is for one-time payments, like top-ups
    // this also actually gets called when the user first purchases a subscription as well
    case 'charge.succeeded':
      await handleSuccessfulCharge(event);
      break;

    // Handle auto-topups via invoice.paid - this has direct access to invoice metadata.
    // invoice.paid is a superset of invoice.payment_succeeded per Stripe docs.
    case 'invoice.paid': {
      const invoice = event.data.object;

      // Kilo Pass invoice.paid events should be routed to the Kilo Pass handler first.
      // If it is a Kilo Pass invoice, no other invoice.paid handler should run.
      const isKiloPassByPriceId = invoiceLooksLikeKiloPassByPriceId(invoice);

      if (isKiloPassByPriceId) {
        await handleKiloPassInvoicePaid({ eventId: event.id, invoice, stripe: client });
        break;
      }

      if (invoiceLooksLikeKiloClawByPriceId(invoice) && invoice.amount_paid > 0) {
        await handleKiloClawInvoicePaid({ eventId: event.id, invoice });
        break;
      }

      // Handle auto-topup (user or organization)
      const isUserAutoTopup = invoice.metadata?.type === 'auto-topup';
      const isOrgAutoTopup = invoice.metadata?.type === 'org-auto-topup';

      if (isUserAutoTopup || isOrgAutoTopup) {
        const chargeId =
          'charge' in invoice && typeof invoice.charge === 'string' ? invoice.charge : null;
        if (!chargeId) break;

        const config: StripeConfig = { type: 'stripe', stripe_payment_id: chargeId };

        if (isUserAutoTopup) {
          const kiloUserId = invoice.metadata?.kiloUserId;
          if (!kiloUserId) break;

          const user = await db.query.kilocode_users.findFirst({
            where: eq(kilocode_users.id, kiloUserId),
          });
          if (!user) break;

          const traceId = invoice.metadata?.traceId ?? event.id;
          let processedSuccessfully = false;

          try {
            logExceptInTest(`Processing auto top-up for user ${user.id}`, {
              invoice_id: invoice.id,
              charge_id: chargeId,
              amount_paid: invoice.amount_paid,
              traceId,
            });

            const autoTopUpOk = await processTopUp(user, invoice.amount_paid, config, {
              isAutoTopUp: true,
            });

            if (!autoTopUpOk) {
              sentryLogger('stripe', 'info')('Auto top-up already registered (invoice fallback)', {
                kilo_user_id: user.id,
                invoice_id: invoice.id,
                charge_id: chargeId,
                traceId,
              });
            }

            processedSuccessfully = true;
          } catch (error) {
            sentryLogger('stripe', 'error')('Auto top-up webhook processing failed for user', {
              invoice_id: invoice.id,
              charge_id: chargeId,
              kilo_user_id: user.id,
              traceId,
              type: 'auto-topup',
              error: error instanceof Error ? error.message : String(error),
            });
            throw error;
          } finally {
            try {
              if (processedSuccessfully) {
                await markAutoTopUpCompleted({ type: 'user', id: user.id });
              } else {
                await releaseAutoTopUpAttemptLock({ type: 'user', id: user.id });
              }
            } catch (lockError) {
              captureException(lockError);
            }
          }
        } else {
          const organizationId = invoice.metadata?.organizationId;
          if (!organizationId) break;

          const traceId = invoice.metadata?.traceId ?? event.id;
          let processedSuccessfully = false;

          try {
            logExceptInTest(`Processing org auto top-up for organization ${organizationId}`, {
              invoice_id: invoice.id,
              charge_id: chargeId,
              amount_paid: invoice.amount_paid,
              traceId,
            });

            const autoTopUpConfig = await db.query.auto_top_up_configs.findFirst({
              where: eq(auto_top_up_configs.owned_by_organization_id, organizationId),
              columns: { created_by_user_id: true },
            });

            await processTopupForOrganization(
              autoTopUpConfig?.created_by_user_id ?? SYSTEM_AUTO_TOP_UP_USER_ID,
              organizationId,
              invoice.amount_paid,
              config
            );

            processedSuccessfully = true;
          } catch (error) {
            sentryLogger('stripe', 'error')(
              'Auto top-up webhook processing failed for organization',
              {
                invoice_id: invoice.id,
                charge_id: chargeId,
                organization_id: organizationId,
                traceId,
                type: 'org-auto-topup',
                error: error instanceof Error ? error.message : String(error),
              }
            );
            throw error;
          } finally {
            try {
              if (processedSuccessfully) {
                await markAutoTopUpCompleted({ type: 'organization', id: organizationId });
              } else {
                await releaseAutoTopUpAttemptLock({ type: 'organization', id: organizationId });
              }
            } catch (lockError) {
              captureException(lockError);
            }
          }
        }
        break;
      }

      break;
    }

    // invoice.payment_succeeded is for subscriptions
    case 'customer.subscription.created': {
      const createdSubType = event.data.object.metadata?.type;
      if (createdSubType === 'kilo-pass') {
        await handleKiloPassSubscriptionEvent({
          eventId: event.id,
          eventType: event.type,
          subscription: event.data.object,
        });
        break;
      }

      if (createdSubType === 'kiloclaw') {
        await handleKiloClawSubscriptionCreated({
          eventId: event.id,
          subscription: event.data.object,
        });
        break;
      }

      // Only dispatch to seat handler for recognized seat subscription types
      if (
        createdSubType === 'seats' ||
        createdSubType === 'stripe-checkout-seats' ||
        createdSubType === 'organization_seats'
      ) {
        await handleSubscriptionEvent(
          event.data.object,
          event.request?.idempotency_key ?? event.id,
          true
        );
      } else {
        warnExceptInTest(
          `Unrecognized subscription metadata type "${createdSubType}" for subscription ${event.data.object.id}, discarding`
        );
      }
      break;
    }
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted': {
      const updatedSubType = event.data.object.metadata?.type;
      if (updatedSubType === 'kilo-pass') {
        await handleKiloPassSubscriptionEvent({
          eventId: event.id,
          eventType: event.type,
          subscription: event.data.object,
        });
        break;
      }

      if (updatedSubType === 'kiloclaw') {
        if (event.type === 'customer.subscription.deleted') {
          await handleKiloClawSubscriptionDeleted({
            eventId: event.id,
            subscription: event.data.object,
          });
        } else {
          await handleKiloClawSubscriptionUpdated({
            eventId: event.id,
            subscription: event.data.object,
          });
        }
        break;
      }

      if (
        updatedSubType === 'seats' ||
        updatedSubType === 'stripe-checkout-seats' ||
        updatedSubType === 'organization_seats'
      ) {
        await handleSubscriptionEvent(
          event.data.object,
          event.request?.idempotency_key ?? event.id
        );
      } else {
        warnExceptInTest(
          `Unrecognized subscription metadata type "${updatedSubType}" for subscription ${event.data.object.id}, discarding`
        );
      }
      break;
    }

    case 'payment_method.detached':
    case 'payment_method.updated':
    case 'payment_method.attached': {
      await handlePaymentMethodEvent(event);
      break;
    }

    case 'subscription_schedule.updated': {
      const schedule = event.data.object;

      // Try KiloClaw schedule handling first
      await handleKiloClawScheduleEvent({
        eventId: event.id,
        schedule,
      });
      // Note: handleKiloClawScheduleEvent returns silently if the schedule
      // doesn't belong to a KiloClaw subscription (no matching stripe_schedule_id)

      const scheduleId = schedule.id;
      const scheduleStatus = schedule.status;
      const shouldDeleteFromStatus =
        scheduleStatus === 'released' ||
        scheduleStatus === 'canceled' ||
        scheduleStatus === 'completed';

      const scheduleStatusForDb = maybeMapStripeScheduleStatusToDb(scheduleStatus);
      if (scheduleStatusForDb === null) {
        await appendKiloPassAuditLog(db, {
          action: KiloPassAuditLogAction.StripeWebhookReceived,
          result: KiloPassAuditLogResult.Failed,
          stripeEventId: event.id,
          payload: {
            scope: 'kilo_pass_scheduled_change',
            type: 'subscription_schedule.updated',
            scheduleId,
            scheduleStatus,
            reason: 'unrecognized_schedule_status',
          },
        });
        return;
      }

      await db.transaction(async tx => {
        const previousStatus = event.data.previous_attributes?.['status'];
        const terminalStatuses = [
          KiloPassScheduledChangeStatus.Released,
          KiloPassScheduledChangeStatus.Canceled,
          KiloPassScheduledChangeStatus.Completed,
        ] as const;

        const softDeleteUpdate = shouldDeleteFromStatus ? auto_deleted_at : {};
        const updatedRows = await tx
          .update(kilo_pass_scheduled_changes)
          .set({ status: scheduleStatusForDb, ...softDeleteUpdate })
          .where(
            and(
              eq(kilo_pass_scheduled_changes.stripe_schedule_id, scheduleId),
              // Only touch the active row.
              isNull(kilo_pass_scheduled_changes.deleted_at),
              // Prevent status regressions once we hit a terminal status.
              // (Still allows idempotent replays of the same terminal status.)
              or(
                not(inArray(kilo_pass_scheduled_changes.status, terminalStatuses)),
                eq(kilo_pass_scheduled_changes.status, scheduleStatusForDb)
              )
            )
          )
          .returning({
            id: kilo_pass_scheduled_changes.id,
            kilo_user_id: kilo_pass_scheduled_changes.kilo_user_id,
            stripe_subscription_id: kilo_pass_scheduled_changes.stripe_subscription_id,
          });

        const row = updatedRows[0];
        if (!row) {
          await appendKiloPassAuditLog(tx, {
            action: KiloPassAuditLogAction.StripeWebhookReceived,
            result: KiloPassAuditLogResult.SkippedIdempotent,
            stripeEventId: event.id,
            payload: {
              scope: 'kilo_pass_scheduled_change',
              type: 'subscription_schedule.updated',
              scheduleId,
              scheduleStatus,
              reason: 'scheduled_change_not_found_or_already_terminal',
            },
          });
          return;
        }

        await appendKiloPassAuditLog(tx, {
          action: KiloPassAuditLogAction.StripeWebhookReceived,
          result: KiloPassAuditLogResult.Success,
          kiloUserId: row.kilo_user_id,
          stripeEventId: event.id,
          stripeSubscriptionId: row.stripe_subscription_id,
          payload: {
            scope: 'kilo_pass_scheduled_change',
            type: 'subscription_schedule.updated',
            scheduleId,
            scheduledChangeId: row.id,
            scheduleStatus,
            previousScheduleStatus: typeof previousStatus === 'string' ? previousStatus : null,
            scheduleStatusForDb,
            softDeleted: shouldDeleteFromStatus,
          },
        });
      });

      break;
    }

    default:
      warnExceptInTest('Unknown stripe event type:', event.type);
      break;
  }
}

/**
 * Creates a Stripe checkout session that:
 * 1. Performs an initial $15 top-up
 * 2. Saves the payment method for future off-session charges (auto-top-up)
 *
 * The key is `setup_future_usage: 'off_session'` which tells Stripe to save
 * the payment method for future charges without customer interaction.
 */
export async function createAutoTopUpSetupCheckoutSession(
  kiloUserId: string,
  stripeCustomerId: string,
  amountCents: number = 5000
): Promise<string | null> {
  const amountDollars = amountCents / 100;
  const rewardfulReferral = await getRewardfulReferral();

  const checkoutSession = await client.checkout.sessions.create({
    mode: 'payment',
    customer: stripeCustomerId,
    ...(rewardfulReferral && { client_reference_id: rewardfulReferral }),
    billing_address_collection: 'required',
    line_items: [
      {
        price_data: {
          currency: 'usd',
          product_data: {
            name: 'Credit Top-Up with Auto-Refill Setup',
            description: `Initial $${amountDollars} top-up. Your card will be saved for automatic $${amountDollars} top ups when balance drops below $${AUTO_TOP_UP_THRESHOLD_DOLLARS}.`,
          },
          unit_amount: amountCents,
        },
        quantity: 1,
      },
    ],
    invoice_creation: {
      enabled: true,
      invoice_data: {
        metadata: { rewardful: 'false' },
      },
    },
    customer_update: {
      name: 'auto',
      address: 'auto',
    },
    tax_id_collection: {
      enabled: true,
      required: 'never',
    },
    success_url: `${APP_URL}/payments/auto-topup/success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${APP_URL}/profile?auto_topup_setup=cancelled`,
    payment_intent_data: {
      metadata: {
        type: 'auto-topup-setup',
        kiloUserId,
        amountCents: String(amountCents),
      },
      // KEY CONFIGURATION: This saves the payment method for future off-session charges
      setup_future_usage: 'off_session',
    },
  });

  return typeof checkoutSession.url === 'string' ? checkoutSession.url : null;
}

export async function getStripeTopUpCheckoutUrl(
  kiloUserId: User['id'],
  stripeCustomerId: User['stripe_customer_id'],
  amount: number,
  origin: string = 'web',
  organizationId?: string | null,
  /** Optional internal path to redirect to when the user cancels checkout. */
  cancelPath?: string | null
): Promise<string | null> {
  const line_items = amount
    ? [
        {
          price_data: {
            currency: 'usd',
            product_data: {
              name: 'Kilo Balance Top Up',
            },
            unit_amount: Math.round(amount * 100), // Convert dollars to cents
          },
          quantity: 1,
        },
      ]
    : [
        {
          price: getEnvVariable('STRIPE_TOP_UP_PRICE_ID'),
          quantity: 1,
        },
      ];

  const isOrganizationTopUp = Boolean(organizationId);
  let cancelUrl: string;
  if (cancelPath) {
    cancelUrl = `${APP_URL}${cancelPath}`;
  } else if (isOrganizationTopUp) {
    cancelUrl = `${APP_URL}/organizations/${organizationId}?${TOPUP_CANCELED_QUERY_STRING_KEY}=true`;
  } else {
    cancelUrl = `${APP_URL}/profile?payment_status=topup_cancelled&origin=${origin}`;
  }

  const rewardfulReferral = await getRewardfulReferral();

  const checkoutSession = await client.checkout.sessions.create({
    mode: 'payment',
    customer: stripeCustomerId,
    ...(rewardfulReferral && { client_reference_id: rewardfulReferral }),
    billing_address_collection: 'required',
    line_items: line_items,
    invoice_creation: {
      enabled: true,
      invoice_data: {
        metadata: { rewardful: 'false' },
      },
    },
    customer_update: {
      name: 'auto',
      address: 'auto',
    },
    tax_id_collection: {
      enabled: true,
      required: 'never',
    },
    success_url: `${APP_URL}/payments/topup/success?session_id={CHECKOUT_SESSION_ID}&origin=${origin}`,
    cancel_url: cancelUrl,
    payment_intent_data: {
      metadata: {
        type: 'stripe-checkout-topup',
        kiloUserId,
        organizationId: organizationId ?? null,
      } satisfies StripeTopupMetadata,
    },
    saved_payment_method_options: {
      payment_method_save: 'enabled',
    },
  });

  const url: string | null = typeof checkoutSession.url === 'string' ? checkoutSession.url : null;
  return url;
}

export async function getSubscriptionsForStripeCustomerId(
  customerId: string
): Promise<Stripe.Subscription[]> {
  const subscriptions = await client.subscriptions.list({
    customer: customerId,
  });

  const subscriptionData: Stripe.Subscription[] = subscriptions.data;
  return subscriptionData;
}

type GetStripeCheckoutUrlProps = {
  kiloUserId: User['id'];
  stripeCustomerId: User['stripe_customer_id'];
  quantity: number;
  organizationId: string;
  cancelUrl: string;
  plan: OrganizationPlan;
  billingCycle: BillingCycle;
};

const assertNever = (x: never): never => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  throw new Error('Unexpected object: ' + (x as any));
};

export function getPriceIdForPlanAndCycle(
  plan: OrganizationPlan,
  billingCycle: BillingCycle
): string {
  switch (plan) {
    case 'teams':
      return billingCycle === 'monthly'
        ? STRIPE_TEAMS_MONTHLY_PRICE_ID
        : STRIPE_TEAMS_ANNUAL_PRICE_ID;
    case 'enterprise':
      return billingCycle === 'monthly'
        ? STRIPE_ENTERPRISE_MONTHLY_PRICE_ID
        : STRIPE_ENTERPRISE_ANNUAL_PRICE_ID;
    default:
      return assertNever(plan);
  }
}

/** All known paid seat price IDs across plans and billing cycles. */
export const KNOWN_SEAT_PRICE_IDS = new Set([
  STRIPE_TEAMS_MONTHLY_PRICE_ID,
  STRIPE_TEAMS_ANNUAL_PRICE_ID,
  STRIPE_ENTERPRISE_MONTHLY_PRICE_ID,
  STRIPE_ENTERPRISE_ANNUAL_PRICE_ID,
]);

/** Derive the plan tier from a Stripe price ID. Returns null for unknown prices. */
export function getPlanForPriceId(priceId: string): OrganizationPlan | null {
  if (priceId === STRIPE_TEAMS_MONTHLY_PRICE_ID || priceId === STRIPE_TEAMS_ANNUAL_PRICE_ID) {
    return 'teams';
  }
  if (
    priceId === STRIPE_ENTERPRISE_MONTHLY_PRICE_ID ||
    priceId === STRIPE_ENTERPRISE_ANNUAL_PRICE_ID
  ) {
    return 'enterprise';
  }
  return null;
}

export async function getStripeSeatsCheckoutUrl(
  props: GetStripeCheckoutUrlProps
): Promise<string | null> {
  const { kiloUserId, stripeCustomerId, quantity, organizationId, cancelUrl, plan, billingCycle } =
    props;

  const subscriptionMetadata: SubscriptionMetadata = {
    type: 'seats',
    kiloUserId,
    organizationId,
    seats: quantity,
    planType: plan,
  };

  try {
    const priceId = getPriceIdForPlanAndCycle(plan, billingCycle);

    const line_items = [
      {
        price: priceId,
        quantity,
      },
    ];

    const successUrl = `${process.env.NEXTAUTH_URL}/payments/subscriptions/success?organizationId=${organizationId}&${STRIPE_SUB_QUERY_STRING_KEY}={CHECKOUT_SESSION_ID}`;
    const rewardfulReferral = await getRewardfulReferral();

    const checkoutSession = await client.checkout.sessions.create({
      mode: 'subscription',
      customer: stripeCustomerId,
      ...(rewardfulReferral && { client_reference_id: rewardfulReferral }),
      allow_promotion_codes: true,
      billing_address_collection: 'required',
      line_items: line_items,
      customer_update: {
        name: 'auto',
        address: 'auto',
      },
      tax_id_collection: {
        enabled: true,
        required: 'never',
      },
      success_url: successUrl,
      cancel_url: cancelUrl,
      metadata: {
        isSubscription: 'yes',
      },
      subscription_data: {
        metadata: { ...subscriptionMetadata, rewardful: 'false' },
      },
    });

    const url: string | null = typeof checkoutSession.url === 'string' ? checkoutSession.url : null;
    return url;
  } catch (error) {
    console.error('Error creating Stripe checkout session for seats:', error);

    captureException(error, {
      tags: { source: 'stripe_seats_checkout' },
      extra: {
        kiloUserId,
        stripeCustomerId,
        quantity,
        organizationId,
      },
    });
    throw error;
  }
}

export async function retrieveSubscription(subscriptionId: string): Promise<Stripe.Subscription> {
  const subscription: Stripe.Subscription = await client.subscriptions.retrieve(subscriptionId, {
    expand: ['schedule'],
  });
  return subscription;
}

export async function handleStopCancellation(
  subscriptionStripeId: string
): Promise<{ success: boolean; message: string }> {
  const idempotencyKey = `sub-stop-cancel-${randomUUID()}`;

  const sub = await client.subscriptions.update(
    subscriptionStripeId,
    {
      cancel_at_period_end: false,
    },
    {
      idempotencyKey,
    }
  );

  // we can eagerly update our database here & not wait for webhook
  await handleSubscriptionEvent(sub, idempotencyKey);

  return successResult({
    message: 'Subscription cancellation has been stopped. Your subscription will continue.',
  });
}

export async function handleCancelSubscription(subscriptionStripeId: string) {
  // Try cancelling directly first. If the subscription has an attached schedule
  // Stripe may reject the update, in which case we release the schedule and
  // retry. This avoids silently dropping a pending billing-cycle change when
  // the cancel itself is the step that fails (Subscription Lifecycle 4).
  let idempotencyKey = `sub-cancel-${randomUUID()}`;
  let sub: Stripe.Subscription;
  try {
    sub = await client.subscriptions.update(
      subscriptionStripeId,
      { cancel_at_period_end: true },
      { idempotencyKey }
    );
  } catch (directCancelError) {
    // Release the schedule and retry. If there is no schedule the cancel
    // failed for an unrelated reason — rethrow immediately.
    const currentSub = await client.subscriptions.retrieve(subscriptionStripeId, {
      expand: ['schedule'],
    });
    if (!currentSub.schedule) {
      throw directCancelError;
    }
    const schedule =
      typeof currentSub.schedule === 'string'
        ? await client.subscriptionSchedules.retrieve(currentSub.schedule)
        : currentSub.schedule;
    if (schedule.status === 'active' || schedule.status === 'not_started') {
      await client.subscriptionSchedules.release(schedule.id);
    }
    idempotencyKey = `sub-cancel-${randomUUID()}`;
    sub = await client.subscriptions.update(
      subscriptionStripeId,
      { cancel_at_period_end: true },
      { idempotencyKey }
    );
  }

  // Cancel succeeded — release any remaining schedule so its phases
  // don't interfere with the pending cancellation.
  if (sub.schedule) {
    try {
      const scheduleId = typeof sub.schedule === 'string' ? sub.schedule : sub.schedule.id;
      await client.subscriptionSchedules.release(scheduleId);
    } catch {
      // Non-critical: the subscription is already set to cancel at period end
    }
  }

  // Eagerly update our database here and not wait for webhook
  await handleSubscriptionEvent(sub, idempotencyKey);
}

export type UpdateSeatCountResult = {
  success: boolean;
  message: string;
  requiresAction?: boolean;
  paymentIntentClientSecret?: string;
};

export async function handleUpdateSeatCount(
  subscriptionStripeId: string,
  newSeatCount: number,
  currentSeatCount: number
): Promise<UpdateSeatCountResult> {
  // Serialize concurrent seat modifications for the same subscription (Seat Count Modification 8).
  // Uses pg_advisory_xact_lock inside a transaction to guarantee the lock and all operations
  // share the same pooled connection. The lock auto-releases on commit/rollback.
  return await db.transaction(async tx => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${subscriptionStripeId}))`);

    const isIncreasingSeats = currentSeatCount < newSeatCount;
    const idempotencyKey = `sub-update-${randomUUID()}`;
    const subscription = await client.subscriptions.retrieve(subscriptionStripeId);

    // Find the paid seat item by known price ID, not blindly using items[0]
    // which could be a free-seat line item (Finding #5).
    const paidSeatItem = subscription.items.data.find(item =>
      KNOWN_SEAT_PRICE_IDS.has(item.price.id)
    );
    if (!paidSeatItem) {
      throw new Error(`No recognized paid seat item found in subscription ${subscriptionStripeId}`);
    }

    // Calculate the free seat count from non-paid items to preserve them
    const freeSeatCount = subscription.items.data
      .filter(item => !KNOWN_SEAT_PRICE_IDS.has(item.price.id))
      .reduce((total, item) => total + (item.quantity ?? 0), 0);

    // The requested newSeatCount is the desired total. Deduct free seats to get paid quantity.
    // The Stripe subscription must retain at least 1 paid seat (Stripe does not allow 0-quantity
    // line items). Reducing to 0 paid seats requires cancelling the subscription instead.
    const rawPaidQuantity = newSeatCount - freeSeatCount;
    if (rawPaidQuantity < 1) {
      throw new Error(
        `Cannot reduce paid seats below 1 (requested total: ${newSeatCount}, free seats: ${freeSeatCount}). Cancel the subscription to remove all paid seats.`
      );
    }
    const paidSeatQuantity = rawPaidQuantity;

    try {
      const updatedSubscription = await client.subscriptions.update(
        subscriptionStripeId,
        {
          proration_behavior: isIncreasingSeats ? 'always_invoice' : 'none',
          payment_behavior: isIncreasingSeats ? 'allow_incomplete' : undefined,
          // Only modify the paid seat item; free-seat items remain untouched.
          items: [
            {
              id: paidSeatItem.id,
              quantity: paidSeatQuantity,
            },
          ],
          expand: ['latest_invoice'],
        },
        {
          idempotencyKey,
        }
      );

      // Get the latest invoice
      const latestInvoice = updatedSubscription.latest_invoice;
      let invoiceObj: Stripe.Invoice | null =
        typeof latestInvoice === 'object' ? latestInvoice : null;

      let paymentIntent: Stripe.PaymentIntent | null = null;

      // If the invoice is open or draft, attempt to pay it to trigger PaymentIntent creation
      if (invoiceObj && (invoiceObj.status === 'open' || invoiceObj.status === 'draft')) {
        try {
          // Finalize if draft
          if (invoiceObj.status === 'draft') {
            invoiceObj = await client.invoices.finalizeInvoice(invoiceObj.id);
          }

          // Attempt to pay the invoice - this will create a PaymentIntent and attempt charge
          const paidInvoice = (await client.invoices.pay(invoiceObj.id, {
            expand: ['payment_intent'],
          })) as Stripe.Invoice & { payment_intent?: Stripe.PaymentIntent | string | null };

          if (typeof paidInvoice.payment_intent === 'object' && paidInvoice.payment_intent) {
            paymentIntent = paidInvoice.payment_intent;
          } else if (typeof paidInvoice.payment_intent === 'string') {
            paymentIntent = await client.paymentIntents.retrieve(paidInvoice.payment_intent);
          }
        } catch (payError) {
          // Invoice.pay() throws when payment fails (e.g., needs 3DS/SCA)
          // When this happens with subscriptions, Stripe may void the original invoice
          // and create a NEW invoice with the PaymentIntent that requires action.
          // We need to list recent invoices for the subscription and find the one
          // with a payment_intent in requires_action status.

          // List recent invoices for this subscription to find one with requires_action
          const recentInvoices = await client.invoices.list({
            subscription: subscriptionStripeId,
            limit: 5,
            expand: ['data.payment_intent'],
          });

          type InvoiceWithPaymentIntent = Stripe.Invoice & {
            payment_intent?: Stripe.PaymentIntent | string | null;
          };

          // Find an invoice with a payment_intent that requires action
          for (const inv of recentInvoices.data) {
            const invWithPi = inv as InvoiceWithPaymentIntent;
            const pi = invWithPi.payment_intent;
            if (typeof pi === 'object' && pi && pi.status === 'requires_action') {
              paymentIntent = pi;
              break;
            }
          }

          // If still not found, try listing PaymentIntents directly for the customer
          if (!paymentIntent) {
            // subscription.customer can be a string ID, expanded Customer object, or DeletedCustomer.
            // Extract the customer ID string regardless of the shape.
            const customerId =
              typeof subscription.customer === 'string'
                ? subscription.customer
                : subscription.customer?.id;

            if (customerId) {
              const paymentIntents = await client.paymentIntents.list({
                customer: customerId,
                limit: 5,
              });

              for (const pi of paymentIntents.data) {
                if (pi.status === 'requires_action') {
                  paymentIntent = pi;
                  break;
                }
              }
            }
          }

          // If we couldn't identify a requires_action payment intent, the invoice payment
          // failed for another reason (e.g., card declined, insufficient funds).
          // Re-throw to avoid falsely treating the seat update as successful.
          if (!paymentIntent || paymentIntent.status !== 'requires_action') {
            throw payError;
          }
        }
      }

      if (paymentIntent && paymentIntent.status === 'requires_action') {
        // 3DS authentication is required - return the client secret for frontend handling
        return {
          success: false,
          message:
            'Payment requires additional authentication. Please complete the verification process.',
          requiresAction: true,
          paymentIntentClientSecret: paymentIntent.client_secret ?? undefined,
        };
      }

      if (
        paymentIntent &&
        (paymentIntent.status === 'requires_payment_method' || paymentIntent.status === 'canceled')
      ) {
        // Payment failed for another reason
        throw new Error('Payment failed. Please update your payment method and try again.');
      }

      // immediately update our seats purchases - it will usually be updated again by the webhook
      // but this allows us to be immediately consistent
      await handleSubscriptionEvent(updatedSubscription, idempotencyKey);

      return {
        success: true,
        message: `Subscription updated to ${newSeatCount} seats successfully.`,
      };
    } catch (error) {
      // Handle 3DS authentication required errors
      // When a payment requires 3DS, Stripe throws an error with code
      // 'subscription_payment_intent_requires_action' or 'invoice_payment_intent_requires_action'

      // Check if this is a Stripe error that requires payment action
      const isStripeError = error instanceof Stripe.errors.StripeError;
      const stripeError = error as Stripe.errors.StripeError & {
        payment_intent?: Stripe.PaymentIntent;
        raw?: {
          payment_intent?: Stripe.PaymentIntent;
        };
      };
      const errorCode = isStripeError ? stripeError.code : undefined;

      // Check for either subscription or invoice requires_action errors
      const requires3DS =
        errorCode === 'subscription_payment_intent_requires_action' ||
        errorCode === 'invoice_payment_intent_requires_action';

      if (isStripeError && requires3DS) {
        // First, check if the error itself contains the PaymentIntent
        // Stripe may attach it directly to the error object
        if (stripeError.payment_intent && stripeError.payment_intent.status === 'requires_action') {
          return {
            success: false,
            message:
              'Payment requires additional authentication. Please complete the verification process.',
            requiresAction: true,
            paymentIntentClientSecret: stripeError.payment_intent.client_secret ?? undefined,
          };
        }

        // When the subscription update fails due to 3DS, Stripe creates a new invoice
        // but then rolls back the subscription. We need to find the pending/draft invoice
        // or the most recent invoice with a payment_intent that requires_action.

        // Re-retrieve the subscription to get the latest invoice info
        const updatedSubscription = await client.subscriptions.retrieve(subscriptionStripeId, {
          expand: ['latest_invoice.payment_intent', 'pending_setup_intent'],
        });

        // The latest_invoice is expanded to include payment_intent
        // Use type assertion for the expanded invoice structure
        const latestInvoice = updatedSubscription.latest_invoice as
          | (Stripe.Invoice & { payment_intent?: Stripe.PaymentIntent | string | null })
          | null;

        let paymentIntent: Stripe.PaymentIntent | null = null;

        // First, try to get payment_intent from the expanded latest_invoice
        if (
          latestInvoice &&
          typeof latestInvoice.payment_intent === 'object' &&
          latestInvoice.payment_intent !== null
        ) {
          paymentIntent = latestInvoice.payment_intent;
        }

        // If not expanded or not found, check if the invoice has a payment_intent ID
        // and retrieve it directly. When subscription update fails, the invoice may be
        // in 'open' status with a payment_intent that requires action.
        if (!paymentIntent && latestInvoice) {
          const paymentIntentId =
            typeof latestInvoice.payment_intent === 'string'
              ? latestInvoice.payment_intent
              : undefined;

          if (paymentIntentId) {
            paymentIntent = await client.paymentIntents.retrieve(paymentIntentId);
          }
        }

        // If still no payment intent, list recent invoices for this subscription
        // and find one with an open payment intent requiring action
        if (!paymentIntent) {
          const recentInvoices = await client.invoices.list({
            subscription: subscriptionStripeId,
            limit: 10,
            expand: ['data.payment_intent'],
          });

          for (const inv of recentInvoices.data) {
            // Cast to include the expanded payment_intent field
            const invoiceWithPi = inv as Stripe.Invoice & {
              payment_intent?: Stripe.PaymentIntent | null;
            };
            const pi = invoiceWithPi.payment_intent;
            if (pi && pi.status === 'requires_action') {
              paymentIntent = pi;
              break;
            }
          }
        }

        if (paymentIntent && paymentIntent.status === 'requires_action') {
          return {
            success: false,
            message:
              'Payment requires additional authentication. Please complete the verification process.',
            requiresAction: true,
            paymentIntentClientSecret: paymentIntent.client_secret ?? undefined,
          };
        }
      }

      // Re-throw other errors
      throw error;
    }
  });
}
