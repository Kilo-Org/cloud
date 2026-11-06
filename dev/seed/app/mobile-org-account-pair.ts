import { randomUUID } from 'node:crypto';

import { kilocode_users, organization_memberships, organizations } from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';

import type { SeedResult } from '../index';
import { assertLocalSeedDatabase, getSeedDb } from '../lib/db';

export const usage = '<fake-email>';

/**
 * One fake owner with two memberships, the pair every account switch needs:
 *
 * - `ownerOrganizationId` is an organization they own, so the money screens
 *   (invoices, credit activity) are readable there.
 * - `memberOrganizationId` is an organization they only belong to as a plain
 *   member, so the same screens refuse that organization.
 *
 * Switching between the two from the new-session account row, with an
 * organization screen still on the Profile tab's stack, is the account switch
 * the Profile tab has to survive.
 */
const OWNER_ORGANIZATION_ID = '5c1e7a90-0000-4000-8000-7a1b2c3d4e01';
const MEMBER_ORGANIZATION_ID = '5c1e7a90-0000-4000-8000-7a1b2c3d4e02';

function printUsage(): void {
  console.log(`Usage: pnpm dev:seed app:mobile-org-account-pair ${usage}`);
  console.log(
    'Seeds a local-only fake owner with one organization they own and one they are a plain member of.'
  );
  console.log('Requires a localhost database; never calls a provider.');
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
  assertLocalSeedDatabase('app:mobile-org-account-pair');
  if (process.env.NODE_ENV === 'production') {
    throw new Error('This fixture requires a local development database.');
  }
  const db = getSeedDb();
  const userId = `dev-seed:mobile-org-account-pair:${email}`;
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
      google_user_name: 'Account switch lab',
      google_user_image_url: '',
      stripe_customer_id: `cus_local_org_account_pair_${randomUUID()}`,
      has_validation_stytch: true,
      customer_source: 'dev-seed',
    })
    .onConflictDoNothing();

  const pair = [
    { id: OWNER_ORGANIZATION_ID, name: 'Switch lab owned' },
    { id: MEMBER_ORGANIZATION_ID, name: 'Switch lab member' },
  ];
  for (const organization of pair) {
    await db
      .insert(organizations)
      .values({
        id: organization.id,
        name: organization.name,
        created_by_kilo_user_id: userId,
        require_seats: true,
        plan: 'teams',
        settings: {},
      })
      .onConflictDoNothing();
  }
  await db
    .insert(organization_memberships)
    .values({ organization_id: OWNER_ORGANIZATION_ID, kilo_user_id: userId, role: 'owner' })
    .onConflictDoNothing();
  await db
    .insert(organization_memberships)
    .values({ organization_id: MEMBER_ORGANIZATION_ID, kilo_user_id: userId, role: 'member' })
    .onConflictDoNothing();

  console.log(
    'This fixture represents: one person who owns one organization and belongs to another.'
  );
  console.log('Suggested next step: sign in with the seeded email on the mobile dev client,');
  console.log('open the owned organization hub link, open Invoices from it, switch the');
  console.log('account to the member organization from the new-session account row, then');
  console.log('return to the Profile tab.');

  return {
    userId,
    email,
    ownerOrganizationId: OWNER_ORGANIZATION_ID,
    ownerOrganizationName: 'Switch lab owned',
    ownerHubDeepLink: `kiloapp:///(app)/(tabs)/(3_profile)/organization/${OWNER_ORGANIZATION_ID}`,
    memberOrganizationId: MEMBER_ORGANIZATION_ID,
    memberOrganizationName: 'Switch lab member',
    memberHubDeepLink: `kiloapp:///(app)/(tabs)/(3_profile)/organization/${MEMBER_ORGANIZATION_ID}`,
  };
}
