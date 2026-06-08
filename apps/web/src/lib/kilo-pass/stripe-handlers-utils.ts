import { computeIssueMonth } from '@/lib/kilo-pass/issuance';
import { dayjs } from '@/lib/kilo-pass/dayjs';
import { captureException } from '@sentry/nextjs';
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
  | { kind: 'without_supported_fingerprint' };

export type RefundableSettlementTarget =
  | { kind: 'payment_intent'; id: string }
  | { kind: 'charge'; id: string };

export type SettledInvoicePaymentResolution =
  | { kind: 'none' }
  | { kind: 'multiple' }
  | {
      kind: 'unresolved';
      reason:
        | 'missing_provider_capability'
        | 'provider_lookup_failed'
        | 'missing_settlement_reference'
        | 'missing_payment_instrument';
    }
  | {
      kind: 'settled';
      paymentMethod: SettledInvoicePaymentMethod;
      refundableTarget: RefundableSettlementTarget | null;
    };

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

function getReusableChargeResult(charge: Stripe.Charge): SettledInvoicePaymentMethod | null {
  const details = charge.payment_method_details;
  if (!details) return null;

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

function reportSettlementLookupFailure(params: {
  error: unknown;
  stripeInvoiceId: string;
  stage: string;
  providerPaymentId?: string;
}): void {
  captureException(params.error, {
    tags: { source: 'kilo_pass_settled_payment_resolution', stage: params.stage },
    extra: {
      stripeInvoiceId: params.stripeInvoiceId,
      ...(params.providerPaymentId ? { providerPaymentId: params.providerPaymentId } : {}),
    },
  });
}

function reportMultipleSettlements(stripeInvoiceId: string): void {
  captureException(new Error('Kilo Pass invoice has multiple paid settlements'), {
    tags: { source: 'kilo_pass_settled_payment_resolution', stage: 'multiple_paid_settlements' },
    extra: { stripeInvoiceId },
  });
}

async function loadPaidInvoicePayments(params: {
  invoice: Stripe.Invoice;
  stripe: Stripe;
}): Promise<Stripe.InvoicePayment[] | SettledInvoicePaymentResolution> {
  if (params.invoice.payments?.has_more === false) {
    return params.invoice.payments.data.filter(payment => payment.status === 'paid');
  }

  if (!params.stripe.invoicePayments?.list) {
    return { kind: 'unresolved', reason: 'missing_provider_capability' };
  }

  try {
    const listed = await params.stripe.invoicePayments.list({
      invoice: params.invoice.id,
      status: 'paid',
      limit: 2,
    });
    const paidPayments = listed.data.filter(payment => payment.status === 'paid');
    if (listed.has_more || paidPayments.length > 1) {
      reportMultipleSettlements(params.invoice.id);
      return { kind: 'multiple' };
    }
    return paidPayments;
  } catch (error) {
    reportSettlementLookupFailure({
      error,
      stripeInvoiceId: params.invoice.id,
      stage: 'invoice_payments_list',
    });
    return { kind: 'unresolved', reason: 'provider_lookup_failed' };
  }
}

async function resolvePaymentIntentSettlement(params: {
  invoice: Stripe.Invoice;
  stripe: Stripe;
  paymentIntent: string | Stripe.PaymentIntent | null | undefined;
}): Promise<SettledInvoicePaymentResolution> {
  if (!params.paymentIntent) {
    return { kind: 'unresolved', reason: 'missing_settlement_reference' };
  }

  const paymentIntentId =
    typeof params.paymentIntent === 'string' ? params.paymentIntent : params.paymentIntent.id;
  let paymentIntent: Stripe.PaymentIntent;
  if (typeof params.paymentIntent !== 'string') {
    paymentIntent = params.paymentIntent;
  } else {
    if (!params.stripe.paymentIntents?.retrieve) {
      return { kind: 'unresolved', reason: 'missing_provider_capability' };
    }
    try {
      paymentIntent = await params.stripe.paymentIntents.retrieve(params.paymentIntent, {
        expand: ['payment_method'],
      });
    } catch (error) {
      reportSettlementLookupFailure({
        error,
        stripeInvoiceId: params.invoice.id,
        stage: 'payment_intent_retrieve',
        providerPaymentId: paymentIntentId,
      });
      return { kind: 'unresolved', reason: 'provider_lookup_failed' };
    }
  }

  const paymentMethodReference = paymentIntent.payment_method;
  if (!paymentMethodReference) {
    return { kind: 'unresolved', reason: 'missing_payment_instrument' };
  }

  let paymentMethod: Stripe.PaymentMethod;
  if (typeof paymentMethodReference !== 'string') {
    paymentMethod = paymentMethodReference;
  } else {
    if (!params.stripe.paymentMethods?.retrieve) {
      return { kind: 'unresolved', reason: 'missing_provider_capability' };
    }
    try {
      paymentMethod = await params.stripe.paymentMethods.retrieve(paymentMethodReference);
    } catch (error) {
      reportSettlementLookupFailure({
        error,
        stripeInvoiceId: params.invoice.id,
        stage: 'payment_method_retrieve',
        providerPaymentId: paymentIntentId,
      });
      return { kind: 'unresolved', reason: 'provider_lookup_failed' };
    }
  }

  return {
    kind: 'settled',
    paymentMethod: getReusablePaymentMethodResult(paymentMethod),
    refundableTarget: paymentIntentId ? { kind: 'payment_intent', id: paymentIntentId } : null,
  };
}

async function resolveChargeSettlement(params: {
  invoice: Stripe.Invoice;
  stripe: Stripe;
  charge: string | Stripe.Charge | undefined;
}): Promise<SettledInvoicePaymentResolution> {
  if (!params.charge) {
    return { kind: 'unresolved', reason: 'missing_settlement_reference' };
  }

  const chargeId = typeof params.charge === 'string' ? params.charge : params.charge.id;
  let charge: Stripe.Charge;
  if (typeof params.charge !== 'string') {
    charge = params.charge;
  } else {
    if (!params.stripe.charges?.retrieve) {
      return { kind: 'unresolved', reason: 'missing_provider_capability' };
    }
    try {
      charge = await params.stripe.charges.retrieve(params.charge);
    } catch (error) {
      reportSettlementLookupFailure({
        error,
        stripeInvoiceId: params.invoice.id,
        stage: 'charge_retrieve',
        providerPaymentId: chargeId,
      });
      return { kind: 'unresolved', reason: 'provider_lookup_failed' };
    }
  }

  const paymentMethod = getReusableChargeResult(charge);
  if (!paymentMethod) {
    return { kind: 'unresolved', reason: 'missing_payment_instrument' };
  }

  return {
    kind: 'settled',
    paymentMethod,
    refundableTarget: chargeId ? { kind: 'charge', id: chargeId } : null,
  };
}

/**
 * Resolves exactly one paid invoice settlement without inspecting attached, default, or local
 * payment methods. Provider lookup failures are reported and returned as unresolved so invoice
 * processing can fail open.
 */
export async function resolveSettledInvoicePayment(params: {
  invoice: Stripe.Invoice;
  stripe: Stripe;
}): Promise<SettledInvoicePaymentResolution> {
  const paidPayments = await loadPaidInvoicePayments(params);
  if (!Array.isArray(paidPayments)) return paidPayments;

  if (paidPayments.length === 0) return { kind: 'none' };
  if (paidPayments.length > 1) {
    reportMultipleSettlements(params.invoice.id);
    return { kind: 'multiple' };
  }

  const payment = paidPayments[0]?.payment;
  if (!payment) return { kind: 'unresolved', reason: 'missing_settlement_reference' };
  if (payment.type === 'payment_intent') {
    return await resolvePaymentIntentSettlement({
      ...params,
      paymentIntent: payment.payment_intent,
    });
  }
  if (payment.type === 'charge') {
    return await resolveChargeSettlement({ ...params, charge: payment.charge });
  }
  return { kind: 'unresolved', reason: 'missing_settlement_reference' };
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
