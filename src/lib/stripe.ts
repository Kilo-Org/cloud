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
  STRIPE_ENTERPRISE_SUBSCRIPTION_PRODUCT_ID,
  STRIPE_TEAMS_SUBSCRIPTION_PRODUCT_ID,
} from '@/lib/config.server';
import type { OrganizationPlan } from '@/lib/organizations/organization-types';
import { successResult } from '@/lib/maybe-result';

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
    })
    .onConflictDoUpdate({
      target: auto_top_up_configs.owned_by_organization_id,
      set: {
        stripe_payment_method_id: paymentMethodId,
        amount_cents: amountCents,
        disabled_reason: null,
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
      await handleOrgAutoTopUpSetup(organizationId, paymentIntent, config);
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
    const hasSeatsMetadata =
      invoice.lines?.data?.some(
        line =>
          line.metadata != null && Object.prototype.hasOwnProperty.call(line.metadata, 'seats')
      ) ?? false;

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
      invoice_type: hasSeatsMetadata ? 'seats' : 'topup',
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

          logExceptInTest(`Processing auto top-up for user ${user.id}`, {
            invoice_id: invoice.id,
            charge_id: chargeId,
            amount_paid: invoice.amount_paid,
          });

          const autoTopUpOk = await processTopUp(user, invoice.amount_paid, config, {
            isAutoTopUp: true,
          });

          if (!autoTopUpOk) {
            sentryLogger('stripe', 'info')('Auto top-up already registered (invoice fallback)', {
              kilo_user_id: user.id,
              invoice_id: invoice.id,
              charge_id: chargeId,
            });
          }

          // Release the in-progress auto-top-up lock
          await db
            .update(auto_top_up_configs)
            .set({ last_auto_top_up_at: sql`NOW()`, attempt_started_at: null })
            .where(eq(auto_top_up_configs.owned_by_user_id, user.id));
        } else {
          const organizationId = invoice.metadata?.organizationId;
          if (!organizationId) break;

          logExceptInTest(`Processing org auto top-up for organization ${organizationId}`, {
            invoice_id: invoice.id,
            charge_id: chargeId,
            amount_paid: invoice.amount_paid,
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

          // Release the in-progress auto-top-up lock
          await db
            .update(auto_top_up_configs)
            .set({ last_auto_top_up_at: sql`NOW()`, attempt_started_at: null })
            .where(eq(auto_top_up_configs.owned_by_organization_id, organizationId));
        }
        break;
      }

      break;
    }

    // invoice.payment_succeeded is for subscriptions
    case 'customer.subscription.created':
      if (event.data.object.metadata?.type === 'kilo-pass') {
        await handleKiloPassSubscriptionEvent({
          eventId: event.id,
          eventType: event.type,
          subscription: event.data.object,
        });
        break;
      }

      await handleSubscriptionEvent(
        event.data.object,
        event.request?.idempotency_key ?? undefined,
        true
      );
      break;
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted':
      if (event.data.object.metadata?.type === 'kilo-pass') {
        await handleKiloPassSubscriptionEvent({
          eventId: event.id,
          eventType: event.type,
          subscription: event.data.object,
        });
        break;
      }

      await handleSubscriptionEvent(event.data.object, event.request?.idempotency_key ?? undefined);
      break;

    case 'payment_method.detached':
    case 'payment_method.updated':
    case 'payment_method.attached': {
      await handlePaymentMethodEvent(event);
      break;
    }

    case 'subscription_schedule.updated': {
      const schedule = event.data.object;

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

  const checkoutSession = await client.checkout.sessions.create({
    mode: 'payment',
    customer: stripeCustomerId,
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
  organizationId?: string | null
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
  let cancelUrl = `${APP_URL}/profile?payment_status=topup_cancelled&origin=${origin}`;
  if (isOrganizationTopUp) {
    cancelUrl = `${APP_URL}/organizations/${organizationId}?${TOPUP_CANCELED_QUERY_STRING_KEY}=true`;
  }

  const checkoutSession = await client.checkout.sessions.create({
    mode: 'payment',
    customer: stripeCustomerId,
    billing_address_collection: 'required',
    line_items: line_items,
    invoice_creation: {
      enabled: true,
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
};

const assertNever = (x: never): never => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  throw new Error('Unexpected object: ' + (x as any));
};

function getProductCodeForPlan(plan: OrganizationPlan): string {
  switch (plan) {
    case 'teams':
      return STRIPE_TEAMS_SUBSCRIPTION_PRODUCT_ID;
    case 'enterprise':
      return STRIPE_ENTERPRISE_SUBSCRIPTION_PRODUCT_ID;
    default:
      return assertNever(plan);
  }
}

export async function getStripeSeatsCheckoutUrl(
  props: GetStripeCheckoutUrlProps
): Promise<string | null> {
  const { kiloUserId, stripeCustomerId, quantity, organizationId, cancelUrl, plan } = props;

  const subscriptionMetadata: SubscriptionMetadata = {
    type: 'stripe-checkout-seats',
    kiloUserId,
    organizationId,
    seats: quantity,
    planType: plan,
  };

  try {
    const productId = getProductCodeForPlan(plan);
    const product = await client.products.retrieve(productId);

    if (typeof product?.default_price !== 'string') {
      throw new Error(`Product ${productId} has no default price set`);
    }

    const line_items = [
      {
        price: product.default_price,
        quantity,
      },
    ];

    const successUrl = `${process.env.NEXTAUTH_URL}/payments/subscriptions/success?organizationId=${organizationId}&${STRIPE_SUB_QUERY_STRING_KEY}={CHECKOUT_SESSION_ID}`;

    const checkoutSession = await client.checkout.sessions.create({
      mode: 'subscription',
      customer: stripeCustomerId,
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
        metadata: subscriptionMetadata,
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
  const subscription: Stripe.Subscription = await client.subscriptions.retrieve(subscriptionId);
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
  const idempotencyKey = `sub-cancel-${randomUUID()}`;
  const sub = await client.subscriptions.update(
    subscriptionStripeId,
    {
      cancel_at_period_end: true,
    },
    {
      idempotencyKey,
    }
  );
  // we can eagerly update our own database here & ignore the webhook
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
  // downgrading seats is not prorated meaning it wont fully downgrade until end of billing cycle
  const isIncreasingSeats = currentSeatCount < newSeatCount;
  // const prorationBehavior = isIncreasingSeats ? 'create_prorations' : 'none';
  const idempotencyKey = `sub-update-${randomUUID()}`;
  const subscription = await client.subscriptions.retrieve(subscriptionStripeId);

  if (!subscription.items.data[0]) {
    throw new Error('No subscription items found');
  }

  try {
    const updatedSubscription = await client.subscriptions.update(
      subscriptionStripeId,
      {
        // TODO: (bmc) right now if we downgrade seats we don't prorate or refund, you just have fewer seats next year. Probably not ideal.
        proration_behavior: isIncreasingSeats ? 'always_invoice' : 'none',
        // For seat increases, use 'allow_incomplete' to let the subscription update proceed.
        // We then manually pay the invoice to trigger the PaymentIntent creation synchronously.
        payment_behavior: isIncreasingSeats ? 'allow_incomplete' : undefined,
        items: [
          {
            id: subscription.items.data[0].id,
            quantity: newSeatCount,
          },
        ],
        // Expand the latest_invoice to get the invoice details
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
}
