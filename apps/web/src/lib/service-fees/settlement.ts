import 'server-only';

import type Stripe from 'stripe';

import {
  sendMissedServiceFeeAlert,
  type MissedServiceFeeAlertInput,
} from '@/lib/service-fees/alerts';
import {
  linkServiceFeeAssessmentStripeIds,
  markServiceFeeAssessmentCharged,
  markServiceFeeAssessmentMissed,
  sanitizeServiceFeeAssessmentMetadata,
  settleServiceFeeAssessment,
  type ServiceFeeAssessmentRecord,
  type ServiceFeeAssessmentStore,
  type ServiceFeeStripeIds,
} from '@/lib/service-fees/assessments';
import {
  calculateServiceFeeMinor,
  getNetPretaxLineAmountMinor,
} from '@/lib/service-fees/calculation';
import { createInvoiceServiceFeeAssessmentKey } from '@/lib/service-fees/checkout';
import { applyDeferredServiceFeeRefunds } from '@/lib/service-fees/refunds';
import {
  isServiceFeeInvoiceLine,
  listAllInvoiceLineItems,
  sumEligibleKiloPassSubtotalMinor,
  type InvoiceLineItemListClient,
} from '@/lib/service-fees/stripe-lines';
import { SERVICE_FEE_SUPPORTED_CURRENCY } from '@/lib/service-fees/types';

export const SERVICE_FEE_RATE_DEVIATION_THRESHOLD_MINOR = 1;
export const SERVICE_FEE_FAILURE_RATE_DEVIATION = 'service_fee_rate_deviation' as const;
export const SERVICE_FEE_FAILURE_MISSING_ASSESSMENT = 'missing_assessment' as const;
export const SERVICE_FEE_FAILURE_APPLICATION = 'fee_application_failed' as const;

export type ServiceFeeSettlementStore = ServiceFeeAssessmentStore & {
  findByStripeInvoiceId?(stripeInvoiceId: string): Promise<ServiceFeeAssessmentRecord | null>;
};

export type KiloPassServiceFeeSettlementStripe = InvoiceLineItemListClient & {
  subscriptions?: {
    retrieve(id: string): Promise<Stripe.Subscription>;
  };
};

export type KiloPassServiceFeeSettlementResult = {
  status: 'settled' | 'ignored';
  settledProductMinor: number;
  chargedFeeMinor: number;
  grossPaidMinor: number;
  assessment: ServiceFeeAssessmentRecord | null;
};

export type KiloPassServiceFeeSettlementDependencies = {
  now?: Date;
  sendAlert?: (input: MissedServiceFeeAlertInput) => Promise<void>;
  sendRateDeviationAlert?: (input: MissedServiceFeeAlertInput) => Promise<void>;
};

/**
 * Settle a paid Kilo Pass invoice against its durable assessment.
 * Collection is observed from the actual fee line, including a zero amount.
 */
