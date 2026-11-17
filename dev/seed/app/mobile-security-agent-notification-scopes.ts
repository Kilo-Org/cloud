import {
  agent_configs,
  kilocode_users,
  organization_memberships,
  organizations,
} from '@kilocode/db/schema';
import { and, eq } from 'drizzle-orm';

import type { SeedResult } from '../index';
import { assertLocalSeedDatabase, getSeedDb } from '../lib/db';
import { normalizeSeedEmail } from '../lib/email';

export const usage = '<email>';

/** Fixed so a rerun replaces the same organization and both configs. */
const ORGANIZATION_ID = '417b0f4e-3d1a-4c8e-9f27-6a1d5b8c2e60';

/** Both notification sections on, so each revealed picker is visible. */
const NOTIFICATION_POLICY = {
  sla_enabled: true,
  sla_notifications_enabled: true,
  sla_notification_min_severity: 'medium',
  sla_notification_warning_days: 5,
  new_finding_notifications_enabled: true,
  new_finding_notification_min_severity: 'high',
  repository_selection_mode: 'all',
} as const;

function printUsage(): void {
  console.log(`Usage: pnpm dev:seed app:mobile-security-agent-notification-scopes ${usage}`);
  console.log('');
  console.log('Points the Security Agent of an existing seeded account at the notification');
  console.log('settings fixture in both scopes it can be opened in: the account is the owner of');
  console.log('its own personal agent and of one organization, and both agents are enabled with');
  console.log('new-finding notifications above High severity and SLA warnings above Medium with');
  console.log('a 5-day lead time. The notification settings screen then renders each revealed');
  console.log('severity picker and the lead-time field in the personal and the organization');
  console.log('scope.');
  console.log('');
  console.log('Usage:');
  console.log('  pnpm dev:seed app:create-user "Notification Scopes" notify@example.com');
  console.log('  pnpm dev:seed app:mobile-security-agent-notification-scopes notify@example.com');
  console.log('');
  console.log('Sign the mobile development client in as that account, then open a scope:');
  console.log('  adb shell "am start -a android.intent.action.VIEW \\');
  console.log(
    "    -d 'kiloapp:///(app)/security-agent/personal/settings/notifications' com.kilocode.kiloapp\""
  );
  console.log('  adb shell "am start -a android.intent.action.VIEW \\');
  console.log(
    `    -d 'kiloapp:///(app)/security-agent/${ORGANIZATION_ID}/settings/notifications' com.kilocode.kiloapp"`
  );
}

export async function run(...args: string[]): Promise<SeedResult | void> {
  if (args.includes('--help') || args.includes('-h')) {
    printUsage();
    return;
  }

  const [email, ...rest] = args;
  if (!email) {
    printUsage();
    throw new Error('Provide the email of an account that app:create-user already seeded.');
  }
  if (rest.length > 0) {
    throw new Error(`unexpected arguments: ${rest.join(' ')}`);
  }

  assertLocalSeedDatabase('app:mobile-security-agent-notification-scopes');
  const db = getSeedDb();
  const normalizedEmail = normalizeSeedEmail(email.trim());
  const users = await db
    .select({ id: kilocode_users.id })
    .from(kilocode_users)
    .where(eq(kilocode_users.normalized_email, normalizedEmail))
    .limit(1);
  const user = users[0];
  if (!user) {
    printUsage();
    throw new Error(`No account for ${email}; run app:create-user first.`);
  }

  // Idempotent rerun: this topic owns the account's personal notification config
  // and everything under its fixed organization, and replaces exactly those.
  await db
    .delete(agent_configs)
    .where(
      and(
        eq(agent_configs.owned_by_user_id, user.id),
        eq(agent_configs.agent_type, 'security_scan')
      )
    );
  await db.delete(agent_configs).where(eq(agent_configs.owned_by_organization_id, ORGANIZATION_ID));
  await db
    .delete(organization_memberships)
    .where(eq(organization_memberships.organization_id, ORGANIZATION_ID));

  await db.insert(agent_configs).values({
    owned_by_user_id: user.id,
    agent_type: 'security_scan',
    // The screens read the config for this platform; `all` is a different row.
    platform: 'github',
    is_enabled: true,
    config_revision: 1,
    created_by: user.id,
    config: NOTIFICATION_POLICY,
  });

  await db
    .insert(organizations)
    .values({
      id: ORGANIZATION_ID,
      name: 'Notification settings lab',
      require_seats: false,
      created_by_kilo_user_id: user.id,
    })
    .onConflictDoNothing();
  await db.insert(organization_memberships).values({
    organization_id: ORGANIZATION_ID,
    kilo_user_id: user.id,
    role: 'owner',
  });

  await db.insert(agent_configs).values({
    owned_by_organization_id: ORGANIZATION_ID,
    agent_type: 'security_scan',
    platform: 'github',
    is_enabled: true,
    config_revision: 1,
    created_by: user.id,
    config: NOTIFICATION_POLICY,
  });

  console.log('This fixture represents:');
  console.log('  One account that owns both an enabled personal Security Agent and an enabled');
  console.log('  organization Security Agent, each with both notification sections on.');
  console.log('Suggested next step:');
  console.log('  Open both deep links above and compare the severity labels with their options.');

  return {
    email,
    userId: user.id,
    organizationId: ORGANIZATION_ID,
    personalNotificationsLink: 'kiloapp:///(app)/security-agent/personal/settings/notifications',
    organizationNotificationsLink: `kiloapp:///(app)/security-agent/${ORGANIZATION_ID}/settings/notifications`,
  };
}
