import { createStripeCustomer } from '@/lib/stripe-client';
import { randomUUID } from 'crypto';
import { createTimer } from '@/lib/timer';
import PostHogClient from '@/lib/posthog';
import { captureException, captureMessage } from '@sentry/nextjs';
import { db } from '@/lib/drizzle';
import { WORKOS_API_KEY } from '@/lib/config.server';
import { WorkOS } from '@workos-inc/node';
import type { User } from '@/db/schema';
import {
  payment_methods,
  kilocode_users,
  user_admin_notes,
  user_auth_provider,
  kilo_pass_subscriptions,
  cloud_agent_webhook_triggers,
  enrichment_data,
  source_embeddings,
  code_indexing_search,
  code_indexing_manifest,
  referral_codes,
  organization_memberships,
  organization_user_limits,
  organization_user_usage,
  organization_invitations,
  organization_audit_logs,
  magic_link_tokens,
  device_auth_requests,
  auto_top_up_configs,
  platform_integrations,
  byok_api_keys,
  agent_configs,
  webhook_events,
  agent_environment_profiles,
  security_findings,
  security_audit_log,
  auto_triage_tickets,
  auto_fix_tickets,
  slack_bot_requests,
  cloud_agent_code_reviews,
  kiloclaw_instances,
  kiloclaw_access_codes,
  user_period_cache,
  user_feedback,
  app_builder_feedback,
  free_model_usage,
  kilo_pass_scheduled_changes,
} from '@/db/schema';
import { eq, and, inArray, sql } from 'drizzle-orm';
import { allow_fake_login } from './constants';
import type { AuthErrorType } from '@/lib/auth/constants';
import { hosted_domain_specials } from '@/lib/auth/constants';
import { strict as assert } from 'node:assert';
import type { OptionalError, Result } from '@/lib/maybe-result';
import { failureResult, successResult, trpcFailure } from '@/lib/maybe-result';
import type { TRPCError } from '@trpc/server';
import type { UUID } from 'node:crypto';
import type { AuthProviderId } from '@/lib/auth/provider-metadata';

const workos = new WorkOS(WORKOS_API_KEY);

/**
 * @param fromDb - Database instance to use (defaults to primary db, pass readDb for replica)
 */
export async function findUserById(
  userId: string,
  fromDb: typeof db = db
): Promise<User | undefined> {
  return await fromDb.query.kilocode_users.findFirst({
    where: eq(kilocode_users.id, userId),
  });
}

export async function findUsersByIds(userIds: string[]): Promise<Map<string, User>> {
  if (userIds.length === 0) return new Map();
  const uniqueUserIds = [...new Set(userIds)];
  const users = await db.query.kilocode_users.findMany({
    where: inArray(kilocode_users.id, uniqueUserIds),
  });

  return new Map(users.map(u => [u.id, u]));
}

export async function findUserByStripeCustomerId(
  stripeCustomerId: string
): Promise<User | undefined> {
  return await db.query.kilocode_users.findFirst({
    where: eq(kilocode_users.stripe_customer_id, stripeCustomerId),
  });
}

const posthogClient = PostHogClient();
if (process.env.NEXT_PUBLIC_POSTHOG_DEBUG) {
  posthogClient.debug();
}

/**
 * Determines if a user should have admin privileges based on their email and hosted domain.
 * Centralized logic ensures all auth providers (Google, magic link, GitHub, etc.) get
 * consistent admin status based on the same rules.
 */
function shouldBeAdmin(email: string, hosted_domain: string | null): boolean {
  return (
    (hosted_domain === hosted_domain_specials.kilocode_admin &&
      email.endsWith('@' + hosted_domain_specials.kilocode_admin)) ||
    (allow_fake_login &&
      hosted_domain === hosted_domain_specials.fake_devonly &&
      email.endsWith('@admin.example.com'))
  );
}

export type CreateOrUpdateUserArgs = {
  google_user_email: string;
  google_user_name: string;
  google_user_image_url: string;
  hosted_domain: string | null;
  provider: AuthProviderId;
  provider_account_id: string;
};

