import { createHash, randomBytes, randomUUID } from 'node:crypto';

import {
  byok_api_keys,
  cli_sessions_v2,
  cliSessions,
  credit_transactions,
  device_auth_requests,
  device_refresh_tokens,
  device_sessions,
  kilocode_users,
  magic_link_tokens,
  organization_memberships,
  organizations,
  payment_methods,
  sharedCliSessions,
  user_admin_notes,
  user_feedback,
  user_notification_preferences,
} from '@kilocode/db/schema';
import { and, eq, inArray, isNotNull, like, sql } from 'drizzle-orm';

import type { SeedResult } from '../index';
import { getSeedDb } from '../lib/db';

const EMAILS = [
  'ok@local.test',
  'ok2@local.test',
  'ok3@local.test',
  'ok4@local.test',
  '429-posthog@local.test',
  '429-pylon@local.test',
  '429-pylon-reply@local.test',
  'fail-posthog@local.test',
  'fail-pylon@local.test',
  'slow-posthog@local.test',
  'missing@local.test',
  'expired-substack@local.test',
  'no-substack@local.test',
  '429-cio@local.test',
  'fail-cio@local.test',
];

const ORG_PREFIX = '[deletion-seed]';
const CREDIT_CATEGORY = 'dev-seed:deletion-queue';
const CREDIT_AMOUNT = 10_000_000;
const ADMIN_EMAIL = 'evgeny@kilocode.ai';

function printUsage(): void {
  console.log('Usage: pnpm dev:seed deletion:fixtures');
  console.log('');
  console.log('Attaches wipeable Cloud rows to the local deletion-mock users:');
  console.log(
    'CLI v2 sessions, device auth, org membership, notes, payment method, BYOK, credits.'
  );
}

function sesId(tag: string): string {
  return `ses_${createHash('sha256').update(tag).digest('hex').slice(0, 26)}`;
}

