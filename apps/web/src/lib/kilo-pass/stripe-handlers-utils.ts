import { computeIssueMonth } from '@/lib/kilo-pass/issuance';
import { dayjs } from '@/lib/kilo-pass/dayjs';
import type Stripe from 'stripe';

/**
 * Adds one month to an issue month string (YYYY-MM-01 format).
 */
export function addOneMonthToIssueMonth(issueMonth: string): string {
  const parsed = dayjs(`${issueMonth}T00:00:00.000Z`).utc();
  if (!parsed.isValid()) {
    throw new Error(`Invalid issueMonth: ${issueMonth}`);
  }

  return computeIssueMonth(parsed.add(1, 'month'));
}

/**
 * Gets the previous issue month from an issue month string (YYYY-MM-01 format).
 */
export function getPreviousIssueMonth(issueMonth: string): string {
  const parsed = dayjs(`${issueMonth}T00:00:00.000Z`).utc();
  if (!parsed.isValid()) {
    throw new Error(`Invalid issueMonth: ${issueMonth}`);
  }

  return computeIssueMonth(parsed.subtract(1, 'month'));
}

/**
 * Returns the period.start of the first subscription line item, which represents
 * the actual service period being billed. invoice.period_start is NOT suitable
 * because Stripe documents it as looking back one period for subscription invoices.
 */
function getSubscriptionLineItemPeriodStart(invoice: Stripe.Invoice): number | null {
  const lines = invoice.lines?.data ?? [];
  for (const line of lines) {
    const details = line.parent?.subscription_item_details;
    if (details && !details.proration) {
      return line.period.start;
    }
  }
  return null;
}

/**
 * Extracts the issue month from a Stripe invoice using the subscription line item's
 * service period. Falls back to invoice.created for non-subscription invoices.
 */
export function getInvoiceIssueMonth(invoice: Stripe.Invoice): string {
  const lineItemPeriodStart = getSubscriptionLineItemPeriodStart(invoice);
  const seconds = lineItemPeriodStart ?? invoice.created ?? null;
  if (seconds === null) {
    throw new Error(
      `Invoice ${invoice.id} has no subscription line item period and no created timestamp`
    );
  }

  return computeIssueMonth(dayjs.unix(seconds).utc());
}

/**
 * Retrieves the latest Stripe subscription from an invoice.
 * Always fetches from Stripe API to ensure we have the current state,
 * not a potentially stale snapshot embedded in the webhook event.
 */
export async function getInvoiceSubscription(params: {
  invoice: Stripe.Invoice;
  stripe: Stripe;
}): Promise<Stripe.Subscription | null> {
  const { invoice, stripe } = params;

  const subscriptionUnion = invoice.parent?.subscription_details?.subscription;

  if (!subscriptionUnion) return null;

  const subscriptionId =
    typeof subscriptionUnion === 'string' ? subscriptionUnion : subscriptionUnion.id;

  return await stripe.subscriptions.retrieve(subscriptionId);
}

export type SupportedReusablePaymentMethodType =
  | 'card'
  | 'sepa_debit'
  | 'us_bank_account'
  | 'bacs_debit'
  | 'au_becs_debit';

export type SettledInvoicePaymentMethod =
  | {
      kind: 'reusable';
      paymentMethodType: SupportedReusablePaymentMethodType;
      fingerprint: string | null;
    }
  | { kind: 'without_supported_fingerprint' }
  | { kind: 'unknown' };

function normalizedFingerprint(value: string | null | undefined): string | null {
  const fingerprint = value?.trim() ?? '';
  return fingerprint || null;
}

function getReusablePaymentMethodResult(
  paymentMethod: Stripe.PaymentMethod
): SettledInvoicePaymentMethod {
  switch (paymentMethod.type) {
    case 'card':
      return {
        kind: 'reusable',
        paymentMethodType: 'card',
        fingerprint: normalizedFingerprint(paymentMethod.card?.fingerprint),
      };
    case 'sepa_debit':
      return {
        kind: 'reusable',
        paymentMethodType: 'sepa_debit',
        fingerprint: normalizedFingerprint(paymentMethod.sepa_debit?.fingerprint),
      };
    case 'us_bank_account':
      return {
        kind: 'reusable',
        paymentMethodType: 'us_bank_account',
        fingerprint: normalizedFingerprint(paymentMethod.us_bank_account?.fingerprint),
      };
    case 'bacs_debit':
      return {
        kind: 'reusable',
        paymentMethodType: 'bacs_debit',
        fingerprint: normalizedFingerprint(paymentMethod.bacs_debit?.fingerprint),
      };
    case 'au_becs_debit':
      return {
        kind: 'reusable',
        paymentMethodType: 'au_becs_debit',
        fingerprint: normalizedFingerprint(paymentMethod.au_becs_debit?.fingerprint),
      };
    default:
      return { kind: 'without_supported_fingerprint' };
  }
}

