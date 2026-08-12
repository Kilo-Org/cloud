import 'server-only';

import { captureException } from '@sentry/nextjs';
import type Stripe from 'stripe';

import {
  AdminSlackNotificationError,
  sendAdminSlackNotification,
} from '@/lib/slack/admin-notifications';
import {
  observeServiceFeeAssessmentRefunds,
  type ServiceFeeAssessmentRecord,
  type ServiceFeeAssessmentStore,
} from '@/lib/service-fees/assessments';
import { calculateCumulativeFeeRefundMinor } from '@/lib/service-fees/calculation';
import {
  isKiloClawInvoiceLine,
  isSeatInvoiceLine,
  isServiceFeeInvoiceLine,
} from '@/lib/service-fees/stripe-lines';

export const SERVICE_FEE_REFUND_ALLOCATION_UNRESOLVED = 'refund_allocation_unresolved';
export const SERVICE_FEE_REFUND_ALLOCATION_UNRESOLVED_SENTRY_TAG =
  'service_fee_refund_allocation_unresolved';
export const SERVICE_FEE_REFUND_PRODUCT_METADATA_KEY = 'serviceFeeRefundProductMinor';
export const SERVICE_FEE_REFUND_FEE_METADATA_KEY = 'serviceFeeRefundFeeMinor';

const PAGE_SIZE = 100;
const COUNTED_REFUND_STATUSES = new Set(['succeeded', 'pending']);

export class ServiceFeeObservationNotReadyError extends Error {
  readonly name = 'ServiceFeeObservationNotReadyError';

  constructor(readonly assessmentKey: string) {
    super(
      `service fee assessment ${assessmentKey} cannot record product or fee observation until settlement`
    );
  }
}

export type ServiceFeeStripeReference = string | { id: string } | null | undefined;

export type ServiceFeeRefundAssessmentStore = ServiceFeeAssessmentStore & {
  findByStripeInvoiceId(stripeInvoiceId: string): Promise<ServiceFeeAssessmentRecord | null>;
  findByStripePaymentIntentId(
    stripePaymentIntentId: string
  ): Promise<ServiceFeeAssessmentRecord | null>;
  findByStripeChargeId(stripeChargeId: string): Promise<ServiceFeeAssessmentRecord | null>;
};

export type ServiceFeeRefundPage<T> = {
  data: T[];
  has_more: boolean;
};

export type ServiceFeeCreditNoteObservation = Pick<
  Stripe.CreditNote,
  'id' | 'invoice' | 'status' | 'lines'
>;

export type ServiceFeeRefundStripeClient = {
  refunds: {
    list(params: {
      charge: string;
      limit?: number;
      starting_after?: string;
    }): Promise<ServiceFeeRefundPage<Stripe.Refund>>;
  };
  creditNotes?: {
    list(params: {
      invoice: string;
      limit?: number;
      starting_after?: string;
    }): Promise<ServiceFeeRefundPage<ServiceFeeCreditNoteObservation>>;
    listLineItems(
      id: string,
      params?: { limit?: number; starting_after?: string }
    ): Promise<ServiceFeeRefundPage<Stripe.CreditNoteLineItem>>;
  };
  invoices?: {
    listLineItems(
      invoiceId: string,
      params?: Stripe.InvoiceListLineItemsParams
    ): Promise<ServiceFeeRefundPage<Stripe.InvoiceLineItem>>;
  };
};

export type ServiceFeeRefundAllocation = {
  productMinor: number;
  feeMinor: number;
};

export type ServiceFeeRefundIncrement = {
  cumulativeProductRefundMinor: number;
  cumulativeFeeRefundMinor: number;
  incrementalProductRefundMinor: number;
  incrementalFeeRefundMinor: number;
  incrementalGrossRefundMinor: number;
};

export type ServiceFeeChargeRefundObservation = {
  id: string;
  amount: number;
  amount_refunded: number;
  payment_intent?: ServiceFeeStripeReference;
  invoice?: ServiceFeeStripeReference;
  refunds?: ServiceFeeRefundPage<Stripe.Refund> | null;
  metadata?: Stripe.Metadata | null;
};

