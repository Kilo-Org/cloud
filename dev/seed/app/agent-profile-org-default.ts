import {
  agent_environment_profiles,
  kilocode_users,
  organization_memberships,
  organizations,
} from '@kilocode/db/schema';
import { eq, inArray } from 'drizzle-orm';

import { assertLocalSeedDatabase, getSeedDb } from '../lib/db';
import { normalizeSeedEmail } from '../lib/email';
import { isValidEmail } from '../lib/users';
import type { SeedResult } from '../index';

export const usage = '<email>';

const USER_ID = 'user_e2e_org_profile_default';
/** Stable, so the deep link a previous run printed keeps opening the screen. */
const ORGANIZATION_ID = 'c4a2f1e6-7b19-4d0e-9a53-2f6d8b1c7e40';
const PROFILE_ID = 'b41d6f52-0c8e-4b7a-9d31-5e2a8c6f9031';
/** The user's own profiles, so the picker must name each row's owner. */
const PERSONAL_PROFILE_IDS = [
  '6f2b9a44-1d57-4c33-8e0a-3b7c5d19f208',
  'c17e4d80-5a92-4b6f-b1d3-9e2f8a6c4b71',
] as const;
const ORGANIZATION_NAME = 'Profile picker lab';
const PROFILE_NAME = 'Shared Agency Review Profile';
const PERSONAL_PROFILE_NAMES = ['My laptop setup', 'Review only'] as const;
const STRIPE_CUSTOMER_ID = 'cus_local_org_profile_default';

function printUsage(): void {
  console.log(`Usage: pnpm dev:seed app:agent-profile-org-default ${usage}`);
  console.log('');
  console.log('Creates a fake user who owns one organization whose shared profile is the');
  console.log('organization default, with no personal default, plus two personal profiles of');
  console.log('the user that are not defaults. In that organization scope the new-session');
  console.log('Environment chip and the profile picker both resolve to the shared profile, and');
  console.log('the picker lists both owners.');
  console.log('Re-running replaces the user, the organization, its membership and the profiles.');
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
  assertLocalSeedDatabase('app:agent-profile-org-default');
  const db = getSeedDb();

  // Reset only this fixture's rows: the profiles, the membership, the
  // organization and the user, by their stable ids.
  await db
    .delete(agent_environment_profiles)
    .where(inArray(agent_environment_profiles.id, [PROFILE_ID, ...PERSONAL_PROFILE_IDS]));
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

  // The user's own profiles, none of them default: the scope is then a mixed
  // list where each row's owner is the thing to tell apart.
  await db.insert(agent_environment_profiles).values(
    PERSONAL_PROFILE_IDS.map((id, index) => ({
      id,
      owned_by_user_id: USER_ID,
      created_by_user_id: USER_ID,
      name: PERSONAL_PROFILE_NAMES[index] ?? 'Personal profile',
      description: "One of the user's own profiles.",
      is_default: false,
    }))
  );

  const deepLink = `kiloapp:///dev/profile-picker-fixture?org=${ORGANIZATION_ID}`;
  console.log(
    'This fixture represents: an organization whose shared profile is its default, plus two personal profiles.'
  );
  console.log(`Deep link: ${deepLink}`);

  return {
    userId: USER_ID,
    email: trimmedEmail,
    organizationId: ORGANIZATION_ID,
    profileId: profile.id,
    deepLink,
  };
}
