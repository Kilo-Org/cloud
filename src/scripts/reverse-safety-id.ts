/**
 * Reverse-lookup a Kilo user from an OpenAI safety ID.
 *
 * OpenAI safety IDs are hex-encoded SHA-256 hashes that we set via
 * `generateProviderSpecificHash(user.id, provider)` when proxying through
 * OpenRouter. This script iterates all users and compares the hash bytes.
 *
 * Usage:
 *   pnpm script src/scripts/reverse-safety-id.ts [optional-safety-id-hex]
 */

import crypto from 'crypto';
import { db, closeAllDrizzleConnections } from '@/lib/drizzle';
import { kilocode_users } from '@kilocode/db/schema';

// Same salt and pepper used in src/lib/providerHash.ts for OpenRouter
const SALT = 'd20250815';
const OPENROUTER_PEPPER = 'henk is a boss';

const DEFAULT_TARGET_HEX = '3778592b5d1cca4db155ca83cd89617856576d0f8d74fe47506f5b3f6f3c1e61';

function hashUserIdHex(userId: string): string {
  return crypto
    .createHash('sha256')
    .update(SALT + OPENROUTER_PEPPER + userId)
    .digest('hex');
}

async function reverseLookup(targetHex: string) {
  console.log(`Looking up safety ID: ${targetHex}\n`);

  const PAGE_SIZE = 1000;
  let offset = 0;
  let totalChecked = 0;

  for (;;) {
    const users = await db
      .select({ id: kilocode_users.id, email: kilocode_users.google_user_email })
      .from(kilocode_users)
      .limit(PAGE_SIZE)
      .offset(offset);

    if (users.length === 0) break;

    for (const user of users) {
      if (hashUserIdHex(user.id) === targetHex) {
        console.log(`Match found!`);
        console.log(`  User ID: ${user.id}`);
        console.log(`  Email:   ${user.email}`);
        return;
      }
    }

    totalChecked += users.length;
    if (totalChecked % 10_000 === 0) {
      console.log(`  checked ${totalChecked} users...`);
    }

    offset += PAGE_SIZE;
  }

  console.log(`No matching user found after checking ${totalChecked} users.`);
}

const targetHex = (process.argv[2] ?? DEFAULT_TARGET_HEX).toLowerCase();

reverseLookup(targetHex)
  .then(async () => {
    await closeAllDrizzleConnections();
    process.exit(0);
  })
  .catch(async error => {
    console.error('Script failed:', error);
    await closeAllDrizzleConnections();
    process.exit(1);
  });
