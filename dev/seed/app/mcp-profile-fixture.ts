import {
  agent_environment_profile_mcp_servers,
  agent_environment_profiles,
  kilocode_users,
} from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';

import { getSeedDb } from '../lib/db';
import { normalizeSeedEmail } from '../lib/email';
import { isValidEmail } from '../lib/users';
import type { SeedResult } from '../index';

export const usage = '<email>';

const PROFILE_NAME = 'Design gate MCP';
const USER_ID = 'user_design_gate_mcp';
/** Stable, so the deep link a previous run printed keeps opening the screen. */
const PROFILE_ID = 'c1f4b0f8-3f4e-4a0d-8a63-6a3e2b5f9d31';
const STRIPE_CUSTOMER_ID = 'cus_local_design_gate_mcp';

/**
 * The MCP servers the profile carries. The first is the row the finding reports:
 * a short name with headers, so the type label and key count fill the line beside
 * it and the name is the element that gets cut. The second has a name wider than
 * the card, so the row still covers the intended ellipsis. The third is a long
 * local server, and the fourth is a short remote one without secrets, so the
 * screen covers both types and the row that shows no count.
 */
const SERVERS = [
  {
    name: 'docs-search',
    type: 'remote',
    enabled: true,
    timeout: null,
    config: {
      url: 'https://mcp.example.com/docs/search/v1',
      headers: { Authorization: 'dev-seed-placeholder', 'X-Team': 'dev-seed-placeholder' },
    },
  },
  {
    name: 'docs-search-engineering-handbook',
    type: 'remote',
    enabled: true,
    timeout: null,
    config: {
      url: 'https://mcp.example.com/docs/search/v1/engineering-handbook',
      headers: { Authorization: 'dev-seed-placeholder', 'X-Team': 'dev-seed-placeholder' },
    },
  },
  {
    name: 'release-notes-toolkit-local-runner',
    type: 'local',
    enabled: true,
    timeout: null,
    config: {
      command: ['npx', '@example/release-notes-mcp', '--workspace', 'engineering'],
      environment: { RELEASE_TRAIN: 'dev-seed-placeholder' },
    },
  },
  {
    name: 'sentry',
    type: 'remote',
    enabled: false,
    timeout: null,
    config: { url: 'https://mcp.example.com/sentry' },
  },
] as const;

function printUsage(): void {
  console.log(`Usage: pnpm dev:seed app:mcp-profile-fixture ${usage}`);
  console.log('');
  console.log('Creates a fake user and one personal agent environment profile whose MCP');
  console.log('servers cover the profile MCP screen: a short remote name with two headers, a');
  console.log('remote name wider than the row, a long local name with one environment entry,');
  console.log('and a short remote server without secrets. Re-running replaces the profile, its');
  console.log('servers, and the user row.');
  console.log('');
  console.log('The deep link it prints opens the profile MCP screen in a dev build:');
  console.log('  kiloapp:///(app)/profile-management/<profileId>/mcp');
  console.log('');
  console.log('Example:');
  console.log('  pnpm dev:seed app:mcp-profile-fixture design-gate@example.com');
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
      description: 'MCP servers the design gate opens on the profile MCP screen.',
      is_default: true,
    })
    .returning({ id: agent_environment_profiles.id });

  if (profile === undefined) {
    throw new Error('profile insert returned no row');
  }

  await db.insert(agent_environment_profile_mcp_servers).values(
    SERVERS.map(server => ({
      profile_id: profile.id,
      name: server.name,
      type: server.type,
      enabled: server.enabled,
      timeout: server.timeout,
      config: server.config,
    }))
  );

  console.log('This fixture represents: the personal profile an owner manages MCP servers on.');
  console.log(`Deep link: kiloapp:///(app)/profile-management/${profile.id}/mcp`);

  return {
    userId: USER_ID,
    email: trimmedEmail,
    profileId: profile.id,
    serverCount: SERVERS.length,
    longestNameLength: Math.max(...SERVERS.map(server => server.name.length)),
    deepLink: `kiloapp:///(app)/profile-management/${profile.id}/mcp`,
  };
}
