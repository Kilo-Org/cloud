import 'server-only';

import type Stripe from 'stripe';

import { getOrganizationKiloPassMetadata } from '@/lib/kilo-pass-org/stripe-metadata';
import { getKiloPassMetadataFromStripeMetadata } from '@/lib/kilo-pass/stripe-handlers-metadata';
import {
  sendMissedServiceFeeAlert,
  type MissedServiceFeeAlertInput,
} from '@/lib/service-fees/alerts';
import {
  markServiceFeeAssessmentCharged,
  markServiceFeeAssessmentMissed,
  prepareServiceFeeAssessmentDecision,
  upsertServiceFeeAssessment,
  type EffectiveExemptionLookup,
  type ServiceFeeAssessmentRecord,
  type ServiceFeeAssessmentStore,
  type ServiceFeeStripeIds,
} from '@/lib/service-fees/assessments';
import {
  buildAutoTopUpServiceFeeInvoiceItem,
  createInvoiceServiceFeeAssessmentKey,
  isKiloOwnedAutoTopUpInvoice,
  SERVICE_FEE_FAILURE_APPLICATION,
} from '@/lib/service-fees/checkout';
import {
  isEligibleKiloPassInvoiceLine,
  isServiceFeeInvoiceLine,
  listAllInvoiceLineItems,
  sumEligibleKiloPassSubtotalMinor,
  type InvoiceLineItemListClient,
} from '@/lib/service-fees/stripe-lines';
import {
  resolveServiceFeeTaxInput,
  type ServiceFeeTaxInput,
  type ServiceFeeTaxPrincipal,
  type StripePriceTaxReader,
} from '@/lib/service-fees/tax';
import { SERVICE_FEE_SUPPORTED_CURRENCY, type ServiceFeeFlow } from '@/lib/service-fees/types';

export type KiloPassInvoiceCreatedStripe = InvoiceLineItemListClient & {
  prices?: StripePriceTaxReader['prices'];
  invoiceItems?: {
    create(
      params: Stripe.InvoiceItemCreateParams
    ): Promise<Pick<Stripe.InvoiceItem, 'id' | 'amount'>>;
  };
  subscriptions?: {
    retrieve(id: string): Promise<Stripe.Subscription>;
  };
};

export type KiloPassInvoiceCreatedDependencies = {
  now?: Date;
  findEffectiveExemption?: EffectiveExemptionLookup;
  resolveTaxInput?: (params: {
    principal: ServiceFeeTaxPrincipal;
    stripe?: StripePriceTaxReader;
  }) => Promise<ServiceFeeTaxInput>;
  sendAlert?: (input: MissedServiceFeeAlertInput) => Promise<void>;
  getOrganizationPurchaseChannel?: (
    organizationId: string
  ) => Promise<'self_serve' | 'manual' | null>;
  isStoreManaged?: (input: {
    invoice: Stripe.Invoice;
    subscription: Stripe.Subscription | null;
  }) => Promise<boolean>;
  ownsSynchronousAttachment?: boolean;
};

export type KiloPassInvoiceCreatedResult = {
  status: 'skipped' | 'assessed' | 'charged' | 'missed';
  assessment: ServiceFeeAssessmentRecord | null;
};

type ClassifiedKiloPassInvoice = {
  flow: Extract<ServiceFeeFlow, 'personal_kilo_pass' | 'organization_kilo_pass'>;
  kiloUserId?: string;
  organizationId?: string;
};

/**
 * Attach at most one Kilo Pass service-fee item to a Stripe-owned draft invoice.
 * Kilo-owned auto-top-up invoices, non-draft invoices, and excluded products are
 * skipped. Fee-domain failures persist `missed` and return normally.
 */