export async function settleKiloPassInvoiceServiceFee(params: {
  invoice: Stripe.Invoice;
  stripe: KiloPassServiceFeeSettlementStripe;
  store: ServiceFeeSettlementStore;
  paymentIntentId?: string | null;
  chargeId?: string | null;
  subscription?: Stripe.Subscription | null;
  lines?: readonly Stripe.InvoiceLineItem[];
  deps?: KiloPassServiceFeeSettlementDependencies;
}): Promise<KiloPassServiceFeeSettlementResult> {
  const deps = params.deps ?? {};
  const now = deps.now ?? new Date();
  const invoiceId = params.invoice.id;
  const stripeIds = invoiceStripeIds(params.invoice, params.paymentIntentId, params.chargeId);

  if (!invoiceId || !hasPaidEvidence(params.invoice)) {
    return ignored(null, params.invoice.amount_paid ?? 0);
  }

  const lines =
    params.lines ??
    (await listAllInvoiceLineItems({
      invoice: params.invoice,
      stripe: params.stripe,
    }));
  const subscription =
    params.subscription !== undefined
      ? params.subscription
      : await loadSubscription(params.invoice, params.stripe);
  const assessment = await resolveSettlementAssessment({
    invoice: params.invoice,
    lines,
    store: params.store,
  });
  const currency =
    params.invoice.currency || assessment?.currency || SERVICE_FEE_SUPPORTED_CURRENCY;
  const productOnlyMinor = sumEligibleKiloPassSubtotalMinor({
    lines,
    currency,
    subscription,
  });
  if (!assessment) {
    await alertSafely({
      assessmentKey: createInvoiceServiceFeeAssessmentKey(invoiceId),
      flow: 'personal_kilo_pass',
      stripeInvoiceId: invoiceId,
      stripePaymentIntentId: stripeIds.stripePaymentIntentId,
      stripeChargeId: stripeIds.stripeChargeId,
      eligibleSubtotalMinor: productOnlyMinor,
      expectedFeeMinor: 0,
      failureCode: SERVICE_FEE_FAILURE_MISSING_ASSESSMENT,
      deps,
      now,
    });
    return {
      status: 'ignored',
      settledProductMinor: productOnlyMinor,
      chargedFeeMinor: 0,
      grossPaidMinor: Math.max(0, params.invoice.amount_paid ?? 0),
      assessment: null,
    };
  }

  const settledProductMinor = productOnlyMinor;
  const feeLine = findFeeLine(lines, assessment);
  const observedFeeMinor = feeLine
    ? Math.max(0, getNetPretaxLineAmountMinor(feeLine, currency))
    : settledProductMinor === 0
      ? 0
      : assessment.outcome === 'charged'
        ? assessment.chargedFeeMinor
        : 0;
  const grossPaidMinor = Math.max(0, params.invoice.amount_paid ?? 0);
  const settledAt =
    unixToDate(params.invoice.status_transitions?.paid_at) ??
    unixToDate(params.invoice.created) ??
    now;

  let current = await linkServiceFeeAssessmentStripeIds({
    store: params.store,
    assessmentKey: assessment.assessmentKey,
    stripeIds,
    now,
  });

  if (current.outcome === 'pending') {
    const canChargeObservedFee = Boolean(feeLine) || settledProductMinor === 0;
    if (canChargeObservedFee && current.expectedFeeMinor > 0) {
      current = await markServiceFeeAssessmentCharged({
        store: params.store,
        assessmentKey: current.assessmentKey,
        chargedFeeMinor: observedFeeMinor,
        stripeIds: {
          ...stripeIds,
          stripeInvoiceFeeLineItemId: feeLine?.id ?? current.stripeInvoiceFeeLineItemId,
        },
        now,
      });
    } else if (current.expectedFeeMinor > 0) {
      current = await markServiceFeeAssessmentMissed({
        store: params.store,
        assessmentKey: current.assessmentKey,
        failureCode: SERVICE_FEE_FAILURE_APPLICATION,
        stripeIds,
        now,
      });
    }
  }

  const settled = await settleServiceFeeAssessment({
    store: params.store,
    assessmentKey: current.assessmentKey,
    settledAt,
    settledProductMinor,
    grossPaidMinor,
    chargedFeeMinor: current.outcome === 'charged' ? observedFeeMinor : 0,
    stripeIds: {
      ...stripeIds,
      stripeInvoiceFeeLineItemId: feeLine?.id ?? current.stripeInvoiceFeeLineItemId,
    },
    now,
  });

  const withDeviation = await recordEffectiveRateDeviation({
    store: params.store,
    assessment: settled,
    settledProductMinor: settled.settledProductMinor,
    chargedFeeMinor: settled.chargedFeeMinor,
    deps,
    now,
  });
  const reconciled = await applyDeferredServiceFeeRefunds({
    store: params.store,
    assessment: withDeviation,
    now,
  });

  return {
    status: 'settled',
    settledProductMinor: reconciled.settledProductMinor,
    chargedFeeMinor: reconciled.chargedFeeMinor,
    grossPaidMinor: reconciled.grossPaidMinor,
    assessment: reconciled,
  };
}

