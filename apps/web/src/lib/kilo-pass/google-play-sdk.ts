import { androidpublisher } from '@googleapis/androidpublisher';
import type { androidpublisher_v3 } from '@googleapis/androidpublisher';
import { GoogleAuth } from 'google-auth-library';
import type { JWTInput } from 'google-auth-library';

import { getEnvVariable } from '@kilocode/web-shared/lib/dotenvx';

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

export async function getGooglePlayOrder(
  orderId: string
): Promise<androidpublisher_v3.Schema$Order> {
  const client = createGooglePlayAndroidPublisherClient();
  const response = await client.orders.get({
    packageName: GOOGLE_PLAY_PACKAGE_NAME,
    orderId,
    fields:
      'orderId,purchaseToken,state,total,tax,lineItems(productId,total,tax,subscriptionDetails(servicePeriodStartTime,servicePeriodEndTime),oneTimePurchaseDetails(quantity))',
  });
  return response.data;
}