export async function findAndSyncExistingUser(args: CreateOrUpdateUserArgs) {
  const timer = createTimer();
  const existing_kilo_user_id = await findUserIdByAuthProvider(
    args.provider,
    args.provider_account_id
  );
  if (!existing_kilo_user_id) {
    return null;
  }

  const existingUser = await findUserById(existing_kilo_user_id);
  assert(existingUser, `User not found for kiloUserId: ${existing_kilo_user_id}`);

  if (existingUser.hosted_domain !== args.hosted_domain) {
    //This really should only affect legacy users.
    await db
      .update(kilocode_users)
      .set({ hosted_domain: args.hosted_domain })
      .where(eq(kilocode_users.id, existingUser.id));
    console.log(
      `Updated hosted_domain for user ${existingUser.id}: ${existingUser.hosted_domain} -> ${args.hosted_domain}`
    );
    existingUser.hosted_domain = args.hosted_domain;
  }
  timer.log(`findFirst user with id ${existingUser.id}`);
  return existingUser;
}

export async function findUserByEmail(email: string): Promise<User | undefined> {
  return await db.query.kilocode_users.findFirst({
    where: eq(kilocode_users.google_user_email, email),
  });
}

export async function createOrUpdateUser(
  args: CreateOrUpdateUserArgs,
  turnstile_guid: UUID | undefined,
  autoLinkToExistingUser: boolean = false
): Promise<Result<{ user: User; isNew: boolean }, AuthErrorType>> {
  const existingUser = await findAndSyncExistingUser(args);
  if (existingUser) {
    // User signed in or is being updated
    posthogClient.capture({
      distinctId: existingUser.google_user_email,
      event: 'user_signed_in',
      properties: {
        name: existingUser.google_user_name,
        hosted_domain: existingUser.hosted_domain,
        provider: args.provider,
        id: existingUser.id,
      },
    });
    return successResult({ user: existingUser, isNew: false });
  }

  // check to see if we have a user with the same email
  const userByEmail = await findUserByEmail(args.google_user_email);
  if (userByEmail) {
    const existingProviders = await getUserAuthProviders(userByEmail.id);
    const hasThisProvider = existingProviders.some(p => p.provider === args.provider);
    const onlyHasFakeLogin =
      existingProviders.length === 1 && existingProviders[0].provider === 'fake-login';
    const hasNoProviders = existingProviders.length === 0;

    // Link this new provider to the existing user if they don't already have it.
    // fake-login is placeholder auth (dev-only) - always allow upgrading from it.
    // Otherwise, only link if autoLinkToExistingUser AND one of:
    //   - User has no providers (clean slate after admin reset)
    //   - Provider is WorkOS/fake-login (special upgrade paths)
    const isUpgradeProvider = args.provider === 'workos' || args.provider === 'fake-login';
    const shouldLink =
      !hasThisProvider &&
      (onlyHasFakeLogin || (autoLinkToExistingUser && (hasNoProviders || isUpgradeProvider)));

    if (shouldLink) {
      // WorkOS SSO: Remove existing OAuth providers to enforce single sign-on
      if (args.provider === 'workos' && !hasNoProviders) {
        await db
          .delete(user_auth_provider)
          .where(eq(user_auth_provider.kilo_user_id, userByEmail.id));
      }

      const linkResult = await linkAccountToExistingUser(userByEmail.id, args);
      if (!linkResult.success) {
        return { success: false, error: linkResult.error };
      }
      // Successfully linked account, return the existing user
      posthogClient.capture({
        distinctId: userByEmail.google_user_email,
        event: 'user_signed_in_with_different_id_and_auto_linked',
        properties: {
          existing_name: userByEmail.google_user_name,
          existing_hosted_domain: userByEmail.hosted_domain,
          existing_id: userByEmail.id,
          new_provider: args.provider,
          new_provider_account_id: args.provider_account_id,
          new_name: args.google_user_name,
          new_email: args.google_user_email,
          new_image_url: args.google_user_image_url,
          new_hosted_domain: args.hosted_domain,
        },
      });
      return successResult({ user: userByEmail, isNew: false });
    } else {
      // User signed in with a different ID, but same email
      posthogClient.capture({
        distinctId: userByEmail.google_user_email,
        event: 'user_signed_in_with_different_id',
        properties: {
          existing_name: userByEmail.google_user_name,
          existing_hosted_domain: userByEmail.hosted_domain,
          existing_id: userByEmail.id,
          new_provider: args.provider,
          new_provider_account_id: args.provider_account_id,
          new_name: args.google_user_name,
          new_email: args.google_user_email,
          new_image_url: args.google_user_image_url,
          new_hosted_domain: args.hosted_domain,
        },
      });
      return failureResult('DIFFERENT-OAUTH');
    }
  }

  if (turnstile_guid && (await findUserById(turnstile_guid)))
    throw new Error('Abuser warning: turnstile guid reuse detected ' + turnstile_guid);

  const newUserId = turnstile_guid ?? randomUUID();

  // New user creation path
  const stripeCustomer = await createStripeCustomer({
    email: args.google_user_email,
    name: args.google_user_name,
    metadata: { kiloUserId: newUserId },
  });

  const newUser = {
    id: newUserId,
    google_user_email: args.google_user_email,
    google_user_name: args.google_user_name,
    google_user_image_url: args.google_user_image_url,
    hosted_domain: args.hosted_domain,
    is_admin: shouldBeAdmin(args.google_user_email, args.hosted_domain),
    stripe_customer_id: stripeCustomer.id,
  } satisfies typeof kilocode_users.$inferInsert;

  const savedUser = await db.transaction(async tx => {
    const [savedUser] = await tx.insert(kilocode_users).values(newUser).returning();
    assert(savedUser, 'Failed to save new user');

    await tx.insert(user_auth_provider).values({
      kilo_user_id: savedUser.id,
      provider: args.provider,
      provider_account_id: args.provider_account_id,
      avatar_url: args.google_user_image_url,
      email: args.google_user_email,
      hosted_domain: args.hosted_domain,
    });

    return savedUser;
  });

  // User created event in PostHog
  posthogClient.capture({
    event: 'user_created',
    distinctId: savedUser.google_user_email,
    properties: {
      id: savedUser.id,
      google_user_email: savedUser.google_user_email,
      google_user_name: savedUser.google_user_name,
      created_at: savedUser.created_at,
      hosted_domain: savedUser.hosted_domain,
      stripe_customer_id: savedUser.stripe_customer_id,
      provider: args.provider,
      $set_once: {
        user_id: savedUser.id,
        email: savedUser.google_user_email,
        name: savedUser.google_user_name,
        user_created_at: savedUser.created_at,
        hosted_domain: savedUser.hosted_domain,
        stripe_id: savedUser.stripe_customer_id,
      },
    },
  });

  // Set up user identification via user ID
  posthogClient.alias({ distinctId: savedUser.google_user_email, alias: savedUser.id });

  return successResult({ user: savedUser, isNew: true });
}

