import {
  agent_environment_profile_agents,
  agent_environment_profile_instructions,
  agent_environment_profiles,
  kilocode_users,
  organization_memberships,
  organizations,
} from '@kilocode/db/schema';
import { and, eq, inArray, ne } from 'drizzle-orm';

import type { SeedResult } from '../index';
import { assertLocalSeedDatabase, getSeedDb } from '../lib/db';
import { normalizeSeedEmail } from '../lib/email';
import { findSeedUserId } from '../lib/users';

export const usage = '<fake-email>';

const USER_NAME = 'Profile permission lab';
const OWNER_ORGANIZATION_NAME = 'Permission lab owned';
const MEMBER_ORGANIZATION_NAME = 'Permission lab member';
const OWNER_AGENTS_PROFILE_NAME = 'Owner agents';
const MEMBER_AGENTS_PROFILE_NAME = 'Member agents';
const MEMBER_EMPTY_PROFILE_NAME = 'Member empty';
const MEMBER_INSTRUCTIONS_PROFILE_NAME = 'Member instructions';
/**
 * Stable, so the deep links a previous run printed keep opening the same
 * screens against the rows this run replaces.
 */
const OWNER_ORGANIZATION_ID = '1b7e4c20-6a3d-4f81-9c05-d2e3f4a5b601';
const MEMBER_ORGANIZATION_ID = '1b7e4c20-6a3d-4f81-9c05-d2e3f4a5b602';
const OWNER_AGENTS_PROFILE_ID = '1b7e4c20-6a3d-4f81-9c05-d2e3f4a5b603';
const MEMBER_AGENTS_PROFILE_ID = '1b7e4c20-6a3d-4f81-9c05-d2e3f4a5b604';
const MEMBER_EMPTY_PROFILE_ID = '1b7e4c20-6a3d-4f81-9c05-d2e3f4a5b605';
const MEMBER_INSTRUCTIONS_PROFILE_ID = '1b7e4c20-6a3d-4f81-9c05-d2e3f4a5b606';

/**
 * The three label variants the profile Agents list renders: a short name with a
 * model, the subagent label on its own, and a long name with a distinct slug,
 * a model and a description, so one row needs an ellipsis.
 */
const AGENT_VARIANTS = {
  short: {
    slug: 'reviewer',
    name: 'Reviewer',
    config: {
      mode: 'primary',
      description: 'Reviews a change before it lands.',
      model: 'anthropic/claude-sonnet-4',
    },
  },
  subagent: {
    slug: 'code-reviewer',
    name: 'Code Reviewer',
    config: { mode: 'subagent', description: 'Reads a diff for defects.' },
  },
  long: {
    slug: 'dependency-nightly-notes',
    name: 'Nightly Dependency Upgrade Reviewer With Notes',
    config: {
      mode: 'all',
      description: 'Upgrades the lockfile every night and files what changed.',
      model: 'openai/gpt-5-mini',
    },
  },
} as const;

/** The owner manages every variant; the member reads the short and the truncating one. */
const OWNER_AGENTS = [AGENT_VARIANTS.short, AGENT_VARIANTS.subagent, AGENT_VARIANTS.long];
const MEMBER_AGENTS = [AGENT_VARIANTS.short, AGENT_VARIANTS.long];

