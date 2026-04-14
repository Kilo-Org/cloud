/**
 * Script to encrypt or decrypt promo codes.
 *
 * Run with:
 *   vercel env run -e production -- pnpm promo encrypt <plaintext>
 *   vercel env run -e production -- pnpm promo decrypt <encrypted>
 *
 * Requires CREDIT_CATEGORIES_ENCRYPTION_KEY environment variable (injected via `vercel env run`).
 *
 * NOTE: This script intentionally avoids importing from promoCreditEncryption or
 * config.server to prevent top-level env var validation (e.g. NEXTAUTH_SECRET)
 * from failing in a CLI context.
 */

import { getEnvVariable } from '@/lib/dotenvx';
import { decryptWithSymmetricKey, encryptWithSymmetricKey } from '@kilocode/encryption';

const CREDIT_CATEGORIES_ENCRYPTION_KEY = getEnvVariable('CREDIT_CATEGORIES_ENCRYPTION_KEY');

if (!CREDIT_CATEGORIES_ENCRYPTION_KEY) {
  console.error('Error: CREDIT_CATEGORIES_ENCRYPTION_KEY environment variable is required');
  process.exit(1);
}

const [operation, value] = process.argv.slice(2);

if (!operation || !value) {
  console.error('Usage: vercel env run -e production -- pnpm promo <encrypt|decrypt> <value>');
  process.exit(1);
}

if (operation === 'encrypt') {
  const encrypted = encryptWithSymmetricKey(value, CREDIT_CATEGORIES_ENCRYPTION_KEY);
  console.log(`Encrypted: ${encrypted}`);
} else if (operation === 'decrypt') {
  const decrypted = decryptWithSymmetricKey(value, CREDIT_CATEGORIES_ENCRYPTION_KEY);
  console.log(`Decrypted: ${decrypted}`);
} else {
  console.error(`Unknown operation: ${operation}. Use 'encrypt' or 'decrypt'.`);
  process.exit(1);
}