export type ServiceFeeRefundObservationStatus = 'ignored' | 'full' | 'allocated' | 'unresolved';

export type ServiceFeeRefundObservationResult = {
  status: ServiceFeeRefundObservationStatus;
  assessment: ServiceFeeAssessmentRecord | null;
  refundedGrossMinor: number;
  refundedProductMinor: number;
  refundedFeeMinor: number;
  createdStripeRefund: false;
};

export type UnresolvedServiceFeeRefundAllocationAlertInput = {
  assessmentKey: string;
  flow: ServiceFeeAssessmentRecord['flow'];
  kiloUserId?: string | null;
  organizationId?: string | null;
  stripeCheckoutSessionId?: string | null;
  stripeInvoiceId?: string | null;
  stripePaymentIntentId?: string | null;
  stripeChargeId?: string | null;
  refundedGrossMinor: number;
  chargeAmountMinor: number;
  settledProductMinor: number;
  chargedFeeMinor: number;
  currency: string;
  observedAt: Date | string;
};

export type ServiceFeeRefundObservationDependencies = {
  sendAlert?: (input: UnresolvedServiceFeeRefundAllocationAlertInput) => Promise<void>;
  captureException?: typeof captureException;
};

export function stripeReferenceId(reference: ServiceFeeStripeReference): string | null {
  if (typeof reference === 'string') {
    return reference.trim() ? reference : null;
  }
  if (reference && typeof reference.id === 'string' && reference.id.trim()) {
    return reference.id;
  }
  return null;
}

export async function resolveServiceFeeAssessmentFromStripeRefs(params: {
  store: ServiceFeeRefundAssessmentStore;
  chargeId?: string | null;
  paymentIntentId?: string | null;
  invoiceId?: string | null;
}): Promise<ServiceFeeAssessmentRecord | null> {
  if (params.chargeId) {
    const byCharge = await params.store.findByStripeChargeId(params.chargeId);
    if (byCharge) return byCharge;
  }
  if (params.paymentIntentId) {
    const byPaymentIntent = await params.store.findByStripePaymentIntentId(params.paymentIntentId);
    if (byPaymentIntent) return byPaymentIntent;
  }
  if (params.invoiceId) {
    const byInvoice = await params.store.findByStripeInvoiceId(params.invoiceId);
    if (byInvoice) return byInvoice;
  }
  return null;
}

export function calculateServiceFeeRefundIncrement(input: {
  originalProductMinor: number;
  originalFeeMinor: number;
  alreadyRefundedProductMinor: number;
  alreadyRefundedFeeMinor: number;
  additionalProductRefundMinor: number;
}): ServiceFeeRefundIncrement {
  assertNonNegativeSafeInteger(input.originalProductMinor, 'originalProductMinor');
  assertNonNegativeSafeInteger(input.originalFeeMinor, 'originalFeeMinor');
  assertNonNegativeSafeInteger(input.alreadyRefundedProductMinor, 'alreadyRefundedProductMinor');
  assertNonNegativeSafeInteger(input.alreadyRefundedFeeMinor, 'alreadyRefundedFeeMinor');
  assertNonNegativeSafeInteger(input.additionalProductRefundMinor, 'additionalProductRefundMinor');

  if (input.alreadyRefundedProductMinor > input.originalProductMinor) {
    throw new Error('alreadyRefundedProductMinor cannot exceed originalProductMinor');
  }
  if (input.alreadyRefundedFeeMinor > input.originalFeeMinor) {
    throw new Error('alreadyRefundedFeeMinor cannot exceed originalFeeMinor');
  }

  const remainingProductMinor = input.originalProductMinor - input.alreadyRefundedProductMinor;
  const incrementalProductRefundMinor = Math.min(
    input.additionalProductRefundMinor,
    remainingProductMinor
  );
  const cumulativeProductRefundMinor =
    input.alreadyRefundedProductMinor + incrementalProductRefundMinor;
  const targetFeeMinor = calculateCumulativeFeeRefundMinor({
    originalProductMinor: input.originalProductMinor,
    originalFeeMinor: input.originalFeeMinor,
    cumulativeProductRefundMinor,
  });
  const remainingFeeMinor = input.originalFeeMinor - input.alreadyRefundedFeeMinor;
  const incrementalFeeRefundMinor = Math.max(
    0,
    Math.min(targetFeeMinor - input.alreadyRefundedFeeMinor, remainingFeeMinor)
  );

  return {
    cumulativeProductRefundMinor,
    cumulativeFeeRefundMinor: input.alreadyRefundedFeeMinor + incrementalFeeRefundMinor,
    incrementalProductRefundMinor,
    incrementalFeeRefundMinor,
    incrementalGrossRefundMinor: incrementalProductRefundMinor + incrementalFeeRefundMinor,
  };
}

