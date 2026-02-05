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
  credit_transactions,
  microdollar_usage,
  payment_methods,
  kilocode_users,
  stytch_fingerprints,
  user_admin_notes,
  user_auth_provider,
  sharedCliSessions,
  cliSessions,
  app_builder_projects,
} from '@/db/schema';
import { eq, and, inArray } from 'drizzle-orm';
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

export async function deleteUserDatabaseRecords(userId: string) {
  await db.transaction(async tx => {
    await tx.delete(microdollar_usage).where(eq(microdollar_usage.kilo_user_id, userId));
    await tx.delete(payment_methods).where(eq(payment_methods.user_id, userId));
    await tx.delete(credit_transactions).where(eq(credit_transactions.kilo_user_id, userId));
    await tx.delete(stytch_fingerprints).where(eq(stytch_fingerprints.kilo_user_id, userId));
    await tx.delete(user_admin_notes).where(eq(user_admin_notes.kilo_user_id, userId));
    await tx.delete(user_auth_provider).where(eq(user_auth_provider.kilo_user_id, userId));
    await tx.delete(sharedCliSessions).where(eq(sharedCliSessions.kilo_user_id, userId));
    await tx.delete(cliSessions).where(eq(cliSessions.kilo_user_id, userId));
    await tx.delete(app_builder_projects).where(eq(app_builder_projects.owned_by_user_id, userId));
    await tx.delete(kilocode_users).where(eq(kilocode_users.id, userId));
    //TODO: OrbEvent deletion - not implementable yet?
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
