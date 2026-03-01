/**
 * Reverse-lookup a Kilo user from an OpenAI safety ID.
 *
 * We set `safety_identifier` via `generateProviderSpecificHash(user.id, provider)`
 * when proxying requests. That function returns a **base64-encoded** SHA-256 hash.
 * The pepper differs per provider ("henk is a boss" for OpenRouter, "vercel" for
 * Vercel AI Gateway). This script tries both and compares raw digest bytes so it
 * works regardless of whether the input is hex or base64.
 *
 * Usage:
 *   pnpm script src/scripts/reverse-safety-id.ts <safety-id>
 *
 * The safety ID can be provided as either hex or base64.
 */

import crypto from 'crypto';
import { db, closeAllDrizzleConnections } from '@/lib/drizzle';
import { kilocode_users } from '@kilocode/db/schema';

// Same salt used in src/lib/providerHash.ts
const SALT = 'd20250815';

// Peppers per provider — see src/lib/providerHash.ts and src/lib/providers/index.ts
const PEPPERS: Record<string, string> = {
  openrouter: 'henk is a boss',
  vercel: 'vercel',
};

function hashUserId(userId: string, pepper: string): Buffer {
  return crypto
    .createHash('sha256')
    .update(SALT + pepper + userId)
    .digest();
}

function parseTarget(input: string): Buffer {
  // Try hex first (64 hex chars = 32 bytes)
  if (/^[0-9a-f]{64}$/i.test(input)) {
    return Buffer.from(input, 'hex');
  }
  // Otherwise treat as base64
  const buf = Buffer.from(input, 'base64');
  if (buf.length === 32) return buf;
  throw new Error(
    `Cannot parse safety ID: expected 64 hex chars or 44-char base64, got "${input}"`
  );
}

async function reverseLookup(target: Buffer) {
  const targetHex = target.toString('hex');
  const targetB64 = target.toString('base64');
  console.log(`Looking up safety ID:`);
  console.log(`  hex:    ${targetHex}`);
  console.log(`  base64: ${targetB64}`);
  console.log(`  trying peppers: ${Object.keys(PEPPERS).join(', ')}\n`);

  const PAGE_SIZE = 50_000;
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
      for (const [provider, pepper] of Object.entries(PEPPERS)) {
        if (hashUserId(user.id, pepper).equals(target)) {
          console.log(`Match found! (provider pepper: ${provider})`);
          console.log(`  User ID: ${user.id}`);
          console.log(`  Email:   ${user.email}`);
          return;
        }
      }
    }

    totalChecked += users.length;
    console.log(`  checked ${totalChecked} users...`);

    offset += PAGE_SIZE;
  }

  console.log(`No matching user found after checking ${totalChecked} users.`);
}

const input = process.argv[2];
if (!input) {
  console.error('Usage: pnpm script src/scripts/reverse-safety-id.ts <safety-id-hex-or-base64>');
  process.exit(1);
}

const target = parseTarget(input.trim());

reverseLookup(target)
  .then(async () => {
    await closeAllDrizzleConnections();
    process.exit(0);
  })
  .catch(async error => {
    console.error('Script failed:', error);
    await closeAllDrizzleConnections();
    process.exit(1);
  });
