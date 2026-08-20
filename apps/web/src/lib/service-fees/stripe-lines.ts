import 'server-only';

import type Stripe from 'stripe';

import {
  STRIPE_ENTERPRISE_ANNUAL_PRICE_ID,
  STRIPE_ENTERPRISE_MONTHLY_PRICE_ID,
  STRIPE_TEAMS_ANNUAL_PRICE_ID,
  STRIPE_TEAMS_MONTHLY_PRICE_ID,
} from '@/lib/config.server';
import { getOrganizationKiloPassMetadata } from '@/lib/kilo-pass-org/stripe-metadata';
import { getKiloPassMetadataFromStripeMetadata } from '@/lib/kilo-pass/stripe-handlers-metadata';
import { getKnownStripePriceIdsForKiloPass } from '@/lib/kilo-pass/stripe-price-ids.server';
import { getKnownStripePriceIdsForKiloClaw } from '@/lib/kiloclaw/stripe-price-ids.server';
import { SEAT_PRODUCT_IDS, isSeatLineItem } from '@/lib/organizations/stripe-seat-line-items';
import { getNetPretaxLineAmountMinor } from '@/lib/service-fees/calculation';
import {
  SERVICE_FEE_METADATA_TYPE,
  SERVICE_FEE_RATE_BASIS_POINTS,
  SERVICE_FEE_VERSION,
} from '@/lib/service-fees/constants';
import type {
  ServiceFeeCommercialMetadata,
  ServiceFeeFlow,
  ServiceFeeLineMetadata,
} from '@/lib/service-fees/types';

const INVOICE_LINE_PAGE_SIZE = 100;

const KNOWN_SEAT_PRICE_IDS = new Set(
  [
    STRIPE_TEAMS_MONTHLY_PRICE_ID,
    STRIPE_TEAMS_ANNUAL_PRICE_ID,
    STRIPE_ENTERPRISE_MONTHLY_PRICE_ID,
    STRIPE_ENTERPRISE_ANNUAL_PRICE_ID,
  ].filter((priceId): priceId is string => Boolean(priceId && priceId.trim()))
);

export type InvoiceLineItemListClient = {
  invoices: {
    listLineItems: (
      invoiceId: string,
      params?: Stripe.InvoiceListLineItemsParams
    ) => PromiseLike<Pick<Stripe.ApiList<Stripe.InvoiceLineItem>, 'data' | 'has_more'>>;
  };
};

export type CheckoutLineLike = Stripe.LineItem | Stripe.Checkout.SessionCreateParams.LineItem;

export function buildServiceFeeLineMetadata(assessmentKey: string): ServiceFeeLineMetadata {
  return {
    type: SERVICE_FEE_METADATA_TYPE,
    serviceFeeVersion: SERVICE_FEE_VERSION,
    serviceFeeAssessmentKey: assessmentKey,
    serviceFeeRateBasisPoints: String(
      SERVICE_FEE_RATE_BASIS_POINTS
    ) as ServiceFeeLineMetadata['serviceFeeRateBasisPoints'],
  };
}

export function buildServiceFeeCommercialMetadata(input: {
  assessmentKey: string;
  flow: ServiceFeeFlow;
  principalMinor?: number;
  organizationId?: string;
}): ServiceFeeCommercialMetadata {
  return {
    serviceFeeAssessmentKey: input.assessmentKey,
    serviceFeeVersion: SERVICE_FEE_VERSION,
    serviceFeeFlow: input.flow,
    ...(input.principalMinor !== undefined
      ? { serviceFeePrincipalMinor: String(input.principalMinor) }
      : {}),
    ...(input.organizationId ? { serviceFeeOrganizationId: input.organizationId } : {}),
  };
}

export function isServiceFeeMetadata(
  metadata: Stripe.Metadata | Stripe.MetadataParam | null | undefined
): boolean {
  return (
    metadata?.type === SERVICE_FEE_METADATA_TYPE &&
    metadata.serviceFeeVersion === SERVICE_FEE_VERSION
  );
}

export function isServiceFeeInvoiceLine(line: Stripe.InvoiceLineItem): boolean {
  return isServiceFeeMetadata(line.metadata);
}

export function isServiceFeeCheckoutLine(line: CheckoutLineLike): boolean {
  if ('price_data' in line && isServiceFeeMetadata(line.price_data?.product_data?.metadata)) {
    return true;
  }

  if (!('price' in line) || !line.price || typeof line.price === 'string') {
    return false;
  }

  if (isServiceFeeMetadata(line.price.metadata)) return true;

  const product = line.price.product;
  if (!product || typeof product === 'string' || product.deleted) return false;
  return isServiceFeeMetadata(product.metadata);
}

export function isKnownKiloPassInvoiceLine(
  line: Stripe.InvoiceLineItem,
  subscription?: Stripe.Subscription | null
): boolean {
  if (
    isServiceFeeInvoiceLine(line) ||
    isSeatInvoiceLine(line, subscription) ||
    isKiloClawInvoiceLine(line)
  ) {
    return false;
  }

  const priceId = getInvoiceLinePriceId(line);
  if (priceId && getKnownKiloPassPriceIdSet().has(priceId)) return true;

  if (
    getKiloPassMetadataFromStripeMetadata(line.metadata) ||
    getOrganizationKiloPassMetadata(line.metadata)
  ) {
    return true;
  }

  if (!subscription || !lineBelongsToSubscription(line, subscription)) return false;

  const subscriptionItemId = getInvoiceLineSubscriptionItemId(line);
  if (!subscriptionItemId) return false;
  const item = subscription.items?.data.find(candidate => candidate.id === subscriptionItemId);
  if (!item) return false;

  return (
    getKnownKiloPassPriceIdSet().has(item.price.id) ||
    getKiloPassMetadataFromStripeMetadata(item.metadata) !== null ||
    getOrganizationKiloPassMetadata(item.metadata) !== null
  );
}