export async function linkAccountToExistingUser(
  existingKiloUserId: string,
  authProviderData: CreateOrUpdateUserArgs
): Promise<Result<{ user: User }, AuthErrorType>> {
  // Verify the existing user exists
  const existingUser = await findUserById(existingKiloUserId);
  if (!existingUser) return failureResult('USER-NOT-FOUND');

  // Link the new auth provider to the existing user
  const linkResult = await linkAuthProviderToUser({
    kilo_user_id: existingKiloUserId,
    provider: authProviderData.provider,
    provider_account_id: authProviderData.provider_account_id,
    email: authProviderData.google_user_email,
    avatar_url: authProviderData.google_user_image_url,
    hosted_domain: authProviderData.hosted_domain,
  });

  if (!linkResult.success) {
    captureException(new Error(`Account linking failed: ${linkResult.error}`), {
      tags: {
        operation: 'account_linking',
        provider: authProviderData.provider,
      },
      extra: {
        existing_user_id: existingKiloUserId,
        provider_email: authProviderData.google_user_email,
        provider_account_id: authProviderData.provider_account_id,
        error_code: linkResult.error,
      },
    });

    return linkResult;
  }

  // Log the account linking event
  posthogClient.capture({
    distinctId: existingUser.google_user_email,
    event: 'account_linked',
    properties: {
      existing_user_id: existingKiloUserId,
      linked_provider: authProviderData.provider,
      linked_email: authProviderData.google_user_email,
      linked_hosted_domain: authProviderData.hosted_domain,
    },
  });

  return successResult({ user: existingUser });
}

