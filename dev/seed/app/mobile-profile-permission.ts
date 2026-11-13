import {
  agent_environment_profile_agents,
  agent_environment_profiles,
  kilocode_users,
  organization_memberships,
  organizations,
} from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';

import type { SeedResult } from '../index';
import { assertLocalSeedDatabase, getSeedDb } from '../lib/db';
import { normalizeSeedEmail } from '../lib/email';

export const usage = '<fake-email>';

const USER_NAME = 'Profile permission lab';
const OWNER_ORGANIZATION_NAME = 'Permission lab owned';
const MEMBER_ORGANIZATION_NAME = 'Permission lab member';
const OWNER_AGENTS_PROFILE_NAME = 'Owner agents';
const MEMBER_AGENTS_PROFILE_NAME = 'Member agents';
const MEMBER_EMPTY_PROFILE_NAME = 'Member empty';
/**
 * Stable, so the deep links a previous run printed keep opening the same
 * screens against the rows this run replaces.
 */
const OWNER_ORGANIZATION_ID = '1b7e4c20-6a3d-4f81-9c05-d2e3f4a5b601';
const MEMBER_ORGANIZATION_ID = '1b7e4c20-6a3d-4f81-9c05-d2e3f4a5b602';
const OWNER_AGENTS_PROFILE_ID = '1b7e4c20-6a3d-4f81-9c05-d2e3f4a5b603';
const MEMBER_AGENTS_PROFILE_ID = '1b7e4c20-6a3d-4f81-9c05-d2e3f4a5b604';
const MEMBER_EMPTY_PROFILE_ID = '1b7e4c20-6a3d-4f81-9c05-d2e3f4a5b605';

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
  console.log('profile with two agents and one profile with no agents. The member cannot');
  console.log('manage either profile, so the mobile profile screens render them read-only.');
  console.log('Re-running replaces the profiles and their agents, so reruns are idempotent.');
  console.log('Requires a localhost database and SKIP_STRIPE_API=true.');
  console.log('');
  console.log('The deep links it prints open the screens in a signed-in mobile dev client:');
  console.log(
    '  kiloapp:///(app)/(tabs)/(3_profile)/profiles/<profileId>/agents?organizationId=<orgId>'
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
  const userId = `dev-seed:mobile-profile-permission:${normalizedEmail}`;
  const [existing] = await db
    .select({ id: kilocode_users.id })
    .from(kilocode_users)
    .where(eq(kilocode_users.normalized_email, normalizedEmail));
  if (existing && existing.id !== userId) {
    throw new Error('The requested email belongs to a different account; choose a new fake email.');
  }

  // Direct insert, no Stripe customer: the profile screens never call Stripe,
  // and dev/seed/lib/stripe.ts refuses a non-test key. The onboarding flags
  // below match dev/seed/app/create-user.ts so the seeded account reaches
  // product surfaces instead of the survey and verification gates.
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
      set: {
        google_user_email: email,
        normalized_email: normalizedEmail,
        has_validation_stytch: true,
        customer_source: 'dev-seed',
      },
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
      .onConflictDoNothing();
  }

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

  // Replace each profile wholesale; its agents cascade with the profile row, so
  // a rerun cannot leave an agent from an earlier run behind.
  for (const profileId of [
    OWNER_AGENTS_PROFILE_ID,
    MEMBER_AGENTS_PROFILE_ID,
    MEMBER_EMPTY_PROFILE_ID,
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

  const ownerAgentsDeepLink = `kiloapp:///(app)/(tabs)/(3_profile)/profiles/${OWNER_AGENTS_PROFILE_ID}/agents?organizationId=${OWNER_ORGANIZATION_ID}`;
  const memberAgentsDeepLink = `kiloapp:///(app)/(tabs)/(3_profile)/profiles/${MEMBER_AGENTS_PROFILE_ID}/agents?organizationId=${MEMBER_ORGANIZATION_ID}`;
  const memberEmptyAgentsDeepLink = `kiloapp:///(app)/(tabs)/(3_profile)/profiles/${MEMBER_EMPTY_PROFILE_ID}/agents?organizationId=${MEMBER_ORGANIZATION_ID}`;
  const memberEmptyOverviewDeepLink = `kiloapp:///(app)/(tabs)/(3_profile)/profiles/${MEMBER_EMPTY_PROFILE_ID}?organizationId=${MEMBER_ORGANIZATION_ID}`;

  console.log(
    'This fixture represents: an owner who manages a profile with three agents, and a plain'
  );
  console.log(
    'member who reads two profiles it cannot manage, one with two agents and one with none.'
  );
  console.log(`Deep link: ${ownerAgentsDeepLink}`);
  console.log(`Deep link: ${memberAgentsDeepLink}`);
  console.log(`Deep link: ${memberEmptyAgentsDeepLink}`);
  console.log(`Deep link: ${memberEmptyOverviewDeepLink}`);

  return {
    userId,
    email,
    ownerOrganizationId: OWNER_ORGANIZATION_ID,
    memberOrganizationId: MEMBER_ORGANIZATION_ID,
    ownerAgentsProfileId: OWNER_AGENTS_PROFILE_ID,
    memberAgentsProfileId: MEMBER_AGENTS_PROFILE_ID,
    memberEmptyProfileId: MEMBER_EMPTY_PROFILE_ID,
    ownerAgentsDeepLink,
    memberAgentsDeepLink,
    memberEmptyAgentsDeepLink,
    memberEmptyOverviewDeepLink,
  };
}