export function isSeatInvoiceLine(
  line: Stripe.InvoiceLineItem,
  subscription?: Stripe.Subscription | null
): boolean {
  if (isServiceFeeInvoiceLine(line)) return false;

  const productId = getInvoiceLineProductId(line);
  if (productId && SEAT_PRODUCT_IDS.has(productId)) return true;

  const priceId = getInvoiceLinePriceId(line);
  if (priceId && KNOWN_SEAT_PRICE_IDS.has(priceId)) return true;

  if (!subscription) return false;
  const subscriptionItemId = getInvoiceLineSubscriptionItemId(line);
  if (!subscriptionItemId) return false;
  const item = subscription.items?.data.find(candidate => candidate.id === subscriptionItemId);
  return item ? isSeatLineItem(item) : false;
}

export function isKiloClawInvoiceLine(line: Stripe.InvoiceLineItem): boolean {
  if (isServiceFeeInvoiceLine(line)) return false;

  const priceId = getInvoiceLinePriceId(line);
  if (priceId && getKnownKiloClawPriceIdSet().has(priceId)) return true;

  return line.metadata?.type === 'kiloclaw';
}

export function isEligibleKiloPassInvoiceLine(
  line: Stripe.InvoiceLineItem,
  subscription?: Stripe.Subscription | null
): boolean {
  return isKnownKiloPassInvoiceLine(line, subscription);
}

export function sumEligibleKiloPassSubtotalMinor(input: {
  lines: readonly Stripe.InvoiceLineItem[];
  currency: string;
  subscription?: Stripe.Subscription | null;
}): number {
  let total = BigInt(0);
  for (const line of input.lines) {
    if (!isEligibleKiloPassInvoiceLine(line, input.subscription)) continue;
    total += BigInt(getNetPretaxLineAmountMinor(line, input.currency));
  }
  if (total <= BigInt(0)) return 0;
  if (total > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error('eligible subtotal exceeds safe integer range');
  }
  return Number(total);
}

export async function listAllInvoiceLineItems(input: {
  invoice: Pick<Stripe.Invoice, 'id' | 'lines'>;
  stripe: InvoiceLineItemListClient;
}): Promise<Stripe.InvoiceLineItem[]> {
  if (!input.invoice.lines?.has_more) {
    return input.invoice.lines?.data ?? [];
  }
  if (!input.invoice.id) {
    throw new Error('invoice id is required to list all invoice lines');
  }

  const lines: Stripe.InvoiceLineItem[] = [];
  let startingAfter: string | undefined;

  for (;;) {
    const page = await input.stripe.invoices.listLineItems(input.invoice.id, {
      limit: INVOICE_LINE_PAGE_SIZE,
      ...(startingAfter ? { starting_after: startingAfter } : {}),
    });
    lines.push(...page.data);
    if (!page.has_more) break;
    const cursor = page.data.at(-1)?.id;
    if (!cursor) {
      throw new Error(`invoice ${input.invoice.id} line page is marked has_more without a cursor`);
    }
    startingAfter = cursor;
  }

  return lines;
}

export async function getEligibleKiloPassSubtotalMinor(input: {
  invoice: Stripe.Invoice;
  stripe: InvoiceLineItemListClient;
  subscription?: Stripe.Subscription | null;
}): Promise<number> {
  const lines = await listAllInvoiceLineItems({
    invoice: input.invoice,
    stripe: input.stripe,
  });
  return sumEligibleKiloPassSubtotalMinor({
    lines,
    currency: input.invoice.currency,
    subscription: input.subscription,
  });
}

function getInvoiceLinePriceId(line: Stripe.InvoiceLineItem): string | null {
  return line.pricing?.price_details?.price ?? null;
}

function getInvoiceLineProductId(line: Stripe.InvoiceLineItem): string | null {
  return line.pricing?.price_details?.product ?? null;
}

function getInvoiceLineSubscriptionItemId(line: Stripe.InvoiceLineItem): string | null {
  const itemId = line.parent?.subscription_item_details?.subscription_item;
  return typeof itemId === 'string' ? itemId : null;
}

function lineBelongsToSubscription(
  line: Stripe.InvoiceLineItem,
  subscription: Stripe.Subscription
): boolean {
  const lineSubscriptionId =
    typeof line.subscription === 'string' ? line.subscription : (line.subscription?.id ?? null);
  const parentSubscriptionId = line.parent?.subscription_item_details?.subscription ?? null;
  return lineSubscriptionId === subscription.id || parentSubscriptionId === subscription.id;
}

function getKnownKiloPassPriceIdSet(): Set<string> {
  return new Set(getKnownStripePriceIdsForKiloPass());
}

function getKnownKiloClawPriceIdSet(): Set<string> {
  try {
    return new Set(getKnownStripePriceIdsForKiloClaw());
  } catch {
    return new Set();
  }
}
