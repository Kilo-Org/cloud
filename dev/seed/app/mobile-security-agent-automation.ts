import { randomUUID } from 'node:crypto';

import {
  agent_configs,
  kilocode_users,
  organization_memberships,
  organizations,
} from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';

import type { SeedResult } from '../index';
import { assertLocalSeedDatabase, getSeedDb } from '../lib/db';

export const usage = '<fake-email>';

/**
 * Fixed so a rerun replaces the same organization, user and config.
 */
const ORGANIZATION_ID = 'b007c8bf-a11e-4c7a-9d0e-6d1a5c0ffee1';

function printUsage(): void {
  console.log(`Usage: pnpm dev:seed app:mobile-security-agent-automation ${usage}`);
  console.log('');
  console.log('Seeds an organization whose Security Agent is enabled and owned by the');
  console.log('signed-in account, with auto analysis on at minimum severity High. Auto');
  console.log('remediation and auto dismiss stay off, so the analysis section sits at the');
  console.log('top of the Automation settings screen. The owner can edit every control.');
  console.log('');
  console.log('Refuses non-loopback databases and USE_PRODUCTION_DB=true; never calls a');
  console.log('provider. No Stripe customer is created, so keep to the settings screens: an');
  console.log('organization billing surface for this account has no customer behind it.');
  console.log('');
  console.log('Sign the mobile development client in as the returned account, then open:');
  console.log('  adb shell "am start -a android.intent.action.VIEW \\');
  console.log(
    `    -d 'kiloapp:///(app)/security-agent/${ORGANIZATION_ID}/settings/automation' com.kilocode.kiloapp"`
  );
}

function userIdFor(email: string): string {
  return `dev-seed:mobile-security-agent-automation:${email}`;
}

/** Inserts the account row the seed owns, or refuses an email that belongs to another. */
async function ensureUser(email: string, name: string): Promise<string> {
  const db = getSeedDb();
  const userId = userIdFor(email);
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
      google_user_name: name,
      google_user_image_url: '',
      stripe_customer_id: `cus_local_security_automation_${randomUUID()}`,
      has_validation_stytch: true,
      customer_source: 'dev-seed',
    })
    .onConflictDoNothing();
  return userId;
}

export async function run(...args: string[]): Promise<SeedResult | void> {
  if (args.includes('--help') || args.includes('-h')) {
    printUsage();
    return;
  }

  const [email, ...extra] = args;
  if (!email || extra.length || !/^[a-z0-9][a-z0-9-]*@example\.(com|test)$/.test(email)) {
    printUsage();
    throw new Error('Provide one owned fake email matching <name>@example.com.');
  }

  assertLocalSeedDatabase('app:mobile-security-agent-automation');
  const db = getSeedDb();
  const ownerId = await ensureUser(email, 'Security automation owner');

  await db
    .insert(organizations)
    .values({
      id: ORGANIZATION_ID,
      name: 'Security automation lab',
      require_seats: false,
      created_by_kilo_user_id: ownerId,
    })
    .onConflictDoNothing();

  await db
    .delete(organization_memberships)
    .where(eq(organization_memberships.organization_id, ORGANIZATION_ID));
  await db.insert(organization_memberships).values({
    organization_id: ORGANIZATION_ID,
    kilo_user_id: ownerId,
    role: 'owner',
  });

  await db.delete(agent_configs).where(eq(agent_configs.owned_by_organization_id, ORGANIZATION_ID));
  await db.insert(agent_configs).values({
    owned_by_organization_id: ORGANIZATION_ID,
    agent_type: 'security_scan',
    platform: 'github',
    is_enabled: true,
    config_revision: 1,
    created_by: ownerId,
    config: {
      auto_sync_enabled: true,
      repository_selection_mode: 'all',
      auto_analysis_enabled: true,
      auto_analysis_min_severity: 'high',
      auto_analysis_include_existing: false,
    },
  });

  console.log(
    'This fixture represents: an organization Security Agent owned by the signed-in account, with auto analysis on above High severity and every other automation section off.'
  );
  console.log('The account is a local row; no provider is called.');
  return {
    email,
    userId: ownerId,
    organizationId: ORGANIZATION_ID,
    automationDeepLink: `kiloapp:///(app)/security-agent/${ORGANIZATION_ID}/settings/automation`,
  };
}
