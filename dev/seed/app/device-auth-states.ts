import { createHash } from 'node:crypto';

import { device_auth_requests } from '@kilocode/db/schema';
import { inArray, or } from 'drizzle-orm';

import { assertLocalSeedDatabase, getSeedDb } from '../lib/db';
import type { SeedResult } from '../index';

/**
 * The requests the mobile login fixture resumes, device code and user code alike
 * (`apps/mobile/src/lib/login-fixture.ts`, `LOGIN_FIXTURE_REQUESTS`). Keep the
 * two in step.
 */
const REQUESTS = {
  pending: {
    code: 'dev-seed-device-auth-pending-code',
    deviceCode: 'dev-seed-device-auth-pending',
    userCode: 'DEVP-ENDG',
  },
  denied: {
    code: 'dev-seed-device-auth-denied-code',
    deviceCode: 'dev-seed-device-auth-denied',
    userCode: 'DEVD-ENYD',
  },
} as const;

const DAY_MS = 24 * 60 * 60 * 1000;

function printUsage(): void {
  console.log('Usage: pnpm dev:seed app:device-auth-states');
  console.log('');
  console.log('Stores two device sign-in requests that no account owns: one pending and');
  console.log('one denied, each with its own user code. The mobile login fixture resumes');
  console.log('a sign-in with their codes, so the local server answers its poll with 202');
  console.log('or 403.');
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
  const requests = [REQUESTS.pending, REQUESTS.denied];
  await db.delete(device_auth_requests).where(
    or(
      inArray(
        device_auth_requests.code,
        requests.map(request => request.code)
      ),
      inArray(
        device_auth_requests.user_code,
        requests.map(request => request.userCode)
      )
    )
  );

  const expiresAt = new Date(Date.now() + DAY_MS).toISOString();
  await db.insert(device_auth_requests).values([
    {
      code: REQUESTS.pending.code,
      user_code: REQUESTS.pending.userCode,
      status: 'pending',
      expires_at: expiresAt,
      device_code_hash: hashDeviceCode(REQUESTS.pending.deviceCode),
    },
    {
      code: REQUESTS.denied.code,
      user_code: REQUESTS.denied.userCode,
      status: 'denied',
      expires_at: expiresAt,
      device_code_hash: hashDeviceCode(REQUESTS.denied.deviceCode),
    },
  ] satisfies (typeof device_auth_requests.$inferInsert)[]);

  console.log('This fixture represents: one pending and one denied device sign-in request.');
  console.log(
    'Suggested next step (signed-out development app): kiloapp:///dev/login-fixture/<pending|denied>'
  );
  return {
    pendingDeviceCode: REQUESTS.pending.deviceCode,
    pendingUserCode: REQUESTS.pending.userCode,
    deniedDeviceCode: REQUESTS.denied.deviceCode,
    deniedUserCode: REQUESTS.denied.userCode,
    pendingLink: 'kiloapp:///dev/login-fixture/pending',
    deniedLink: 'kiloapp:///dev/login-fixture/denied',
    expiresAt,
  };
}