/**
 * Error thrown when soft-delete preconditions are not met.
 */
export class SoftDeletePreconditionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SoftDeletePreconditionError';
  }
}

/**
 * Soft-delete a user: anonymize PII, scrub related data, but keep the
 * user row and financial/billing records intact.
 *
 * Preconditions (will throw SoftDeletePreconditionError if violated):
 * - User must not have an active, non-cancelling Kilo Pass subscription
 *
 * What is kept:
 * - The kilocode_users row (anonymized)
 * - Stripe link (stripe_customer_id unchanged)
 * - credit_transactions, microdollar_usage (billing records)
 * - kilo_pass_subscriptions/issuances/issuance_items (financial)
 * - cli_sessions, shared_cli_sessions, cli_sessions_v2 (session history)
 * - deployments, app_builder_projects (user assets)
 * - stytch_fingerprints (abuse detection)
 * - referral_code_usages (financial, references anonymized user)
 *
 * What is scrubbed/deleted:
 * - PII on the user row (email, name, avatar, urls)
 * - user_auth_provider (auth links with email/avatar)
 * - enrichment_data (GitHub/LinkedIn/Clay PII)
 * - user_admin_notes
 * - referral_codes (user's own code)
 * - magic_link_tokens (email-based)
 * - organization_memberships (removed from all orgs)
 * - organization_invitations (sent by user + addressed to user's email)
 * - organization_user_limits/usage
 * - organization_audit_logs (actor PII nulled)
 * - payment_methods (soft-deleted, address/name/IP fields nulled)
 * - user_feedback / app_builder_feedback / free_model_usage (FK nulled)
 * - Various user-owned resources (platform_integrations, byok_api_keys,
 *   agent_configs, webhook_events, code_indexing_*, source_embeddings,
 *   cloud_agent_webhook_triggers, agent_environment_profiles,
 *   security_findings, auto_triage/fix_tickets, slack_bot_requests,
 *   cloud_agent_code_reviews, device_auth_requests, auto_top_up_configs,
 *   kiloclaw_instances/access_codes, user_period_cache,
 *   kilo_pass_scheduled_changes)
 */
