import {
  agent_environment_profile_agents,
  agent_environment_profiles,
  kilocode_users,
} from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';

import { getSeedDb } from '../lib/db';
import { normalizeSeedEmail } from '../lib/email';
import { isValidEmail } from '../lib/users';
import type { SeedResult } from '../index';

export const usage = '<email>';

const PROFILE_NAME = 'Design gate agents';
const USER_ID = 'user_design_gate_agents';
/** Stable, so the deep link a previous run printed keeps opening the screen. */
const PROFILE_ID = 'a9ad137f-bad3-4d1a-9565-0cb862c7f81d';
const STRIPE_CUSTOMER_ID = 'cus_local_design_gate_agents';

/**
 * The agents the profile carries. The first two print their name twice unless
 * the list hides a slug that only repeats the name; the third has a long name
 * and a distinct slug, so its row shows both a name and a slug line.
 */
const AGENTS = [
  {
    slug: 'reviewer',
    name: 'Reviewer',
    config: {
      mode: 'primary',
      description: 'Reviews a change before it lands.',
      model: 'anthropic/claude-sonnet-4',
    },
  },
  {
    slug: 'code-reviewer',
    name: 'Code Reviewer',
    config: { mode: 'subagent', description: 'Reads a diff for defects.' },
  },
  {
    slug: 'dependency-nightly-notes',
    name: 'Nightly Dependency Upgrade Reviewer With Notes',
    config: {
      mode: 'all',
      description: 'Upgrades the lockfile every night and files what changed.',
      model: 'openai/gpt-5-mini',
    },
  },
] as const;

function printUsage(): void {
  console.log(`Usage: pnpm dev:seed app:agent-profile-fixture ${usage}`);
  console.log('');
  console.log('Creates a fake user and one personal agent environment profile whose agents');
  console.log('cover the profile Agents list: two whose slug only repeats the name, and one');
  console.log('long row whose name and slug both need truncating. Re-running replaces the');
  console.log('profile, its agents, and the user row.');
  console.log('');
  console.log('The deep link it prints opens the profile Agents screen in a dev build:');
  console.log('  kiloapp:///profile-management/<profileId>/agents');
  console.log('');
  console.log('Example:');
  console.log('  pnpm dev:seed app:agent-profile-fixture design-gate@example.com');
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
      description: 'Agents the design gate opens on the profile Agents screen.',
      is_default: true,
    })
    .returning({ id: agent_environment_profiles.id });

  if (profile === undefined) {
    throw new Error('profile insert returned no row');
  }

  await db.insert(agent_environment_profile_agents).values(
    AGENTS.map(agent => ({
      profile_id: profile.id,
      slug: agent.slug,
      name: agent.name,
      config: agent.config,
    }))
  );

  console.log('This fixture represents: the personal profile an owner manages agents on.');
  console.log(`Deep link: kiloapp:///profile-management/${profile.id}/agents`);

  return {
    userId: USER_ID,
    email: trimmedEmail,
    profileId: profile.id,
    agentCount: AGENTS.length,
    deepLink: `kiloapp:///profile-management/${profile.id}/agents`,
  };
}
