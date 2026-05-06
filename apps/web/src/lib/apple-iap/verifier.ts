import {
  Environment,
  SignedDataVerifier,
  type JWSTransactionDecodedPayload,
  type ResponseBodyV2DecodedPayload,
} from '@apple/app-store-server-library';
import { getEnvVariable } from '@/lib/dotenvx';
import type {
  AppleDecodedNotification,
  AppleDecodedTransaction,
  AppleIapEnvironment,
} from './types';

const BUNDLE_ID = 'com.kilocode.kiloapp';

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

function createVerifier(): SignedDataVerifier {
  return new SignedDataVerifier(
    getAppleRootCertificates(),
    true,
    getAppleEnvironment(),
    BUNDLE_ID,
    getAppleAppAppleId()
  );
}

function normalizeEnvironment(environment: string | undefined): AppleIapEnvironment {
  if (environment === 'Production') return 'Production';
  return 'Sandbox';
}

export async function verifyAppleTransactionJws(
  transactionJws: string
): Promise<AppleDecodedTransaction> {
  const decoded = (await createVerifier().verifyAndDecodeTransaction(
    transactionJws
  )) as JWSTransactionDecodedPayload;

  if (!decoded.transactionId || !decoded.originalTransactionId || !decoded.bundleId) {
    throw new Error('Apple transaction payload missing required identifiers');
  }
  if (!decoded.productId || !decoded.purchaseDate) {
    throw new Error('Apple transaction payload missing purchase fields');
  }

  return {
    transactionId: decoded.transactionId,
    originalTransactionId: decoded.originalTransactionId,
    webOrderLineItemId: decoded.webOrderLineItemId,
    bundleId: decoded.bundleId,
    productId: decoded.productId,
    purchaseDate: decoded.purchaseDate,
    revocationDate: decoded.revocationDate,
    appAccountToken: decoded.appAccountToken,
    environment: normalizeEnvironment(decoded.environment),
    type: decoded.type,
  };
}

export async function verifyAppleNotificationJws(
  signedPayload: string
): Promise<AppleDecodedNotification> {
  const decoded = (await createVerifier().verifyAndDecodeNotification(
    signedPayload
  )) as ResponseBodyV2DecodedPayload;

  if (!decoded.notificationUUID || !decoded.notificationType) {
    throw new Error('Apple notification payload missing required identifiers');
  }

  return {
    notificationUUID: decoded.notificationUUID,
    notificationType: decoded.notificationType,
    subtype: decoded.subtype,
    data: decoded.data
      ? {
          environment: normalizeEnvironment(decoded.data.environment),
          signedTransactionInfo: decoded.data.signedTransactionInfo,
        }
      : undefined,
  };
}