export async function softDeleteUser(userId: string) {
  const user = await findUserById(userId);
  if (!user) return; // Nothing to do for non-existent user

  // Grab the original email before we anonymize — needed for cleanup of
  // magic_link_tokens and organization_invitations addressed to this user.
  const originalEmail = user.google_user_email;

  await db.transaction(async tx => {
    // ── Precondition checks (inside tx to avoid TOCTOU races) ──────────
    const activeSubscriptions = await tx
      .select({ id: kilo_pass_subscriptions.id })
      .from(kilo_pass_subscriptions)
      .where(
        and(
          eq(kilo_pass_subscriptions.kilo_user_id, userId),
          eq(kilo_pass_subscriptions.status, 'active'),
          eq(kilo_pass_subscriptions.cancel_at_period_end, false)
        )
      );

    if (activeSubscriptions.length > 0) {
      throw new SoftDeletePreconditionError(
        `User ${userId} has an active Kilo Pass subscription. Cancel the subscription before deleting the account.`
      );
    }

    // ── 1. Anonymize the user row ────────────────────────────────────────
    await tx
      .update(kilocode_users)
      .set({
        google_user_email: `deleted+${userId}@deleted.invalid`,
        google_user_name: 'Deleted User',
        google_user_image_url: '',
        hosted_domain: null,
        linkedin_url: null,
        github_url: null,
        api_token_pepper: null,
        default_model: null,
        blocked_reason: `soft-deleted at ${new Date().toISOString()}`,
        auto_top_up_enabled: false,
        completed_welcome_form: false,
        cohorts: {},
        is_admin: false,
      })
      .where(eq(kilocode_users.id, userId));

    // ── 2. Hard-delete PII tables ────────────────────────────────────────
    await tx.delete(user_auth_provider).where(eq(user_auth_provider.kilo_user_id, userId));
    await tx.delete(enrichment_data).where(eq(enrichment_data.user_id, userId));
    await tx.delete(user_admin_notes).where(eq(user_admin_notes.kilo_user_id, userId));
    await tx.delete(referral_codes).where(eq(referral_codes.kilo_user_id, userId));
    await tx.delete(magic_link_tokens).where(eq(magic_link_tokens.email, originalEmail));

    // Remove from organizations
    await tx
      .delete(organization_memberships)
      .where(eq(organization_memberships.kilo_user_id, userId));
    // Delete invitations sent BY this user and invitations sent TO this user's email
    await tx
      .delete(organization_invitations)
      .where(eq(organization_invitations.invited_by, userId));
    await tx
      .delete(organization_invitations)
      .where(eq(organization_invitations.email, originalEmail));
    await tx
      .delete(organization_user_limits)
      .where(eq(organization_user_limits.kilo_user_id, userId));
    await tx
      .delete(organization_user_usage)
      .where(eq(organization_user_usage.kilo_user_id, userId));

    // User-owned resources (these would have been CASCADE-deleted if we
    // deleted the user row, but since we keep it, we delete them explicitly)

    // cloud_agent_webhook_triggers has RESTRICT FK on agent_environment_profiles,
    // so delete triggers before profiles
    await tx
      .delete(cloud_agent_webhook_triggers)
      .where(eq(cloud_agent_webhook_triggers.user_id, userId));
    await tx
      .delete(agent_environment_profiles)
      .where(eq(agent_environment_profiles.owned_by_user_id, userId));

    await tx
      .delete(platform_integrations)
      .where(eq(platform_integrations.owned_by_user_id, userId));
    await tx.delete(byok_api_keys).where(eq(byok_api_keys.kilo_user_id, userId));
    await tx.delete(agent_configs).where(eq(agent_configs.owned_by_user_id, userId));
    await tx.delete(webhook_events).where(eq(webhook_events.owned_by_user_id, userId));
    await tx.delete(security_findings).where(eq(security_findings.owned_by_user_id, userId));
    await tx.delete(auto_fix_tickets).where(eq(auto_fix_tickets.owned_by_user_id, userId));
    await tx.delete(auto_triage_tickets).where(eq(auto_triage_tickets.owned_by_user_id, userId));
    await tx.delete(slack_bot_requests).where(eq(slack_bot_requests.owned_by_user_id, userId));
    await tx
      .delete(cloud_agent_code_reviews)
      .where(eq(cloud_agent_code_reviews.owned_by_user_id, userId));
    await tx.delete(device_auth_requests).where(eq(device_auth_requests.kilo_user_id, userId));
    await tx.delete(auto_top_up_configs).where(eq(auto_top_up_configs.owned_by_user_id, userId));
    await tx.delete(kiloclaw_access_codes).where(eq(kiloclaw_access_codes.kilo_user_id, userId));
    await tx.delete(kiloclaw_instances).where(eq(kiloclaw_instances.user_id, userId));
    await tx.delete(user_period_cache).where(eq(user_period_cache.kilo_user_id, userId));
    await tx
      .delete(kilo_pass_scheduled_changes)
      .where(eq(kilo_pass_scheduled_changes.kilo_user_id, userId));

    // Code indexing data
    await tx.delete(source_embeddings).where(eq(source_embeddings.kilo_user_id, userId));
    await tx.delete(code_indexing_search).where(eq(code_indexing_search.kilo_user_id, userId));
    await tx.delete(code_indexing_manifest).where(eq(code_indexing_manifest.kilo_user_id, userId));

    // ── 3. Anonymize PII in retained tables ──────────────────────────────

    // Organization audit logs: keep the log entries, strip actor PII
    await tx
      .update(organization_audit_logs)
      .set({ actor_email: null, actor_name: null })
      .where(eq(organization_audit_logs.actor_id, userId));

    // Security audit logs: keep org-owned entries, strip actor PII
    // (user-owned entries are cascade-deleted via owned_by_user_id FK)
    await tx
      .update(security_audit_log)
      .set({ actor_email: null, actor_name: null })
      .where(eq(security_audit_log.actor_id, userId));

    // Payment methods: soft-delete and strip address/name/IP fields
    await tx
      .update(payment_methods)
      .set({
        deleted_at: sql`now()`,
        name: null,
        address_line1: null,
        address_line2: null,
        address_city: null,
        address_state: null,
        address_zip: null,
        address_country: null,
        http_x_forwarded_for: null,
        http_x_vercel_ip_city: null,
        http_x_vercel_ip_country: null,
        http_x_vercel_ip_latitude: null,
        http_x_vercel_ip_longitude: null,
        http_x_vercel_ja4_digest: null,
      })
      .where(eq(payment_methods.user_id, userId));

    // ── 4. Nullify FK references ─────────────────────────────────────────
    await tx
      .update(user_feedback)
      .set({ kilo_user_id: null })
      .where(eq(user_feedback.kilo_user_id, userId));
    await tx
      .update(app_builder_feedback)
      .set({ kilo_user_id: null })
      .where(eq(app_builder_feedback.kilo_user_id, userId));
    await tx
      .update(free_model_usage)
      .set({ kilo_user_id: null })
      .where(eq(free_model_usage.kilo_user_id, userId));
  });
}

