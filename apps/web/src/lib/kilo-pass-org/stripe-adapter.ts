import 'server-only';

import { randomUUID } from 'node:crypto';
import type Stripe from 'stripe';
import { and, desc, eq, ne } from 'drizzle-orm';
import { kilo_pass_org_agreements, organization_seats_purchases } from '@kilocode/db/schema';
import {
  KiloPassOrgAgreementState,
  KiloPassOrgProcessingCondition,
  KiloPassOrgPurchaseChannel,
} from '@kilocode/db/schema-types';
import type { KiloPassCadence, KiloPassTier } from '@/lib/kilo-pass/enums';
import { db } from '@/lib/drizzle';
import { client as stripe } from '@/lib/stripe-client';
import {
  getKnownStripePriceIdsForKiloPass,
  getStripePriceIdForKiloPass,
} from '@/lib/kilo-pass/stripe-price-ids.server';
import { isSeatLineItem } from '@/lib/organizations/stripe-seat-line-items';
import {
  handleKiloPassInvoiceCreated,
  SERVICE_FEE_FAILURE_APPLICATION,
  type KiloPassInvoiceCreatedDependencies,
  type KiloPassInvoiceCreatedResult,
  type KiloPassInvoiceCreatedStripe,
} from '@/lib/service-fees/invoice-created';
import { createServiceFeeStores } from '@/lib/service-fees/drizzle-store';
import { getEffectiveOrganizationServiceFeeExemption } from '@/lib/service-fees/organization-exemptions';
import { reportChargeAttempted, type ChargeAttemptContext } from '@/lib/bouncer/credit-events';
import {
  buildServiceFeeCommercialMetadata,
  getInvoiceLineInvoiceItemId,
  isEligibleKiloPassInvoiceLine,
  isServiceFeeInvoiceLine,
  isServiceFeeMetadata,
  listAllInvoiceLineItems,
  sumEligibleKiloPassSubtotalMinor,
  type InvoiceLineItemListClient,
} from '@/lib/service-fees/stripe-lines';
import {
  markServiceFeeAssessmentCharged,
  markServiceFeeAssessmentMissed,
  prepareServiceFeeAssessmentDecision,
  upsertServiceFeeAssessment,
  type ServiceFeeAssessmentRecord,
  type ServiceFeeAssessmentStore,
  type ServiceFeeStripeIds,
} from '@/lib/service-fees/assessments';
import { buildAutoTopUpServiceFeeInvoiceItem } from '@/lib/service-fees/checkout';
import {
  resolveServiceFeeTaxInput,
  type ServiceFeeTaxInput,
  type ServiceFeeTaxPrincipal,
  type StripePriceTaxReader,
} from '@/lib/service-fees/tax';
import {
  sendMissedServiceFeeAlert,
  type MissedServiceFeeAlertInput,
} from '@/lib/service-fees/alerts';
import {
  settleKiloPassInvoiceServiceFee,
  type KiloPassServiceFeeSettlementDependencies,
  type KiloPassServiceFeeSettlementStripe,
  type ServiceFeeSettlementStore,
} from '@/lib/service-fees/settlement';
import {
  SERVICE_FEE_SUPPORTED_CURRENCY,
  type ServiceFeeCommercialMetadata,
} from '@/lib/service-fees/types';
import {
  activatePaidAgreement,
  bindProviderSeatAddOnItem,
  createParentSupplement,
  createPendingAgreement,
  endAgreementAfterPassItemRemoved,
  suspendAgreementForPaymentReview,
} from './service';
import {
  activeAndFuturePhases,
  classifyCancellationSchedule,
  isOwnedCancellationSchedule,
  isTerminalScheduleStatus,
  OrganizationKiloPassCheckoutScheduleError,
  ORGANIZATION_KILO_PASS_CANCELLATION_ORIGIN,
  phaseItemPriceId,
  phaseUpdateParams,
  releaseCancellationSchedule,
  reportOrganizationKiloPassScheduleProblem,
  retrieveAttachedSchedule,
  subscriptionScheduleItems,
  subscriptionScheduleItemsWithout,
  throwUnsafeOrganizationKiloPassSchedule,
  type OrganizationKiloPassCheckoutScheduleErrorReason,
  type ScheduleReleaseResult,
} from './cancellation-schedule';
import {
  getOrganizationKiloPassMetadata,
  ORGANIZATION_KILO_PASS_METADATA_TYPE,
} from '@/lib/kilo-pass-org/stripe-metadata';
import { monthlyWindowContaining, type IssuanceWindow } from './calculations';

export {
  getOrganizationKiloPassMetadata,
  ORGANIZATION_KILO_PASS_METADATA_TYPE,
} from '@/lib/kilo-pass-org/stripe-metadata';

function intervalToCadence(
  interval: Stripe.Price.Recurring.Interval | undefined
): 'monthly' | 'yearly' {
  if (interval === 'year') return 'yearly';
  return 'monthly';
}

function subscriptionMetadata(subscription: Stripe.Subscription) {
  return getOrganizationKiloPassMetadata(subscription.metadata);
}

function periodForItem(item: Stripe.SubscriptionItem) {
  if (!item.current_period_start || !item.current_period_end)
    throw new Error(`Organization Kilo Pass item ${item.id} has no billing period`);
  return {
    start: new Date(item.current_period_start * 1000),
    end: new Date(item.current_period_end * 1000),
  };
}

function isPendingProviderItemId(itemId: string | null | undefined): boolean {
  return typeof itemId === 'string' && itemId.startsWith('pending:');
}

function isServiceFeeSubscriptionItem(item: Stripe.SubscriptionItem): boolean {
  if (isServiceFeeMetadata(item.metadata) || isServiceFeeMetadata(item.price?.metadata)) {
    return true;
  }
  const product = item.price?.product;
  return (
    typeof product === 'object' &&
    product !== null &&
    !product.deleted &&
    isServiceFeeMetadata(product.metadata)
  );
}

function isCandidateOrganizationPassItem(item: Stripe.SubscriptionItem): boolean {
  return !isSeatLineItem(item) && !isServiceFeeSubscriptionItem(item);
}

/**
 * Locate the bound Kilo Pass organization subscription item.
 * Order: persisted provider item id, known Kilo Pass Price id, then metadata.
 * Seat and service-fee items are never candidates. The fee must not change
 * which item, period, quantity, or capacity this returns.
 */
export function resolveOrganizationKiloPassSubscriptionItem(input: {
  subscription: Stripe.Subscription;
  boundProviderItemId?: string | null;
}): Stripe.SubscriptionItem | undefined {
  const items = input.subscription.items.data;
  const boundId = input.boundProviderItemId;
  if (boundId && !isPendingProviderItemId(boundId)) {
    const bound = items.find(item => item.id === boundId && isCandidateOrganizationPassItem(item));
    if (bound) return bound;
  }

  const knownPriceIds = new Set(getKnownStripePriceIdsForKiloPass());
  const byKnownPrice = items.find(
    item => isCandidateOrganizationPassItem(item) && knownPriceIds.has(item.price.id)
  );
  if (byKnownPrice) return byKnownPrice;

  const byItemMetadata = items.find(
    item =>
      isCandidateOrganizationPassItem(item) &&
      getOrganizationKiloPassMetadata(item.metadata) !== null
  );
  if (byItemMetadata) return byItemMetadata;

  if (!getOrganizationKiloPassMetadata(input.subscription.metadata)) return undefined;
  const metadataCandidates = items.filter(isCandidateOrganizationPassItem);
  if (metadataCandidates.length === 1) return metadataCandidates[0];
  return undefined;
}

function organizationPassItem(
  subscription: Stripe.Subscription,
  boundProviderItemId?: string | null
) {
  const item = resolveOrganizationKiloPassSubscriptionItem({
    subscription,
    boundProviderItemId,
  });
  if (!item) throw new Error(`Subscription ${subscription.id} has no Kilo Pass organization item`);
  return item;
}

function paidSeatItem(subscription: Stripe.Subscription) {
  const item = subscription.items.data.find(isSeatLineItem);
  if (!item) throw new Error(`Subscription ${subscription.id} has no seat item`);
  return item;
}

export type OrganizationKiloPassServiceFeeAttachment = {
  invoice: Stripe.Invoice;
  subscription?: Stripe.Subscription | null;
  stripe?: KiloPassInvoiceCreatedStripe;
  store?: ServiceFeeAssessmentStore;
  deps?: KiloPassInvoiceCreatedDependencies;
};

