import { kilocode_users, organization_memberships, organizations } from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';

import type { SeedResult } from '../index';
import { assertLocalSeedDatabase, getSeedDb } from '../lib/db';

export const usage = '<fake-email>';

/**
 * One fake account that holds several organizations, the membership list the
 * Home header's account picker scrolls in a landscape window:
 *
 * - Personal stays the first row, and the organizations follow it, so the
 *   picker opens with an organization checked rather than with `Personal`.
 * - Six organizations make the list taller than its half-window cap on a
 *   phone-sized screen, so the list scrolls and the checked row's reveal has
 *   to leave the first row in view.
 *
 * Open the account picker sheet with the returned deep link in a signed-in
 * mobile development client.
 */
const ORGANIZATION_IDS = [
  '7d1e5c00-0000-4000-8000-000000000001',
  '7d1e5c00-0000-4000-8000-000000000002',
  '7d1e5c00-0000-4000-8000-000000000003',
  '7d1e5c00-0000-4000-8000-000000000004',
  '7d1e5c00-0000-4000-8000-000000000005',
  '7d1e5c00-0000-4000-8000-000000000006',
];

function printUsage(): void {
  console.log(`Usage: pnpm dev:seed app:mobile-picker-orgs ${usage}`);
  console.log(
    'Seeds a local-only fake account with six organizations, enough for the account picker list to scroll.'
  );
  console.log('Requires a localhost database; never calls a provider.');
  console.log('Open the returned deep link in a signed-in mobile development client.');
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
  assertLocalSeedDatabase('app:mobile-picker-orgs');
  if (process.env.NODE_ENV === 'production') {
    throw new Error('This fixture requires a local development database.');
  }
  const db = getSeedDb();
  const userId = `dev-seed:mobile-picker-orgs:${email}`;
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
      google_user_name: 'Account picker lab',
      google_user_image_url: '',
      stripe_customer_id: `cus_local_mobile_picker_orgs_${userId.slice(-12)}`,
      has_validation_stytch: true,
      customer_source: 'dev-seed',
    })
    .onConflictDoNothing();

  const memberships = ORGANIZATION_IDS.map((id, index) => ({
    id,
    name: `Picker lab ${index + 1}`,
    role: index === 0 ? ('owner' as const) : ('member' as const),
  }));
  for (const organization of memberships) {
    await db
      .insert(organizations)
      .values({
        id: organization.id,
        name: organization.name,
        created_by_kilo_user_id: userId,
        require_seats: false,
        settings: {},
      })
      .onConflictDoNothing();
  }
  for (const organization of memberships) {
    await db
      .insert(organization_memberships)
      .values({
        organization_id: organization.id,
        kilo_user_id: userId,
        role: organization.role,
      })
      .onConflictDoNothing();
  }

  console.log('This fixture represents: one person who belongs to six organizations.');
  console.log('Suggested next step: sign in with the seeded email on the mobile dev client,');
  console.log('then open the deep link and hold the device in landscape to see the list');
  console.log('scroll under its half-window cap.');

  return {
    userId,
    email,
    organizationCount: memberships.length,
    organizationNames: memberships.map(organization => organization.name).join(', '),
    accountPickerDeepLink: 'kiloapp:///dev/account-picker-sheet-fixture',
  };
}