async function resolveSettlementAssessment(params: {
  invoice: Stripe.Invoice;
  lines: readonly Stripe.InvoiceLineItem[];
  store: ServiceFeeSettlementStore;
}): Promise<ServiceFeeAssessmentRecord | null> {
  const keys = uniqueNonEmpty([
    nonempty(params.invoice.metadata?.serviceFeeAssessmentKey),
    nonempty(params.invoice.parent?.subscription_details?.metadata?.serviceFeeAssessmentKey),
    ...params.lines.map(line => nonempty(line.metadata?.serviceFeeAssessmentKey)),
  ]);

  for (const assessmentKey of keys) {
    const byKey = await params.store.findByAssessmentKey(assessmentKey);
    if (byKey) return byKey;
  }

  if (params.invoice.id) {
    const byInvoiceId = params.store.findByStripeInvoiceId
      ? await params.store.findByStripeInvoiceId(params.invoice.id)
      : null;
    if (byInvoiceId) return byInvoiceId;
    return params.store.findByAssessmentKey(
      createInvoiceServiceFeeAssessmentKey(params.invoice.id)
    );
  }

  return null;
}

async function recordEffectiveRateDeviation(params: {
  store: ServiceFeeSettlementStore;
  assessment: ServiceFeeAssessmentRecord;
  settledProductMinor: number;
  chargedFeeMinor: number;
  deps: KiloPassServiceFeeSettlementDependencies;
  now: Date;
}): Promise<ServiceFeeAssessmentRecord> {
  if (params.assessment.outcome !== 'charged') {
    return params.assessment;
  }

  const expectedFromSettled = calculateServiceFeeMinor(params.settledProductMinor);
  const deviation = Math.abs(params.chargedFeeMinor - expectedFromSettled);
  if (deviation <= SERVICE_FEE_RATE_DEVIATION_THRESHOLD_MINOR) {
    return params.assessment;
  }

  const metadata = sanitizeServiceFeeAssessmentMetadata({
    ...params.assessment.metadata,
    service_fee_rate_deviation: true,
  });
  const updated = metadata.service_fee_rate_deviation
    ? await params.store.update(params.assessment.assessmentKey, { metadata })
    : params.assessment;

  await alertSafely({
    assessmentKey: params.assessment.assessmentKey,
    flow: params.assessment.flow,
    kiloUserId: params.assessment.kiloUserId,
    organizationId: params.assessment.organizationId,
    stripeInvoiceId: params.assessment.stripeInvoiceId,
    stripePaymentIntentId: params.assessment.stripePaymentIntentId,
    stripeChargeId: params.assessment.stripeChargeId,
    eligibleSubtotalMinor: params.settledProductMinor,
    expectedFeeMinor: expectedFromSettled,
    failureCode: SERVICE_FEE_FAILURE_RATE_DEVIATION,
    deps: {
      ...params.deps,
      sendAlert: params.deps.sendRateDeviationAlert ?? params.deps.sendAlert,
    },
    now: params.now,
  });

  return updated;
}

function findFeeLine(
  lines: readonly Stripe.InvoiceLineItem[],
  assessment: ServiceFeeAssessmentRecord
): Stripe.InvoiceLineItem | undefined {
  const byAssessmentKey = lines.find(
    line =>
      isServiceFeeInvoiceLine(line) &&
      line.metadata?.serviceFeeAssessmentKey === assessment.assessmentKey
  );
  if (byAssessmentKey) return byAssessmentKey;

  const byMetadata = lines.find(isServiceFeeInvoiceLine);
  if (byMetadata) return byMetadata;

  const feePriceId = nonempty(assessment.stripeFeePriceId);
  if (!feePriceId) return undefined;
  return lines.find(line => invoiceLinePriceId(line) === feePriceId);
}

function invoiceLinePriceId(line: Stripe.InvoiceLineItem): string | null {
  return nonempty(line.pricing?.price_details?.price);
}

async function loadSubscription(
  invoice: Stripe.Invoice,
  stripe: KiloPassServiceFeeSettlementStripe
): Promise<Stripe.Subscription | null> {
  const reference = invoice.parent?.subscription_details?.subscription;
  if (!reference) return null;
  if (typeof reference !== 'string') return reference;
  if (!stripe.subscriptions?.retrieve) return null;
  try {
    return await stripe.subscriptions.retrieve(reference);
  } catch {
    return null;
  }
}