async function lookupOrganizationKiloPassPurchaseChannel(
  organizationId: string
): Promise<'self_serve' | 'manual' | null> {
  const [agreement] = await db
    .select({ purchaseChannel: kilo_pass_org_agreements.purchase_channel })
    .from(kilo_pass_org_agreements)
    .where(
      and(
        eq(kilo_pass_org_agreements.parent_organization_id, organizationId),
        ne(kilo_pass_org_agreements.state, KiloPassOrgAgreementState.Ended)
      )
    )
    .orderBy(desc(kilo_pass_org_agreements.created_at))
    .limit(1);
  if (
    agreement?.purchaseChannel === KiloPassOrgPurchaseChannel.SelfServe ||
    agreement?.purchaseChannel === KiloPassOrgPurchaseChannel.Manual
  ) {
    return agreement.purchaseChannel;
  }
  return null;
}

/**
 * Attach at most one non-discountable service fee to a self-service org Kilo
 * Pass draft invoice. The fee is calculated from the aggregate net Kilo Pass
 * product only; seats and existing fee lines are excluded. Exact-organization
 * exemption is used with no hierarchy inheritance. Tax-unapproved and other
 * fee-domain failures persist `missed` and return normally.
 *
 * Used by `createOrganizationKiloPassCheckout`, which already holds the draft
 * invoice id. `handleUpdateSeatCount` must not call this: it previews, decides,
 * and persists outside the seat advisory lock, then attaches only the prepared
 * invoice item with `attachPreparedOrganizationKiloPassServiceFee`.
 * Resolve the pass item with `resolveOrganizationKiloPassSubscriptionItem`
 * instead of first-non-seat; this attach never changes the bound item, period,
 * quantity, or capacity.
 */
export async function attachOrganizationKiloPassServiceFeeToDraftInvoice(
  params: OrganizationKiloPassServiceFeeAttachment
): Promise<KiloPassInvoiceCreatedResult> {
  const createdStores = params.store === undefined ? createServiceFeeStores() : undefined;
  const store = params.store ?? createdStores?.assessments;
  if (store === undefined) {
    throw new Error('organization Kilo Pass service-fee store is unavailable');
  }
  return handleKiloPassInvoiceCreated({
    invoice: params.invoice,
    stripe: params.stripe ?? {
      prices: stripe.prices,
      invoices: stripe.invoices,
      invoiceItems: stripe.invoiceItems,
      subscriptions: stripe.subscriptions,
    },
    store,
    deps: {
      findEffectiveExemption: createdStores
        ? async (organizationId, at) =>
            getEffectiveOrganizationServiceFeeExemption({
              store: createdStores.exemptions,
              organizationId,
              at,
            })
        : undefined,
      getOrganizationPurchaseChannel: lookupOrganizationKiloPassPurchaseChannel,
      ...params.deps,
      ownsSynchronousAttachment: true,
    },
  });
}

const SERVICE_FEE_FAILURE_INVOICE_NOT_DRAFT = 'invoice_not_draft' as const;

export type OrganizationKiloPassSeatCapacityStripe = InvoiceLineItemListClient & {
  invoices: InvoiceLineItemListClient['invoices'] & {
    createPreview(
      params: Stripe.InvoiceCreatePreviewParams
    ): Promise<
      Pick<Stripe.Invoice, 'id' | 'currency' | 'customer' | 'created' | 'status' | 'lines'>
    >;
  };
  invoiceItems?: {
    create(
      params: Stripe.InvoiceItemCreateParams
    ): Promise<Pick<Stripe.InvoiceItem, 'id' | 'amount'>>;
    list?(
      params: Stripe.InvoiceItemListParams
    ): Promise<Pick<Stripe.ApiList<Stripe.InvoiceItem>, 'data' | 'has_more'>>;
    del?(id: string): Promise<unknown>;
  };
  prices?: StripePriceTaxReader['prices'];
};

export type OrganizationKiloPassSeatCapacityFeeDependencies = KiloPassInvoiceCreatedDependencies & {
  now?: Date;
  resolveTaxInput?: (params: {
    principal: ServiceFeeTaxPrincipal;
    stripe?: StripePriceTaxReader;
  }) => Promise<ServiceFeeTaxInput>;
  sendAlert?: (input: MissedServiceFeeAlertInput) => Promise<void>;
};

export type PreparedOrganizationKiloPassSeatCapacityFee = {
  prorationDate: number;
  organizationPassItemId: string | null;
  shouldAttach: boolean;
  assessmentKey: string | null;
  assessment: ServiceFeeAssessmentRecord | null;
  feeInvoiceItem: Omit<Stripe.InvoiceItemCreateParams, 'invoice'> | null;
  expectedFeeMinor: number;
  commercialMetadata: ServiceFeeCommercialMetadata | null;
};

export function createSeatCapacityServiceFeeAssessmentKey(input: {
  subscriptionId: string;
  prorationDate: number;
  paidSeatQuantity: number;
}): string {
  return `seat-capacity:${input.subscriptionId}:${input.prorationDate}:${input.paidSeatQuantity}`;
}

export function createOrgCheckoutServiceFeeAssessmentKey(id: string = randomUUID()): string {
  return `org-checkout:${id}`;
}

function emptyPreparedSeatCapacityFee(
  prorationDate: number,
  organizationPassItemId: string | null = null
): PreparedOrganizationKiloPassSeatCapacityFee {
  return {
    prorationDate,
    organizationPassItemId,
    shouldAttach: false,
    assessmentKey: null,
    assessment: null,
    feeInvoiceItem: null,
    expectedFeeMinor: 0,
    commercialMetadata: null,
  };
}

/**
 * Preview a seat+pass quantity increase and persist the fee decision before
 * `handleUpdateSeatCount` takes the advisory lock. Seat-only, decreases,
 * missing org identity, and manual agreements skip preview and assessment.
 * Tax-unapproved and other fee-domain failures persist `missed` and return
 * without an attachable item so the base update can continue.
 */
