import {
  AppStoreServerAPIClient,
  Environment,
  SignedDataVerifier,
  type JWSTransactionDecodedPayload,
} from '@apple/app-store-server-library';
import * as z from 'zod';

import { getEnvVariable } from '@kilocode/web-shared/lib/dotenvx';

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

export type AppleStoreEnvironment = 'Sandbox' | 'Production';

export type AppleStoreDecodedTransaction = {
  transactionId: string;
  originalTransactionId: string;
  bundleId: string;
  productId: string;
  purchaseDate: number;
  expiresDate?: number;
  appAccountToken?: string;
  revocationDate?: number;
  revocationType?: string;
  /** Refunded share of the transaction in milliunits (100000 = 100%). */
  revocationPercentage?: number;
  /** `RevocationReason.REFUNDED_DUE_TO_ISSUE` (1) or `REFUNDED_FOR_OTHER_REASON` (0). */
  revocationReason?: number;
  currency?: string;
  price?: number;
  environment: AppleStoreEnvironment;
  rawPayload: Record<string, unknown>;
};

const AppleStoreTransactionPayloadSchema = z
  .object({
    transactionId: z.string().min(1),
    originalTransactionId: z.string().min(1),
    bundleId: z.string().min(1),
    productId: z.string().min(1),
    purchaseDate: z.number(),
    expiresDate: z.number().optional(),
    appAccountToken: z.string().uuid().optional(),
    revocationDate: z.number().optional(),
    revocationType: z.string().optional(),
    revocationPercentage: z.number().optional(),
    revocationReason: z.number().optional(),
    currency: z.string().optional(),
    price: z.number().optional(),
    environment: z.string().optional(),
  })
  .passthrough();

export function normalizeEnvironment(environment: string | undefined): AppleStoreEnvironment {
  if (environment === 'Production') return 'Production';
  return 'Sandbox';
}

function decodeAppleStoreTransactionPayload(
  decoded: JWSTransactionDecodedPayload
): AppleStoreDecodedTransaction {
  const parsed = AppleStoreTransactionPayloadSchema.safeParse(decoded);
  if (!parsed.success) {
    throw new Error('Apple transaction payload missing required identifiers');
  }
  const payload = parsed.data;

  return {
    transactionId: payload.transactionId,
    originalTransactionId: payload.originalTransactionId,
    bundleId: payload.bundleId,
    productId: payload.productId,
    purchaseDate: payload.purchaseDate,
    expiresDate: payload.expiresDate,
    appAccountToken: payload.appAccountToken,
    revocationDate: payload.revocationDate,
    revocationType: payload.revocationType,
    revocationPercentage: payload.revocationPercentage,
    revocationReason: payload.revocationReason,
    currency: payload.currency,
    price: payload.price,
    environment: normalizeEnvironment(payload.environment),
    rawPayload: payload,
  };
}

export async function decodeAppleStoreTransactionJws(
  signedTransactionJws: string
): Promise<AppleStoreDecodedTransaction> {
  const decoded = (await createAppleStoreSignedDataVerifier().verifyAndDecodeTransaction(
    signedTransactionJws
  )) as JWSTransactionDecodedPayload;
  return decodeAppleStoreTransactionPayload(decoded);
}
