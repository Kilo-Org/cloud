import { randomUUID } from 'node:crypto';

import {
  kilocode_users,
  organization_memberships,
  organizations,
  platform_integrations,
} from '@kilocode/db/schema';
import { eq, inArray } from 'drizzle-orm';

import { getSeedDb } from '../lib/db';
import { normalizeSeedEmail } from '../lib/email';
import type { SeedResult } from '../index';

export const usage = '<owner-email> <member-email>';

const PENDING_ORGANIZATION_NAME = 'Security Agent Pending GitHub';
const SUSPENDED_ORGANIZATION_NAME = 'Security Agent Suspended GitHub';
const ORGANIZATION_NAMES = [PENDING_ORGANIZATION_NAME, SUSPENDED_ORGANIZATION_NAME];
const AWAITING_APPROVAL_STATUS = 'awaiting_installation';

function printUsage(): void {
  console.log(`Usage: pnpm dev:seed app:security-agent-github-states ${usage}`);
  console.log('');
  console.log(
    'Seeds two organizations an organization owner (and a member who cannot manage'
  );
  console.log(
    'them) can open the Security Agent entry on. Both hold a GitHub App association'
  );
  console.log('the organization cannot act on yet:');
  console.log(
    '  - the first has an install request awaiting a GitHub organization admin,'
  );
  console.log('    with no installation id;');
  console.log('  - the second has a suspended installation GitHub will not serve.');
  console.log('');
  console.log('Both associations leave the single-installation slot free, so the entry');
  console.log('starts a GitHub App installation from either one.');
  console.log('');
  console.log('Usage:');
  console.log('  pnpm dev:seed app:create-user "GitHub Fixture Owner" owner@example.com');
  console.log('  pnpm dev:seed app:create-user "GitHub Fixture Member" member@example.com');
  console.log('  pnpm dev:seed app:security-agent-github-states owner@example.com member@example.com');
  console.log('');
  console.log('Open either entry with:');
  console.log(
    "  adb shell \"am start -a android.intent.action.VIEW -d 'kiloapp:///(app)/security-agent/<pendingOrganizationId>' com.kilocode.kiloapp\""
  );
}

async function lookupUserId(email: string): Promise<string> {
  const db = getSeedDb();
  const [user] = await db
    .select({ id: kilocode_users.id })
    .from(kilocode_users)
    .where(eq(kilocode_users.normalized_email, normalizeSeedEmail(email.trim())))
    .limit(1);
  if (!user) {
    throw new Error(`no seeded user for ${email}; run app:create-user first`);
  }
  return user.id;
}

export async function run(...args: string[]): Promise<SeedResult | void> {
  if (args.includes('--help') || args.includes('-h')) {
    printUsage();
    return;
  }

  const [ownerEmail, memberEmail, ...rest] = args;
  if (!ownerEmail || !memberEmail) {
    printUsage();
    throw new Error(`expected ${usage}`);
  }
  if (rest.length > 0) {
    throw new Error(`unexpected arguments: ${rest.join(' ')}`);
  }

  const db = getSeedDb();
  const ownerUserId = await lookupUserId(ownerEmail);
  const memberUserId = await lookupUserId(memberEmail);

  // Idempotent rerun: the two organizations are the only rows this topic owns,
  // and their integrations and memberships cascade with them.
  await db.delete(organizations).where(inArray(organizations.name, ORGANIZATION_NAMES));

  const pendingOrganizationId = randomUUID();
  const suspendedOrganizationId = randomUUID();

  await db.insert(organizations).values([
    {
      id: pendingOrganizationId,
      name: PENDING_ORGANIZATION_NAME,
      created_by_kilo_user_id: ownerUserId,
    },
    {
      id: suspendedOrganizationId,
      name: SUSPENDED_ORGANIZATION_NAME,
      created_by_kilo_user_id: ownerUserId,
    },
  ]);

  await db.insert(organization_memberships).values([
    { organization_id: pendingOrganizationId, kilo_user_id: ownerUserId, role: 'owner' },
    { organization_id: pendingOrganizationId, kilo_user_id: memberUserId, role: 'member' },
    { organization_id: suspendedOrganizationId, kilo_user_id: ownerUserId, role: 'owner' },
    { organization_id: suspendedOrganizationId, kilo_user_id: memberUserId, role: 'member' },
  ]);

  const requestedAt = new Date().toISOString();
  await db.insert(platform_integrations).values([
    {
      owned_by_organization_id: pendingOrganizationId,
      created_by_user_id: ownerUserId,
      platform: 'github',
      integration_type: 'app',
      platform_installation_id: null,
      platform_account_id: '9200001',
      platform_account_login: 'fixture-pending-org',
      integration_status: 'pending',
      github_app_type: 'standard',
      metadata: {
        pending_approval: {
          requester: {
            kilo_user_id: ownerUserId,
            kilo_user_email: ownerEmail,
            kilo_user_name: 'GitHub Fixture Owner',
            requested_at: requestedAt,
          },
          github_requester: { id: '9200001', login: 'fixture-pending-org' },
          status: AWAITING_APPROVAL_STATUS,
        },
      },
      kilo_requester_user_id: ownerUserId,
      installed_at: requestedAt,
      created_at: requestedAt,
      updated_at: requestedAt,
    },
    {
      owned_by_organization_id: suspendedOrganizationId,
      created_by_user_id: ownerUserId,
      platform: 'github',
      integration_type: 'app',
      platform_installation_id: '9200002',
      platform_account_id: '9200002',
      platform_account_login: 'fixture-suspended-org',
      integration_status: 'suspended',
      suspended_at: requestedAt,
      suspended_by: 'github_suspend',
      github_app_type: 'standard',
      github_connection_role: 'workflow',
      metadata: {},
      installed_at: requestedAt,
      created_at: requestedAt,
      updated_at: requestedAt,
    },
  ]);

  console.log('This fixture represents:');
  console.log('  Two organizations whose GitHub App association is not active yet: an');
  console.log('  install request awaiting a GitHub organization admin, and a suspended');
  console.log('  installation. The owner can start an installation from either one; the');
  console.log('  member sees the read-only notice instead of the install action.');
  console.log('Suggested next step:');
  console.log('  Open the Security Agent entry links in the Result block of this run.');

  return {
    ownerUserId,
    memberUserId,
    pendingOrganizationId,
    suspendedOrganizationId,
    pendingEntryLink: `kiloapp:///(app)/security-agent/${pendingOrganizationId}`,
    suspendedEntryLink: `kiloapp:///(app)/security-agent/${suspendedOrganizationId}`,
  };
}
