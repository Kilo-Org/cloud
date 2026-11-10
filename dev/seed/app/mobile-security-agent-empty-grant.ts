/**
 * Seed fixture for the Security Agent's empty GitHub App grant.
 *
 * The state this produces — an active GitHub integration whose repository
 * snapshot is a settled empty list — is the "connected, but nothing to scan"
 * case: the repository pickers answer with their no-repositories empty state,
 * and a manual sync is refused for having nothing in scope. Reaching it by hand
 * needs a real GitHub App installation with no repository access, so the two
 * surfaces that explain it are otherwise untestable end to end.
 */

import { randomUUID } from 'node:crypto';

import {
  agent_configs,
  kilocode_users,
  organization_memberships,
  organizations,
  platform_integrations,
} from '@kilocode/db/schema';
import { eq, sql } from 'drizzle-orm';

import { assertLocalSeedDatabase, getSeedDb } from '../lib/db';
import { normalizeSeedEmail } from '../lib/email';
import type { SeedResult } from '../index';

export const usage = '<owner-email> <member-email>';

const SETTINGS_MARKER = 'security-agent-empty-grant';
const ORGANIZATION_NAME = 'Northwind Traders';

function printUsage(): void {
  console.log(`Usage: pnpm dev:seed app:mobile-security-agent-empty-grant ${usage}`);
  console.log('');
  console.log('Creates an organization whose GitHub App grant holds no repositories, with an');
  console.log('owner and a member: the grant is an active integration whose repository');
  console.log('snapshot is a settled empty list, and the Security Agent is enabled over all');
  console.log('repositories. The member can read the agent and start a sync but cannot change');
  console.log('repository policy.');
  console.log('');
  console.log('Usage:');
  console.log('  pnpm dev:seed app:create-user "Agent Owner" owner@example.com');
  console.log('  pnpm dev:seed app:create-user "Agent Member" member@example.com');
  console.log(
    '  pnpm dev:seed app:mobile-security-agent-empty-grant owner@example.com member@example.com'
  );
  console.log('');
  console.log('Open the organization voices with:');
  console.log('  adb shell "am start -a android.intent.action.VIEW \\');
  console.log(
    "    -d 'kiloapp:///(app)/security-agent/<organizationId>/settings' com.kilocode.kiloapp\""
  );
}

async function findUser(email: string): Promise<string> {
  const db = getSeedDb();
  const rows = await db
    .select({ id: kilocode_users.id })
    .from(kilocode_users)
    .where(eq(kilocode_users.normalized_email, normalizeSeedEmail(email)))
    .limit(1);
  const user = rows[0];
  if (!user) {
    throw new Error(`no seeded user for ${email}: run app:create-user first`);
  }
  return user.id;
}

async function reset(): Promise<void> {
  const db = getSeedDb();
  const previous = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(sql`${organizations.settings} ->> ${SETTINGS_MARKER} = 'seed'`);
  const orgIds = previous.map(row => row.id);
  if (orgIds.length === 0) {
    return;
  }
  for (const orgId of orgIds) {
    // Delete the children first: only the configs and memberships cascade.
    await db.delete(agent_configs).where(eq(agent_configs.owned_by_organization_id, orgId));
    await db
      .delete(platform_integrations)
      .where(eq(platform_integrations.owned_by_organization_id, orgId));
    await db
      .delete(organization_memberships)
      .where(eq(organization_memberships.organization_id, orgId));
    await db.delete(organizations).where(eq(organizations.id, orgId));
  }
}

export async function run(...args: string[]): Promise<SeedResult | void> {
  if (args.includes('--help') || args.includes('-h')) {
    printUsage();
    return;
  }

  const [ownerEmail, memberEmail, ...rest] = args;
  if (!ownerEmail || !memberEmail) {
    printUsage();
    throw new Error('expected an owner email and a member email');
  }
  if (rest.length > 0) {
    throw new Error(`unexpected arguments: ${rest.join(' ')}`);
  }
  assertLocalSeedDatabase('app:mobile-security-agent-empty-grant');

  const ownerUserId = await findUser(ownerEmail);
  const memberUserId = await findUser(memberEmail);
  if (ownerUserId === memberUserId) {
    throw new Error('the owner and the member must be different users');
  }

  await reset();

  const db = getSeedDb();
  const organizationId = randomUUID();
  await db.insert(organizations).values({
    id: organizationId,
    name: ORGANIZATION_NAME,
    plan: 'teams',
    seat_count: 2,
    require_seats: false,
    microdollars_used: 0,
    total_microdollars_acquired: 0,
    auto_top_up_enabled: false,
    settings: { [SETTINGS_MARKER]: 'seed' },
  });

  await db.insert(organization_memberships).values([
    { organization_id: organizationId, kilo_user_id: ownerUserId, role: 'owner' },
    { organization_id: organizationId, kilo_user_id: memberUserId, role: 'member' },
  ]);

  // An active installation with the security-review permission and a
  // synchronized, empty repository snapshot: `getRepositories` answers this
  // list as-is, and a sync finds nothing in scope. It carries the workflow role
  // and a numeric installation id, so the organization's connection lookups —
  // the entry gate and the operations it opens — resolve this row.
  await db.insert(platform_integrations).values({
    id: randomUUID(),
    owned_by_organization_id: organizationId,
    created_by_user_id: ownerUserId,
    platform: 'github',
    integration_type: 'app',
    integration_status: 'active',
    platform_installation_id: `9${String(Math.floor(10_000_000 + Math.random() * 89_999_999))}`,
    platform_account_id: 'seed-empty-grant',
    platform_account_login: 'northwind-traders',
    permissions: { vulnerability_alerts: 'read' },
    repository_access: 'all',
    repositories: [],
    repositories_synced_at: new Date().toISOString(),
    github_app_type: 'standard',
    github_connection_role: 'workflow',
  });

  await db.insert(agent_configs).values({
    owned_by_organization_id: organizationId,
    agent_type: 'security_scan',
    platform: 'github',
    config: { repository_selection_mode: 'all', selected_repository_ids: [] },
    is_enabled: true,
    created_by: ownerUserId,
  });

  const scope = organizationId;
  console.log('This fixture represents:');
  console.log('  An organization whose GitHub App grant holds no repositories, with an owner');
  console.log('  and a member, and Security Agent enabled over every repository.');
  console.log('Suggested next step:');
  console.log(`  Sign in as the member and open /security-agent/${scope}/settings.`);

  return {
    organizationId,
    ownerUserId,
    memberUserId,
    settingsLink: `kiloapp:///(app)/security-agent/${scope}/settings`,
    dashboardLink: `kiloapp:///(app)/security-agent/${scope}`,
  };
}
