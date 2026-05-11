import {
  AppStoreServerAPIClient,
  Environment,
  SignedDataVerifier,
} from '@apple/app-store-server-library';

import { getEnvVariable } from '@/lib/dotenvx';

export const APPLE_STORE_BUNDLE_ID = 'com.kilocode.kiloapp';

type CachedValue<T> = {
  key: string;
  value: T;
};

let cachedRootCertificates: CachedValue<Buffer[]> | null = null;
let cachedSignedDataVerifier: CachedValue<SignedDataVerifier> | null = null;
let cachedApiClient: CachedValue<AppStoreServerAPIClient> | null = null;

function requiredEnv(name: string): string {
  const value = getEnvVariable(name);
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

function getAppleEnvironment(): Environment {
  return requiredEnv('APPLE_IAP_ENVIRONMENT') === Environment.PRODUCTION
    ? Environment.PRODUCTION
    : Environment.SANDBOX;
}

function getAppleAppAppleId(): number | undefined {
  const value = getEnvVariable('APPLE_APP_APPLE_ID');
  return value ? Number(value) : undefined;
}

function parseAppleRootCertificates(pemBundle: string): Buffer[] {
  return pemBundle
    .split('-----END CERTIFICATE-----')
    .map(part => part.trim())
    .filter(Boolean)
    .map(part => Buffer.from(`${part}\n-----END CERTIFICATE-----\n`));
}

function getAppleRootCertificates(pemBundle: string): Buffer[] {
  if (cachedRootCertificates?.key === pemBundle) {
    return cachedRootCertificates.value;
  }

  const certificates = parseAppleRootCertificates(pemBundle);
  cachedRootCertificates = { key: pemBundle, value: certificates };
  return certificates;
}

export function createAppleStoreSignedDataVerifier(): SignedDataVerifier {
  const pemBundle = requiredEnv('APPLE_ROOT_CERTIFICATES_PEM');
  const environment = getAppleEnvironment();
  const appAppleId = getAppleAppAppleId();
  const key = JSON.stringify([pemBundle, environment, appAppleId ?? null]);
  if (cachedSignedDataVerifier?.key === key) {
    return cachedSignedDataVerifier.value;
  }

  const verifier = new SignedDataVerifier(
    getAppleRootCertificates(pemBundle),
    true,
    environment,
    APPLE_STORE_BUNDLE_ID,
    appAppleId
  );
  cachedSignedDataVerifier = { key, value: verifier };
  return verifier;
}

export function createAppleStoreServerApiClient(): AppStoreServerAPIClient {
  const privateKey = requiredEnv('APPLE_IAP_PRIVATE_KEY').replace(/\\n/g, '\n');
  const keyId = requiredEnv('APPLE_IAP_KEY_ID');
  const issuerId = requiredEnv('APPLE_IAP_ISSUER_ID');
  const environment = getAppleEnvironment();
  const key = JSON.stringify([privateKey, keyId, issuerId, environment]);
  if (cachedApiClient?.key === key) {
    return cachedApiClient.value;
  }

  const client = new AppStoreServerAPIClient(
    privateKey,
    keyId,
    issuerId,
    APPLE_STORE_BUNDLE_ID,
    environment
  );
  cachedApiClient = { key, value: client };
  return client;
}
