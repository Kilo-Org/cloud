import { createHmac, randomUUID } from 'node:crypto';

import { coding_plan_key_inventory } from '@kilocode/db/schema';
import { and, eq, inArray } from 'drizzle-orm';

import { sealInventoryCredential } from '../lib/coding-plan-inventory-credential';
import { assertLocalSeedDatabase, getSeedDb } from '../lib/db';
import type { SeedResult } from '../index';

const PROVIDERS = {
  minimax: { planId: 'minimax-token-plan-plus', providerId: 'minimax' },
  byteplus: {
    planId: 'byteplus-coding-plan-team-lite',
    providerId: 'byteplus-coding',
  },
  'byteplus-pro': {
    planId: 'byteplus-coding-plan-team-pro',
    providerId: 'byteplus-coding',
  },
} as const;
const KEY_PREFIX = 'dev-seed:coding-plans';
const MAX_CREDENTIAL_COUNT = 20;

export const usage = '<scenario> [count] [minimax|byteplus|byteplus-pro]';

function printUsage(): void {
  console.log(`Usage: pnpm dev:seed coding-plans:available-credentials ${usage}`);
  console.log('');
  console.log(
    'Creates placeholder inventory credentials, encrypted through the local byok-kms service, for local subscription UI testing.'
  );
  console.log(
    'These credentials bypass provider validation and must not be used for provider traffic.'
  );
  console.log('');
  console.log('Examples:');
  console.log('  pnpm dev:seed coding-plans:available-credentials subscription-smoke 1');
  console.log('  pnpm dev:seed coding-plans:available-credentials byteplus-smoke 1 byteplus');
  console.log(
    '  pnpm dev:seed coding-plans:available-credentials byteplus-pro-smoke 1 byteplus-pro'
  );
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

function credentialFingerprint(plaintext: string, key: Buffer): string {
  return createHmac('sha256', key).update(plaintext).digest('hex');
}

export async function run(...args: string[]): Promise<SeedResult | void> {
  if (args.includes('--help') || args.includes('-h')) {
    printUsage();
    return;
  }

  const [rawScenario, rawCount, rawProvider = 'minimax', ...rest] = args;
  if (rest.length > 0) {
    printUsage();
    throw new Error(`Unexpected extra arguments: ${rest.join(' ')}`);
  }

  const scenario = requireScenario(rawScenario);
  const count = parseCount(rawCount);
  if (rawProvider !== 'minimax' && rawProvider !== 'byteplus' && rawProvider !== 'byteplus-pro') {
    throw new Error('provider must be minimax, byteplus, or byteplus-pro');
  }
  const provider = PROVIDERS[rawProvider];
  const key = requireEncryptionKey();
  const planned = Array.from({ length: count }, (_, index) => {
    const plaintext = `${KEY_PREFIX}:${scenario}:${index + 1}`;
    return {
      id: randomUUID(),
      plaintext,
      upstreamPlanId: `${KEY_PREFIX}:${rawProvider}-plan:${scenario}:${index + 1}`,
      fingerprint: credentialFingerprint(plaintext, key),
    };
  });
  const fingerprints = planned.map(credential => credential.fingerprint);
  // Both checks run before any credential is sealed: sealing asks the KMS service for a
  // data key, which an aborted run must not do.
  assertLocalSeedDatabase('coding-plans:available-credentials');
  const db = getSeedDb();

  const consumed = await db
    .select({ status: coding_plan_key_inventory.status })
    .from(coding_plan_key_inventory)
    .where(inArray(coding_plan_key_inventory.credential_fingerprint, fingerprints));
  if (consumed.some(credential => credential.status !== 'available')) {
    throw new Error('This scenario has already assigned inventory. Use a new scenario name.');
  }

  const credentials = await Promise.all(
    planned.map(async credential => ({
      ...credential,
      sealed: await sealInventoryCredential(credential.id, credential.plaintext),
    }))
  );

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
              id: credential.id,
              plan_id: provider.planId,
              provider_id: provider.providerId,
              upstream_plan_id: credential.upstreamPlanId,
              ...credential.sealed,
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
    planId: provider.planId,
    providerId: provider.providerId,
    availableCredentials: inserted,
    providerTrafficValid: false,
  };
}
