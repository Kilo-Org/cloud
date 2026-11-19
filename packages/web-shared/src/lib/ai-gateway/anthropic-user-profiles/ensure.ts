import 'server-only';
import { and, eq, isNull, or } from 'drizzle-orm';
import { kilocode_users, organizations } from '@kilocode/db/schema';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { isClaudeOperatorConfigured } from '@kilocode/web-shared/lib/ai-gateway/claude-billing/operator';
import { createAnthropicUserProfile } from '@kilocode/web-shared/lib/ai-gateway/anthropic-user-profiles/api';
import type { AnthropicUserProfileSubject } from '@kilocode/web-shared/lib/ai-gateway/anthropic-user-profiles/decision';

// Everything here reads and writes the primary: it runs after the response
// through `after()`, and a lagging replica would hide a profile another request
// just stored and create a duplicate.

async function storeUserProfile(userId: string, userProfileId: string): Promise<string | null> {
  const [stored] = await db
    .update(kilocode_users)
    .set({ anthropic_user_profile_id: userProfileId })
    .where(and(eq(kilocode_users.id, userId), isNull(kilocode_users.anthropic_user_profile_id)))
    .returning({ id: kilocode_users.anthropic_user_profile_id });
  if (stored) return stored.id;
  // Another request stored its profile first. Use that one; the cleanup deletes
  // the profile created here once nothing references it.
  const [winner] = await db
    .select({ id: kilocode_users.anthropic_user_profile_id })
    .from(kilocode_users)
    .where(eq(kilocode_users.id, userId));
  return winner?.id ?? null;
}

async function ensureUserProfile(userId: string): Promise<string | null> {
  const [user] = await db
    .select({
      profileId: kilocode_users.anthropic_user_profile_id,
      email: kilocode_users.google_user_email,
      normalizedEmail: kilocode_users.normalized_email,
      createdAt: kilocode_users.created_at,
      blockedReason: kilocode_users.blocked_reason,
    })
    .from(kilocode_users)
    .where(eq(kilocode_users.id, userId));
  if (!user || user.blockedReason !== null) return null;
  if (user.profileId) return user.profileId;
  const created = await createAnthropicUserProfile({
    kind: 'user',
    userId,
    email: user.normalizedEmail ?? user.email,
    createdAt: user.createdAt,
  });
  return await storeUserProfile(userId, created);
}

async function ensureRootOrganizationProfile(rootOrganizationId: string): Promise<string | null> {
  const [root] = await db
    .select({
      profileId: organizations.anthropic_user_profile_id,
      name: organizations.name,
      createdAt: organizations.created_at,
      deletedAt: organizations.deleted_at,
    })
    .from(organizations)
    .where(eq(organizations.id, rootOrganizationId));
  if (!root || root.deletedAt !== null) return null;
  if (root.profileId) return root.profileId;
  const created = await createAnthropicUserProfile({
    kind: 'organization',
    organizationId: rootOrganizationId,
    name: root.name,
    createdAt: root.createdAt,
  });
  const [stored] = await db
    .update(organizations)
    .set({ anthropic_user_profile_id: created })
    .where(
      and(eq(organizations.id, rootOrganizationId), isNull(organizations.anthropic_user_profile_id))
    )
    .returning({ id: organizations.anthropic_user_profile_id });
  if (stored) return stored.id;
  const [winner] = await db
    .select({ id: organizations.anthropic_user_profile_id })
    .from(organizations)
    .where(eq(organizations.id, rootOrganizationId));
  return winner?.id ?? null;
}

async function ensureOrganizationProfile(organizationId: string): Promise<string | null> {
  const [organization] = await db
    .select({
      profileId: organizations.anthropic_user_profile_id,
      parentOrganizationId: organizations.parent_organization_id,
      deletedAt: organizations.deleted_at,
    })
    .from(organizations)
    .where(eq(organizations.id, organizationId));
  if (!organization || organization.deletedAt !== null) return null;
  if (organization.profileId) return organization.profileId;

  const rootOrganizationId = organization.parentOrganizationId ?? organizationId;
  const rootProfileId = await ensureRootOrganizationProfile(rootOrganizationId);
  if (!rootProfileId) return null;
  await shareAnthropicUserProfileWithSubOrganizations(rootOrganizationId, rootProfileId);
  const [current] = await db
    .select({ id: organizations.anthropic_user_profile_id })
    .from(organizations)
    .where(eq(organizations.id, organizationId));
  return current?.id ?? null;
}

/** Gives the parent's profile to its live sub-organizations that have none yet. */
export async function shareAnthropicUserProfileWithSubOrganizations(
  parentOrganizationId: string,
  userProfileId: string,
  fromDb: Pick<typeof db, 'update'> = db
): Promise<void> {
  await fromDb
    .update(organizations)
    .set({ anthropic_user_profile_id: userProfileId })
    .where(
      and(
        or(
          eq(organizations.id, parentOrganizationId),
          eq(organizations.parent_organization_id, parentOrganizationId)
        ),
        isNull(organizations.anthropic_user_profile_id),
        isNull(organizations.deleted_at)
      )
    );
}

const inFlight = new Map<string, Promise<string | null>>();

/**
 * Returns the subject's profile, creating and storing one when it has none. A
 * concurrent creation elsewhere can win the store; the stored profile is
 * returned either way and the losing one is left for the cleanup.
 */
export async function ensureAnthropicUserProfile(
  subject: AnthropicUserProfileSubject
): Promise<string | null> {
  if (!isClaudeOperatorConfigured()) return null;
  const key =
    subject.kind === 'user' ? `user:${subject.userId}` : `organization:${subject.organizationId}`;
  const pending = inFlight.get(key);
  if (pending) return await pending;
  const promise = (
    subject.kind === 'user'
      ? ensureUserProfile(subject.userId)
      : ensureOrganizationProfile(subject.organizationId)
  ).finally(() => inFlight.delete(key));
  inFlight.set(key, promise);
  return await promise;
}