export async function prepareOrganizationKiloPassSeatCapacityFee(input: {
  subscription: Stripe.Subscription;
  paidSeatItemId: string;
  paidSeatQuantity: number;
  isIncreasingSeats: boolean;
  prorationDate: number;
  stripe?: OrganizationKiloPassSeatCapacityStripe;
  store?: ServiceFeeAssessmentStore;
  deps?: OrganizationKiloPassSeatCapacityFeeDependencies;
}): Promise<PreparedOrganizationKiloPassSeatCapacityFee> {
  const organizationPassItem = resolveOrganizationKiloPassSubscriptionItem({
    subscription: input.subscription,
  });
  const empty = emptyPreparedSeatCapacityFee(input.prorationDate, organizationPassItem?.id ?? null);
  if (!input.isIncreasingSeats || !organizationPassItem) {
    return empty;
  }

  const metadata = getOrganizationKiloPassMetadata(input.subscription.metadata);
  if (!metadata) {
    return empty;
  }

  const deps = input.deps ?? {};
  const now = deps.now ?? new Date(input.prorationDate * 1000);
  const getChannel =
    deps.getOrganizationPurchaseChannel ?? lookupOrganizationKiloPassPurchaseChannel;
  const channel = await getChannel(metadata.organizationId);
  if (channel !== 'self_serve') {
    return empty;
  }

  const stripeClient = input.stripe ?? defaultSeatCapacityStripe();
  const createdStores = input.store === undefined ? createServiceFeeStores() : undefined;
  const store = input.store ?? createdStores?.assessments;
  if (store === undefined) {
    throw new Error('organization Kilo Pass seat-capacity service-fee store is unavailable');
  }

  const assessmentKey = createSeatCapacityServiceFeeAssessmentKey({
    subscriptionId: input.subscription.id,
    prorationDate: input.prorationDate,
    paidSeatQuantity: input.paidSeatQuantity,
  });
  const customer = customerIdFromReference(input.subscription.customer);
  const stripeIds: ServiceFeeStripeIds = { stripeCustomerId: customer };

  try {
    const existing = await store.findByAssessmentKey(assessmentKey);
    if (existing && (existing.outcome === 'charged' || existing.outcome === 'missed')) {
      return {
        ...empty,
        assessmentKey,
        assessment: existing,
        expectedFeeMinor: existing.expectedFeeMinor,
      };
    }

    const preview = await stripeClient.invoices.createPreview({
      customer: customer ?? undefined,
      subscription: input.subscription.id,
      subscription_details: {
        items: [
          { id: input.paidSeatItemId, quantity: input.paidSeatQuantity },
          { id: organizationPassItem.id, quantity: input.paidSeatQuantity },
        ],
        proration_behavior: 'always_invoice',
        proration_date: input.prorationDate,
      },
      expand: ['lines.data'],
    });
    const lines =
      preview.lines?.has_more && preview.id
        ? await listAllInvoiceLineItems({
            invoice: { id: preview.id, lines: preview.lines },
            stripe: stripeClient,
          })
        : (preview.lines?.data ?? []);
    const eligibleSubtotalMinor = sumEligibleKiloPassSubtotalMinor({
      lines,
      currency: preview.currency || SERVICE_FEE_SUPPORTED_CURRENCY,
      subscription: input.subscription,
    });
    const findEffectiveExemption =
      deps.findEffectiveExemption ??
      (createdStores
        ? async (organizationId, at) =>
            getEffectiveOrganizationServiceFeeExemption({
              store: createdStores.exemptions,
              organizationId,
              at,
            })
        : undefined);
    const decision = await prepareServiceFeeAssessmentDecision(
      {
        assessmentKey,
        flow: 'organization_kilo_pass',
        currency: preview.currency || SERVICE_FEE_SUPPORTED_CURRENCY,
        eligibilityCreatedAt: now,
        eligibleSubtotalMinor,
        kiloUserId: metadata.kiloUserId,
        organizationId: metadata.organizationId,
        stripeCustomerId: customer ?? undefined,
      },
      { findEffectiveExemption }
    );
    const commercialMetadata = buildServiceFeeCommercialMetadata({
      assessmentKey,
      flow: decision.flow,
      organizationId: metadata.organizationId,
    });

    const record = await upsertServiceFeeAssessment({
      store,
      decision,
      stripeIds,
      now,
    });
    if (record.outcome !== 'pending') {
      return {
        prorationDate: input.prorationDate,
        organizationPassItemId: organizationPassItem.id,
        shouldAttach: false,
        assessmentKey,
        assessment: record,
        feeInvoiceItem: null,
        expectedFeeMinor: record.expectedFeeMinor,
        commercialMetadata,
      };
    }

    const resolveTax = deps.resolveTaxInput ?? resolveServiceFeeTaxInput;
    let taxInput: ServiceFeeTaxInput;
    try {
      taxInput = await resolveTax({
        principal: taxPrincipalFromLines(lines, input.subscription),
        stripe: stripeClient.prices ? { prices: stripeClient.prices } : undefined,
      });
    } catch {
      const missed = await persistSeatCapacityMissed({
        store,
        assessmentKey,
        stripeIds,
        failureCode: SERVICE_FEE_FAILURE_APPLICATION,
        record,
        deps,
        now,
      });
      return {
        prorationDate: input.prorationDate,
        organizationPassItemId: organizationPassItem.id,
        shouldAttach: false,
        assessmentKey,
        assessment: missed.assessment,
        feeInvoiceItem: null,
        expectedFeeMinor: record.expectedFeeMinor,
        commercialMetadata,
      };
    }
    if (!customer) {
      const missed = await persistSeatCapacityMissed({
        store,
        assessmentKey,
        stripeIds,
        failureCode: SERVICE_FEE_FAILURE_APPLICATION,
        record,
        deps,
        now,
      });
      return {
        prorationDate: input.prorationDate,
        organizationPassItemId: organizationPassItem.id,
        shouldAttach: false,
        assessmentKey,
        assessment: missed.assessment,
        feeInvoiceItem: null,
        expectedFeeMinor: record.expectedFeeMinor,
        commercialMetadata,
      };
    }

    const feeInvoiceItem = buildAutoTopUpServiceFeeInvoiceItem({
      assessmentKey,
      invoiceId: 'pending',
      customerId: customer,
      feeMinor: decision.expectedFeeMinor,
      taxInput,
    });
    const { invoice: _pendingInvoice, ...feeInvoiceItemWithoutInvoice } = feeInvoiceItem;
    return {
      prorationDate: input.prorationDate,
      organizationPassItemId: organizationPassItem.id,
      shouldAttach: true,
      assessmentKey,
      assessment: record,
      feeInvoiceItem: feeInvoiceItemWithoutInvoice,
      expectedFeeMinor: decision.expectedFeeMinor,
      commercialMetadata,
    };
  } catch (error) {
    await alertSeatCapacitySafely({
      assessmentKey,
      flow: 'organization_kilo_pass',
      kiloUserId: metadata.kiloUserId,
      organizationId: metadata.organizationId,
      eligibleSubtotalMinor: 0,
      expectedFeeMinor: 0,
      failureCode: failureCodeFromUnknown(error, SERVICE_FEE_FAILURE_APPLICATION),
      deps,
      now,
    });
    return empty;
  }
}

/**
 * Attach one already-prepared non-discountable fee item to the draft invoice
 * returned by `subscriptions.update`. No preview, exemption, tax, or initial
 * assessment write happens here. Attachment failure is fail-open.
 */
export async function attachPreparedOrganizationKiloPassServiceFee(input: {
  prepared: PreparedOrganizationKiloPassSeatCapacityFee;
  invoice: Stripe.Invoice;
  stripe?: Pick<OrganizationKiloPassSeatCapacityStripe, 'invoiceItems'>;
  store?: ServiceFeeAssessmentStore;
  deps?: OrganizationKiloPassSeatCapacityFeeDependencies;
  pendingInvoiceItemId?: string | null;
}): Promise<ServiceFeeAssessmentRecord | null> {
  const prepared = input.prepared;
  if (!prepared.shouldAttach || !prepared.assessmentKey || !prepared.feeInvoiceItem) {
    return prepared.assessment;
  }

  const deps = input.deps ?? {};
  const now = deps.now ?? new Date();
  const createdStores = input.store === undefined ? createServiceFeeStores() : undefined;
  const store = input.store ?? createdStores?.assessments;
  if (store === undefined) {
    return prepared.assessment;
  }

  const stripeIds: ServiceFeeStripeIds = {
    stripeCustomerId: prepared.assessment?.stripeCustomerId ?? null,
    stripeInvoiceId: input.invoice.id,
  };

  try {
    const existingFeeLine = (input.invoice.lines?.data ?? []).find(line => {
      if (!isServiceFeeInvoiceLine(line)) return false;
      return line.metadata?.serviceFeeAssessmentKey === prepared.assessmentKey;
    });
    if (existingFeeLine) {
      if (input.pendingInvoiceItemId) {
        await discardStagedOrganizationKiloPassServiceFeeItem({
          invoiceItemId: input.pendingInvoiceItemId,
          stripe: input.stripe,
        });
      }
      return markServiceFeeAssessmentCharged({
        store,
        assessmentKey: prepared.assessmentKey,
        chargedFeeMinor: Math.max(0, existingFeeLine.amount),
        stripeIds: {
          ...stripeIds,
          stripeInvoiceFeeItemId:
            getInvoiceLineInvoiceItemId(existingFeeLine) ?? input.pendingInvoiceItemId,
          stripeInvoiceFeeLineItemId:
            input.invoice.status === 'draft' ? undefined : existingFeeLine.id,
        },
        now,
      });
    }

    if (input.pendingInvoiceItemId) {
      await discardStagedOrganizationKiloPassServiceFeeItem({
        invoiceItemId: input.pendingInvoiceItemId,
        stripe: input.stripe,
      });
    }

    if (input.invoice.status !== 'draft' || !input.invoice.id) {
      const missed = await persistSeatCapacityMissed({
        store,
        assessmentKey: prepared.assessmentKey,
        stripeIds,
        failureCode: SERVICE_FEE_FAILURE_INVOICE_NOT_DRAFT,
        record: prepared.assessment,
        deps,
        now,
      });
      return missed.assessment;
    }

    const create =
      input.stripe?.invoiceItems?.create ?? stripe.invoiceItems.create.bind(stripe.invoiceItems);
    const item = await create({
      ...prepared.feeInvoiceItem,
      invoice: input.invoice.id,
    });
    return markServiceFeeAssessmentCharged({
      store,
      assessmentKey: prepared.assessmentKey,
      chargedFeeMinor: prepared.expectedFeeMinor,
      stripeIds: {
        ...stripeIds,
        stripeInvoiceFeeItemId: item.id,
      },
      now,
    });
  } catch (error) {
    const missed = await persistSeatCapacityMissed({
      store,
      assessmentKey: prepared.assessmentKey,
      stripeIds,
      failureCode: failureCodeFromUnknown(error, SERVICE_FEE_FAILURE_APPLICATION),
      record: prepared.assessment,
      deps,
      now,
    });
    return missed.assessment;
  }
}

function defaultSeatCapacityStripe(): OrganizationKiloPassSeatCapacityStripe {
  return {
    invoices: stripe.invoices,
    invoiceItems: stripe.invoiceItems,
    prices: stripe.prices,
  };
}

/**
 * Create the non-discountable fee as a pending customer invoice item so
 * `subscriptions.update` can pull it onto the invoice it immediately
 * finalizes. Saved cards often leave no draft window for post-update attach.
 */