export async function handleKiloPassInvoiceCreated(params: {
  invoice: Stripe.Invoice;
  stripe: KiloPassInvoiceCreatedStripe;
  store: ServiceFeeAssessmentStore;
  deps?: KiloPassInvoiceCreatedDependencies;
}): Promise<KiloPassInvoiceCreatedResult> {
  const deps = params.deps ?? {};
  const now = deps.now ?? new Date();

  if (isKiloOwnedAutoTopUpInvoice(params.invoice)) {
    return skipped();
  }
  if (!params.invoice.id) {
    return skipped();
  }

  try {
    const subscription = await loadSubscription(params.invoice, params.stripe);
    if (await deps.isStoreManaged?.({ invoice: params.invoice, subscription })) {
      return skipped();
    }

    const lines = await listAllInvoiceLineItems({
      invoice: params.invoice,
      stripe: params.stripe,
    });
    const classified = await classifyEligibleKiloPassInvoice({
      invoice: params.invoice,
      lines,
      subscription,
      getOrganizationPurchaseChannel: deps.getOrganizationPurchaseChannel,
    });
    if (!classified) {
      return skipped();
    }

    const assessmentKey = resolveInvoiceAssessmentKey(params.invoice, subscription, lines);
    const existingFeeLine = findAssessmentFeeLine(lines, assessmentKey);
    const existing = await params.store.findByAssessmentKey(assessmentKey);
    if (
      !assessmentKey.startsWith('invoice:') &&
      !existingFeeLine &&
      !deps.ownsSynchronousAttachment
    ) {
      return existing ? { status: 'assessed', assessment: existing } : skipped();
    }
    if (existing && (existing.outcome === 'charged' || existing.outcome === 'missed')) {
      return {
        status: existing.outcome,
        assessment: existing,
      };
    }
    const eligibleSubtotalMinor = sumEligibleKiloPassSubtotalMinor({
      lines,
      currency: params.invoice.currency || SERVICE_FEE_SUPPORTED_CURRENCY,
      subscription,
    });
    const eligibilityCreatedAt = unixToDate(params.invoice.created) ?? now;
    const stripeIds = invoiceStripeIds(params.invoice);

    const decision = await prepareServiceFeeAssessmentDecision(
      {
        assessmentKey,
        flow: classified.flow,
        currency: params.invoice.currency || SERVICE_FEE_SUPPORTED_CURRENCY,
        eligibilityCreatedAt,
        eligibleSubtotalMinor,
        kiloUserId: classified.kiloUserId,
        organizationId: classified.organizationId,
        stripeCustomerId: stripeIds.stripeCustomerId ?? undefined,
      },
      { findEffectiveExemption: deps.findEffectiveExemption }
    );

    const record = await upsertServiceFeeAssessment({
      store: params.store,
      decision,
      stripeIds,
      now,
    });

    if (record.outcome !== 'pending') {
      return { status: 'assessed', assessment: record };
    }

    if (existingFeeLine) {
      const charged = await markServiceFeeAssessmentCharged({
        store: params.store,
        assessmentKey,
        chargedFeeMinor: Math.max(0, existingFeeLine.amount),
        stripeIds: {
          ...stripeIds,
          stripeInvoiceFeeLineItemId: existingFeeLine.id,
        },
        now,
      });
      return { status: 'charged', assessment: charged };
    }

    if (params.invoice.status !== 'draft') {
      return persistMissed({
        store: params.store,
        assessmentKey,
        stripeIds,
        failureCode: 'invoice_not_draft',
        record,
        deps,
        now,
      });
    }

    const resolveTax = deps.resolveTaxInput ?? resolveServiceFeeTaxInput;
    let taxInput: ServiceFeeTaxInput;
    try {
      taxInput = await resolveTax({
        principal: taxPrincipalFromLines(lines, subscription),
        stripe: params.stripe.prices ? { prices: params.stripe.prices } : undefined,
      });
    } catch {
      return persistMissed({
        store: params.store,
        assessmentKey,
        stripeIds,
        failureCode: SERVICE_FEE_FAILURE_APPLICATION,
        record,
        deps,
        now,
      });
    }
    if (!params.stripe.invoiceItems?.create || !stripeIds.stripeCustomerId) {
      return persistMissed({
        store: params.store,
        assessmentKey,
        stripeIds,
        failureCode: SERVICE_FEE_FAILURE_APPLICATION,
        record,
        deps,
        now,
      });
    }

    try {
      const item = await params.stripe.invoiceItems.create(
        buildAutoTopUpServiceFeeInvoiceItem({
          assessmentKey,
          invoiceId: params.invoice.id,
          customerId: stripeIds.stripeCustomerId,
          feeMinor: decision.expectedFeeMinor,
          taxInput,
        })
      );
      const charged = await markServiceFeeAssessmentCharged({
        store: params.store,
        assessmentKey,
        chargedFeeMinor: decision.expectedFeeMinor,
        stripeIds: {
          ...stripeIds,
          stripeInvoiceFeeLineItemId: item.id,
        },
        now,
      });
      return { status: 'charged', assessment: charged };
    } catch (error) {
      return persistMissed({
        store: params.store,
        assessmentKey,
        stripeIds,
        failureCode: failureCodeFromUnknown(error, SERVICE_FEE_FAILURE_APPLICATION),
        record,
        deps,
        now,
      });
    }
  } catch (error) {
    const metadataSources = collectMetadata(params.invoice, null);
    const organization = firstPresent(metadataSources, getOrganizationKiloPassMetadata);
    const personal = firstPresent(metadataSources, getKiloPassMetadataFromStripeMetadata);
    await alertSafely({
      assessmentKey: params.invoice.id
        ? createInvoiceServiceFeeAssessmentKey(params.invoice.id)
        : 'invoice:unknown',
      flow: organization ? 'organization_kilo_pass' : 'personal_kilo_pass',
      kiloUserId: organization?.kiloUserId ?? personal?.kiloUserId,
      organizationId: organization?.organizationId,
      stripeInvoiceId: params.invoice.id,
      eligibleSubtotalMinor: 0,
      expectedFeeMinor: 0,
      failureCode: failureCodeFromUnknown(error, SERVICE_FEE_FAILURE_APPLICATION),
      deps,
      now,
    });
    return skipped();
  }
}

