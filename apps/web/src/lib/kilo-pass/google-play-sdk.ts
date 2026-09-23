import { androidpublisher } from '@googleapis/androidpublisher';
import type { androidpublisher_v3 } from '@googleapis/androidpublisher';
import { GoogleAuth } from 'google-auth-library';
import type { JWTInput } from 'google-auth-library';

import { getEnvVariable } from '@/lib/dotenvx';

export const GOOGLE_PLAY_PACKAGE_NAME = 'com.kilocode.kiloapp';

const ANDROID_PUBLISHER_SCOPE = 'https://www.googleapis.com/auth/androidpublisher';

type CachedValue<T> = {
  key: string;
  value: T;
};

let cachedPublisherClient: CachedValue<androidpublisher_v3.Androidpublisher> | null = null;

function requiredEnv(name: string): string {
  const value = getEnvVariable(name);
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

function parseGooglePlayServiceAccountCredentials(json: string): JWTInput {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    throw new Error('GOOGLE_PLAY_PUBLISHER_SERVICE_ACCOUNT_JSON is invalid');
  }

  if (
    typeof value !== 'object' ||
    value === null ||
    !('client_email' in value) ||
    !('private_key' in value)
  ) {
    throw new Error('GOOGLE_PLAY_PUBLISHER_SERVICE_ACCOUNT_JSON is invalid');
  }

  const credentials = value as JWTInput;
  if (!credentials.client_email || !credentials.private_key) {
    throw new Error('GOOGLE_PLAY_PUBLISHER_SERVICE_ACCOUNT_JSON is invalid');
  }
  return credentials;
}

/**
 * Validates GOOGLE_PLAY_PUBLISHER_SERVICE_ACCOUNT_JSON without issuing a Play
 * request. A one-off run calls this before scanning so a missing or malformed
 * service account stops it with one clear, non-zero-exit message instead of
 * turning every order lookup into an indistinguishable `failed=N`.
 */
export function assertGooglePlayServiceAccountConfigured(): void {
  parseGooglePlayServiceAccountCredentials(
    requiredEnv('GOOGLE_PLAY_PUBLISHER_SERVICE_ACCOUNT_JSON')
  );
}

export function createGooglePlayAndroidPublisherClient(): androidpublisher_v3.Androidpublisher {
  const serviceAccountJson = requiredEnv('GOOGLE_PLAY_PUBLISHER_SERVICE_ACCOUNT_JSON');
  if (cachedPublisherClient?.key === serviceAccountJson) {
    return cachedPublisherClient.value;
  }

  const credentials = parseGooglePlayServiceAccountCredentials(serviceAccountJson);
  const auth = new GoogleAuth({
    credentials,
    scopes: [ANDROID_PUBLISHER_SCOPE],
  });
  const client = androidpublisher({ version: 'v3', auth });
  cachedPublisherClient = { key: serviceAccountJson, value: client };
  return client;
}

export async function getGooglePlaySubscriptionPurchase(
  purchaseToken: string
): Promise<androidpublisher_v3.Schema$SubscriptionPurchaseV2> {
  const client = createGooglePlayAndroidPublisherClient();
  const response = await client.purchases.subscriptionsv2.get({
    packageName: GOOGLE_PLAY_PACKAGE_NAME,
    token: purchaseToken,
  });
  return response.data;
}

export async function getGooglePlayProductPurchase(
  productId: string,
  purchaseToken: string
): Promise<androidpublisher_v3.Schema$ProductPurchase> {
  const client = createGooglePlayAndroidPublisherClient();
  const response = await client.purchases.products.get({
    packageName: GOOGLE_PLAY_PACKAGE_NAME,
    productId,
    token: purchaseToken,
  });
  return response.data;
}

export async function consumeGooglePlayProductPurchase(
  productId: string,
  purchaseToken: string
): Promise<void> {
  const client = createGooglePlayAndroidPublisherClient();
  try {
    await client.purchases.products.consume({
      packageName: GOOGLE_PLAY_PACKAGE_NAME,
      productId,
      token: purchaseToken,
    });
  } catch (error) {
    // The app can consume concurrently, or the response can be lost. A purchase
    // that is already consumed proves the consume took effect, so it is a success.
    const current = await getGooglePlayProductPurchase(productId, purchaseToken);
    if (current.consumptionState !== 1) throw error;
  }
}

export async function getGooglePlaySubscriptionOrder(
  orderId: string
): Promise<androidpublisher_v3.Schema$Order> {
  const client = createGooglePlayAndroidPublisherClient();
  const response = await client.orders.get({
    packageName: GOOGLE_PLAY_PACKAGE_NAME,
    orderId,
    fields:
      'orderId,purchaseToken,state,total,tax,lineItems(productId,total,tax,subscriptionDetails(servicePeriodStartTime,servicePeriodEndTime))',
  });
  return response.data;
}

export async function acknowledgeGooglePlaySubscriptionPurchase(
  productId: string,
  purchaseToken: string,
  appAccountToken?: string | null
): Promise<void> {
  const client = createGooglePlayAndroidPublisherClient();
  try {
    await client.purchases.subscriptions.acknowledge({
      packageName: GOOGLE_PLAY_PACKAGE_NAME,
      subscriptionId: productId,
      token: purchaseToken,
      // Google accepts these identifiers only for out-of-app resubscriptions.
      // https://developers.google.com/android-publisher/api-ref/rest/v3/purchases.subscriptions/acknowledge#ExternalAccountIds
      requestBody: appAccountToken
        ? { externalAccountIds: { obfuscatedAccountId: appAccountToken } }
        : {},
    });
  } catch (error) {
    // The app can acknowledge concurrently, or the response can be lost.
    const current = await getGooglePlaySubscriptionPurchase(purchaseToken);
    if (current.acknowledgementState !== 'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED') throw error;
  }
}

/**
 * Refunds the latest charge and revokes the subscription immediately.
 *
 * A user holds at most one Kilo Pass, so a second paid subscription is a
 * duplicate: the charge is reversed instead of admitted. The full amount is
 * refunded because Kilo granted nothing against a duplicate purchase; the
 * Kilo-side clawback (`reverseGooglePlayRefundCredits`) accounts for the spent
 * side, so the customer nets amount paid minus amount spent.
 *
 * A caller must treat a throw as "not reversed" and keep the notification
 * unprocessed, because retiring a charged order without a reversal loses money.
 */
export async function revokeGooglePlaySubscriptionPurchase(purchaseToken: string): Promise<void> {
  const client = createGooglePlayAndroidPublisherClient();
  try {
    await client.purchases.subscriptionsv2.revoke({
      packageName: GOOGLE_PLAY_PACKAGE_NAME,
      token: purchaseToken,
      requestBody: { revocationContext: { fullRefund: {} } },
    });
  } catch (error) {
    // A retried notification can find the subscription already revoked, and
    // Play then rejects the repeat call. Only EXPIRED proves the reversal took
    // effect: CANCELED, PAUSED, ON_HOLD and PENDING can still be entitled and
    // still charged, so their errors must keep the notification unprocessed.
    const current = await getGooglePlaySubscriptionPurchase(purchaseToken);
    if (current.subscriptionState !== 'SUBSCRIPTION_STATE_EXPIRED') {
      throw error;
    }
  }
}
