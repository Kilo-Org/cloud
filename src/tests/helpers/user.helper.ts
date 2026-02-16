import { db } from '@/lib/drizzle';
import type { User } from '@/db/schema';
import { kilocode_users, user_auth_provider } from '@/db/schema';
import { hosted_domain_specials } from '@/lib/auth/constants';

export function defineTestUser(userData: Partial<User> = {}): User {
  const randomUserId = `test-user-${Math.random()}`;
  const now = new Date().toISOString();

  return {
    id: randomUserId,
    google_user_email: `${randomUserId}@example.com`,
    google_user_name: 'Test User',
    google_user_image_url: 'https://example.com/avatar.png',
    stripe_customer_id: `stripe-customer-${randomUserId}`,
    hosted_domain: hosted_domain_specials.non_workspace_google_account,
    created_at: now,
    updated_at: now,
    microdollars_used: 0,
    kilo_pass_threshold: null,
    total_microdollars_acquired: 0,
    is_admin: false,
    blocked_reason: null,
    has_validation_novel_card_with_hold: false,
    has_validation_stytch: false,
    api_token_pepper: null,
    auto_top_up_enabled: false,
    default_model: null,
    is_bot: false,
    next_credit_expiration_at: null,
    cohorts: {},
    linkedin_url: null,
    github_url: null,
    ...userData,
  } satisfies User;
}

export async function insertTestUser(userData: Partial<User> = {}): Promise<User> {
  const result = await db.insert(kilocode_users).values(defineTestUser(userData)).returning();
  return result[0];
}

export async function insertTestUserAndGoogleAuth(userData: Partial<User> = {}): Promise<User> {
  const insertedUser = await insertTestUser(userData);

  await db.insert(user_auth_provider).values({
    kilo_user_id: insertedUser.id,
    provider: 'google',
    provider_account_id: `google-${insertedUser.id}`,
    email: insertedUser.google_user_email,
    avatar_url: insertedUser.google_user_image_url,
    hosted_domain:
      insertedUser.hosted_domain === hosted_domain_specials.non_workspace_google_account
        ? null
        : insertedUser.hosted_domain,
  });

  return insertedUser;
}