async function classifyEligibleKiloPassInvoice(input: {
  invoice: Stripe.Invoice;
  lines: readonly Stripe.InvoiceLineItem[];
  subscription: Stripe.Subscription | null;
  getOrganizationPurchaseChannel?: KiloPassInvoiceCreatedDependencies['getOrganizationPurchaseChannel'];
}): Promise<ClassifiedKiloPassInvoice | null> {
  const metadataSources = collectMetadata(input.invoice, input.subscription);
  const organization = firstPresent(metadataSources, getOrganizationKiloPassMetadata);
  const personal = firstPresent(metadataSources, getKiloPassMetadataFromStripeMetadata);
  const hasEligibleLine = input.lines.some(line =>
    isEligibleKiloPassInvoiceLine(line, input.subscription)
  );

  if (organization) {
    const channel = input.getOrganizationPurchaseChannel
      ? await input.getOrganizationPurchaseChannel(organization.organizationId)
      : 'self_serve';
    if (channel !== 'self_serve') {
      return null;
    }
    if (!hasEligibleLine) {
      return null;
    }
    return {
      flow: 'organization_kilo_pass',
      organizationId: organization.organizationId,
      kiloUserId: organization.kiloUserId,
    };
  }

  if (!hasEligibleLine) {
    return null;
  }
  if (!personal?.kiloUserId) {
    return null;
  }
  return {
    flow: 'personal_kilo_pass',
    kiloUserId: personal.kiloUserId,
  };
}

function collectMetadata(
  invoice: Stripe.Invoice,
  subscription: Stripe.Subscription | null
): Array<Stripe.Metadata | null | undefined> {
  return [invoice.metadata, invoice.parent?.subscription_details?.metadata, subscription?.metadata];
}

function firstPresent<T>(
  sources: Array<Stripe.Metadata | null | undefined>,
  read: (metadata: Stripe.Metadata | null | undefined) => T | null
): T | null {
  for (const source of sources) {
    const value = read(source);
    if (value) return value;
  }
  return null;
}

function resolveInvoiceAssessmentKey(
  invoice: Stripe.Invoice,
  subscription: Stripe.Subscription | null,
  lines: readonly Stripe.InvoiceLineItem[]
): string {
  const metadataKey = collectMetadata(invoice, subscription)
    .map(metadata => metadata?.serviceFeeAssessmentKey?.trim())
    .find(Boolean);
  if (metadataKey) return metadataKey;

  const feeLineKey = lines
    .filter(isServiceFeeInvoiceLine)
    .map(line => line.metadata?.serviceFeeAssessmentKey?.trim())
    .find(Boolean);
  return feeLineKey || createInvoiceServiceFeeAssessmentKey(invoice.id);
}