// We always stytch approve users who accept organization invites
// so they don't get dumped onto the stych flow after accepting and get
// free credits
export async function ensureHasValidStytch(id: User['id']) {
  await db
    .update(kilocode_users)
    .set({ has_validation_stytch: true })
    .where(eq(kilocode_users.id, id));
}

// Auth Provider Management Functions

export type UserAuthProvider = typeof user_auth_provider.$inferSelect;

export async function getUserAuthProviders(kiloUserId: string): Promise<UserAuthProvider[]> {
  return await db
    .select()
    .from(user_auth_provider)
    .where(eq(user_auth_provider.kilo_user_id, kiloUserId))
    .orderBy(user_auth_provider.created_at);
}

export async function findUserIdByAuthProvider(
  provider: AuthProviderId,
  providerAccountId: string
) {
  const result = await db.query.user_auth_provider.findFirst({
    where: and(
      eq(user_auth_provider.provider, provider),
      eq(user_auth_provider.provider_account_id, providerAccountId)
    ),
    columns: { kilo_user_id: true },
  });
  return result?.kilo_user_id ?? null;
}

/**
 * Get all auth providers for a user by email.
 * Returns all providers the user has linked, categorized by type.
 * Used for provider selection UI when user has multiple sign-in options.
 *
 * @param email - Any email linked to the user's account
 * @returns Object with user's providers and SSO info, or null if no account exists
 */