export async function stagePreparedOrganizationKiloPassServiceFeeItem(input: {
  prepared: PreparedOrganizationKiloPassSeatCapacityFee;
  stripe?: Pick<OrganizationKiloPassSeatCapacityStripe, 'invoiceItems'>;
}): Promise<string | null> {
  const prepared = input.prepared;
  if (!prepared.shouldAttach || !prepared.feeInvoiceItem) return null;
  const invoiceItems = input.stripe?.invoiceItems ?? stripe.invoiceItems;
  const list = invoiceItems.list?.bind(invoiceItems);
  const customer = prepared.feeInvoiceItem.customer;
  if (list && typeof customer === 'string') {
    try {
      let startingAfter: string | undefined;
      for (;;) {
        const page = await list({
          customer,
          pending: true,
          limit: 100,
          ...(startingAfter ? { starting_after: startingAfter } : {}),
        });
        const existing = page.data.find(
          item => item.metadata?.serviceFeeAssessmentKey === prepared.assessmentKey
        );
        if (existing) return existing.id;
        if (!page.has_more) break;
        const cursor = page.data.at(-1)?.id;
        if (!cursor) return null;
        startingAfter = cursor;
      }
    } catch {
      return null;
    }
  }
  const create = invoiceItems.create.bind(invoiceItems);
  try {
    const item = await create(prepared.feeInvoiceItem);
    return item.id;
  } catch {
    return null;
  }
}

export async function discardStagedOrganizationKiloPassServiceFeeItem(input: {
  invoiceItemId: string;
  stripe?: Pick<OrganizationKiloPassSeatCapacityStripe, 'invoiceItems'>;
}): Promise<void> {
  const del = input.stripe?.invoiceItems?.del ?? stripe.invoiceItems.del?.bind(stripe.invoiceItems);
  if (!del) return;
  try {
    await del(input.invoiceItemId);
  } catch {
    // Orphan cleanup is best-effort. Settlement still records missed.
  }
}

function taxPrincipalFromLines(
  lines: readonly Stripe.InvoiceLineItem[],
  subscription: Stripe.Subscription | null
): ServiceFeeTaxPrincipal {
  const eligible = lines.find(line => isEligibleKiloPassInvoiceLine(line, subscription));
  const priceId = eligible?.pricing?.price_details?.price;
  return priceId ? { kind: 'price', priceId } : { kind: 'inline' };
}

function customerIdFromReference(
  customer: string | Stripe.Customer | Stripe.DeletedCustomer | null | undefined
): string | null {
  if (typeof customer === 'string' && customer.trim()) return customer;
  if (customer && typeof customer === 'object' && 'id' in customer && customer.id) {
    return customer.id;
  }
  return null;
}