export function buildServiceFeeRefundAllocationMetadata(allocation: ServiceFeeRefundAllocation): {
  [SERVICE_FEE_REFUND_PRODUCT_METADATA_KEY]: string;
  [SERVICE_FEE_REFUND_FEE_METADATA_KEY]: string;
} {
  assertNonNegativeSafeInteger(allocation.productMinor, 'productMinor');
  assertNonNegativeSafeInteger(allocation.feeMinor, 'feeMinor');
  return {
    [SERVICE_FEE_REFUND_PRODUCT_METADATA_KEY]: String(allocation.productMinor),
    [SERVICE_FEE_REFUND_FEE_METADATA_KEY]: String(allocation.feeMinor),
  };
}

export function parseServiceFeeRefundAllocationMetadata(
  metadata: Stripe.Metadata | Stripe.MetadataParam | null | undefined
): ServiceFeeRefundAllocation | null {
  if (!metadata) return null;
  const productMinor = parseMinorMetadata(metadata[SERVICE_FEE_REFUND_PRODUCT_METADATA_KEY]);
  const feeMinor = parseMinorMetadata(metadata[SERVICE_FEE_REFUND_FEE_METADATA_KEY]);
  if (productMinor === null || feeMinor === null) return null;
  return { productMinor, feeMinor };
}

/**
 * Observe `charge.refunded`. Never creates a Stripe refund. Full remaining
 * no-amount Kilo refunds are treated as full product+fee once cumulative gross
 * equals the charge amount.
 *
 * An existing unsettled assessment still records `refundedGrossMinor`. Product
 * and fee columns cannot be written until settlement without violating refund
 * caps, so this throws for webhook retry after persisting the gross.
 */
