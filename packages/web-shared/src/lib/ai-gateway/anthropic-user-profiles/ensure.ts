import 'server-only';
import { and, eq, isNull } from 'drizzle-orm';
import { kilocode_users, organizations } from '@kilocode/db/schema';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { isClaudeOperatorConfigured } from '@kilocode/web-shared/lib/ai-gateway/claude-billing/operator';
import { createAnthropicUserProfile } from '@kilocode/web-shared/lib/ai-gateway/anthropic-user-profiles/api';
import type { AnthropicUserProfileSubject } from '@kilocode/web-shared/lib/ai-gateway/anthropic-user-profiles/decision';

// Everything here reads and writes the primary: it runs after the response
// through `after()`, and a lagging replica would hide a profile another request
// just stored and create a duplicate.

// The final writes recheck the account: a soft deletion or block during the
// remote create clears or forbids the slot, and must not be undone by a late write.
async function storeUserProfile(userId: string, userProfileId: string): Promise<string | null> {
  const active = and(eq(kilocode_users.id, userId), isNull(kilocode_users.blocked_reason));
  const [stored] = await db
    .update(kilocode_users)
    .set({ anthropic_user_profile_id: userProfileId })
    .where(and(active, isNull(kilocode_users.anthropic_user_profile_id)))
    .returning({ id: kilocode_users.anthropic_user_profile_id });
  if (stored) return stored.id;
  // Another request stored its profile first, or the account is gone. The
  // profile created here is left for the cleanup, since nothing references it.
  const [winner] = await db
    .select({ id: kilocode_users.anthropic_user_profile_id })
    .from(kilocode_users)
    .where(active);
  return winner?.id ?? null;
}

async function ensureUserProfile(userId: string, country: string | null): Promise<string | null> {
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
    country,
  });
  return await storeUserProfile(userId, created);
}

/** A live organization without a parent, which owns the profile its sub-organizations share. */
function liveRootOrganization(organizationId: string) {
  return and(
    eq(organizations.id, organizationId),
    isNull(organizations.parent_organization_id),
    isNull(organizations.deleted_at)
  );
}

async function ensureRootOrganizationProfile(rootOrganizationId: string): Promise<string | null> {
  const [root] = await db
    .select({
      profileId: organizations.anthropic_user_profile_id,
      name: organizations.name,
      createdAt: organizations.created_at,
    })
    .from(organizations)
    .where(liveRootOrganization(rootOrganizationId));
  if (!root) return null;
  if (root.profileId) return root.profileId;
  const created = await createAnthropicUserProfile({
    kind: 'organization',
    organizationId: rootOrganizationId,
    name: root.name,
    createdAt: root.createdAt,
  });
  // Publishing and sharing commit together. `setParent` and sub-organization
  // creation read the parent's profile under a share lock, which this row
  // update waits for or blocks, so a sub-organization attached meanwhile either
  // copies this profile or is in the share below. The recheck that the row is
  // still a live root keeps an organization attached during the create from
  // getting a profile of its own.
  return await db.transaction(async tx => {
    const [stored] = await tx
      .update(organizations)
      .set({ anthropic_user_profile_id: created })
      .where(
        and(
          liveRootOrganization(rootOrganizationId),
          isNull(organizations.anthropic_user_profile_id)
        )
      )
      .returning({ id: organizations.anthropic_user_profile_id });
    if (stored?.id) {
      await shareAnthropicUserProfileWithSubOrganizations(rootOrganizationId, stored.id, tx);
      return stored.id;
    }
    const [winner] = await tx
      .select({ id: organizations.anthropic_user_profile_id })
      .from(organizations)
      .where(liveRootOrganization(rootOrganizationId));
    return winner?.id ?? null;
  });
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
    .where(and(eq(organizations.id, organizationId), isNull(organizations.deleted_at)));
  return current?.id ?? null;
}

/** Gives the parent's profile to its live sub-organizations that have none yet. */
async function shareAnthropicUserProfileWithSubOrganizations(
  parentOrganizationId: string,
  userProfileId: string,
  fromDb: Pick<typeof db, 'update'> = db
): Promise<void> {
  await fromDb
    .update(organizations)
    .set({ anthropic_user_profile_id: userProfileId })
    .where(
      and(
        eq(organizations.parent_organization_id, parentOrganizationId),
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
  subject: AnthropicUserProfileSubject,
  /** The request's IP country; used only for user profiles. */
  country: string | null = null
): Promise<string | null> {
  if (!isClaudeOperatorConfigured()) return null;
  const key =
    subject.kind === 'user' ? `user:${subject.userId}` : `organization:${subject.organizationId}`;
  const pending = inFlight.get(key);
  if (pending) return await pending;
  const promise = (
    subject.kind === 'user'
      ? ensureUserProfile(subject.userId, country)
      : ensureOrganizationProfile(subject.organizationId)
  ).finally(() => inFlight.delete(key));
  inFlight.set(key, promise);
  return await promise;
}
