import type { androidpublisher_v3 } from '@googleapis/androidpublisher';

import { KiloPassPaymentProvider } from '@/lib/kilo-pass/enums';
import { APPLE_STORE_BUNDLE_ID } from '@/lib/kilo-pass/apple-store-sdk';
import {
  decodeAppleStoreTransactionJws,
  normalizeEnvironment,
  type AppleStoreDecodedTransaction,
  type AppleStoreEnvironment,
} from '@/lib/kilo-pass/apple-store-verifier';
import {
  consumeGooglePlayProductPurchase,
  getGooglePlayProductPurchase,
} from '@/lib/kilo-pass/google-play-sdk';

import {
  getStoreCreditProductByAppleProductId,
  getStoreCreditProductByGoogleProductId,
} from './store-products';

export type ValidatedStoreCreditPurchase = {
  paymentProvider: KiloPassPaymentProvider;
  productId: string;
  providerTransactionId: string;
  appAccountToken: string | null;
  quantity: number;
  amountUsd: number;
  amountMicrodollars: number;
  purchasedAtIso: string;
  environment: AppleStoreEnvironment;
  rawPayload: unknown;
};

function assertCreditQuantity(quantity: unknown, providerLabel: string): number {
  if (
    typeof quantity !== 'number' ||
    !Number.isInteger(quantity) ||
    quantity < 1 ||
    quantity > 100
  ) {
    throw new Error(`${providerLabel} quantity is out of range`);
  }
  return quantity;
}

/**
 * The decoded App Store transaction type does not surface `quantity`, so read
 * it from the payload (or from an explicitly attached property in tests).
 */
function readAppleQuantity(decoded: AppleStoreDecodedTransaction): unknown {
  const attached = (decoded as { quantity?: unknown }).quantity;
  if (attached !== undefined) return attached;
  return (decoded.rawPayload as { quantity?: unknown }).quantity ?? 1;
}

export function mapAppleCreditTransaction(
  decoded: AppleStoreDecodedTransaction
): ValidatedStoreCreditPurchase {
  if (!decoded.transactionId || !decoded.bundleId || !decoded.productId) {
    throw new Error('Apple transaction is missing identifiers');
  }
  if (decoded.bundleId !== APPLE_STORE_BUNDLE_ID) {
    throw new Error('Apple transaction bundle mismatch');
  }
  if (decoded.revocationDate != null) {
    throw new Error('Apple transaction has been revoked');
  }
  // Credit packs are consumables: a transaction that expires is a subscription
  // or a non-consumable, never a credit purchase.
  if (decoded.expiresDate != null) {
    throw new Error('Apple credit purchase is not a consumable');
  }

  const product = getStoreCreditProductByAppleProductId(decoded.productId);
  if (!product) {
    throw new Error('Apple transaction product is not a credit pack');
  }

  const quantity = assertCreditQuantity(readAppleQuantity(decoded), 'Apple transaction');

  return {
    paymentProvider: KiloPassPaymentProvider.AppStore,
    productId: decoded.productId,
    providerTransactionId: decoded.transactionId,
    appAccountToken: decoded.appAccountToken ?? null,
    quantity,
    amountUsd: product.amountUsd,
    amountMicrodollars: product.amountMicrodollars * quantity,
    purchasedAtIso: new Date(decoded.purchaseDate).toISOString(),
    environment: normalizeEnvironment(decoded.environment),
    rawPayload: decoded.rawPayload,
  };
}

export async function verifyAppleCreditPurchase(
  signedTransactionJws: string
): Promise<ValidatedStoreCreditPurchase> {
  return mapAppleCreditTransaction(await decodeAppleStoreTransactionJws(signedTransactionJws));
}

function googlePlayPurchaseTimeIso(apiData: androidpublisher_v3.Schema$ProductPurchase): string {
  const purchaseTimeMs = Number(apiData.purchaseTimeMillis);
  if (Number.isFinite(purchaseTimeMs)) return new Date(purchaseTimeMs).toISOString();
  return new Date().toISOString();
}

export async function verifyGooglePlayCreditPurchase(params: {
  productId: string;
  purchaseToken: string;
}): Promise<ValidatedStoreCreditPurchase> {
  const apiData = await getGooglePlayProductPurchase(params.productId, params.purchaseToken);

  const responseProductId = apiData.productId ?? '';
  if (responseProductId !== params.productId) {
    throw new Error('Google Play purchase product is not a credit pack');
  }
  const product = getStoreCreditProductByGoogleProductId(responseProductId);
  if (!product) {
    throw new Error('Google Play purchase product is not a credit pack');
  }
  // ProductPurchase.purchaseState: 0 purchased, 1 canceled, 2 pending.
  if (apiData.purchaseState !== 0) {
    throw new Error('Google Play purchase is not in a purchased state');
  }

  const quantity = assertCreditQuantity(apiData.quantity ?? 1, 'Google Play purchase');

  const orderId = apiData.orderId;
  const providerTransactionId = orderId && orderId.length > 0 ? orderId : params.purchaseToken;

  return {
    paymentProvider: KiloPassPaymentProvider.GooglePlay,
    productId: responseProductId,
    providerTransactionId,
    appAccountToken: apiData.obfuscatedExternalAccountId ?? null,
    quantity,
    amountUsd: product.amountUsd,
    amountMicrodollars: product.amountMicrodollars * quantity,
    purchasedAtIso: googlePlayPurchaseTimeIso(apiData),
    // ProductPurchase.purchaseType: 0 test, 1 promo, 2 rewarded.
    environment: apiData.purchaseType === 0 ? 'Sandbox' : 'Production',
    rawPayload: apiData,
  };
}

/**
 * A one-time product must be *consumed*, not acknowledged, to be purchasable
 * again; consume also acknowledges. An already-consumed purchase is a success.
 */
export async function acknowledgeGooglePlayCreditPurchase(
  productId: string,
  purchaseToken: string
): Promise<void> {
  await consumeGooglePlayProductPurchase(productId, purchaseToken);
}