export async function observeServiceFeeChargeRefunded(params: {
  store: ServiceFeeRefundAssessmentStore;
  charge: ServiceFeeChargeRefundObservation;
  stripe?: ServiceFeeRefundStripeClient;
  trustedAllocation?: ServiceFeeRefundAllocation | null;
  now?: Date;
  deps?: ServiceFeeRefundObservationDependencies;
}): Promise<ServiceFeeRefundObservationResult> {
  const assessment = await resolveServiceFeeAssessmentFromStripeRefs({
    store: params.store,
    chargeId: params.charge.id,
    paymentIntentId: stripeReferenceId(params.charge.payment_intent),
    invoiceId: stripeReferenceId(params.charge.invoice),
  });
  if (!assessment) {
    return ignoredResult(null, params.charge.amount_refunded);
  }
  if (!assessment.settledAt) {
    const refundedGrossMinor = Math.max(0, params.charge.amount_refunded);
    const isFullRefund = params.charge.amount > 0 && refundedGrossMinor >= params.charge.amount;
    await persistRefundObservation({
      store: params.store,
      assessment,
      refundedGrossMinor,
      refundedProductMinor: assessment.refundedProductMinor,
      refundedFeeMinor: assessment.refundedFeeMinor,
      unresolved: !isFullRefund,
      now: params.now,
    });
    throw new ServiceFeeObservationNotReadyError(assessment.assessmentKey);
  }

  const refundedGrossMinor = Math.max(0, params.charge.amount_refunded);
  const isFullRefund = params.charge.amount > 0 && refundedGrossMinor >= params.charge.amount;
  let refunds: { items: Stripe.Refund[]; complete: boolean };
  try {
    refunds = await listChargeRefunds(params.charge, params.stripe);
  } catch {
    refunds = { items: params.charge.refunds?.data ?? [], complete: false };
  }

  let allocation: ServiceFeeRefundAllocation | null = null;
  let complete = false;

  if (isFullRefund) {
    allocation = {
      productMinor: assessment.settledProductMinor,
      feeMinor: assessment.chargedFeeMinor,
    };
    complete = true;
  } else if (params.trustedAllocation) {
    allocation = params.trustedAllocation;
    complete = true;
  } else if (refunds.complete) {
    const fromRefundMetadata = sumRefundMetadataAllocations(refunds.items);
    if (fromRefundMetadata) {
      allocation = fromRefundMetadata;
      complete = true;
    }
  }

  if (!complete) {
    try {
      const fromCreditNotes = await collectCreditNoteAllocations({
        assessment,
        invoiceId: stripeReferenceId(params.charge.invoice) ?? assessment.stripeInvoiceId,
        stripe: params.stripe,
      });
      if (
        fromCreditNotes.complete &&
        (fromCreditNotes.allocation.productMinor > 0 || fromCreditNotes.allocation.feeMinor > 0)
      ) {
        allocation = fromCreditNotes.allocation;
        complete = true;
      }
    } catch {
      // Listing credit notes or invoice lines is supporting evidence only.
      // A Stripe follow-up failure must not block recording the observed gross.
    }
  }

  if (!complete || !allocation) {
    const unresolved = await persistRefundObservation({
      store: params.store,
      assessment,
      refundedGrossMinor,
      refundedProductMinor: assessment.refundedProductMinor,
      refundedFeeMinor: assessment.refundedFeeMinor,
      unresolved: true,
      now: params.now,
    });
    await emitUnresolvedAllocationAlert(unresolved, params.charge, params.deps);
    return {
      status: 'unresolved',
      assessment: unresolved,
      refundedGrossMinor: unresolved.refundedGrossMinor,
      refundedProductMinor: unresolved.refundedProductMinor,
      refundedFeeMinor: unresolved.refundedFeeMinor,
      createdStripeRefund: false,
    };
  }

  const applied = applyAllocation(assessment, allocation);
  const updated = await persistRefundObservation({
    store: params.store,
    assessment,
    refundedGrossMinor,
    refundedProductMinor: applied.productMinor,
    refundedFeeMinor: applied.feeMinor,
    unresolved: false,
    now: params.now,
  });

  return {
    status: isFullRefund ? 'full' : 'allocated',
    assessment: updated,
    refundedGrossMinor: updated.refundedGrossMinor,
    refundedProductMinor: updated.refundedProductMinor,
    refundedFeeMinor: updated.refundedFeeMinor,
    createdStripeRefund: false,
  };
}

/**
 * Observe `credit_note.created` / `credit_note.updated`. Known invoice-line
 * allocations are cumulative and idempotent. Unknown lines are ignored.
 */
