import { createCipheriv, randomBytes } from 'node:crypto';

import { byok_api_keys } from '@kilocode/db/schema';
import type { EncryptedData } from '@kilocode/db/schema-types';
import { and, eq } from 'drizzle-orm';

import { getSeedDb } from '../lib/db';
import type { SeedResult } from '../index';

const PROVIDER_ID = 'minimax';
const KEY_PREFIX = 'dev-seed:coding-plans:occupied-minimax';

export const usage = '<user-id> <scenario> [--disabled]';

function printUsage(): void {
  console.log(`Usage: pnpm dev:seed coding-plans:occupied-minimax-byok ${usage}`);
  console.log('');
  console.log('Creates an encrypted personal MiniMax BYOK key that blocks Token Plan Plus signup.');
  console.log('The placeholder key supports subscription precondition UI testing only.');
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

function requireScenario(value: string | undefined): string {
  const scenario = value?.trim();
  if (!scenario || !/^[a-zA-Z0-9_-]{1,64}$/.test(scenario)) {
    throw new Error('scenario must contain 1-64 letters, digits, underscores, or hyphens');
  }
  return scenario;
}

export async function run(...args: string[]): Promise<SeedResult | void> {
  if (args.includes('--help') || args.includes('-h')) {
    printUsage();
    return;
  }

  const [rawUserId, rawScenario, ...options] = args;
  const userId = rawUserId?.trim();
  if (!userId) {
    printUsage();
    throw new Error('user-id is required');
  }
  const scenario = requireScenario(rawScenario);
  const unknownOptions = options.filter(option => option !== '--disabled');
  if (unknownOptions.length > 0) {
    throw new Error(`Unknown arguments: ${unknownOptions.join(' ')}`);
  }
  const isEnabled = !options.includes('--disabled');
  const db = getSeedDb();
  const [existing] = await db
    .select({ id: byok_api_keys.id })
    .from(byok_api_keys)
    .where(and(eq(byok_api_keys.kilo_user_id, userId), eq(byok_api_keys.provider_id, PROVIDER_ID)))
    .limit(1);
  if (existing) {
    throw new Error('User already has a MiniMax BYOK key. Use a new test user.');
  }

  const [inserted] = await db
    .insert(byok_api_keys)
    .values({
      kilo_user_id: userId,
      organization_id: null,
      provider_id: PROVIDER_ID,
      encrypted_api_key: encryptCredential(`${KEY_PREFIX}:${scenario}`, requireEncryptionKey()),
      management_source: 'user',
      created_by: userId,
      is_enabled: isEnabled,
    } satisfies typeof byok_api_keys.$inferInsert)
    .returning({ id: byok_api_keys.id });
  if (!inserted) {
    throw new Error('Failed to create MiniMax BYOK key');
  }

  return {
    userId,
    scenario,
    byokKeyId: inserted.id,
    providerId: PROVIDER_ID,
    enabled: isEnabled,
    providerTrafficValid: false,
  };
}
