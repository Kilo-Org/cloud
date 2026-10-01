import { createHash } from 'node:crypto';

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

import { StorePurchasePendingError, StoreVerificationError } from './store-purchase-errors';
import {
  getStoreCreditProductByAppleProductId,
  getStoreCreditProductByGoogleProductId,
} from './store-products';

export type ValidatedStoreCreditPurchase = {
  paymentProvider: KiloPassPaymentProvider;
  productId: string;
  providerTransactionId: string;
  appAccountToken: string | null;
  /**
   * The raw Google Play purchase token this verification was handed, or null
   * for an App Store purchase.
   *
   * It exists only so a processed refund event can be matched in either arrival
   * order: the store-event table keys a Play purchase by the order id the
   * notification carries and by the raw token, while the credit ledger and the
   * advisory lock only ever see `providerTransactionId` (the order id, or a
   * digest of this token when Play reported none). It is never a lock key, a
   * ledger value, or part of a reported error. Optional so a hand-built
   * purchase can omit it; the verifier always sets it.
   */
  googlePlayPurchaseToken?: string | null;
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
    throw new StoreVerificationError(`${providerLabel} quantity is out of range`);
  }
  return quantity;
}

/**
 * Play names a one-time product purchase by its order id, which the purchase
 * API is documented to return only "if it exists". The purchase token is then
 * the only other id Play answers with, but a token is a bearer credential: it
 * may never be written into a credit row, a lock key, or an error report, so
 * the fallback identity is a digest. The refund handler derives the same one
 * from the token its notification carries.
 */
export function googlePlayCreditProviderTransactionId(params: {
  orderId?: string | null;
  purchaseToken: string;
}): string {
  const orderId = params.orderId?.trim() ?? '';
  if (orderId.length > 0) return orderId;
  return `token-sha256:${createHash('sha256').update(params.purchaseToken).digest('hex')}`;
}

/**
 * The ids a refund notification may name a purchase by, for matching
 * `kilo_pass_store_events` rows only.
 *
 * The completion locks the purchase and keys the grant by
 * `providerTransactionId`, which is the order id when Play reported one and the
 * token digest otherwise. A voided notification always carries an order id, so
 * the raw token `googlePlayPurchaseToken` holds is what finds a digest-keyed
 * grant — and only that lookup may see it, because the store event table stores
 * the token by design while the value never reaches a lock, the ledger, or
 * telemetry.
 */
export function storeCreditRefundLookupProviderTransactionIds(
  purchase: ValidatedStoreCreditPurchase
): string[] {
  const ids = [purchase.providerTransactionId];
  const purchaseToken = purchase.googlePlayPurchaseToken;
  if (
    typeof purchaseToken === 'string' &&
    purchaseToken.length > 0 &&
    !ids.includes(purchaseToken)
  ) {
    ids.push(purchaseToken);
  }
  return ids;
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
    throw new StoreVerificationError('Apple transaction is missing identifiers');
  }
  if (decoded.bundleId !== APPLE_STORE_BUNDLE_ID) {
    throw new StoreVerificationError('Apple transaction bundle mismatch');
  }
  if (decoded.revocationDate != null) {
    throw new StoreVerificationError('Apple transaction has been revoked');
  }
  // Credit packs are consumables: a transaction that expires is a subscription
  // or a non-consumable, never a credit purchase.
  if (decoded.expiresDate != null) {
    throw new StoreVerificationError('Apple credit purchase is not a consumable');
  }

  const product = getStoreCreditProductByAppleProductId(decoded.productId);
  if (!product) {
    throw new StoreVerificationError('Apple transaction product is not a credit pack');
  }

  const quantity = assertCreditQuantity(readAppleQuantity(decoded), 'Apple transaction');

  return {
    paymentProvider: KiloPassPaymentProvider.AppStore,
    productId: decoded.productId,
    providerTransactionId: decoded.transactionId,
    appAccountToken: decoded.appAccountToken ?? null,
    googlePlayPurchaseToken: null,
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

  // The Android Publisher API returns no `productId` for a one-time product
  // purchase: the token endpoint already names the product, and the API answers
  // 400 when the token belongs to a different product. A response that does carry
  // a product id is still checked against the request.
  const responseProductId = apiData.productId ?? params.productId;
  if (responseProductId !== params.productId) {
    throw new StoreVerificationError('Google Play purchase product is not a credit pack');
  }
  const product = getStoreCreditProductByGoogleProductId(responseProductId);
  if (!product) {
    throw new StoreVerificationError('Google Play purchase product is not a credit pack');
  }
  // ProductPurchase.purchaseState: 0 purchased, 1 canceled, 2 pending.
  //
  // A pending purchase (2) is not a defect in the receipt: Play has accepted the
  // charge but not finished it — a cash or otherwise deferred payment awaiting
  // approval — and the *same token* verifies once Play reports state 0. It is
  // thrown as its own retryable type so the router does not answer with the
  // terminal receipt refusal the mobile client remembers for the process, which
  // would strand a charge that is approved a moment later. A canceled (1) or
  // unknown state is a receipt the store will never let succeed.
  if (apiData.purchaseState === 2) {
    throw new StorePurchasePendingError();
  }
  if (apiData.purchaseState !== 0) {
    throw new StoreVerificationError('Google Play purchase is not in a purchased state');
  }

  // A credit pack is sold one unit at a time, and the voided-purchase handler
  // refuses a quantity-based refund of a multi-quantity order because the
  // notification does not carry the refunded quantity. Until that
  // reconciliation exists, a multi-unit purchase must be refused *before* it is
  // granted: Play's later single-unit refund would remove one unit while the
  // grant kept all of them, and the notification would retry a permanently
  // rejected refund forever.
  const quantity = apiData.quantity ?? 1;
  if (quantity !== 1) {
    throw new StoreVerificationError('Google Play credit packs are sold one unit at a time');
  }
  const providerTransactionId = googlePlayCreditProviderTransactionId({
    orderId: apiData.orderId,
    purchaseToken: params.purchaseToken,
  });

  return {
    paymentProvider: KiloPassPaymentProvider.GooglePlay,
    productId: responseProductId,
    providerTransactionId,
    appAccountToken: apiData.obfuscatedExternalAccountId ?? null,
    googlePlayPurchaseToken: params.purchaseToken,
    quantity,
    amountUsd: product.amountUsd,
    amountMicrodollars: product.amountMicrodollars * quantity,
    purchasedAtIso: googlePlayPurchaseTimeIso(apiData),
    // ProductPurchase.purchaseType: 0 test, 1 promo, 2 rewarded.
    //
    // A test (license-tester) purchase is credited like a paid one on purpose,
    // and this is the documented exception: the stores offer no other path to
    // exercise a real charge end to end, the amount always comes from the
    // catalog and never from the caller, and the grant is idempotent. It
    // mirrors the Kilo Pass store flow, which also grants on a Sandbox
    // purchase. Refusing Sandbox here would make the only testable store path
    // uncreditable.
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
