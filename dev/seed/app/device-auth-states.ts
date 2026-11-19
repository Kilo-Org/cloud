import { createHash } from 'node:crypto';

import { device_auth_requests } from '@kilocode/db/schema';
import { inArray } from 'drizzle-orm';

import { assertLocalSeedDatabase, getSeedDb } from '../lib/db';
import type { SeedResult } from '../index';

/**
 * The device codes the mobile login fixture resumes
 * (`apps/mobile/src/lib/login-fixture.ts`, `LOGIN_FIXTURE_DEVICE_CODES`).
 * Keep the two in step.
 */
const PENDING_DEVICE_CODE = 'dev-seed-device-auth-pending';
const DENIED_DEVICE_CODE = 'dev-seed-device-auth-denied';

const DAY_MS = 24 * 60 * 60 * 1000;

function printUsage(): void {
  console.log('Usage: pnpm dev:seed app:device-auth-states');
  console.log('');
  console.log('Stores two device sign-in requests that no account owns: one pending and');
  console.log('one denied. The mobile login fixture resumes a sign-in with their device');
  console.log('codes, so the local server answers its poll with 202 or 403.');
  console.log('');
  console.log('Suggested next step (signed-out development app):');
  console.log('  kiloapp:///dev/login-fixture/pending');
  console.log('  kiloapp:///dev/login-fixture/denied');
}

function hashDeviceCode(deviceCode: string): string {
  // Same hash as `hashDeviceSecret` in apps/web/src/lib/device-auth/device-auth.ts.
  return createHash('sha256').update(deviceCode).digest('hex');
}

export async function run(...args: string[]): Promise<SeedResult | void> {
  if (args.includes('--help') || args.includes('-h')) {
    printUsage();
    return;
  }
  await assertLocalSeedDatabase('app:device-auth-states');
  const db = getSeedDb();
  const codes = ['dev-seed-device-auth-pending-code', 'dev-seed-device-auth-denied-code'];
  await db.delete(device_auth_requests).where(inArray(device_auth_requests.code, codes));

  const expiresAt = new Date(Date.now() + DAY_MS).toISOString();
  await db.insert(device_auth_requests).values([
    {
      code: 'dev-seed-device-auth-pending-code',
      status: 'pending',
      expires_at: expiresAt,
      device_code_hash: hashDeviceCode(PENDING_DEVICE_CODE),
    },
    {
      code: 'dev-seed-device-auth-denied-code',
      status: 'denied',
      expires_at: expiresAt,
      device_code_hash: hashDeviceCode(DENIED_DEVICE_CODE),
    },
  ] satisfies (typeof device_auth_requests.$inferInsert)[]);

  console.log('This fixture represents: one pending and one denied device sign-in request.');
  console.log('Suggested next step: kiloapp:///dev/login-fixture/<pending|denied>');
  return {
    pendingDeviceCode: PENDING_DEVICE_CODE,
    deniedDeviceCode: DENIED_DEVICE_CODE,
    pendingLink: 'kiloapp:///dev/login-fixture/pending',
    deniedLink: 'kiloapp:///dev/login-fixture/denied',
    expiresAt,
  };
}
