import 'server-only';

import type Stripe from 'stripe';

import {
  buildAffiliateEventDedupeKey,
  enqueueAffiliateEventForUser,
} from '@/lib/impact/affiliate-events';
import { KiloPassCadence, KiloPassTier } from '@/lib/kilo-pass/enums';
import { sentryLogger } from '@/lib/utils.server';

const logWarning = sentryLogger('kilo-pass-affiliate-sale', 'warning');

export type KiloPassAffiliateSaleContext = {
  userId: string;
  tier: KiloPassTier;
  cadence: KiloPassCadence;
  itemSku?: string;
};

const KILO_PASS_AFFILIATE_SALE_REPORTING = {
  [KiloPassTier.Tier19]: {
    [KiloPassCadence.Monthly]: {
      itemCategory: 'kilo-pass-tier-19-monthly',
      itemName: 'Kilo Pass Tier 19 Monthly',
    },
    [KiloPassCadence.Yearly]: {
      itemCategory: 'kilo-pass-tier-19-yearly',
      itemName: 'Kilo Pass Tier 19 Yearly',
    },
  },
  [KiloPassTier.Tier49]: {
    [KiloPassCadence.Monthly]: {
      itemCategory: 'kilo-pass-tier-49-monthly',
      itemName: 'Kilo Pass Tier 49 Monthly',
    },
    [KiloPassCadence.Yearly]: {
      itemCategory: 'kilo-pass-tier-49-yearly',
      itemName: 'Kilo Pass Tier 49 Yearly',
    },
  },
  [KiloPassTier.Tier199]: {
    [KiloPassCadence.Monthly]: {
      itemCategory: 'kilo-pass-tier-199-monthly',
      itemName: 'Kilo Pass Tier 199 Monthly',
    },
    [KiloPassCadence.Yearly]: {
      itemCategory: 'kilo-pass-tier-199-yearly',
      itemName: 'Kilo Pass Tier 199 Yearly',
    },
  },
} satisfies Record<
  KiloPassTier,
  Record<KiloPassCadence, { itemCategory: string; itemName: string }>
>;

export function getKiloPassAffiliateSaleReportingFields(context: KiloPassAffiliateSaleContext) {
  const reportingFields = KILO_PASS_AFFILIATE_SALE_REPORTING[context.tier][context.cadence];
  return context.itemSku ? { ...reportingFields, itemSku: context.itemSku } : reportingFields;
}

function getChargeId(charge: string | Stripe.Charge | null | undefined): string | null {
  if (typeof charge === 'string') return charge;
  return charge?.id ?? null;
}

function getLegacyInvoiceChargeId(invoice: Stripe.Invoice): string | null {
  const invoiceCharge = 'charge' in invoice ? invoice.charge : null;
  if (typeof invoiceCharge === 'string') return invoiceCharge;
  if (
    invoiceCharge &&
    typeof invoiceCharge === 'object' &&
    'id' in invoiceCharge &&
    typeof invoiceCharge.id === 'string'
  ) {
    return invoiceCharge.id;
  }
  return null;
}

async function getRecoverableStripeChargeId(params: {
  invoice: Stripe.Invoice;
  stripe: Stripe;
}): Promise<string | null> {
  const { invoice, stripe } = params;

  for (const invoicePayment of invoice.payments?.data ?? []) {
    if (invoicePayment.status !== 'paid') continue;

    const payment = invoicePayment.payment;
    if (payment.type === 'charge') {
      const chargeId = getChargeId(payment.charge);
      if (chargeId) return chargeId;
      continue;
    }

    const rawPaymentIntent = payment.payment_intent;
    const expandedChargeId =
      typeof rawPaymentIntent === 'string' ? null : getChargeId(rawPaymentIntent?.latest_charge);
    if (expandedChargeId) return expandedChargeId;

    const paymentIntentId =
      typeof rawPaymentIntent === 'string' ? rawPaymentIntent : rawPaymentIntent?.id;
    if (!paymentIntentId || !stripe.paymentIntents?.retrieve) continue;

    try {
      const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId, {
        expand: ['latest_charge'],
      });
      const chargeId = getChargeId(paymentIntent.latest_charge);
      if (chargeId) return chargeId;
    } catch (error) {
      logWarning('Kilo Pass affiliate charge recovery failed', {
        stripe_invoice_id: invoice.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return getLegacyInvoiceChargeId(invoice);
}

function getReportablePromoCode(invoice: Stripe.Invoice): string | null {
  for (const discount of invoice.discounts ?? []) {
    if (typeof discount === 'string' || !('promotion_code' in discount)) continue;

    const promotionCode = discount.promotion_code;
    if (!promotionCode || typeof promotionCode === 'string') continue;

    const code = promotionCode.code.trim();
    if (code) return code;
  }

  return null;
}

export async function enqueueKiloPassAffiliateSaleForInvoice(params: {
  eventId: string;
  invoice: Stripe.Invoice;
  stripe: Stripe;
  context: KiloPassAffiliateSaleContext | null;
}): Promise<void> {
  const { eventId, invoice, stripe, context } = params;
  if (!context || invoice.amount_paid <= 0) {
    return;
  }

  try {
    const eventDate =
      invoice.status_transitions?.paid_at != null
        ? new Date(invoice.status_transitions.paid_at * 1000)
        : new Date();
    const stripeChargeId = await getRecoverableStripeChargeId({ invoice, stripe });
    const promoCode = getReportablePromoCode(invoice);

    await enqueueAffiliateEventForUser({
      userId: context.userId,
      provider: 'impact',
      eventType: 'sale',
      dedupeKey: buildAffiliateEventDedupeKey({
        provider: 'impact',
        eventType: 'sale',
        entityId: invoice.id,
      }),
      eventDate,
      orderId: invoice.id,
      amount: invoice.amount_paid / 100,
      currencyCode: invoice.currency ?? 'usd',
      ...getKiloPassAffiliateSaleReportingFields(context),
      ...(promoCode ? { promoCode } : {}),
      ...(stripeChargeId ? { stripeChargeId } : {}),
    });
  } catch (error) {
    logWarning('Affiliate sale enqueue failed', {
      stripe_event_id: eventId,
      user_id: context.userId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
