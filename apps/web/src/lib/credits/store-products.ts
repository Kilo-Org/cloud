import type { KiloPassPaymentProvider } from '@/lib/kilo-pass/enums';
import { toMicrodollars } from '@/lib/utils';

/**
 * One-off credit packs sold through the App Store and Google Play.
 *
 * The stores only sell fixed SKUs configured in App Store Connect / Play
 * Console, so an arbitrary amount cannot be sold through them. That is why the
 * preset option was delivered: the catalog below is the single source of truth
 * for what may be sold and for how many credits a validated purchase grants.
 * No code path may grant an amount outside this catalog.
 */
export type StoreCreditProduct = {
  amountUsd: number;
  amountMicrodollars: number;
  appleProductId: string;
  googleProductId: string;
};

function storeCreditProduct(
  amountUsd: number,
  appleProductId: string,
  googleProductId: string
): StoreCreditProduct {
  return {
    amountUsd,
    amountMicrodollars: toMicrodollars(amountUsd),
    appleProductId,
    googleProductId,
  };
}

export const STORE_CREDIT_PRODUCTS: StoreCreditProduct[] = [
  storeCreditProduct(10, 'credits.usd10.v1', 'credits_usd10'),
  storeCreditProduct(50, 'credits.usd50.v1', 'credits_usd50'),
  storeCreditProduct(100, 'credits.usd100.v1', 'credits_usd100'),
  storeCreditProduct(500, 'credits.usd500.v1', 'credits_usd500'),
];

export function getStoreCreditProductByAppleProductId(
  appleProductId: string
): StoreCreditProduct | undefined {
  return STORE_CREDIT_PRODUCTS.find(product => product.appleProductId === appleProductId);
}

export function getStoreCreditProductByGoogleProductId(
  googleProductId: string
): StoreCreditProduct | undefined {
  return STORE_CREDIT_PRODUCTS.find(product => product.googleProductId === googleProductId);
}

/**
 * The `credit_transactions.stripe_payment_id` idempotency key for a store
 * credit purchase. Mirrors the synthetic provider payment id for Kilo Pass
 * (`kilo-pass:${provider}:${providerTransactionId}`), which makes a replayed
 * completion a no-op.
 */
export function storeCreditPaymentId(
  provider: KiloPassPaymentProvider,
  providerTransactionId: string
): string {
  return `store-credit:${provider}:${providerTransactionId}`;
}
