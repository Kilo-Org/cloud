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
 * Fixed so a rerun replaces the same organization, users and config.
 */
const ORGANIZATION_ID = 'b007c8bf-ad4d-4651-b5e1-d20989d0dc71';

/** The organization's own owner. The caller is only a member of it. */
const OWNER_EMAIL = 'security-notifications-owner@example.com';

function printUsage(): void {
  console.log(`Usage: pnpm dev:seed app:mobile-security-agent-notifications ${usage}`);
  console.log('');
  console.log('Seeds an organization whose Security Agent is enabled, with both notification');
  console.log('sections on: new-finding notifications above High severity and SLA warnings');
  console.log('above Medium with a 5-day lead time. The signed-in account is a plain member of');
  console.log('that organization, so every control on the notification settings screen is');
  console.log('read-only — the state a member sees.');
  console.log('');
  console.log('Refuses non-loopback databases and USE_PRODUCTION_DB=true; never calls a');
  console.log('provider. No Stripe customer is created, so keep to the settings screens: an');
  console.log('organization billing surface for this account has no customer behind it.');
  console.log('');
  console.log('Sign the mobile development client in as the returned account, then open:');
  console.log('  adb shell "am start -a android.intent.action.VIEW \\');
  console.log(
    `    -d 'kiloapp:///(app)/security-agent/${ORGANIZATION_ID}/settings/notifications' com.kilocode.kiloapp"`
  );
}

function userIdFor(email: string): string {
  return `dev-seed:mobile-security-agent-notifications:${email}`;
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
      stripe_customer_id: `cus_local_security_notifications_${randomUUID()}`,
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

  assertLocalSeedDatabase('app:mobile-security-agent-notifications');
  const db = getSeedDb();
  const memberId = await ensureUser(email, 'Security notifications member');
  const ownerId = await ensureUser(OWNER_EMAIL, 'Security notifications owner');

  await db
    .insert(organizations)
    .values({
      id: ORGANIZATION_ID,
      name: 'Security notifications lab',
      require_seats: false,
      created_by_kilo_user_id: ownerId,
    })
    .onConflictDoNothing();

  await db
    .delete(organization_memberships)
    .where(eq(organization_memberships.organization_id, ORGANIZATION_ID));
  await db.insert(organization_memberships).values([
    {
      organization_id: ORGANIZATION_ID,
      kilo_user_id: ownerId,
      role: 'owner',
    },
    {
      organization_id: ORGANIZATION_ID,
      kilo_user_id: memberId,
      role: 'member',
    },
  ]);
  // The caller was seeded earlier under the same address by another topic: its
  // own organization rows stay untouched, and this function only re-creates this
  // organization's memberships, which is where its role matters.

  await db.delete(agent_configs).where(eq(agent_configs.owned_by_organization_id, ORGANIZATION_ID));
  await db.insert(agent_configs).values({
    owned_by_organization_id: ORGANIZATION_ID,
    agent_type: 'security_scan',
    platform: 'github',
    is_enabled: true,
    config_revision: 1,
    created_by: ownerId,
    config: {
      sla_enabled: true,
      sla_notifications_enabled: true,
      sla_notification_min_severity: 'medium',
      sla_notification_warning_days: 5,
      new_finding_notifications_enabled: true,
      new_finding_notification_min_severity: 'high',
      auto_sync_enabled: true,
      repository_selection_mode: 'all',
    },
  });

  console.log(
    'This fixture represents: an organization Security Agent with both notification sections on, seen by a member who cannot change them.'
  );
  console.log('Both the caller and the organization owner are local rows; no provider is called.');
  return {
    email,
    memberUserId: memberId,
    ownerEmail: OWNER_EMAIL,
    organizationId: ORGANIZATION_ID,
    notificationsDeepLink: `kiloapp:///(app)/security-agent/${ORGANIZATION_ID}/settings/notifications`,
  };
}
