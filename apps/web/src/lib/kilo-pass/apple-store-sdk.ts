import { Environment, SignedDataVerifier } from '@apple/app-store-server-library';

import { getEnvVariable } from '@/lib/dotenvx';

export const APPLE_STORE_BUNDLE_ID = 'com.kilocode.kiloapp';

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
    APPLE_STORE_BUNDLE_ID,
    getAppleAppAppleId()
  );
}