export async function observeServiceFeeCreditNote(params: {
  store: ServiceFeeRefundAssessmentStore;
  creditNote: ServiceFeeCreditNoteObservation;
  stripe?: ServiceFeeRefundStripeClient;
  now?: Date;
}): Promise<ServiceFeeRefundObservationResult> {
  const invoiceId = stripeReferenceId(params.creditNote.invoice);
  const assessment = await resolveServiceFeeAssessmentFromStripeRefs({
    store: params.store,
    invoiceId,
  });
  if (!assessment || !invoiceId) {
    return ignoredResult(assessment, assessment?.refundedGrossMinor ?? 0);
  }
  if (!assessment.settledAt) {
    throw new ServiceFeeObservationNotReadyError(assessment.assessmentKey);
  }

  const collected = await collectCreditNoteAllocations({
    assessment,
    invoiceId,
    stripe: params.stripe,
    currentCreditNote: params.creditNote,
  });
  if (
    !collected.complete &&
    collected.allocation.productMinor === 0 &&
    collected.allocation.feeMinor === 0
  ) {
    return {
      status: 'ignored',
      assessment,
      refundedGrossMinor: assessment.refundedGrossMinor,
      refundedProductMinor: assessment.refundedProductMinor,
      refundedFeeMinor: assessment.refundedFeeMinor,
      createdStripeRefund: false,
    };
  }

  const applied = applyAllocation(assessment, collected.allocation);
  const updated = await persistRefundObservation({
    store: params.store,
    assessment,
    refundedGrossMinor: assessment.refundedGrossMinor,
    refundedProductMinor: applied.productMinor,
    refundedFeeMinor: applied.feeMinor,
    unresolved: false,
    now: params.now,
  });

  return {
    status: 'allocated',
    assessment: updated,
    refundedGrossMinor: updated.refundedGrossMinor,
    refundedProductMinor: updated.refundedProductMinor,
    refundedFeeMinor: updated.refundedFeeMinor,
    createdStripeRefund: false,
  };
}

export function buildUnresolvedServiceFeeRefundAllocationAlertText(
  input: UnresolvedServiceFeeRefundAllocationAlertInput
): string {
  return [
    'Service fee refund allocation unresolved',
    `assessment_key=${input.assessmentKey}`,
    `flow=${input.flow}`,
    `owner_id=${nonEmpty(input.organizationId) ?? nonEmpty(input.kiloUserId) ?? 'unknown'}`,
    `stripe_checkout_session_id=${nonEmpty(input.stripeCheckoutSessionId) ?? 'none'}`,
    `stripe_invoice_id=${nonEmpty(input.stripeInvoiceId) ?? 'none'}`,
    `stripe_payment_intent_id=${nonEmpty(input.stripePaymentIntentId) ?? 'none'}`,
    `stripe_charge_id=${nonEmpty(input.stripeChargeId) ?? 'none'}`,
    `refunded_gross_minor=${input.refundedGrossMinor}`,
    `charge_amount_minor=${input.chargeAmountMinor}`,
    `settled_product_minor=${input.settledProductMinor}`,
    `charged_fee_minor=${input.chargedFeeMinor}`,
    `currency=${input.currency}`,
    `failure_code=${SERVICE_FEE_REFUND_ALLOCATION_UNRESOLVED}`,
    `observed_at=${toIsoTimestamp(input.observedAt)}`,
  ].join('\n');
}

/**
 * Apply a refund observed before settlement. Only a full gross refund can be
 * reconstructed from persisted columns; partial allocations wait for webhook
 * retry after `settled_at` is written.
 */
export async function applyDeferredServiceFeeRefunds(params: {
  store: ServiceFeeAssessmentStore;
  assessment: ServiceFeeAssessmentRecord;
  now?: Date;
}): Promise<ServiceFeeAssessmentRecord> {
  const assessment = params.assessment;
  if (!assessment.settledAt) return assessment;
  if (assessment.grossPaidMinor <= 0 || assessment.refundedGrossMinor < assessment.grossPaidMinor) {
    return assessment;
  }
  if (
    assessment.refundedProductMinor === assessment.settledProductMinor &&
    assessment.refundedFeeMinor === assessment.chargedFeeMinor
  ) {
    return assessment;
  }

  return persistRefundObservation({
    store: params.store,
    assessment,
    refundedGrossMinor: assessment.refundedGrossMinor,
    refundedProductMinor: assessment.settledProductMinor,
    refundedFeeMinor: assessment.chargedFeeMinor,
    unresolved: false,
    now: params.now,
  });
}