async function persistSeatCapacityMissed(params: {
  store: ServiceFeeAssessmentStore;
  assessmentKey: string;
  stripeIds: ServiceFeeStripeIds;
  failureCode: string;
  record: ServiceFeeAssessmentRecord | null;
  deps: OrganizationKiloPassSeatCapacityFeeDependencies;
  now: Date;
}): Promise<{ assessment: ServiceFeeAssessmentRecord | null }> {
  try {
    const missed = await markServiceFeeAssessmentMissed({
      store: params.store,
      assessmentKey: params.assessmentKey,
      failureCode: params.failureCode,
      stripeIds: params.stripeIds,
      now: params.now,
    });
    await alertSeatCapacitySafely({
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
    return { assessment: missed };
  } catch (error) {
    await alertSeatCapacitySafely({
      assessmentKey: params.assessmentKey,
      flow: params.record?.flow ?? 'organization_kilo_pass',
      kiloUserId: params.record?.kiloUserId,
      organizationId: params.record?.organizationId,
      stripeInvoiceId: params.stripeIds.stripeInvoiceId,
      eligibleSubtotalMinor: params.record?.eligibleSubtotalMinor ?? 0,
      expectedFeeMinor: params.record?.expectedFeeMinor ?? 0,
      failureCode: failureCodeFromUnknown(error, params.failureCode),
      deps: params.deps,
      now: params.now,
    });
    return { assessment: params.record };
  }
}

async function alertSeatCapacitySafely(params: {
  assessmentKey: string;
  flow: MissedServiceFeeAlertInput['flow'];
  kiloUserId?: string | null;
  organizationId?: string | null;
  stripeInvoiceId?: string | null;
  eligibleSubtotalMinor: number;
  expectedFeeMinor: number;
  failureCode: string;
  deps: OrganizationKiloPassSeatCapacityFeeDependencies;
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
    // Slack/Sentry failure must not change the seat-capacity fee outcome.
  }
}

function failureCodeFromUnknown(error: unknown, fallback: string): string {
  if (error instanceof Error && /^[a-z][a-z0-9_]{0,99}$/.test(error.message)) {
    return error.message;
  }
  return fallback;
}

function hasCreatePreview(
  stripeClient: KiloPassInvoiceCreatedStripe | undefined
): stripeClient is OrganizationKiloPassSeatCapacityStripe {
  const invoices = stripeClient?.invoices as { createPreview?: unknown } | undefined;
  return typeof invoices?.createPreview === 'function';
}

/**
 * Persist the org-checkout assessment before `subscriptions.update` so
 * `invoice.created` can bind to `org-checkout:<uuid>` and skip attachment.
 * The checkout caller is the synchronous attachment owner.
 */
export async function prepareOrganizationKiloPassCheckoutFee(input: {
  subscription: Stripe.Subscription;
  priceId: string;
  quantity: number;
  organizationId: string;
  kiloUserId: string;
  assessmentKey: string;
  stripe?: OrganizationKiloPassSeatCapacityStripe;
  store?: ServiceFeeAssessmentStore;
  deps?: OrganizationKiloPassSeatCapacityFeeDependencies;
}): Promise<PreparedOrganizationKiloPassSeatCapacityFee> {
  const empty = emptyPreparedSeatCapacityFee(Math.floor(Date.now() / 1000));
  const deps = input.deps ?? {};
  const now = deps.now ?? new Date();
  const stripeClient = input.stripe ?? defaultSeatCapacityStripe();
  const createdStores = input.store === undefined ? createServiceFeeStores() : undefined;
  const store = input.store ?? createdStores?.assessments;
  if (store === undefined) {
    throw new Error('organization Kilo Pass checkout service-fee store is unavailable');
  }

  const customer = customerIdFromReference(input.subscription.customer);
  const stripeIds: ServiceFeeStripeIds = { stripeCustomerId: customer };
  const commercialMetadata = buildServiceFeeCommercialMetadata({
    assessmentKey: input.assessmentKey,
    flow: 'organization_kilo_pass',
    organizationId: input.organizationId,
  });

  try {
    const existing = await store.findByAssessmentKey(input.assessmentKey);
    if (existing && (existing.outcome === 'charged' || existing.outcome === 'missed')) {
      return {
        ...empty,
        assessmentKey: input.assessmentKey,
        assessment: existing,
        expectedFeeMinor: existing.expectedFeeMinor,
        commercialMetadata,
      };
    }

    const preview = await stripeClient.invoices.createPreview({
      customer: customer ?? undefined,
      subscription: input.subscription.id,
      subscription_details: {
        items: [
          ...input.subscription.items.data.map(item => ({
            id: item.id,
            quantity: item.quantity ?? 1,
          })),
          { price: input.priceId, quantity: input.quantity },
        ],
        proration_behavior: 'always_invoice',
      },
      expand: ['lines.data'],
    });
    const lines =
      preview.lines?.has_more && preview.id
        ? await listAllInvoiceLineItems({
            invoice: { id: preview.id, lines: preview.lines },
            stripe: stripeClient,
          })
        : (preview.lines?.data ?? []);
    const eligibleSubtotalMinor = sumEligibleKiloPassSubtotalMinor({
      lines,
      currency: preview.currency || SERVICE_FEE_SUPPORTED_CURRENCY,
      subscription: input.subscription,
    });
    const findEffectiveExemption =
      deps.findEffectiveExemption ??
      (createdStores
        ? async (organizationId, at) =>
            getEffectiveOrganizationServiceFeeExemption({
              store: createdStores.exemptions,
              organizationId,
              at,
            })
        : undefined);
    const decision = await prepareServiceFeeAssessmentDecision(
      {
        assessmentKey: input.assessmentKey,
        flow: 'organization_kilo_pass',
        currency: preview.currency || SERVICE_FEE_SUPPORTED_CURRENCY,
        eligibilityCreatedAt: now,
        eligibleSubtotalMinor,
        kiloUserId: input.kiloUserId,
        organizationId: input.organizationId,
        stripeCustomerId: customer ?? undefined,
      },
      { findEffectiveExemption }
    );
    const record = await upsertServiceFeeAssessment({
      store,
      decision,
      stripeIds,
      now,
    });
    if (record.outcome !== 'pending') {
      return {
        prorationDate: empty.prorationDate,
        organizationPassItemId: null,
        shouldAttach: false,
        assessmentKey: input.assessmentKey,
        assessment: record,
        feeInvoiceItem: null,
        expectedFeeMinor: record.expectedFeeMinor,
        commercialMetadata,
      };
    }

    const resolveTax = deps.resolveTaxInput ?? resolveServiceFeeTaxInput;
    let taxInput: ServiceFeeTaxInput;
    try {
      taxInput = await resolveTax({
        principal: taxPrincipalFromLines(lines, input.subscription),
        stripe: stripeClient.prices ? { prices: stripeClient.prices } : undefined,
      });
    } catch {
      const missed = await persistSeatCapacityMissed({
        store,
        assessmentKey: input.assessmentKey,
        stripeIds,
        failureCode: SERVICE_FEE_FAILURE_APPLICATION,
        record,
        deps,
        now,
      });
      return {
        prorationDate: empty.prorationDate,
        organizationPassItemId: null,
        shouldAttach: false,
        assessmentKey: input.assessmentKey,
        assessment: missed.assessment,
        feeInvoiceItem: null,
        expectedFeeMinor: record.expectedFeeMinor,
        commercialMetadata,
      };
    }
    if (!customer) {
      const missed = await persistSeatCapacityMissed({
        store,
        assessmentKey: input.assessmentKey,
        stripeIds,
        failureCode: SERVICE_FEE_FAILURE_APPLICATION,
        record,
        deps,
        now,
      });
      return {
        prorationDate: empty.prorationDate,
        organizationPassItemId: null,
        shouldAttach: false,
        assessmentKey: input.assessmentKey,
        assessment: missed.assessment,
        feeInvoiceItem: null,
        expectedFeeMinor: record.expectedFeeMinor,
        commercialMetadata,
      };
    }

    const feeInvoiceItem = buildAutoTopUpServiceFeeInvoiceItem({
      assessmentKey: input.assessmentKey,
      invoiceId: 'pending',
      customerId: customer,
      feeMinor: decision.expectedFeeMinor,
      taxInput,
    });
    const { invoice: _pendingInvoice, ...feeInvoiceItemWithoutInvoice } = feeInvoiceItem;
    return {
      prorationDate: empty.prorationDate,
      organizationPassItemId: null,
      shouldAttach: true,
      assessmentKey: input.assessmentKey,
      assessment: record,
      feeInvoiceItem: feeInvoiceItemWithoutInvoice,
      expectedFeeMinor: decision.expectedFeeMinor,
      commercialMetadata,
    };
  } catch (error) {
    await alertSeatCapacitySafely({
      assessmentKey: input.assessmentKey,
      flow: 'organization_kilo_pass',
      kiloUserId: input.kiloUserId,
      organizationId: input.organizationId,
      eligibleSubtotalMinor: 0,
      expectedFeeMinor: 0,
      failureCode: failureCodeFromUnknown(error, SERVICE_FEE_FAILURE_APPLICATION),
      deps,
      now,
    });
    return {
      ...empty,
      assessmentKey: input.assessmentKey,
      commercialMetadata,
    };
  }
}

/**
 * Item updates on a subscription with an attached schedule can be rewritten by
 * Stripe, so checkout releases only an owned cancellation schedule that keeps
 * the current items and refuses any other schedule.
 */
async function releaseCheckoutSchedule(input: {
  subscription: Stripe.Subscription;
  organizationId: string;
}): Promise<void> {
  const fail = (
    reason: string,
    errorReason: OrganizationKiloPassCheckoutScheduleErrorReason,
    schedule: Stripe.SubscriptionSchedule | null,
    error?: unknown
  ): never => {
    reportOrganizationKiloPassScheduleProblem({
      event: 'checkout',
      reason,
      organizationId: input.organizationId,
      subscriptionId: input.subscription.id,
      schedule,
      error,
    });
    throw new OrganizationKiloPassCheckoutScheduleError(errorReason);
  };
  let schedule: Stripe.SubscriptionSchedule | null;
  try {
    schedule = await retrieveAttachedSchedule(input.subscription);
  } catch (error) {
    return fail('schedule_read_failed', 'schedule_unavailable', null, error);
  }
  if (!schedule) return;
  if (!isOwnedCancellationSchedule(schedule)) {
    return fail('unowned_schedule', 'schedule_conflict', schedule);
  }
  const currentItems = subscriptionScheduleItems(input.subscription);
  const shape = classifyCancellationSchedule({
    schedule,
    currentItems,
    retainedItems: currentItems,
    periodEnd: Math.floor(periodForItem(paidSeatItem(input.subscription)).end.getTime() / 1000),
  });
  if (shape.kind !== 'idle') {
    return fail(shape.kind === 'unsafe' ? shape.reason : shape.kind, 'schedule_conflict', schedule);
  }
  try {
    await releaseCancellationSchedule(schedule.id);
  } catch (error) {
    fail('schedule_release_failed', 'schedule_unavailable', schedule, error);
  }
}

export async function createOrganizationKiloPassCheckout(input: {
  organizationId: string;
  actorUserId: string;
  tier: 'tier_19' | 'tier_49' | 'tier_199';
  allocations: { childOrganizationId: string; passCount: number }[];
  serviceFee?: Omit<OrganizationKiloPassServiceFeeAttachment, 'invoice' | 'subscription'>;
  /** Bouncer context; omitted by callers that do not report a `charge.attempted`. */
  attempt?: ChargeAttemptContext;
}): Promise<
  { kind: 'payment_action'; clientSecret: string } | { kind: 'completed' } | { kind: 'pending' }
> {
  const [purchase] = await db
    .select({ subscriptionId: organization_seats_purchases.subscription_stripe_id })
    .from(organization_seats_purchases)
    .where(
      and(
        eq(organization_seats_purchases.organization_id, input.organizationId),
        eq(organization_seats_purchases.subscription_status, 'active')
      )
    )
    .orderBy(desc(organization_seats_purchases.created_at))
    .limit(1);
  if (!purchase) throw new Error('An active organization seat subscription is required');
  const subscription = await stripe.subscriptions.retrieve(purchase.subscriptionId);
  if (subscription.status !== 'active' || subscription.ended_at) {
    throw new Error('An active organization seat subscription is required');
  }
  const existingPassItem = resolveOrganizationKiloPassSubscriptionItem({ subscription });
  if (existingPassItem) throw new Error('KILO_PASS_ORG_ALREADY_EXISTS');
  await releaseCheckoutSchedule({ subscription, organizationId: input.organizationId });
  const seatItem = paidSeatItem(subscription);
  const cadence = intervalToCadence(seatItem.price.recurring?.interval);
  const paidSeats = seatItem.quantity ?? 0;
  const period = periodForItem(seatItem);

  // Persist agreement and allocation intent before Stripe changes the subscription.
  const pending = await createPendingAgreement({
    parentOrganizationId: input.organizationId,
    actorUserId: input.actorUserId,
    tier: input.tier,
    cadence,
    paidSeatCount: paidSeats,
    issuanceAnchorAt: period.start,
    providerSubscriptionId: subscription.id,
    providerSeatAddOnItemId: `pending:${subscription.id}`,
    initialAllocations: input.allocations.map(allocation => ({
      organizationId: allocation.childOrganizationId,
      passCapacity: allocation.passCount,
    })),
  });
  if (!pending.created) throw new Error('KILO_PASS_ORG_ALREADY_EXISTS');
  const price = getStripePriceIdForKiloPass({
    tier: input.tier as KiloPassTier,
    cadence: cadence as KiloPassCadence,
  });
  const assessmentKey = createOrgCheckoutServiceFeeAssessmentKey();
  let prepared: PreparedOrganizationKiloPassSeatCapacityFee = {
    ...emptyPreparedSeatCapacityFee(Math.floor(Date.now() / 1000)),
    assessmentKey,
    commercialMetadata: buildServiceFeeCommercialMetadata({
      assessmentKey,
      flow: 'organization_kilo_pass',
      organizationId: input.organizationId,
    }),
  };
  try {
    prepared = await prepareOrganizationKiloPassCheckoutFee({
      subscription,
      priceId: price,
      quantity: paidSeats,
      organizationId: input.organizationId,
      kiloUserId: input.actorUserId,
      assessmentKey,
      stripe: hasCreatePreview(input.serviceFee?.stripe) ? input.serviceFee.stripe : undefined,
      store: input.serviceFee?.store,
      deps: {
        getOrganizationPurchaseChannel: async () => 'self_serve',
        ...input.serviceFee?.deps,
      },
    });
  } catch {
    // Persist-before-update is best-effort. The base add-on still proceeds.
  }
  const pendingFeeItemId = await stagePreparedOrganizationKiloPassServiceFeeItem({
    prepared,
    stripe: input.serviceFee?.stripe,
  });
  let updated: Stripe.Subscription;
  try {
    updated = await stripe.subscriptions.update(subscription.id, {
      payment_behavior: 'allow_incomplete',
      proration_behavior: 'always_invoice',
      items: [{ price, quantity: paidSeats }],
      metadata: {
        ...subscription.metadata,
        type: ORGANIZATION_KILO_PASS_METADATA_TYPE,
        organizationId: input.organizationId,
        kiloUserId: input.actorUserId,
        tier: input.tier,
        cadence,
      },
      expand: ['latest_invoice.confirmation_secret', 'latest_invoice.lines'],
    });
  } catch (error) {
    if (pendingFeeItemId) {
      await discardStagedOrganizationKiloPassServiceFeeItem({
        invoiceItemId: pendingFeeItemId,
        stripe: input.serviceFee?.stripe,
      });
    }
    throw error;
  }
  const passItem = organizationPassItem(updated);
  await bindProviderSeatAddOnItem({
    agreementId: pending.agreementId,
    providerSeatAddOnItemId: passItem.id,
  });
  const invoice = typeof updated.latest_invoice === 'object' ? updated.latest_invoice : null;
  if (input.attempt && invoice) {
    reportChargeAttempted({
      flow: 'kilo_pass',
      userId: input.actorUserId,
      orgId: input.organizationId,
      amountCents: invoice.amount_due,
      accountCreatedAt: input.attempt.accountCreatedAt,
      ip: input.attempt.ip,
      ipCountry: input.attempt.ipCountry,
    });
  }
  let feeResult: Awaited<ReturnType<typeof attachPreparedOrganizationKiloPassServiceFee>> | null =
    null;
  if (invoice && prepared.shouldAttach) {
    feeResult = await attachPreparedOrganizationKiloPassServiceFee({
      prepared,
      invoice,
      stripe: input.serviceFee?.stripe,
      store: input.serviceFee?.store,
      deps: input.serviceFee?.deps,
      pendingInvoiceItemId: pendingFeeItemId,
    });
  }
  if (
    invoice?.status === 'paid' ||
    (invoice?.amount_due === 0 && feeResult?.outcome !== 'charged')
  ) {
    await handleOrganizationKiloPassInvoicePaid({
      invoice,
      serviceFee: {
        store: input.serviceFee?.store,
        stripe: input.serviceFee?.stripe,
        deps: input.serviceFee?.deps,
      },
    });
    return { kind: 'completed' };
  }
  let openPayments: Stripe.ApiList<Stripe.InvoicePayment> | null = null;
  if (invoice) {
    try {
      openPayments = await stripe.invoicePayments.list({
        invoice: invoice.id,
        status: 'open',
        payment: { type: 'payment_intent' },
        expand: ['data.payment.payment_intent'],
        limit: 10,
      });
    } catch {
      // The agreement and add-on are already durable. Webhook/poll reconciliation
      // remains authoritative if the follow-up provider read is unavailable.
      return { kind: 'pending' };
    }
  }
  const paymentIntent = openPayments?.data
    .map(payment => payment.payment.payment_intent)
    .find(reference => typeof reference === 'object');
  if (paymentIntent?.status === 'requires_action' && invoice?.confirmation_secret?.client_secret) {
    return { kind: 'payment_action', clientSecret: invoice.confirmation_secret.client_secret };
  }
  return { kind: 'pending' };
}

function invoiceLinesForSubscriptionItem(
  invoice: Stripe.Invoice,
  itemId: string
): Stripe.InvoiceLineItem[] {
  return (invoice.lines?.data ?? []).filter(
    line =>
      !isServiceFeeInvoiceLine(line) &&
      line.parent?.subscription_item_details?.subscription_item === itemId
  );
}

function preferredInvoiceLine(
  lines: readonly Stripe.InvoiceLineItem[]
): Stripe.InvoiceLineItem | undefined {
  if (lines.length === 0) return undefined;
  const positive = lines.filter(line => line.amount > 0);
  const pool = positive.length > 0 ? positive : lines;
  return [...pool].sort((left, right) => (right.quantity ?? 0) - (left.quantity ?? 0))[0];
}

function invoiceLineForSubscriptionItem(invoice: Stripe.Invoice, itemId: string) {
  return preferredInvoiceLine(invoiceLinesForSubscriptionItem(invoice, itemId));
}

function invoiceLineForKnownKiloPassPrice(invoice: Stripe.Invoice) {
  const knownPriceIds = new Set(getKnownStripePriceIdsForKiloPass());
  return preferredInvoiceLine(
    (invoice.lines?.data ?? []).filter(line => {
      if (isServiceFeeInvoiceLine(line)) return false;
      const priceId = line.pricing?.price_details?.price;
      return priceId !== undefined && knownPriceIds.has(priceId);
    })
  );
}

function linePeriod(line: Stripe.InvoiceLineItem) {
  if (!line.period?.start || !line.period?.end)
    throw new Error(`Invoice line ${line.id} has no service period`);
  return { start: new Date(line.period.start * 1000), end: new Date(line.period.end * 1000) };
}

function paidSeatSnapshotFromInvoice(
  invoice: Stripe.Invoice,
  itemId: string
): { quantity: number; period: IssuanceWindow } | null {
  const line = invoiceLineForSubscriptionItem(invoice, itemId);
  if (!line) return null;
  const quantity = line?.quantity;
  if (typeof quantity !== 'number' || !Number.isSafeInteger(quantity) || quantity < 0) return null;
  return { quantity, period: linePeriod(line) };
}

function isBridgeWindow(window: IssuanceWindow, paid: IssuanceWindow) {
  return paid.start > window.start || paid.end < window.end;
}

async function settleOrganizationKiloPassInvoiceServiceFeeBeforeActivation(params: {
  invoice: Stripe.Invoice;
  subscription: Stripe.Subscription;
  serviceFee?:
    | {
        store?: ServiceFeeAssessmentStore;
        stripe?: KiloPassServiceFeeSettlementStripe;
        deps?: KiloPassServiceFeeSettlementDependencies & { now?: Date };
      }
    | undefined;
}): Promise<void> {
  const createdStores =
    params.serviceFee?.store === undefined ? createServiceFeeStores() : undefined;
  const store = (params.serviceFee?.store ?? createdStores?.assessments) as
    | ServiceFeeSettlementStore
    | undefined;
  if (store === undefined) return;
  try {
    await settleKiloPassInvoiceServiceFee({
      invoice: params.invoice,
      stripe: params.serviceFee?.stripe ?? {
        invoices: stripe.invoices,
        subscriptions: stripe.subscriptions,
      },
      store,
      subscription: params.subscription,
      deps: params.serviceFee?.deps,
    });
  } catch {
    // Fee settlement must not block agreement activation after a successful payment.
  }
}

export async function handleOrganizationKiloPassInvoicePaid(params: {
  invoice: Stripe.Invoice;
  paidSeatCount?: number;
  serviceFee?: {
    store?: ServiceFeeAssessmentStore;
    stripe?: KiloPassServiceFeeSettlementStripe;
    deps?: KiloPassServiceFeeSettlementDependencies & {
      now?: Date;
    };
  };
}) {
  const reference = params.invoice.parent?.subscription_details?.subscription;
  const subscriptionId = typeof reference === 'string' ? reference : reference?.id;
  if (!subscriptionId) return false;
  const subscription = await stripe.subscriptions.retrieve(subscriptionId);
  const metadata = subscriptionMetadata(subscription);
  if (!metadata) return false;
  const [agreement] = await db
    .select()
    .from(kilo_pass_org_agreements)
    .where(
      and(
        eq(kilo_pass_org_agreements.provider_subscription_id, subscription.id),
        ne(kilo_pass_org_agreements.state, KiloPassOrgAgreementState.Ended)
      )
    )
    .orderBy(desc(kilo_pass_org_agreements.created_at))
    .limit(1);
  if (!agreement) return false;
  const item = resolveOrganizationKiloPassSubscriptionItem({
    subscription,
    boundProviderItemId: agreement.provider_seat_add_on_item_id,
  });
  if (!item) return false;
  if (agreement.provider_seat_add_on_item_id !== item.id) {
    await bindProviderSeatAddOnItem({
      agreementId: agreement.id,
      providerSeatAddOnItemId: item.id,
    });
  }
  const line =
    invoiceLineForSubscriptionItem(params.invoice, item.id) ??
    invoiceLineForKnownKiloPassPrice(params.invoice);
  if (!line) return false;
  const paidPeriod = linePeriod(line);
  const seatItem = subscription.items.data.find(isSeatLineItem);
  const seatSnapshot = seatItem ? paidSeatSnapshotFromInvoice(params.invoice, seatItem.id) : null;
  // Eager seat-change reconciliation supplies the paid post-update quantity because
  // proration invoices can omit the seat line. Webhooks otherwise use immutable lines.
  const subscriptionSeatCount = seatItem?.quantity;
  const seats =
    params.paidSeatCount ??
    seatSnapshot?.quantity ??
    (agreement.state === KiloPassOrgAgreementState.Active &&
    typeof subscriptionSeatCount === 'number' &&
    Number.isSafeInteger(subscriptionSeatCount) &&
    subscriptionSeatCount >= 0
      ? subscriptionSeatCount
      : agreement.purchased_pass_capacity);
  const firstWindow = monthlyWindowContaining(
    new Date(agreement.issuance_anchor_at),
    paidPeriod.start
  );
  const isBridge = isBridgeWindow(firstWindow, paidPeriod);
  const previousSeats = agreement.purchased_pass_capacity;
  const paidIncreaseSupersedesPendingCapacity =
    agreement.next_purchased_pass_capacity !== null &&
    seats > agreement.next_purchased_pass_capacity;
  await settleOrganizationKiloPassInvoiceServiceFeeBeforeActivation({
    invoice: params.invoice,
    subscription,
    serviceFee: params.serviceFee,
  });
  await activatePaidAgreement({
    agreementId: agreement.id,
    recipientUserId: metadata.kiloUserId,
    paidFrom: paidPeriod.start,
    paidUntil: paidPeriod.end,
    paidSeatCount: seats,
    firstWindow,
    isBridge,
    paidBridgeInterval: isBridge ? paidPeriod : undefined,
  });
  if (
    agreement.state === KiloPassOrgAgreementState.Active &&
    agreement.processing_condition !== KiloPassOrgProcessingCondition.Manual &&
    agreement.processing_condition !== KiloPassOrgProcessingCondition.SuspendedForReview &&
    (seats > previousSeats || paidIncreaseSupersedesPendingCapacity)
  ) {
    await createParentSupplement({
      agreementId: agreement.id,
      recipientUserId: metadata.kiloUserId,
      window: firstWindow,
      paidSeatCount: seats,
      providerInvoiceLineId: line.id,
      now: new Date(),
    });
  }
  return true;
}

/** Repairs a pending agreement when Stripe has already finalized its add-on invoice. */
export async function reconcileOrganizationKiloPassPayment(organizationId: string) {
  const [agreement] = await db
    .select({
      id: kilo_pass_org_agreements.id,
      providerSubscriptionId: kilo_pass_org_agreements.provider_subscription_id,
    })
    .from(kilo_pass_org_agreements)
    .where(
      and(
        eq(kilo_pass_org_agreements.parent_organization_id, organizationId),
        eq(kilo_pass_org_agreements.state, KiloPassOrgAgreementState.PendingPayment)
      )
    )
    .orderBy(desc(kilo_pass_org_agreements.created_at))
    .limit(1);
  if (!agreement?.providerSubscriptionId) return false;

  const subscription = await stripe.subscriptions.retrieve(agreement.providerSubscriptionId, {
    expand: ['latest_invoice'],
  });
  const invoice = subscription.latest_invoice;
  if (invoice && typeof invoice !== 'string' && invoice.status === 'paid') {
    const activated = await handleOrganizationKiloPassInvoicePaid({ invoice });
    if (activated) return true;
  }
  if (subscription.status !== 'canceled' && !subscription.ended_at) return false;

  await db
    .update(kilo_pass_org_agreements)
    .set({ state: KiloPassOrgAgreementState.Ended })
    .where(
      and(
        eq(kilo_pass_org_agreements.id, agreement.id),
        eq(kilo_pass_org_agreements.state, KiloPassOrgAgreementState.PendingPayment)
      )
    );
  return true;
}

/** Keep the paid seat subscription alive while removing only its Kilo Pass add-on at renewal. */
export async function scheduleOrganizationKiloPassCancellation(input: {
  providerSubscriptionId: string;
  providerSeatAddOnItemId: string;
  agreementId: string;
  organizationId: string;
}) {
  const subscription = await stripe.subscriptions.retrieve(input.providerSubscriptionId);
  const passItem = subscription.items.data.find(item => item.id === input.providerSeatAddOnItemId);
  if (!passItem) return;
  const period = periodForItem(paidSeatItem(subscription));
  const periodStart = Math.floor(period.start.getTime() / 1000);
  const periodEnd = Math.floor(period.end.getTime() / 1000);
  const currentItems = subscriptionScheduleItems(subscription);
  const retainedItems = subscriptionScheduleItemsWithout(subscription, passItem.id);
  const unsafe = (reason: string, schedule: Stripe.SubscriptionSchedule | null): never =>
    throwUnsafeOrganizationKiloPassSchedule({
      event: 'cancel',
      reason,
      organizationId: input.organizationId,
      subscriptionId: subscription.id,
      schedule,
    });

  const existing = await retrieveAttachedSchedule(subscription);
  let target: Stripe.SubscriptionSchedule;
  let activePhase: Stripe.SubscriptionSchedule.Phase | null;
  if (!existing) {
    target = await stripe.subscriptionSchedules.create({ from_subscription: subscription.id });
    activePhase = target.phases[0] ?? null;
  } else {
    const isOrphanedCreate =
      Object.keys(existing.metadata ?? {}).length === 0 && existing.phases.length === 1;
    if (!isOwnedCancellationSchedule(existing) && !isOrphanedCreate) {
      return unsafe('unowned_schedule', existing);
    }
    const shape = classifyCancellationSchedule({
      schedule: existing,
      currentItems,
      retainedItems,
      periodEnd,
    });
    if (shape.kind === 'unsafe') return unsafe(shape.reason, existing);
    if (shape.kind === 'removal_pending') return;
    target = existing;
    activePhase = shape.activePhase;
  }
  await stripe.subscriptionSchedules.update(target.id, {
    metadata: {
      origin: ORGANIZATION_KILO_PASS_CANCELLATION_ORIGIN,
      agreementId: input.agreementId,
    },
    end_behavior: 'release',
    phases: [
      phaseUpdateParams(activePhase, currentItems, {
        start_date: activePhase?.start_date ?? periodStart,
        end_date: periodEnd,
      }),
      phaseUpdateParams(activePhase, retainedItems),
    ],
  });
}

/**
 * Restores the Kilo Pass add-on by releasing the owned cancellation schedule.
 * The subscription already carries the current items, so release keeps them.
 */
export async function resumeOrganizationKiloPassCancellation(input: {
  providerSubscriptionId: string;
  providerSeatAddOnItemId: string;
  organizationId: string;
}) {
  const subscription = await stripe.subscriptions.retrieve(input.providerSubscriptionId);
  const passItem = subscription.items.data.find(item => item.id === input.providerSeatAddOnItemId);
  if (!passItem) throw new Error('KILO_PASS_ADD_ON_UNAVAILABLE');
  const schedule = await retrieveAttachedSchedule(subscription);
  if (!schedule) return;
  const unsafe = (reason: string): never =>
    throwUnsafeOrganizationKiloPassSchedule({
      event: 'resume',
      reason,
      organizationId: input.organizationId,
      subscriptionId: subscription.id,
      schedule,
    });
  if (!isOwnedCancellationSchedule(schedule)) return unsafe('unowned_schedule');
  const shape = classifyCancellationSchedule({
    schedule,
    currentItems: subscriptionScheduleItems(subscription),
    retainedItems: subscriptionScheduleItemsWithout(subscription, passItem.id),
    periodEnd: Math.floor(periodForItem(paidSeatItem(subscription)).end.getTime() / 1000),
  });
  if (shape.kind === 'unsafe') return unsafe(shape.reason);
  await releaseCancellationSchedule(schedule.id);
}

async function retrieveOwnedScheduleFromEvent(
  subscription: Stripe.Subscription
): Promise<Stripe.SubscriptionSchedule | null> {
  if (!subscription.schedule) return null;
  const schedule = await stripe.subscriptionSchedules.retrieve(
    typeof subscription.schedule === 'string' ? subscription.schedule : subscription.schedule.id
  );
  return isOwnedCancellationSchedule(schedule) ? schedule : null;
}

async function agreementForCancellationSchedule(
  schedule: Stripe.SubscriptionSchedule,
  providerSubscriptionId: string
) {
  const agreementId = schedule.metadata?.agreementId;
  if (!agreementId) return null;
  const [agreement] = await db
    .select()
    .from(kilo_pass_org_agreements)
    .where(
      and(
        eq(kilo_pass_org_agreements.id, agreementId),
        eq(kilo_pass_org_agreements.provider_subscription_id, providerSubscriptionId)
      )
    )
    .limit(1);
  return agreement ?? null;
}

/**
 * Subscription events can arrive late. A missing pass item in the payload only
 * ends a live agreement when a fresh read confirms its item is gone, so an old
 * event cannot end an agreement repurchased on the same subscription.
 */
function isPassItemStillAttached(
  fresh: Stripe.Subscription,
  providerSeatAddOnItemId: string | null
): boolean {
  return (
    resolveOrganizationKiloPassSubscriptionItem({
      subscription: fresh,
      boundProviderItemId: providerSeatAddOnItemId,
    }) !== undefined
  );
}

/**
 * After renewal removes the pass item, the owned schedule's retained phase
 * would otherwise stay attached for a full period. Release it only when its
 * current phase no longer carries a Kilo Pass price.
 */
async function releaseScheduleAfterPassItemRemoved(
  schedule: Stripe.SubscriptionSchedule
): Promise<ScheduleReleaseResult | null> {
  if (isTerminalScheduleStatus(schedule.status)) {
    return { scheduleId: schedule.id, status: schedule.status, alreadyTerminal: true };
  }
  const { activePhase } = activeAndFuturePhases(schedule);
  const passPriceIds = new Set(getKnownStripePriceIdsForKiloPass());
  if (!activePhase || activePhase.items.some(item => passPriceIds.has(phaseItemPriceId(item)))) {
    return null;
  }
  return releaseCancellationSchedule(schedule.id);
}

/**
 * Org cancellation is a schedule, so `cancel_at_period_end` stays false.
 * Keep the pending cancellation while fresh provider state still shows the
 * owned removal; event payloads can be stale.
 */
async function hasPendingOwnedRemoval(input: {
  subscriptionId: string;
  passItemId: string;
}): Promise<boolean> {
  const fresh = await stripe.subscriptions.retrieve(input.subscriptionId);
  const passItem = resolveOrganizationKiloPassSubscriptionItem({
    subscription: fresh,
    boundProviderItemId: input.passItemId,
  });
  if (!passItem) return true;
  const schedule = await retrieveAttachedSchedule(fresh);
  if (!schedule || !isOwnedCancellationSchedule(schedule)) return false;
  const seatItem = fresh.items.data.find(isSeatLineItem);
  if (!seatItem) return false;
  const shape = classifyCancellationSchedule({
    schedule,
    currentItems: subscriptionScheduleItems(fresh),
    retainedItems: subscriptionScheduleItemsWithout(fresh, passItem.id),
    periodEnd: Math.floor(periodForItem(seatItem).end.getTime() / 1000),
  });
  return shape.kind === 'removal_pending';
}

/**
 * The cancellation schedule names the agreement it was created for, so a
 * retried event can finish ending and auditing that agreement even after a
 * later event ended it or a repurchase made another agreement live. Schedules
 * without an agreement fall back to the live agreement.
 */
async function handlePassItemMissing(
  subscription: Stripe.Subscription,
  liveAgreement: typeof kilo_pass_org_agreements.$inferSelect | null
): Promise<boolean> {
  const schedule = await retrieveOwnedScheduleFromEvent(subscription);
  const scheduleAgreement = schedule
    ? await agreementForCancellationSchedule(schedule, subscription.id)
    : null;
  const agreement = scheduleAgreement ?? liveAgreement;
  if (!agreement) return false;
  if (agreement.state !== KiloPassOrgAgreementState.Ended) {
    const fresh = await stripe.subscriptions.retrieve(subscription.id);
    if (isPassItemStillAttached(fresh, agreement.provider_seat_add_on_item_id)) return true;
  }
  const scheduleRelease = schedule ? await releaseScheduleAfterPassItemRemoved(schedule) : null;
  await endAgreementAfterPassItemRemoved({ agreementId: agreement.id, scheduleRelease });
  return true;
}

/** Subscription events reconcile identity and lifecycle only. Paid capacity is invoice-paid only. */
export async function handleOrganizationKiloPassSubscriptionEvent(
  subscription: Stripe.Subscription
) {
  const metadata = subscriptionMetadata(subscription);
  if (!metadata) return false;
  const [agreement] = await db
    .select()
    .from(kilo_pass_org_agreements)
    .where(
      and(
        eq(kilo_pass_org_agreements.provider_subscription_id, subscription.id),
        ne(kilo_pass_org_agreements.state, KiloPassOrgAgreementState.Ended)
      )
    )
    .orderBy(desc(kilo_pass_org_agreements.created_at))
    .limit(1);
  const item = agreement
    ? resolveOrganizationKiloPassSubscriptionItem({
        subscription,
        boundProviderItemId: agreement.provider_seat_add_on_item_id,
      })
    : undefined;
  if (!agreement || !item) {
    return handlePassItemMissing(subscription, agreement ?? null);
  }
  if (agreement.provider_seat_add_on_item_id !== item.id)
    await bindProviderSeatAddOnItem({
      agreementId: agreement.id,
      providerSeatAddOnItemId: item.id,
    });
  if (subscription.ended_at || subscription.status === 'canceled') {
    await db
      .update(kilo_pass_org_agreements)
      .set({ state: KiloPassOrgAgreementState.Ended })
      .where(eq(kilo_pass_org_agreements.id, agreement.id));
    return true;
  }
  // Subscription events can reconcile cancellation only after invoice.paid has
  // activated the agreement. A pending checkout must remain pending even when
  // Stripe has already transitioned its subscription to active.
  if (
    agreement.state !== KiloPassOrgAgreementState.Active &&
    agreement.state !== KiloPassOrgAgreementState.CancelAtPeriodEnd
  ) {
    return true;
  }
  if (subscription.cancel_at_period_end) {
    await db
      .update(kilo_pass_org_agreements)
      .set({ state: KiloPassOrgAgreementState.CancelAtPeriodEnd })
      .where(eq(kilo_pass_org_agreements.id, agreement.id));
  } else if (
    agreement.state === KiloPassOrgAgreementState.CancelAtPeriodEnd &&
    (await hasPendingOwnedRemoval({ subscriptionId: subscription.id, passItemId: item.id }))
  ) {
    return true;
  } else {
    await db
      .update(kilo_pass_org_agreements)
      .set({ state: KiloPassOrgAgreementState.Active, cancellation_effective_at: null })
      .where(eq(kilo_pass_org_agreements.id, agreement.id));
  }
  return true;
}

export async function handleOrganizationKiloPassPaymentAdverse(subscriptionId: string) {
  await suspendAgreementForPaymentReview(subscriptionId);
}

export async function handleOrganizationKiloPassPaymentAdverseForInvoice(invoice: Stripe.Invoice) {
  const reference = invoice.parent?.subscription_details?.subscription;
  const subscriptionId = typeof reference === 'string' ? reference : reference?.id;
  if (subscriptionId) await handleOrganizationKiloPassPaymentAdverse(subscriptionId);
}

/** Ends an unpaid checkout only after Stripe has made its invoice terminal. */
export async function endPendingOrganizationKiloPassForTerminalInvoice(invoice: Stripe.Invoice) {
  if (invoice.status !== 'void' && invoice.status !== 'uncollectible') return false;
  const reference = invoice.parent?.subscription_details?.subscription;
  const subscriptionId = typeof reference === 'string' ? reference : reference?.id;
  if (!subscriptionId) return false;
  const [agreement] = await db
    .select()
    .from(kilo_pass_org_agreements)
    .where(
      and(
        eq(kilo_pass_org_agreements.provider_subscription_id, subscriptionId),
        eq(kilo_pass_org_agreements.state, KiloPassOrgAgreementState.PendingPayment)
      )
    )
    .orderBy(desc(kilo_pass_org_agreements.created_at))
    .limit(1);
  if (!agreement) return false;
  const isUnbound = isPendingProviderItemId(agreement.provider_seat_add_on_item_id);
  const unboundPassLine = isUnbound ? invoiceLineForKnownKiloPassPrice(invoice) : undefined;
  if (
    isUnbound
      ? !unboundPassLine
      : !invoiceLineForSubscriptionItem(invoice, agreement.provider_seat_add_on_item_id ?? '')
  ) {
    return false;
  }

  const subscription = await stripe.subscriptions.retrieve(subscriptionId);
  const passItem = resolveOrganizationKiloPassSubscriptionItem({
    subscription,
    boundProviderItemId: isUnbound ? undefined : agreement.provider_seat_add_on_item_id,
  });
  if (passItem) {
    await stripe.subscriptions.update(subscriptionId, {
      proration_behavior: 'none',
      items: [{ id: passItem.id, deleted: true }],
    });
  }
  await db
    .update(kilo_pass_org_agreements)
    .set({ state: KiloPassOrgAgreementState.Ended })
    .where(
      and(
        eq(kilo_pass_org_agreements.id, agreement.id),
        eq(kilo_pass_org_agreements.state, KiloPassOrgAgreementState.PendingPayment)
      )
    );
  return true;
}