function hasPaidEvidence(invoice: Stripe.Invoice): boolean {
  return invoice.status === 'paid' || typeof invoice.status_transitions?.paid_at === 'number';
}

function invoiceStripeIds(
  invoice: Stripe.Invoice,
  paymentIntentId?: string | null,
  chargeId?: string | null
): ServiceFeeStripeIds {
  let resolvedPaymentIntentId = nonempty(paymentIntentId);
  let resolvedChargeId = nonempty(chargeId);

  for (const payment of invoice.payments?.data ?? []) {
    if (payment.status && payment.status !== 'paid') continue;
    const paymentRef = payment.payment;
    if (!paymentRef) continue;
    if (paymentRef.type === 'payment_intent' && !resolvedPaymentIntentId) {
      resolvedPaymentIntentId = referenceId(paymentRef.payment_intent);
      if (
        !resolvedChargeId &&
        paymentRef.payment_intent &&
        typeof paymentRef.payment_intent !== 'string'
      ) {
        resolvedChargeId = referenceId(paymentRef.payment_intent.latest_charge);
      }
    }
    if (paymentRef.type === 'charge' && !resolvedChargeId) {
      resolvedChargeId = referenceId(paymentRef.charge);
    }
  }

  return {
    stripeInvoiceId: invoice.id,
    stripeCustomerId: customerId(invoice.customer),
    stripePaymentIntentId: resolvedPaymentIntentId,
    stripeChargeId: resolvedChargeId,
  };
}

function referenceId(value: string | { id?: string } | null | undefined): string | null {
  if (typeof value === 'string') return nonempty(value);
  if (value && typeof value.id === 'string') return nonempty(value.id);
  return null;
}

function customerId(
  customer: string | Stripe.Customer | Stripe.DeletedCustomer | null | undefined
): string | null {
  if (typeof customer === 'string' && customer.trim()) return customer;
  if (customer && typeof customer === 'object' && 'id' in customer && customer.id) {
    return customer.id;
  }
  return null;
}

function nonempty(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function uniqueNonEmpty(values: Array<string | null>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

function unixToDate(value: number | null | undefined): Date | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  return new Date(value * 1000);
}

function ignored(
  assessment: ServiceFeeAssessmentRecord | null,
  grossPaidMinor: number
): KiloPassServiceFeeSettlementResult {
  return {
    status: 'ignored',
    settledProductMinor: assessment?.settledProductMinor ?? 0,
    chargedFeeMinor: assessment?.chargedFeeMinor ?? 0,
    grossPaidMinor,
    assessment,
  };
}

async function alertSafely(params: {
  assessmentKey: string;
  flow: ServiceFeeAssessmentRecord['flow'] | 'personal_kilo_pass';
  kiloUserId?: string | null;
  organizationId?: string | null;
  stripeInvoiceId?: string | null;
  stripePaymentIntentId?: string | null;
  stripeChargeId?: string | null;
  eligibleSubtotalMinor: number;
  expectedFeeMinor: number;
  failureCode: string;
  deps: KiloPassServiceFeeSettlementDependencies;
  now: Date;
}): Promise<void> {
  const sendAlert = params.deps.sendAlert ?? sendMissedServiceFeeAlert;
  try {
    await sendAlert({
      assessmentKey: params.assessmentKey,
      flow: params.flow,
      kiloUserId: params.kiloUserId,
      organizationId: params.organizationId,
      stripeInvoiceId: params.stripeInvoiceId,
      stripePaymentIntentId: params.stripePaymentIntentId,
      stripeChargeId: params.stripeChargeId,
      eligibleSubtotalMinor: params.eligibleSubtotalMinor,
      expectedFeeMinor: params.expectedFeeMinor,
      currency: SERVICE_FEE_SUPPORTED_CURRENCY,
      failureCode: params.failureCode,
      attemptedAt: params.now,
    });
  } catch {
    // Alert failure must not change settlement outcome.
  }
}
