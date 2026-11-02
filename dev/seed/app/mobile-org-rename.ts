import { randomUUID } from 'node:crypto';

import { kilocode_users, organization_memberships, organizations } from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';

import type { SeedResult } from '../index';
import { getSeedDb } from '../lib/db';

export const usage = '<fake-email>';

/**
 * Two organizations the same fake owner belongs to, one per rename outcome the
 * mobile rename dialog has to survive:
 *
 * - `refusedOrganizationId` never got a seat subscription and its trial ended
 *   more than three days ago, so `classifyOrganizationEntitlement` reports
 *   `trial_expired_hard` with no bypass and every organization mutation is
 *   refused with `FORBIDDEN` / `Organization trial has expired.` The owner
 *   still sees the rename control, so a rename typed here is rejected by the
 *   server while the dialog stays open.
 * - `acceptedOrganizationId` is a fresh organization inside its trial, so the
 *   same rename succeeds and the dialog closes.
 */
const REFUSED_ORGANIZATION_ID = '5c1e7a90-0000-4000-8000-6a7b8c9d0e11';
const ACCEPTED_ORGANIZATION_ID = '5c1e7a90-0000-4000-8000-6a7b8c9d0e12';

function printUsage(): void {
  console.log(`Usage: pnpm dev:seed app:mobile-org-rename ${usage}`);
  console.log(
    'Seeds a local-only fake owner with one organization whose trial ended and one inside its trial.'
  );
  console.log('Requires a localhost database and SKIP_STRIPE_API=true; never calls a provider.');
  console.log('Open the returned deep links in a signed-in mobile development client.');
}

export async function run(...args: string[]): Promise<SeedResult | void> {
  if (args.includes('--help') || args.includes('-h')) {
    printUsage();
    return;
  }
  const [email, ...extra] = args;
  if (!email || extra.length || !/^kilo-[a-z0-9-]+@example\.com$/.test(email)) {
    printUsage();
    throw new Error('Provide one owned fake email matching kilo-<name>@example.com.');
  }
  const databaseUrl = new URL(process.env.POSTGRES_URL ?? '');
  if (
    !['localhost', '127.0.0.1', '[::1]'].includes(databaseUrl.hostname) ||
    process.env.NODE_ENV === 'production' ||
    process.env.SKIP_STRIPE_API !== 'true'
  ) {
    throw new Error('This fixture requires a local development database and SKIP_STRIPE_API=true.');
  }
  const db = getSeedDb();
  const userId = `dev-seed:mobile-org-rename:${email}`;
  const [existing] = await db
    .select({ id: kilocode_users.id })
    .from(kilocode_users)
    .where(eq(kilocode_users.normalized_email, email));
  if (existing && existing.id !== userId) {
    throw new Error('The requested email belongs to a different account; choose a new fake email.');
  }
  await db
    .insert(kilocode_users)
    .values({
      id: userId,
      google_user_email: email,
      normalized_email: email,
      google_user_name: 'Rename lab owner',
      google_user_image_url: '',
      stripe_customer_id: `cus_local_org_rename_${randomUUID()}`,
      has_validation_stytch: false,
      customer_source: 'dev-seed',
    })
    .onConflictDoNothing();

  await db
    .insert(organizations)
    .values({
      id: REFUSED_ORGANIZATION_ID,
      name: 'Rename lab refused',
      created_at: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString(),
      created_by_kilo_user_id: userId,
      free_trial_end_at: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
      require_seats: true,
      plan: 'teams',
      settings: {},
    })
    .onConflictDoNothing();
  await db
    .insert(organizations)
    .values({
      id: ACCEPTED_ORGANIZATION_ID,
      name: 'Rename lab accepted',
      created_by_kilo_user_id: userId,
      require_seats: true,
      plan: 'teams',
      settings: {},
    })
    .onConflictDoNothing();
  for (const organizationId of [REFUSED_ORGANIZATION_ID, ACCEPTED_ORGANIZATION_ID]) {
    await db
      .insert(organization_memberships)
      .values({ organization_id: organizationId, kilo_user_id: userId, role: 'owner' })
      .onConflictDoNothing();
  }

  console.log('This fixture represents: an organization owner renaming their organization.');
  console.log('The refused organization answers every rename with the trial sentence.');
  console.log('Suggested next step: open a returned deep link on the signed-in mobile app.');
  return {
    userId,
    refusedOrganizationId: REFUSED_ORGANIZATION_ID,
    refusedOrganizationName: 'Rename lab refused',
    refusedDeepLink: `kiloapp:///(app)/(tabs)/(3_profile)/organization/${REFUSED_ORGANIZATION_ID}`,
    acceptedOrganizationId: ACCEPTED_ORGANIZATION_ID,
    acceptedOrganizationName: 'Rename lab accepted',
    acceptedDeepLink: `kiloapp:///(app)/(tabs)/(3_profile)/organization/${ACCEPTED_ORGANIZATION_ID}`,
  };
}