function printUsage(): void {
  console.log(`Usage: pnpm dev:seed app:mobile-profile-permission ${usage}`);
  console.log('');
  console.log('Seeds a local-only fake account that owns one organization and is a plain');
  console.log('member of another. The owned organization has one profile with three agents');
  console.log('covering the Agents list label variants; the member organization has one');
  console.log('profile with two agents, one profile with no agents, and one profile with two');
  console.log('rules files, one of them a full-length file name. The member cannot manage any');
  console.log('of them, so the mobile profile screens render them read-only.');
  console.log('Re-running replaces the profiles and their rows, so reruns are idempotent.');
  console.log('Requires a localhost database and SKIP_STRIPE_API=true.');
  console.log('');
  console.log('The deep links it prints open the screens in a signed-in mobile dev client:');
  console.log(
    '  kiloapp:///(app)/(tabs)/(3_profile)/profiles/<profileId>/agents?organizationId=<orgId>'
  );
  console.log(
    '  kiloapp:///(app)/(tabs)/(3_profile)/profiles/<profileId>/instructions?organizationId=<orgId>'
  );
  console.log('  kiloapp:///(app)/(tabs)/(3_profile)/profiles/<profileId>?organizationId=<orgId>');
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
  assertLocalSeedDatabase('app:mobile-profile-permission');
  if (process.env.SKIP_STRIPE_API !== 'true') {
    throw new Error(
      'This fixture requires an isolated loopback database and SKIP_STRIPE_API=true.'
    );
  }

  const db = getSeedDb();
  const normalizedEmail = normalizeSeedEmail(email);
  // A fake account that already signed in keeps its own row and its own
  // sign-in address: the fixture joins it. A row this fixture left under an
  // earlier email is its own fixture, so it takes the requested address.
  const adoptedUserId = await findSeedUserId(normalizedEmail);
  const userId = adoptedUserId ?? `dev-seed:mobile-profile-permission:${normalizedEmail}`;

  // Direct insert, no Stripe customer: the profile screens never call Stripe,
  // and dev/seed/lib/stripe.ts refuses a non-test key. The onboarding flags
  // below match dev/seed/app/create-user.ts so the seeded account reaches
  // product surfaces instead of the survey and verification gates. The address
  // is written only for the fixture's own row.
  await db
    .insert(kilocode_users)
    .values({
      id: userId,
      google_user_email: email,
      normalized_email: normalizedEmail,
      google_user_name: USER_NAME,
      google_user_image_url: '',
      stripe_customer_id: 'cus_local_profile_permission',
      has_validation_stytch: true,
      customer_source: 'dev-seed',
    })
    .onConflictDoUpdate({
      target: kilocode_users.id,
      set:
        adoptedUserId === null
          ? {
              google_user_email: email,
              normalized_email: normalizedEmail,
              has_validation_stytch: true,
              customer_source: 'dev-seed',
            }
          : { has_validation_stytch: true, customer_source: 'dev-seed' },
    });

  for (const organization of [
    {
      id: OWNER_ORGANIZATION_ID,
      name: OWNER_ORGANIZATION_NAME,
      createdByKiloUserId: userId,
    },
    {
      id: MEMBER_ORGANIZATION_ID,
      name: MEMBER_ORGANIZATION_NAME,
      // Someone else created this organization; this user only belongs to it.
      createdByKiloUserId: null,
    },
  ]) {
    await db
      .insert(organizations)
      .values({
        id: organization.id,
        name: organization.name,
        created_by_kilo_user_id: organization.createdByKiloUserId,
        require_seats: false,
      })
      .onConflictDoUpdate({
        target: organizations.id,
        set: { created_by_kilo_user_id: organization.createdByKiloUserId },
      });
  }

  // The roles below are the whole fixture, so both organizations belong to one
  // account at a time: a run for another email takes them over instead of adding
  // that email beside the previous owner.
  await db
    .delete(organization_memberships)
    .where(
      and(
        inArray(organization_memberships.organization_id, [
          OWNER_ORGANIZATION_ID,
          MEMBER_ORGANIZATION_ID,
        ]),
        ne(organization_memberships.kilo_user_id, userId)
      )
    );

  // The membership roles are the whole fixture: the owner may manage profiles,
  // the plain member may only read them.
  for (const membership of [
    { organizationId: OWNER_ORGANIZATION_ID, role: 'owner' },
    { organizationId: MEMBER_ORGANIZATION_ID, role: 'member' },
  ] as const) {
    await db
      .insert(organization_memberships)
      .values({
        organization_id: membership.organizationId,
        kilo_user_id: userId,
        role: membership.role,
      })
      .onConflictDoUpdate({
        target: [organization_memberships.organization_id, organization_memberships.kilo_user_id],
        set: { role: membership.role },
      });
  }

  // Replace each profile wholesale; its agents and rules files cascade with the
  // profile row, so a rerun cannot leave a row from an earlier run behind.
  for (const profileId of [
    OWNER_AGENTS_PROFILE_ID,
    MEMBER_AGENTS_PROFILE_ID,
    MEMBER_EMPTY_PROFILE_ID,
    MEMBER_INSTRUCTIONS_PROFILE_ID,
  ]) {
    await db.delete(agent_environment_profiles).where(eq(agent_environment_profiles.id, profileId));
  }

  await db.insert(agent_environment_profiles).values([
    {
      id: OWNER_AGENTS_PROFILE_ID,
      owned_by_organization_id: OWNER_ORGANIZATION_ID,
      created_by_user_id: userId,
      name: OWNER_AGENTS_PROFILE_NAME,
      description: 'Agents the organization owner manages on the profile Agents screen.',
    },
    {
      id: MEMBER_AGENTS_PROFILE_ID,
      owned_by_organization_id: MEMBER_ORGANIZATION_ID,
      created_by_user_id: userId,
      name: MEMBER_AGENTS_PROFILE_NAME,
      description: 'Agents the plain member reads on the profile Agents screen.',
    },
    {
      id: MEMBER_EMPTY_PROFILE_ID,
      owned_by_organization_id: MEMBER_ORGANIZATION_ID,
      created_by_user_id: userId,
      name: MEMBER_EMPTY_PROFILE_NAME,
      description: 'A profile with no agents, so the member sees an empty list it cannot change.',
    },
    {
      id: MEMBER_INSTRUCTIONS_PROFILE_ID,
      owned_by_organization_id: MEMBER_ORGANIZATION_ID,
      // Another organization admin created this one, so the member is not its
      // author either.
      created_by_user_id: null,
      name: MEMBER_INSTRUCTIONS_PROFILE_NAME,
      description: 'Rules files the plain member reads on the profile Instructions screen.',
    },
  ]);

  await db.insert(agent_environment_profile_agents).values(
    OWNER_AGENTS.map(agent => ({
      profile_id: OWNER_AGENTS_PROFILE_ID,
      slug: agent.slug,
      name: agent.name,
      config: agent.config,
    }))
  );
  await db.insert(agent_environment_profile_agents).values(
    MEMBER_AGENTS.map(agent => ({
      profile_id: MEMBER_AGENTS_PROFILE_ID,
      slug: agent.slug,
      name: agent.name,
      config: agent.config,
    }))
  );

  await db.insert(agent_environment_profile_instructions).values([
    {
      profile_id: MEMBER_INSTRUCTIONS_PROFILE_ID,
      name: 'team-release-checklist',
      content: [
        '# Team release checklist',
        '',
        '- Run the checks the change names before the release branch.',
        '- List the commits the release carries.',
        '',
      ].join('\n'),
      enabled: true,
    },
    {
      // Exactly the server's `MAX_IMPORT_INSTRUCTION_NAME_LENGTH` and the mobile
      // form's `INSTRUCTION_NAME_MAX_LENGTH`, so a read-only row wraps in full.
      profile_id: MEMBER_INSTRUCTIONS_PROFILE_ID,
      name: 'release-checklist-for-the-hindi-and-urdu-partner-team-handoff-before-every-partner-session-check-now',
      content: [
        '# Partner session release checklist',
        '',
        '- Confirm the Hindi and Urdu partner handoff notes are current.',
        '- Run the partner session check before every session.',
        '',
      ].join('\n'),
      enabled: true,
    },
  ] satisfies (typeof agent_environment_profile_instructions.$inferInsert)[]);

  const ownerAgentsDeepLink = `kiloapp:///(app)/(tabs)/(3_profile)/profiles/${OWNER_AGENTS_PROFILE_ID}/agents?organizationId=${OWNER_ORGANIZATION_ID}`;
  const memberAgentsDeepLink = `kiloapp:///(app)/(tabs)/(3_profile)/profiles/${MEMBER_AGENTS_PROFILE_ID}/agents?organizationId=${MEMBER_ORGANIZATION_ID}`;
  const memberEmptyAgentsDeepLink = `kiloapp:///(app)/(tabs)/(3_profile)/profiles/${MEMBER_EMPTY_PROFILE_ID}/agents?organizationId=${MEMBER_ORGANIZATION_ID}`;
  const memberEmptyOverviewDeepLink = `kiloapp:///(app)/(tabs)/(3_profile)/profiles/${MEMBER_EMPTY_PROFILE_ID}?organizationId=${MEMBER_ORGANIZATION_ID}`;
  const memberInstructionsDeepLink = `kiloapp:///(app)/(tabs)/(3_profile)/profiles/${MEMBER_INSTRUCTIONS_PROFILE_ID}/instructions?organizationId=${MEMBER_ORGANIZATION_ID}`;

  console.log(
    'This fixture represents: an owner who manages a profile with three agents, and a plain'
  );
  console.log(
    'member who reads three profiles it cannot manage: one with two agents, one with none,'
  );
  console.log('and one with two rules files, one of them a full-length file name.');
  console.log(`Deep link: ${ownerAgentsDeepLink}`);
  console.log(`Deep link: ${memberAgentsDeepLink}`);
  console.log(`Deep link: ${memberEmptyAgentsDeepLink}`);
  console.log(`Deep link: ${memberEmptyOverviewDeepLink}`);
  console.log(`Deep link: ${memberInstructionsDeepLink}`);

  return {
    userId,
    email,
    ownerOrganizationId: OWNER_ORGANIZATION_ID,
    memberOrganizationId: MEMBER_ORGANIZATION_ID,
    ownerAgentsProfileId: OWNER_AGENTS_PROFILE_ID,
    memberAgentsProfileId: MEMBER_AGENTS_PROFILE_ID,
    memberEmptyProfileId: MEMBER_EMPTY_PROFILE_ID,
    memberInstructionsProfileId: MEMBER_INSTRUCTIONS_PROFILE_ID,
    ownerAgentsDeepLink,
    memberAgentsDeepLink,
    memberEmptyAgentsDeepLink,
    memberEmptyOverviewDeepLink,
    memberInstructionsDeepLink,
  };
}