export async function getAllUserProviders(email: string): Promise<{
  kiloUserId: string;
  providers: AuthProviderId[];
  primaryEmail: string;
  workosHostedDomain?: string;
} | null> {
  const lowerEmail = email.toLowerCase().trim();

  // Get all auth providers that share the same kilo_user_id as any provider with this email.
  // This uses a correlated subquery to find the user ID and get all their providers in a single query.
  const providers = await db
    .select()
    .from(user_auth_provider)
    .where(
      eq(
        user_auth_provider.kilo_user_id,
        db
          .select({ id: user_auth_provider.kilo_user_id })
          .from(user_auth_provider)
          .where(eq(user_auth_provider.email, lowerEmail))
          .limit(1)
      )
    )
    .orderBy(user_auth_provider.created_at);

  if (providers.length === 0) {
    return null;
  }

  const kiloUserId = providers[0].kilo_user_id;
  const user = await findUserById(kiloUserId);
  if (!user) {
    return null;
  }

  const workosProvider = providers.find(p => p.provider === 'workos');

  return {
    kiloUserId,
    providers: providers.map(p => p.provider),
    primaryEmail: user.google_user_email,
    workosHostedDomain: workosProvider?.hosted_domain ?? undefined,
  };
}

/**
 * Look up WorkOS organization by domain.
 * Returns the organization if exactly one is found, or the first one if multiple exist.
 * Logs warnings for edge cases (multiple orgs, zero orgs).
 *
 * @param domain - The domain to look up
 * @returns The WorkOS organization, or null if not found
 */
export async function getWorkOSOrganization(domain: string) {
  const orgResult = await workos.organizations.listOrganizations({ domains: [domain] });

  if (orgResult.data.length === 1) {
    return orgResult.data[0];
  }

  if (orgResult.data.length > 1) {
    captureMessage(
      `Multiple WorkOS organizations found for domain, using first one: ${domain} (count: ${orgResult.data.length})`,
      'warning'
    );
    return orgResult.data[0];
  }

  return null;
}

type LinkAuthErrors = 'ACCOUNT-ALREADY-LINKED' | 'PROVIDER-ALREADY-LINKED' | 'LINKING-FAILED';
export type LinkAuthProviderResult = OptionalError<LinkAuthErrors>;

export type AuthProviderLinking = Omit<UserAuthProvider, 'created_at'>;

export async function linkAuthProviderToUser(
  authProviderData: AuthProviderLinking
): Promise<LinkAuthProviderResult> {
  const kiloUserId = authProviderData.kilo_user_id;
  // Check if this provider account is already linked to another user
  const existing_kilo_user_id = await findUserIdByAuthProvider(
    authProviderData.provider,
    authProviderData.provider_account_id
  );

  if (existing_kilo_user_id && existing_kilo_user_id !== kiloUserId) {
    return failureResult('ACCOUNT-ALREADY-LINKED');
  }

  // Check if user already has this provider linked
  const userProviders = await getUserAuthProviders(kiloUserId);
  const hasProvider = userProviders.some(p => p.provider === authProviderData.provider);

  if (hasProvider) {
    return failureResult('PROVIDER-ALREADY-LINKED');
  }

  const [newAuthProvider] = await db
    .insert(user_auth_provider)
    .values(authProviderData)
    .returning();

  if (!newAuthProvider) {
    return failureResult('LINKING-FAILED');
  }

  return successResult();
}

export async function unlinkAuthProviderFromUser(
  kiloUserId: string,
  provider: AuthProviderId
): Promise<OptionalError<TRPCError>> {
  // Safety check: ensure user has at least 2 auth providers before unlinking
  const userProviders = await getUserAuthProviders(kiloUserId);

  if (userProviders.length <= 1)
    return trpcFailure({
      code: 'BAD_REQUEST',
      message: 'Cannot unlink the last authentication method',
    });

  const providerToUnlink = userProviders.find(p => p.provider === provider);
  if (!providerToUnlink) {
    return trpcFailure({
      code: 'BAD_REQUEST',
      message: `User does not have a linked ${provider} account`,
    });
  }

  await db
    .delete(user_auth_provider)
    .where(
      and(
        eq(user_auth_provider.kilo_user_id, kiloUserId),
        eq(user_auth_provider.provider, provider)
      )
    );

  return successResult();
}