export async function sendUnresolvedServiceFeeRefundAllocationAlert(
  input: UnresolvedServiceFeeRefundAllocationAlertInput,
  deps: ServiceFeeRefundObservationDependencies = {}
): Promise<void> {
  const sendNotification = deps.sendAlert
    ? async (alertInput: UnresolvedServiceFeeRefundAllocationAlertInput) => {
        await deps.sendAlert?.(alertInput);
      }
    : async (alertInput: UnresolvedServiceFeeRefundAllocationAlertInput) => {
        await sendAdminSlackNotification({
          text: buildUnresolvedServiceFeeRefundAllocationAlertText(alertInput),
          unfurl_links: false,
          unfurl_media: false,
        });
      };
  const capture = deps.captureException ?? captureException;

  try {
    await sendNotification(input);
  } catch (error) {
    const isSlackError = error instanceof AdminSlackNotificationError;
    capture(isSlackError ? error : new Error('Admin Slack notification failed'), {
      tags: { source: SERVICE_FEE_REFUND_ALLOCATION_UNRESOLVED_SENTRY_TAG },
      extra: {
        kind: isSlackError ? error.kind : 'unexpected',
        status: isSlackError ? (error.status ?? null) : null,
        assessmentKey: input.assessmentKey,
        flow: input.flow,
        failureCode: SERVICE_FEE_REFUND_ALLOCATION_UNRESOLVED,
      },
    });
  }
}

function applyAllocation(
  assessment: ServiceFeeAssessmentRecord,
  allocation: ServiceFeeRefundAllocation
): ServiceFeeRefundAllocation {
  return {
    productMinor: Math.max(
      assessment.refundedProductMinor,
      Math.min(allocation.productMinor, assessment.settledProductMinor)
    ),
    feeMinor: Math.max(
      assessment.refundedFeeMinor,
      Math.min(allocation.feeMinor, assessment.chargedFeeMinor)
    ),
  };
}

async function persistRefundObservation(params: {
  store: ServiceFeeAssessmentStore;
  assessment: ServiceFeeAssessmentRecord;
  refundedGrossMinor: number;
  refundedProductMinor: number;
  refundedFeeMinor: number;
  unresolved: boolean;
  now?: Date;
}): Promise<ServiceFeeAssessmentRecord> {
  return observeServiceFeeAssessmentRefunds({
    store: params.store,
    assessmentKey: params.assessment.assessmentKey,
    refundedProductMinor: params.refundedProductMinor,
    refundedFeeMinor: params.refundedFeeMinor,
    refundedGrossMinor: params.refundedGrossMinor,
    unresolved: params.unresolved,
    now: params.now,
  });
}

async function emitUnresolvedAllocationAlert(
  assessment: ServiceFeeAssessmentRecord,
  charge: ServiceFeeChargeRefundObservation,
  deps: ServiceFeeRefundObservationDependencies | undefined
): Promise<void> {
  const input: UnresolvedServiceFeeRefundAllocationAlertInput = {
    assessmentKey: assessment.assessmentKey,
    flow: assessment.flow,
    kiloUserId: assessment.kiloUserId,
    organizationId: assessment.organizationId,
    stripeCheckoutSessionId: assessment.stripeCheckoutSessionId,
    stripeInvoiceId: assessment.stripeInvoiceId,
    stripePaymentIntentId: assessment.stripePaymentIntentId,
    stripeChargeId: assessment.stripeChargeId ?? charge.id,
    refundedGrossMinor: assessment.refundedGrossMinor,
    chargeAmountMinor: charge.amount,
    settledProductMinor: assessment.settledProductMinor,
    chargedFeeMinor: assessment.chargedFeeMinor,
    currency: assessment.currency,
    observedAt: new Date(),
  };

  if (deps?.sendAlert) {
    try {
      await deps.sendAlert(input);
    } catch (error) {
      const capture = deps.captureException ?? captureException;
      capture(error instanceof Error ? error : new Error('Admin Slack notification failed'), {
        tags: { source: SERVICE_FEE_REFUND_ALLOCATION_UNRESOLVED_SENTRY_TAG },
        extra: {
          kind: 'unexpected',
          status: null,
          assessmentKey: assessment.assessmentKey,
          flow: assessment.flow,
          failureCode: SERVICE_FEE_REFUND_ALLOCATION_UNRESOLVED,
        },
      });
    }
    return;
  }

  await sendUnresolvedServiceFeeRefundAllocationAlert(input, deps);
}

