/**
 * Script to encrypt or decrypt promo codes.
 *
 * Run with:
 *   vercel env run -e production -- pnpm promo encrypt <plaintext>
 *   vercel env run -e production -- pnpm promo decrypt <encrypted>
 *
 * Requires CREDIT_CATEGORIES_ENCRYPTION_KEY environment variable (injected via `vercel env run`).
 */

import { getEnvVariable } from '@/lib/dotenvx';
import { decryptPromoCode, encryptPromoCode } from '@/lib/promoCreditEncryption';

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
  const encrypted = encryptPromoCode(value);
  console.log(`Encrypted: ${encrypted}`);
} else if (operation === 'decrypt') {
  const decrypted = decryptPromoCode(value);
  console.log(`Decrypted: ${decrypted}`);
} else {
  console.error(`Unknown operation: ${operation}. Use 'encrypt' or 'decrypt'.`);
  process.exit(1);
}
