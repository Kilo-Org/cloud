import {
  agent_environment_profile_vars,
  agent_environment_profiles,
  kilocode_users,
} from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';

import { assertLocalSeedDatabase, getSeedDb } from '../lib/db';
import { normalizeSeedEmail } from '../lib/email';
import { isValidEmail } from '../lib/users';
import type { SeedResult } from '../index';

export const usage = '<email>';

const PROFILE_NAME = 'Design gate variables';
const USER_ID = 'user_design_gate_variables';
/** Stable, so the deep link a previous run printed keeps opening the screen. */
const PROFILE_ID = '5d0f3a61-8c47-4b2e-9f14-7a6c2d8e0b53';
const STRIPE_CUSTOMER_ID = 'cus_local_design_gate_variables';

/**
 * The variables the profile carries. The first is the row a narrow layout
 * reports: a key longer than the value's share of the line beside a value that
 * is longer still, so the row has to decide which of the two keeps its text.
 * The second is a secret, which renders the fixed dot run instead of a value.
 * The third pairs a short key with a short value, so the screen covers a row
 * with width to spare next to the two that have none.
 */
const VARIABLES = [
  {
    key: 'DATABASE_URL_READ_REPLICA',
    value: 'postgresql://reporting-replica.internal.example.com/app?sslmode=require',
    isSecret: false,
  },
  {
    key: 'STRIPE_WEBHOOK_SIGNING_SECRET',
    value: '***',
    isSecret: true,
  },
  {
    key: 'DEBUG',
    value: '1',
    isSecret: false,
  },
] as const;

function printUsage(): void {
  console.log(`Usage: pnpm dev:seed app:mobile-profile-variables ${usage}`);
  console.log('');
  console.log('Creates a fake user and one personal agent environment profile whose variables');
  console.log('cover the profile Variables screen: a long key with a longer value, a long secret');
  console.log('key, and a short key with a short value. Re-running replaces the profile, its');
  console.log('variables, and the user row.');
  console.log('');
  console.log('The deep link it prints opens the profile Variables screen in a dev build:');
  console.log('  kiloapp:///(app)/(tabs)/(3_profile)/profiles/<profileId>/variables');
  console.log('');
  console.log('Example:');
  console.log('  pnpm dev:seed app:mobile-profile-variables design-gate@example.com');
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
  assertLocalSeedDatabase('app:mobile-profile-variables');
  const db = getSeedDb();

  // Direct insert, no Stripe customer: the profile screens never call Stripe,
  // and dev/seed/lib/stripe.ts refuses the example file's placeholder key.
  // The onboarding flags below match dev/seed/app/create-user.ts so the seeded
  // account reaches product surfaces instead of the survey and verification
  // gates.
  await db
    .insert(kilocode_users)
    .values({
      id: USER_ID,
      google_user_email: trimmedEmail,
      google_user_name: 'Design Gate',
      google_user_image_url: 'https://example.com/design-gate.png',
      stripe_customer_id: STRIPE_CUSTOMER_ID,
      normalized_email: normalizedEmail,
      has_validation_stytch: true,
      customer_source: 'dev-seed',
    })
    .onConflictDoUpdate({
      target: kilocode_users.id,
      set: {
        google_user_email: trimmedEmail,
        normalized_email: normalizedEmail,
        has_validation_stytch: true,
        customer_source: 'dev-seed',
      },
    });

  // The profile cascade removes its variables, so only the profile is deleted.
  await db
    .delete(agent_environment_profiles)
    .where(eq(agent_environment_profiles.owned_by_user_id, USER_ID));

  const [profile] = await db
    .insert(agent_environment_profiles)
    .values({
      id: PROFILE_ID,
      owned_by_user_id: USER_ID,
      created_by_user_id: USER_ID,
      name: PROFILE_NAME,
      description: 'Variables the design gate opens on the profile Variables screen.',
      is_default: true,
    })
    .returning({ id: agent_environment_profiles.id });

  if (profile === undefined) {
    throw new Error('profile insert returned no row');
  }

  await db.insert(agent_environment_profile_vars).values(
    VARIABLES.map(variable => ({
      profile_id: profile.id,
      key: variable.key,
      value: variable.value,
      is_secret: variable.isSecret,
    }))
  );

  const deepLink = `kiloapp:///(app)/(tabs)/(3_profile)/profiles/${profile.id}/variables`;
  console.log('This fixture represents: the personal profile an owner manages variables on.');
  console.log(`Deep link: ${deepLink}`);

  return {
    userId: USER_ID,
    email: trimmedEmail,
    profileId: profile.id,
    variableCount: VARIABLES.length,
    longestKeyLength: Math.max(...VARIABLES.map(variable => variable.key.length)),
    deepLink,
  };
}
