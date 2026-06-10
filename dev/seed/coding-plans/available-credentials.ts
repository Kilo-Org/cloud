import { createCipheriv, createHmac, randomBytes } from 'node:crypto';

import { coding_plan_key_inventory } from '@kilocode/db/schema';
import type { EncryptedData } from '@kilocode/db/schema-types';
import { and, eq, inArray } from 'drizzle-orm';

import { getSeedDb } from '../lib/db';
import type { SeedResult } from '../index';

const PLAN_ID = 'minimax-token-plan-plus';
const PROVIDER_ID = 'minimax';
const KEY_PREFIX = 'dev-seed:coding-plans';
const MAX_CREDENTIAL_COUNT = 20;

export const usage = '<scenario> [count]';

function printUsage(): void {
  console.log(`Usage: pnpm dev:seed coding-plans:available-credentials ${usage}`);
  console.log('');
  console.log(
    'Creates encrypted placeholder inventory credentials for local subscription UI testing.'
  );
  console.log(
    'These credentials bypass MiniMax validation and must not be used for provider traffic.'
  );
  console.log('');
  console.log('Examples:');
  console.log('  pnpm dev:seed coding-plans:available-credentials subscription-smoke 1');
  console.log('  pnpm dev:seed coding-plans:available-credentials byok-permutations 4');
}

function parseCount(rawCount: string | undefined): number {
  if (!rawCount) {
    return 1;
  }

  if (!/^\d+$/.test(rawCount)) {
    throw new Error('count must be a positive integer');
  }

  const count = Number(rawCount);
  if (!Number.isSafeInteger(count) || count < 1 || count > MAX_CREDENTIAL_COUNT) {
    throw new Error(`count must be between 1 and ${MAX_CREDENTIAL_COUNT}`);
  }

  return count;
}

function requireScenario(value: string | undefined): string {
  const scenario = value?.trim();
  if (!scenario || !/^[a-zA-Z0-9_-]{1,64}$/.test(scenario)) {
    throw new Error('scenario must contain 1-64 letters, digits, underscores, or hyphens');
  }
  return scenario;
}

function requireEncryptionKey(): Buffer {
  const keyBase64 = process.env.BYOK_ENCRYPTION_KEY;
  if (!keyBase64) {
    throw new Error('BYOK_ENCRYPTION_KEY is not configured');
  }

  const key = Buffer.from(keyBase64, 'base64');
  if (key.length !== 32) {
    throw new Error('BYOK_ENCRYPTION_KEY must decode to 32 bytes');
  }
  return key;
}

function encryptCredential(plaintext: string, key: Buffer): EncryptedData {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);

  return {
    iv: iv.toString('base64'),
    data: encrypted.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64'),
  };
}

function credentialFingerprint(plaintext: string, key: Buffer): string {
  return createHmac('sha256', key).update(plaintext).digest('hex');
}

export async function run(...args: string[]): Promise<SeedResult | void> {
  if (args.includes('--help') || args.includes('-h')) {
    printUsage();
    return;
  }

  const [rawScenario, rawCount, ...rest] = args;
  if (rest.length > 0) {
    printUsage();
    throw new Error(`Unexpected extra arguments: ${rest.join(' ')}`);
  }

  const scenario = requireScenario(rawScenario);
  const count = parseCount(rawCount);
  const key = requireEncryptionKey();
  const credentials = Array.from({ length: count }, (_, index) => {
    const plaintext = `${KEY_PREFIX}:${scenario}:${index + 1}`;
    return {
      upstreamPlanId: `${KEY_PREFIX}:minimax-plan:${scenario}:${index + 1}`,
      fingerprint: credentialFingerprint(plaintext, key),
      encrypted: encryptCredential(plaintext, key),
    };
  });
  const fingerprints = credentials.map(credential => credential.fingerprint);
  const db = getSeedDb();

  const consumed = await db
    .select({ status: coding_plan_key_inventory.status })
    .from(coding_plan_key_inventory)
    .where(inArray(coding_plan_key_inventory.credential_fingerprint, fingerprints));
  if (consumed.some(credential => credential.status !== 'available')) {
    throw new Error('This scenario has already assigned inventory. Use a new scenario name.');
  }

  const inserted = await db.transaction(async tx => {
    await tx
      .delete(coding_plan_key_inventory)
      .where(
        and(
          inArray(coding_plan_key_inventory.credential_fingerprint, fingerprints),
          eq(coding_plan_key_inventory.status, 'available')
        )
      );
    const rows = await tx
      .insert(coding_plan_key_inventory)
      .values(
        credentials.map(
          credential =>
            ({
              plan_id: PLAN_ID,
              provider_id: PROVIDER_ID,
              upstream_plan_id: credential.upstreamPlanId,
              encrypted_api_key: credential.encrypted,
              credential_fingerprint: credential.fingerprint,
              status: 'available',
            }) satisfies typeof coding_plan_key_inventory.$inferInsert
        )
      )
      .returning({ id: coding_plan_key_inventory.id });
    return rows.length;
  });

  console.log('This fixture supports local Coding Plan subscription and BYOK UI flows only.');
  console.log('Do not test provider traffic with placeholder credentials.');

  return {
    scenario,
    planId: PLAN_ID,
    providerId: PROVIDER_ID,
    availableCredentials: inserted,
    providerTrafficValid: false,
  };
}