function findAssessmentFeeLine(
  lines: readonly Stripe.InvoiceLineItem[],
  assessmentKey: string | null
): Stripe.InvoiceLineItem | undefined {
  return lines.find(line => {
    if (!isServiceFeeInvoiceLine(line)) return false;
    if (!assessmentKey) return true;
    return line.metadata?.serviceFeeAssessmentKey === assessmentKey;
  });
}

function taxPrincipalFromLines(
  lines: readonly Stripe.InvoiceLineItem[],
  subscription: Stripe.Subscription | null
): ServiceFeeTaxPrincipal {
  const eligible = lines.find(line => isEligibleKiloPassInvoiceLine(line, subscription));
  const priceId = eligible?.pricing?.price_details?.price;
  return priceId ? { kind: 'price', priceId } : { kind: 'inline' };
}

async function loadSubscription(
  invoice: Stripe.Invoice,
  stripe: KiloPassInvoiceCreatedStripe
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

async function persistMissed(params: {
  store: ServiceFeeAssessmentStore;
  assessmentKey: string;
  stripeIds: ServiceFeeStripeIds;
  failureCode: string;
  record: ServiceFeeAssessmentRecord;
  deps: KiloPassInvoiceCreatedDependencies;
  now: Date;
}): Promise<KiloPassInvoiceCreatedResult> {
  try {
    const missed = await markServiceFeeAssessmentMissed({
      store: params.store,
      assessmentKey: params.assessmentKey,
      failureCode: params.failureCode,
      stripeIds: params.stripeIds,
      now: params.now,
    });
    await alertSafely({
      assessmentKey: missed.assessmentKey,
      flow: missed.flow,
      kiloUserId: missed.kiloUserId,
      organizationId: missed.organizationId,
      stripeInvoiceId: missed.stripeInvoiceId,
      eligibleSubtotalMinor: missed.eligibleSubtotalMinor,
      expectedFeeMinor: missed.expectedFeeMinor,
      failureCode: missed.failureCode ?? params.failureCode,
      deps: params.deps,
      now: params.now,
    });
    return { status: 'missed', assessment: missed };
  } catch (error) {
    await alertSafely({
      assessmentKey: params.assessmentKey,
      flow: params.record.flow,
      kiloUserId: params.record.kiloUserId,
      organizationId: params.record.organizationId,
      stripeInvoiceId: params.stripeIds.stripeInvoiceId,
      eligibleSubtotalMinor: params.record.eligibleSubtotalMinor,
      expectedFeeMinor: params.record.expectedFeeMinor,
      failureCode: failureCodeFromUnknown(error, params.failureCode),
      deps: params.deps,
      now: params.now,
    });
    return { status: 'missed', assessment: params.record };
  }
}

async function alertSafely(params: {
  assessmentKey: string;
  flow: ServiceFeeFlow;
  kiloUserId?: string | null;
  organizationId?: string | null;
  stripeInvoiceId?: string | null;
  eligibleSubtotalMinor: number;
  expectedFeeMinor: number;
  failureCode: string;
  deps: KiloPassInvoiceCreatedDependencies;
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
      eligibleSubtotalMinor: params.eligibleSubtotalMinor,
      expectedFeeMinor: params.expectedFeeMinor,
      currency: SERVICE_FEE_SUPPORTED_CURRENCY,
      failureCode: params.failureCode,
      attemptedAt: params.now,
    });
  } catch {
    // Slack/Sentry failure must not change invoice-created outcome.
  }
}

function invoiceStripeIds(invoice: Stripe.Invoice): ServiceFeeStripeIds {
  return {
    stripeInvoiceId: invoice.id,
    stripeCustomerId: customerId(invoice.customer),
  };
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

function unixToDate(value: number | null | undefined): Date | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  return new Date(value * 1000);
}

function failureCodeFromUnknown(error: unknown, fallback: string): string {
  if (error instanceof Error && /^[a-z][a-z0-9_]{0,99}$/.test(error.message)) {
    return error.message;
  }
  return fallback;
}

function skipped(): KiloPassInvoiceCreatedResult {
  return { status: 'skipped', assessment: null };
}

export { SERVICE_FEE_FAILURE_APPLICATION };
