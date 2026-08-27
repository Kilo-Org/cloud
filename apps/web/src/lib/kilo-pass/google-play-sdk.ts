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
  const parsed = JSON.parse(json) as JWTInput;
  if (!parsed.client_email || !parsed.private_key) {
    throw new Error('GOOGLE_PLAY_PUBLISHER_SERVICE_ACCOUNT_JSON is invalid');
  }
  return parsed;
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