async function listChargeRefunds(
  charge: ServiceFeeChargeRefundObservation,
  stripe: ServiceFeeRefundStripeClient | undefined
): Promise<{ items: Stripe.Refund[]; complete: boolean }> {
  if (charge.refunds && !charge.refunds.has_more) {
    return { items: charge.refunds.data, complete: true };
  }
  if (!stripe) {
    return { items: charge.refunds?.data ?? [], complete: false };
  }

  const items = await listAllPages(startingAfter =>
    stripe.refunds.list({
      charge: charge.id,
      limit: PAGE_SIZE,
      ...(startingAfter ? { starting_after: startingAfter } : {}),
    })
  );
  return { items, complete: true };
}

function sumRefundMetadataAllocations(
  refunds: readonly Stripe.Refund[]
): ServiceFeeRefundAllocation | null {
  const counted = refunds.filter(refund => COUNTED_REFUND_STATUSES.has(refund.status ?? ''));
  if (counted.length === 0) return null;

  let productMinor = 0;
  let feeMinor = 0;
  for (const refund of counted) {
    const allocation = parseServiceFeeRefundAllocationMetadata(refund.metadata);
    if (!allocation) return null;
    productMinor += allocation.productMinor;
    feeMinor += allocation.feeMinor;
  }
  return { productMinor, feeMinor };
}

async function collectCreditNoteAllocations(params: {
  assessment: ServiceFeeAssessmentRecord;
  invoiceId: string | null;
  stripe?: ServiceFeeRefundStripeClient;
  currentCreditNote?: ServiceFeeCreditNoteObservation;
}): Promise<{ allocation: ServiceFeeRefundAllocation; complete: boolean }> {
  if (!params.invoiceId) {
    return { allocation: { productMinor: 0, feeMinor: 0 }, complete: false };
  }

  const creditNotes = await listInvoiceCreditNotes(
    params.invoiceId,
    params.stripe,
    params.currentCreditNote
  );
  const invoiceLines = await listInvoiceLines(params.invoiceId, params.stripe);
  const invoiceLinesById = new Map(invoiceLines.items.map(line => [line.id, line]));

  let productMinor = 0;
  let feeMinor = 0;
  let complete = creditNotes.complete && invoiceLines.complete;

  for (const creditNote of creditNotes.items) {
    if (creditNote.status === 'void') continue;
    const lines = await listCreditNoteLines(creditNote, params.stripe);
    if (!lines.complete) complete = false;
    for (const line of lines.items) {
      const classified = classifyCreditNoteLine(line, params.assessment, invoiceLinesById);
      if (classified === 'fee') {
        feeMinor += Math.max(0, line.amount);
        continue;
      }
      if (classified === 'product') {
        productMinor += Math.max(0, line.amount);
        continue;
      }
      if (classified === 'ignored') continue;
      complete = false;
    }
  }

  return { allocation: { productMinor, feeMinor }, complete };
}

async function listInvoiceCreditNotes(
  invoiceId: string,
  stripe: ServiceFeeRefundStripeClient | undefined,
  current?: ServiceFeeCreditNoteObservation
): Promise<{ items: ServiceFeeCreditNoteObservation[]; complete: boolean }> {
  const listCreditNotes = stripe?.creditNotes?.list;
  if (!listCreditNotes) {
    return {
      items: current ? [current] : [],
      complete: Boolean(current && current.lines && !current.lines.has_more),
    };
  }

  const items = await listAllPages(startingAfter =>
    listCreditNotes({
      invoice: invoiceId,
      limit: PAGE_SIZE,
      ...(startingAfter ? { starting_after: startingAfter } : {}),
    })
  );
  return { items, complete: true };
}

