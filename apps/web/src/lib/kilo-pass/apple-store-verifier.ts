import {
  Environment,
  SignedDataVerifier,
  type JWSTransactionDecodedPayload,
} from '@apple/app-store-server-library';
import * as z from 'zod';

import { getEnvVariable } from '@/lib/dotenvx';
import type { ValidatedStoreKiloPassPurchase } from './store-subscription-completion';
import { KiloPassPaymentProvider } from './enums';
import { getMobileStoreKiloPassProductByAppleProductId } from './mobile-store-products';

const BUNDLE_ID = 'com.kilocode.kiloapp';

export type AppleStoreEnvironment = 'Sandbox' | 'Production';

export type AppleStoreDecodedTransaction = {
  transactionId: string;
  originalTransactionId: string;
  bundleId: string;
  productId: string;
  purchaseDate: number;
  appAccountToken?: string;
  revocationDate?: number;
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
    appAccountToken: z.string().uuid().optional(),
    revocationDate: z.number().optional(),
    environment: z.string().optional(),
  })
  .passthrough();

function requiredEnv(name: string): string {
  const value = getEnvVariable(name);
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

function getAppleEnvironment(): Environment {
  return requiredEnv('APPLE_IAP_ENVIRONMENT') === 'Production'
    ? Environment.PRODUCTION
    : Environment.SANDBOX;
}

function getAppleAppAppleId(): number | undefined {
  const value = getEnvVariable('APPLE_APP_APPLE_ID');
  return value ? Number(value) : undefined;
}

function getAppleRootCertificates(): Buffer[] {
  const pemBundle = requiredEnv('APPLE_ROOT_CERTIFICATES_PEM');
  return pemBundle
    .split('-----END CERTIFICATE-----')
    .map(part => part.trim())
    .filter(Boolean)
    .map(part => Buffer.from(`${part}\n-----END CERTIFICATE-----\n`));
}

export function createAppleStoreSignedDataVerifier(): SignedDataVerifier {
  return new SignedDataVerifier(
    getAppleRootCertificates(),
    true,
    getAppleEnvironment(),
    BUNDLE_ID,
    getAppleAppAppleId()
  );
}

function normalizeEnvironment(environment: string | undefined): AppleStoreEnvironment {
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
    appAccountToken: payload.appAccountToken,
    revocationDate: payload.revocationDate,
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

export function mapAppleKiloPassTransaction(
  transaction: AppleStoreDecodedTransaction
): ValidatedStoreKiloPassPurchase {
  if (!transaction.transactionId || !transaction.originalTransactionId || !transaction.bundleId) {
    throw new Error('Apple transaction payload missing required identifiers');
  }
  if (transaction.bundleId !== BUNDLE_ID) {
    throw new Error('Apple transaction bundle mismatch');
  }
  if (transaction.revocationDate) {
    throw new Error('Apple transaction has been revoked');
  }

  const product = getMobileStoreKiloPassProductByAppleProductId(transaction.productId);
  if (!product) {
    throw new Error('Apple Kilo Pass product is not enabled');
  }

  return {
    paymentProvider: KiloPassPaymentProvider.AppStore,
    productId: transaction.productId,
    providerTransactionId: transaction.transactionId,
    providerOriginalTransactionId: transaction.originalTransactionId,
    providerSubscriptionId: transaction.originalTransactionId,
    appAccountToken: transaction.appAccountToken ?? null,
    purchaseToken: null,
    environment: transaction.environment,
    purchasedAtIso: new Date(transaction.purchaseDate).toISOString(),
    tier: product.tier,
    cadence: product.cadence,
    rawPayload: transaction.rawPayload,
  };
}

export async function verifyAppleKiloPassTransactionJws(
  signedTransactionJws: string
): Promise<ValidatedStoreKiloPassPurchase> {
  const transaction = await decodeAppleStoreTransactionJws(signedTransactionJws);
  return {
    ...mapAppleKiloPassTransaction(transaction),
    purchaseToken: signedTransactionJws,
  };
}
