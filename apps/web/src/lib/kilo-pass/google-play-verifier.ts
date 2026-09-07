import type { androidpublisher_v3 } from '@googleapis/androidpublisher';

import type { ValidatedStoreKiloPassPurchase } from './store-subscription-completion';
import { KiloPassPaymentProvider } from './enums';
import { getMobileStoreKiloPassProductByGoogleProductId } from './mobile-store-products';
import { getGooglePlaySubscriptionPurchase } from './google-play-sdk';

export type GooglePlayEnvironment = 'Sandbox' | 'Production';

export type GooglePlayDecodedPurchase = {
  purchaseToken: string;
  productId: string;
  latestOrderId: string;
  startTimeMs: number;
  expiryTimeMs: number;
  obfuscatedExternalAccountId?: string;
  environment: GooglePlayEnvironment;
  subscriptionState: string;
  rawPayload: Record<string, unknown>;
};

/**
 * Google Play states that entitle the buyer. `CANCELED` keeps access until the
 * paid period ends, and `IN_GRACE_PERIOD` keeps access while a payment retries.
 * Every other state (pending, paused, on hold, expired) grants no entitlement,
 * so a purchase in one of those states must never complete as `active`.
 */
const ENTITLED_GOOGLE_PLAY_SUBSCRIPTION_STATES = new Set([
  'SUBSCRIPTION_STATE_ACTIVE',
  'SUBSCRIPTION_STATE_CANCELED',
  'SUBSCRIPTION_STATE_IN_GRACE_PERIOD',
]);

export function mapGooglePlayKiloPassPurchase(
  decoded: GooglePlayDecodedPurchase
): ValidatedStoreKiloPassPurchase {
  if (!decoded.purchaseToken || !decoded.productId || !decoded.latestOrderId) {
    throw new Error('Google Play purchase payload missing required identifiers');
  }
  if (!Number.isFinite(decoded.startTimeMs) || !Number.isFinite(decoded.expiryTimeMs)) {
    throw new Error('Google Play subscription purchase has invalid timestamps');
  }
  // Called only from the tRPC purchase-completion path; renewals and refunds enter via
  // the Play notifications handler, which intentionally allows expired purchases.
  if (!ENTITLED_GOOGLE_PLAY_SUBSCRIPTION_STATES.has(decoded.subscriptionState)) {
    throw new Error(
      `Google Play subscription purchase is not entitled: ${decoded.subscriptionState || 'unknown'}`
    );
  }
  if (decoded.expiryTimeMs <= Date.now()) {
    throw new Error('Google Play subscription purchase has expired');
  }

  const product = getMobileStoreKiloPassProductByGoogleProductId(decoded.productId);
  if (!product) {
    throw new Error('Google Play Kilo Pass product is not enabled');
  }

  return {
    paymentProvider: KiloPassPaymentProvider.GooglePlay,
    productId: decoded.productId,
    providerTransactionId: decoded.latestOrderId,
    providerOriginalTransactionId: decoded.purchaseToken,
    providerSubscriptionId: decoded.purchaseToken,
    appAccountToken: decoded.obfuscatedExternalAccountId ?? null,
    purchaseToken: decoded.purchaseToken,
    environment: decoded.environment,
    purchasedAtIso: new Date(decoded.startTimeMs).toISOString(),
    expiresAtIso: new Date(decoded.expiryTimeMs).toISOString(),
    tier: product.tier,
    cadence: product.cadence,
    rawPayload: decoded.rawPayload,
  };
}

export function decodeGooglePlaySubscriptionPurchase(
  apiData: androidpublisher_v3.Schema$SubscriptionPurchaseV2,
  purchaseToken: string
): GooglePlayDecodedPurchase {
  const lineItems = apiData.lineItems ?? [];
  if (lineItems.length === 0) {
    throw new Error('Google Play subscription purchase missing line items');
  }
  const lineItem = lineItems[0];

  const latestOrderId =
    lineItem.latestSuccessfulOrderId ??
    (apiData as { latestOrderId?: string | null }).latestOrderId ??
    '';
  if (!latestOrderId) {
    throw new Error('Google Play purchase payload missing required identifiers');
  }

  return {
    purchaseToken,
    productId: lineItem.productId ?? '',
    latestOrderId,
    startTimeMs: Date.parse(apiData.startTime ?? ''),
    expiryTimeMs: Date.parse(lineItem.expiryTime ?? ''),
    obfuscatedExternalAccountId:
      apiData.externalAccountIdentifiers?.obfuscatedExternalAccountId ?? undefined,
    environment: apiData.testPurchase != null ? 'Sandbox' : 'Production',
    subscriptionState: apiData.subscriptionState ?? '',
    rawPayload: apiData as unknown as Record<string, unknown>,
  };
}

export async function verifyGooglePlayKiloPassPurchase(
  purchaseToken: string
): Promise<ValidatedStoreKiloPassPurchase> {
  const apiData = await getGooglePlaySubscriptionPurchase(purchaseToken);
  return mapGooglePlayKiloPassPurchase(
    decodeGooglePlaySubscriptionPurchase(apiData, purchaseToken)
  );
}
