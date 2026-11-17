import { randomUUID } from 'node:crypto';

import {
  agent_environment_profile_commands,
  agent_environment_profiles,
  kilocode_users,
  organization_memberships,
  organizations,
} from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';

import type { SeedResult } from '../index';
import { assertLocalSeedDatabase, getSeedDb } from '../lib/db';

export const usage = '<fake-email>';

const USER_NAME = 'Profile commands member';
const ORGANIZATION_NAME = 'Setup commands lab';
const PROFILE_NAME = 'Shared setup';
/** Stable, so the deep link a previous run printed keeps opening the screen. */
const ORGANIZATION_ID = '3f2f7d31-4e7a-4a3c-9a55-1d0b6c8e2f10';
const PROFILE_ID = '6c1d9b52-8a4e-4f7b-b2e3-9d5a0c7f1e64';
const COMMAND_COUNT = 20;
/** The length band the fixture exists for: too long for one line anywhere. */
const MIN_COMMAND_LENGTH = 400;
const MAX_COMMAND_LENGTH = 500;

/**
 * One setup command per list position, at the length a real multi-step setup
 * command reaches. Steps are chained until the command lands in the band, so
 * the fixture cannot drift out of it when the base text is edited.
 */
function longCommand(index: number): string {
  const position = index + 1;
  let command =
    `pnpm install --frozen-lockfile && pnpm --filter @kilocode/harness-sdk run build && ` +
    `pnpm --filter @kilocode/trpc run build && pnpm exec drizzle-kit generate`;
  let step = 1;
  while (command.length < MIN_COMMAND_LENGTH) {
    command += ` && echo "setup ${position}, step ${step} done"`;
    step += 1;
  }
  if (command.length > MAX_COMMAND_LENGTH) {
    throw new Error(`command ${position} is ${command.length} characters long`);
  }
  return command;
}

function printUsage(): void {
  console.log(`Usage: pnpm dev:seed app:mobile-profile-commands ${usage}`);
  console.log('');
  console.log('Seeds a local-only fake account that is a plain member of an organization, and an');
  console.log('organization-owned profile whose 20 setup commands are 400-500 characters long.');
  console.log(
    'The member cannot manage the profile, so the mobile Profile commands screen renders'
  );
  console.log('it read-only. Requires a localhost database and SKIP_STRIPE_API=true.');
  console.log('');
  console.log('The deep link it prints opens the screen in a signed-in mobile development client:');
  console.log('  kiloapp:///(app)/profile-management/<profileId>/commands?organizationId=<orgId>');
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
  assertLocalSeedDatabase('app:mobile-profile-commands');
  if (process.env.SKIP_STRIPE_API !== 'true') {
    throw new Error(
      'This fixture requires an isolated loopback database and SKIP_STRIPE_API=true.'
    );
  }

  const db = getSeedDb();
  const userId = `dev-seed:mobile-profile-commands:${email}`;
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
      google_user_name: USER_NAME,
      google_user_image_url: '',
      stripe_customer_id: `cus_local_profile_commands_${randomUUID()}`,
      has_validation_stytch: false,
      customer_source: 'dev-seed',
    })
    .onConflictDoNothing();
  await db
    .insert(organizations)
    .values({
      id: ORGANIZATION_ID,
      name: ORGANIZATION_NAME,
      require_seats: false,
    })
    .onConflictDoNothing();
  // A plain member: reads the organization's profiles, cannot manage them.
  await db
    .insert(organization_memberships)
    .values({
      organization_id: ORGANIZATION_ID,
      kilo_user_id: userId,
      role: 'member',
    })
    .onConflictDoUpdate({
      target: [organization_memberships.organization_id, organization_memberships.kilo_user_id],
      set: { role: 'member' },
    });

  // The profile's commands and vars cascade with the profile row.
  await db.delete(agent_environment_profiles).where(eq(agent_environment_profiles.id, PROFILE_ID));
  await db.insert(agent_environment_profiles).values({
    id: PROFILE_ID,
    owned_by_organization_id: ORGANIZATION_ID,
    created_by_user_id: userId,
    name: PROFILE_NAME,
    description: 'The shared setup every session in the organization starts with.',
  });
  await db.insert(agent_environment_profile_commands).values(
    Array.from({ length: COMMAND_COUNT }, (_, index) => ({
      profile_id: PROFILE_ID,
      sequence: index,
      command: longCommand(index),
    }))
  );

  const deepLink = `kiloapp:///(app)/profile-management/${PROFILE_ID}/commands?organizationId=${ORGANIZATION_ID}`;
  console.log('This fixture represents: an organization member reading the shared profile.');
  console.log(`Deep link: ${deepLink}`);

  return {
    userId,
    email,
    organizationId: ORGANIZATION_ID,
    profileId: PROFILE_ID,
    commandCount: COMMAND_COUNT,
    deepLink,
  };
}