async function listCreditNoteLines(
  creditNote: ServiceFeeCreditNoteObservation,
  stripe: ServiceFeeRefundStripeClient | undefined
): Promise<{ items: Stripe.CreditNoteLineItem[]; complete: boolean }> {
  if (creditNote.lines && !creditNote.lines.has_more) {
    return { items: creditNote.lines.data, complete: true };
  }
  const listLineItems = stripe?.creditNotes?.listLineItems;
  if (!listLineItems) {
    return { items: creditNote.lines?.data ?? [], complete: false };
  }
  const items = await listAllPages(startingAfter =>
    listLineItems(creditNote.id, {
      limit: PAGE_SIZE,
      ...(startingAfter ? { starting_after: startingAfter } : {}),
    })
  );
  return { items, complete: true };
}

async function listInvoiceLines(
  invoiceId: string,
  stripe: ServiceFeeRefundStripeClient | undefined
): Promise<{ items: Stripe.InvoiceLineItem[]; complete: boolean }> {
  const listLineItems = stripe?.invoices?.listLineItems;
  if (!listLineItems) {
    return { items: [], complete: false };
  }
  const items = await listAllPages(startingAfter =>
    listLineItems(invoiceId, {
      limit: PAGE_SIZE,
      ...(startingAfter ? { starting_after: startingAfter } : {}),
    })
  );
  return { items, complete: true };
}

function classifyCreditNoteLine(
  line: Stripe.CreditNoteLineItem,
  assessment: ServiceFeeAssessmentRecord,
  invoiceLinesById: Map<string, Stripe.InvoiceLineItem>
): 'fee' | 'product' | 'ignored' | 'unknown' {
  if (line.type !== 'invoice_line_item' || !line.invoice_line_item) {
    return line.amount === 0 ? 'ignored' : 'unknown';
  }
  if (line.invoice_line_item === assessment.stripeInvoiceFeeLineItemId) {
    return 'fee';
  }

  const invoiceLine = invoiceLinesById.get(line.invoice_line_item);
  if (!invoiceLine) {
    return assessment.stripeInvoiceFeeLineItemId ? 'product' : 'unknown';
  }
  if (isServiceFeeInvoiceLine(invoiceLine)) return 'fee';
  if (isSeatInvoiceLine(invoiceLine) || isKiloClawInvoiceLine(invoiceLine)) return 'ignored';
  return 'product';
}

async function listAllPages<T extends { id: string }>(
  listPage: (startingAfter: string | undefined) => Promise<ServiceFeeRefundPage<T>>
): Promise<T[]> {
  const rows: T[] = [];
  let startingAfter: string | undefined;

  for (;;) {
    const page = await listPage(startingAfter);
    rows.push(...page.data);
    if (!page.has_more) return rows;
    const cursor = page.data.at(-1)?.id;
    if (!cursor) {
      throw new Error('stripe page is marked has_more without a cursor');
    }
    startingAfter = cursor;
  }
}

function ignoredResult(
  assessment: ServiceFeeAssessmentRecord | null,
  refundedGrossMinor: number
): ServiceFeeRefundObservationResult {
  return {
    status: 'ignored',
    assessment,
    refundedGrossMinor,
    refundedProductMinor: assessment?.refundedProductMinor ?? 0,
    refundedFeeMinor: assessment?.refundedFeeMinor ?? 0,
    createdStripeRefund: false,
  };
}

function parseMinorMetadata(value: unknown): number | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) return null;
  return parsed;
}

function nonEmpty(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function toIsoTimestamp(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return 'invalid_timestamp';
  return date.toISOString();
}

function assertNonNegativeSafeInteger(value: number, label: string): void {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer`);
  }
}