function getReusableChargeResult(charge: Stripe.Charge): SettledInvoicePaymentMethod {
  const details = charge.payment_method_details;
  if (!details) return { kind: 'unknown' };

  switch (details.type) {
    case 'card':
      return {
        kind: 'reusable',
        paymentMethodType: 'card',
        fingerprint: normalizedFingerprint(details.card?.fingerprint),
      };
    case 'sepa_debit':
      return {
        kind: 'reusable',
        paymentMethodType: 'sepa_debit',
        fingerprint: normalizedFingerprint(details.sepa_debit?.fingerprint),
      };
    case 'us_bank_account':
      return {
        kind: 'reusable',
        paymentMethodType: 'us_bank_account',
        fingerprint: normalizedFingerprint(details.us_bank_account?.fingerprint),
      };
    case 'bacs_debit':
      return {
        kind: 'reusable',
        paymentMethodType: 'bacs_debit',
        fingerprint: normalizedFingerprint(details.bacs_debit?.fingerprint),
      };
    case 'au_becs_debit':
      return {
        kind: 'reusable',
        paymentMethodType: 'au_becs_debit',
        fingerprint: normalizedFingerprint(details.au_becs_debit?.fingerprint),
      };
    default:
      return { kind: 'without_supported_fingerprint' };
  }
}

async function getExpandedPaymentMethod(params: {
  stripe: Stripe;
  paymentMethod: string | Stripe.PaymentMethod | null;
}): Promise<Stripe.PaymentMethod | null> {
  if (params.paymentMethod === null) return null;
  if (typeof params.paymentMethod !== 'string') return params.paymentMethod;
  if (!params.stripe.paymentMethods?.retrieve) return null;
  return await params.stripe.paymentMethods.retrieve(params.paymentMethod);
}

async function getExpandedCharge(params: {
  stripe: Stripe;
  charge: string | Stripe.Charge | undefined;
}): Promise<Stripe.Charge | null> {
  if (!params.charge) return null;
  if (typeof params.charge !== 'string') return params.charge;
  if (!params.stripe.charges?.retrieve) return null;
  return await params.stripe.charges.retrieve(params.charge);
}

/**
 * Resolves the payment instrument that settled an invoice. This deliberately uses the paid
 * invoice payment rather than a customer's attached or default payment method.
 */
export async function getSettledInvoicePaymentMethod(params: {
  invoice: Stripe.Invoice;
  stripe: Stripe;
}): Promise<SettledInvoicePaymentMethod> {
  const embeddedPaidPayments = (params.invoice.payments?.data ?? []).filter(
    payment => payment.status === 'paid'
  );
  const paidPayments =
    embeddedPaidPayments.length > 0
      ? embeddedPaidPayments
      : params.stripe.invoicePayments?.list
        ? (
            await params.stripe.invoicePayments.list({
              invoice: params.invoice.id,
              status: 'paid',
              limit: 1,
            })
          ).data
        : [];

  for (const invoicePayment of paidPayments) {
    const payment = invoicePayment.payment;
    if (payment.type === 'charge') {
      const charge = await getExpandedCharge({ stripe: params.stripe, charge: payment.charge });
      if (charge) return getReusableChargeResult(charge);
      continue;
    }
    if (payment.type !== 'payment_intent' || !payment.payment_intent) continue;

    const paymentIntent =
      typeof payment.payment_intent === 'string'
        ? params.stripe.paymentIntents?.retrieve
          ? await params.stripe.paymentIntents.retrieve(payment.payment_intent, {
              expand: ['payment_method'],
            })
          : null
        : payment.payment_intent;
    if (!paymentIntent) continue;

    const paymentMethod = await getExpandedPaymentMethod({
      stripe: params.stripe,
      paymentMethod: paymentIntent.payment_method,
    });
    if (paymentMethod) return getReusablePaymentMethodResult(paymentMethod);
  }

  return { kind: 'unknown' };
}

/**
 * Gets the ended_at timestamp from a Stripe subscription as an ISO string.
 * Falls back to current time if no ended_at or canceled_at is available.
 */
export function getStripeEndedAtIso(subscription: Stripe.Subscription): string {
  const seconds = subscription.ended_at ?? subscription.canceled_at ?? null;
  if (seconds != null) {
    return dayjs.unix(seconds).utc().toISOString();
  }
  return dayjs().utc().toISOString();
}