function hashToken(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export async function run(...args: string[]): Promise<SeedResult | void> {
  if (args.includes('--help') || args.includes('-h')) {
    printUsage();
    return;
  }
  if (args.length > 0) {
    printUsage();
    throw new Error(`Unexpected extra arguments: ${args.join(' ')}`);
  }

  const db = getSeedDb();
  const users = await db
    .select({
      id: kilocode_users.id,
      email: kilocode_users.google_user_email,
    })
    .from(kilocode_users)
    .where(inArray(kilocode_users.google_user_email, [...EMAILS]));

  const byEmail = new Map(users.map(user => [user.email, user]));
  const missing = EMAILS.filter(email => !byEmail.has(email));
  if (missing.length > 0) {
    throw new Error(`Missing Cloud users: ${missing.join(', ')}`);
  }

  const [admin] = await db
    .select({ id: kilocode_users.id })
    .from(kilocode_users)
    .where(eq(kilocode_users.google_user_email, ADMIN_EMAIL))
    .limit(1);
  if (!admin) {
    throw new Error(`Admin ${ADMIN_EMAIL} not found`);
  }

  const userIds = users.map(user => user.id);
  const existingOrgs = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(like(organizations.name, `${ORG_PREFIX}%`));
  const orgIds = existingOrgs.map(org => org.id);

  if (orgIds.length > 0) {
    await db
      .delete(organization_memberships)
      .where(inArray(organization_memberships.organization_id, orgIds));
  }

  await db
    .delete(cli_sessions_v2)
    .where(
      and(
        inArray(cli_sessions_v2.kilo_user_id, userIds),
        isNotNull(cli_sessions_v2.parent_session_id)
      )
    );
  await db.delete(cli_sessions_v2).where(inArray(cli_sessions_v2.kilo_user_id, userIds));
  await db.delete(sharedCliSessions).where(inArray(sharedCliSessions.kilo_user_id, userIds));
  await db.delete(cliSessions).where(inArray(cliSessions.kilo_user_id, userIds));

  const sessions = await db
    .select({ id: device_sessions.id })
    .from(device_sessions)
    .where(inArray(device_sessions.kilo_user_id, userIds));
  if (sessions.length > 0) {
    await db.delete(device_refresh_tokens).where(
      inArray(
        device_refresh_tokens.device_session_id,
        sessions.map(session => session.id)
      )
    );
  }
  await db.delete(device_sessions).where(inArray(device_sessions.kilo_user_id, userIds));
  await db.delete(device_auth_requests).where(inArray(device_auth_requests.kilo_user_id, userIds));
  await db.delete(user_admin_notes).where(inArray(user_admin_notes.kilo_user_id, userIds));
  await db.delete(user_feedback).where(inArray(user_feedback.kilo_user_id, userIds));
  await db
    .delete(user_notification_preferences)
    .where(inArray(user_notification_preferences.user_id, userIds));
  await db.delete(payment_methods).where(inArray(payment_methods.user_id, userIds));
  await db.delete(byok_api_keys).where(inArray(byok_api_keys.kilo_user_id, userIds));
  await db.delete(magic_link_tokens).where(inArray(magic_link_tokens.email, [...EMAILS]));
  if (orgIds.length > 0) {
    await db.delete(organizations).where(inArray(organizations.id, orgIds));
  }

  console.log('This fixture represents: wipeable Cloud rows for deletion-mock users.');
  console.log('Note: credits are kept across reruns; other rows are reset.');

  for (const email of EMAILS) {
    const user = byEmail.get(email);
    if (!user) {
      throw new Error(`Missing Cloud user after lookup: ${email}`);
    }

    const [org] = await db
      .insert(organizations)
      .values({
        name: `${ORG_PREFIX} ${email}`,
        created_by_kilo_user_id: user.id,
        require_seats: false,
        seat_count: 1,
      })
      .returning({ id: organizations.id });
    if (!org) throw new Error(`Failed to create org for ${email}`);

    await db.insert(organization_memberships).values({
      organization_id: org.id,
      kilo_user_id: user.id,
      role: 'owner',
    });

    const parentId = sesId(`${user.id}:parent`);
    const childId = sesId(`${user.id}:child`);
    await db.insert(cli_sessions_v2).values({
      session_id: parentId,
      kilo_user_id: user.id,
      title: `Deletion fixture parent ${email}`,
      organization_id: org.id,
      created_on_platform: 'cli',
      git_url: 'https://github.com/example/deletion-seed.git',
      git_branch: 'main',
      status: 'idle',
    });
    await db.insert(cli_sessions_v2).values({
      session_id: childId,
      kilo_user_id: user.id,
      parent_session_id: parentId,
      title: `Deletion fixture child ${email}`,
      organization_id: org.id,
      created_on_platform: 'cli',
      status: 'idle',
    });

    await db.insert(device_auth_requests).values({
      code: `del-seed-${user.id.slice(0, 8)}`,
      kilo_user_id: user.id,
      status: 'pending',
      expires_at: new Date(Date.now() + 86_400_000).toISOString(),
      user_agent: 'deletion-seed/1.0',
      ip_address: '203.0.113.10',
    });

    const [deviceSession] = await db
      .insert(device_sessions)
      .values({
        kilo_user_id: user.id,
        user_agent: 'Kilo CLI deletion-seed',
      })
      .returning({ id: device_sessions.id });
    if (!deviceSession) throw new Error(`Failed to create device session for ${email}`);

    await db.insert(device_refresh_tokens).values({
      token_hash: hashToken(`refresh:${user.id}`),
      device_session_id: deviceSession.id,
      expires_at: new Date(Date.now() + 30 * 86_400_000).toISOString(),
    });

    await db.insert(user_admin_notes).values({
      kilo_user_id: user.id,
      admin_kilo_user_id: admin.id,
      note_content: `Deletion fixture note for ${email}`,
    });

    await db.insert(user_feedback).values({
      kilo_user_id: user.id,
      feedback_text: `Please delete my account ${email}`,
    });

    await db.insert(user_notification_preferences).values({
      user_id: user.id,
    });

    await db.insert(magic_link_tokens).values({
      token_hash: hashToken(`magic:${user.id}`),
      email,
      expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    });

    await db.insert(payment_methods).values({
      user_id: user.id,
      stripe_id: `pm_seed_${user.id.replaceAll('-', '').slice(0, 16)}`,
      last4: '4242',
      brand: 'visa',
      name: `Deletion ${email}`,
      address_line1: '1 Market St',
      address_city: 'San Francisco',
      address_state: 'CA',
      address_zip: '94105',
      address_country: 'US',
      http_x_forwarded_for: '203.0.113.10',
    });

    await db.insert(byok_api_keys).values({
      kilo_user_id: user.id,
      provider_id: 'openai',
      created_by: user.id,
      encrypted_api_key: {
        iv: randomBytes(12).toString('base64'),
        data: randomBytes(32).toString('base64'),
        authTag: randomBytes(16).toString('base64'),
      },
    });

    const existingCredit = await db
      .select({ id: credit_transactions.id })
      .from(credit_transactions)
      .where(
        and(
          eq(credit_transactions.kilo_user_id, user.id),
          eq(credit_transactions.credit_category, CREDIT_CATEGORY)
        )
      )
      .limit(1);

    if (existingCredit.length === 0) {
      const [fresh] = await db
        .select({ used: kilocode_users.microdollars_used })
        .from(kilocode_users)
        .where(eq(kilocode_users.id, user.id))
        .limit(1);
      await db.insert(credit_transactions).values({
        id: randomUUID(),
        kilo_user_id: user.id,
        amount_microdollars: CREDIT_AMOUNT,
        is_free: true,
        description: 'Deletion queue fixture credits',
        credit_category: CREDIT_CATEGORY,
        original_baseline_microdollars_used: fresh?.used ?? 0,
      });
      await db
        .update(kilocode_users)
        .set({
          total_microdollars_acquired: sql`${kilocode_users.total_microdollars_acquired} + ${CREDIT_AMOUNT}`,
        })
        .where(eq(kilocode_users.id, user.id));
    }
  }

  return {
    userCount: EMAILS.length,
    v2SessionsPerUser: 2,
    creditUsd: 10,
    orgPrefix: ORG_PREFIX,
  };
}
