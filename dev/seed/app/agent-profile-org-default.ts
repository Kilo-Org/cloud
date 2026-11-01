import {
  agent_environment_profiles,
  kilocode_users,
  organization_memberships,
  organizations,
} from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';

import { getSeedDb } from '../lib/db';
import { normalizeSeedEmail } from '../lib/email';
import { isValidEmail } from '../lib/users';
import type { SeedResult } from '../index';

export const usage = '<email>';

const USER_ID = 'user_e2e_org_profile_default';
/** Stable, so the deep link a previous run printed keeps opening the screen. */
const ORGANIZATION_ID = 'c4a2f1e6-7b19-4d0e-9a53-2f6d8b1c7e40';
const PROFILE_ID = 'b41d6f52-0c8e-4b7a-9d31-5e2a8c6f9031';
const ORGANIZATION_NAME = 'Profile picker lab';
const PROFILE_NAME = 'Shared Agency Review Profile';
const STRIPE_CUSTOMER_ID = 'cus_local_org_profile_default';

function printUsage(): void {
  console.log(`Usage: pnpm dev:seed app:agent-profile-org-default ${usage}`);
  console.log('');
  console.log('Creates a fake user who owns one organization whose shared profile is the');
  console.log('organization default, with no personal default. In that organization scope the');
  console.log('new-session Environment chip and the profile picker both resolve to that profile.');
  console.log('Re-running replaces the user, the organization, its membership and the profile.');
  console.log('');
  console.log('The deep link it prints opens the profile picker sheet in a dev build:');
  console.log(`  kiloapp:///dev/profile-picker-fixture?org=${ORGANIZATION_ID}`);
  console.log('');
  console.log('Example:');
  console.log(`  pnpm dev:seed app:agent-profile-org-default org-profile@example.com`);
}

export async function run(...args: string[]): Promise<SeedResult | void> {
  if (args.includes('--help') || args.includes('-h')) {
    printUsage();
    return;
  }

  const [email, ...rest] = args;
  if (!email) {
    printUsage();
    throw new Error('email is required');
  }
  if (rest.length > 0) {
    throw new Error(`unexpected argument: ${rest[0]}`);
  }
  if (!isValidEmail(email)) {
    throw new Error(`email is not a valid address: ${email}`);
  }

  const trimmedEmail = email.trim();
  const normalizedEmail = normalizeSeedEmail(trimmedEmail);
  const db = getSeedDb();

  // Reset only this fixture's rows: the profile, the membership, the
  // organization and the user, by their stable ids.
  await db.delete(agent_environment_profiles).where(eq(agent_environment_profiles.id, PROFILE_ID));
  await db
    .delete(organization_memberships)
    .where(eq(organization_memberships.organization_id, ORGANIZATION_ID));
  await db.delete(organizations).where(eq(organizations.id, ORGANIZATION_ID));
  await db.delete(kilocode_users).where(eq(kilocode_users.id, USER_ID));

  await db.insert(kilocode_users).values({
    id: USER_ID,
    google_user_email: trimmedEmail,
    google_user_name: 'Org profile default',
    google_user_image_url: 'https://example.com/org-profile-default.png',
    stripe_customer_id: STRIPE_CUSTOMER_ID,
    normalized_email: normalizedEmail,
    has_validation_stytch: true,
    customer_source: 'dev-seed',
  });

  await db.insert(organizations).values({
    id: ORGANIZATION_ID,
    name: ORGANIZATION_NAME,
    plan: 'teams',
    seat_count: 1,
    require_seats: true,
    created_by_kilo_user_id: USER_ID,
  });

  await db.insert(organization_memberships).values({
    organization_id: ORGANIZATION_ID,
    kilo_user_id: USER_ID,
    role: 'owner',
  });

  // The organization's shared default. The user has no personal profile, so
  // `agentProfiles.listCombined.effectiveDefaultId` resolves to this row.
  const [profile] = await db
    .insert(agent_environment_profiles)
    .values({
      id: PROFILE_ID,
      owned_by_organization_id: ORGANIZATION_ID,
      created_by_user_id: USER_ID,
      name: PROFILE_NAME,
      description: 'The shared profile the organization runs on by default.',
      is_default: true,
    })
    .returning({ id: agent_environment_profiles.id });

  if (profile === undefined) {
    throw new Error('profile insert returned no row');
  }

  const deepLink = `kiloapp:///dev/profile-picker-fixture?org=${ORGANIZATION_ID}`;
  console.log('This fixture represents: an organization whose shared profile is its default.');
  console.log(`Deep link: ${deepLink}`);

  return {
    userId: USER_ID,
    email: trimmedEmail,
    organizationId: ORGANIZATION_ID,
    profileId: profile.id,
    deepLink,
  };
}
