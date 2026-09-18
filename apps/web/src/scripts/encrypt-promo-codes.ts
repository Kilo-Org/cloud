/**
 * Script to encrypt or decrypt promo codes.
 *
 * Run with:
 *   vercel env run -e production -- pnpm promo encrypt <plaintext>
 *   vercel env run -e production -- pnpm promo decrypt <encrypted>
 *
 * Requires CREDIT_CATEGORIES_ENCRYPTION_KEY_V2 or CREDIT_CATEGORIES_ENCRYPTION_KEY
 * (injected via `vercel env run`).
 *
 * NOTE: This script intentionally avoids importing from promoCreditEncryption or
 * config.server to prevent top-level env var validation (e.g. NEXTAUTH_SECRET)
 * from failing in a CLI context.
 */

import { getEnvVariable } from '@/lib/dotenvx';
import { decryptWithSymmetricKey, encryptWithSymmetricKey } from '@kilocode/encryption';

const encryptionKey =
  getEnvVariable('CREDIT_CATEGORIES_ENCRYPTION_KEY_V2') ||
  getEnvVariable('CREDIT_CATEGORIES_ENCRYPTION_KEY');

if (!encryptionKey) {
  console.error(
    'Error: CREDIT_CATEGORIES_ENCRYPTION_KEY_V2 or CREDIT_CATEGORIES_ENCRYPTION_KEY environment variable is required'
  );
  process.exit(1);
}

const [operation, value] = process.argv.slice(2);

if (!operation || !value) {
  console.error('Usage: vercel env run -e production -- pnpm promo <encrypt|decrypt> <value>');
  process.exit(1);
}

if (operation === 'encrypt') {
  const encrypted = encryptWithSymmetricKey(value, encryptionKey);
  console.log(`Encrypted: ${encrypted}`);
} else if (operation === 'decrypt') {
  const decrypted = decryptWithSymmetricKey(value, encryptionKey);
  console.log(`Decrypted: ${decrypted}`);
} else {
  console.error(`Unknown operation: ${operation}. Use 'encrypt' or 'decrypt'.`);
  process.exit(1);
}
