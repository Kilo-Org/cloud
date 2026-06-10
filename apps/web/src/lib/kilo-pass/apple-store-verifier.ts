import { type JWSTransactionDecodedPayload } from '@apple/app-store-server-library';
import * as z from 'zod';

import type { ValidatedStoreKiloPassPurchase } from './store-subscription-completion';
import { KiloPassPaymentProvider } from './enums';
import { getMobileStoreKiloPassProductByAppleProductId } from './mobile-store-products';
import { APPLE_STORE_BUNDLE_ID, createAppleStoreSignedDataVerifier } from './apple-store-sdk';

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

export function mapAppleKiloPassTransaction(
  transaction: AppleStoreDecodedTransaction
): ValidatedStoreKiloPassPurchase {
  if (!transaction.transactionId || !transaction.originalTransactionId || !transaction.bundleId) {
    throw new Error('Apple transaction payload missing required identifiers');
  }
  if (transaction.bundleId !== APPLE_STORE_BUNDLE_ID) {
    throw new Error('Apple transaction bundle mismatch');
  }
  if (transaction.revocationDate) {
    throw new Error('Apple transaction has been revoked');
  }
  if (transaction.expiresDate == null) {
    throw new Error('Apple subscription transaction is missing an expiration date');
  }
  // Called only from the tRPC purchase-completion path; renewals and refunds enter via
  // the webhook handler in apple-store-notifications.ts, which intentionally allows expired transactions.
  if (transaction.expiresDate <= Date.now()) {
    throw new Error('Apple subscription transaction has expired');
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
    expiresAtIso: transaction.expiresDate ? new Date(transaction.expiresDate).toISOString() : null,
    tier: product.tier,
    cadence: product.cadence,
    rawPayload: transaction.rawPayload,
  };
}

export async function verifyAppleKiloPassTransactionJws(
  signedTransactionJws: string
): Promise<ValidatedStoreKiloPassPurchase> {
  const transaction = await decodeAppleStoreTransactionJws(signedTransactionJws);
  return mapAppleKiloPassTransaction(transaction);
}
