import 'server-only';
import { APP_URL } from '@kilocode/web-shared/lib/constants';
import { db } from '@kilocode/web-shared/lib/drizzle';
import {
  kilocode_users,
  organization_memberships,
  organizations,
  user_auth_provider,
} from '@kilocode/db/schema';
import type { OrganizationRole } from '@kilocode/db/schema-types';
import { and, eq, inArray } from 'drizzle-orm';
import type { Owner } from '@/lib/integrations/core/types';

/**
 * Organization roles whose members may start a Cloud Agent session from a
 * Discord guild. Billing managers are excluded: the role carries no code access.
 */
const SESSION_ORGANIZATION_ROLES: OrganizationRole[] = ['owner', 'admin', 'member'];

/**
 * Roles inherited from a parent organization, mirroring the organization
 * access rules used elsewhere. `member` is not inherited because
 * ORGANIZATION_PARENT_ACCESS_ROLES does not include it.
 */
const SESSION_PARENT_ORGANIZATION_ROLES: OrganizationRole[] = ['owner', 'admin'];

export type DiscordSessionDenialReason =
  | 'unknown_requester'
  | 'unlinked_account'
  | 'account_unavailable'
  | 'not_installation_owner'
  | 'not_organization_member';

export type DiscordSessionAuthorization =
  | { authorized: true; discordUserId: string; kiloUserId: string }
  | { authorized: false; reason: DiscordSessionDenialReason; discordUserId?: string };

export const DISCORD_SESSION_UNAVAILABLE_MESSAGE = `Starting a Cloud Agent session from Discord needs a linked Kilo account with access to this workspace. Connect your Discord account at ${APP_URL}/connected-accounts and mention the bot again.`;

/**
 * Instructions appended to the bot system prompt when the author may not start
 * sessions, so a text answer explains the requirement instead of claiming work
 * started.
 */
export const DISCORD_SESSION_UNAVAILABLE_PROMPT_NOTICE = `

## Session starts are unavailable to this Discord account
This Discord account is not linked to a Kilo account with access to this workspace, so you cannot start Cloud Agent sessions and no tools are available.
- If the request needs code changes, repository inspection, or a Cloud Agent session, reply that starting a session from Discord needs a linked Kilo account with access to this workspace and ask the user to connect Discord at ${APP_URL}/connected-accounts, then mention the bot again.
- Never claim a session started, code changed, or a pull request was opened.`;

/**
 * Decide whether a Discord author may start an owner-credentialed Cloud Agent
 * session for this installation.
 *
 * The author must be linked to a Kilo account, and that account must be the
 * installation owner for user-owned installations or an active member of the
 * owning organization for organization-owned installations.
 */
export async function authorizeDiscordSessionRequester(
  owner: Owner,
  discordUserId: string | undefined
): Promise<DiscordSessionAuthorization> {
  if (!discordUserId) {
    return { authorized: false, reason: 'unknown_requester' };
  }

  const [provider] = await db
    .select({ kiloUserId: user_auth_provider.kilo_user_id })
    .from(user_auth_provider)
    .where(
      and(
        eq(user_auth_provider.provider, 'discord'),
        eq(user_auth_provider.provider_account_id, discordUserId)
      )
    )
    .limit(1);

  if (!provider) {
    return { authorized: false, reason: 'unlinked_account', discordUserId };
  }

  const kiloUserId = provider.kiloUserId;

  const [user] = await db
    .select({
      blockedAt: kilocode_users.blocked_at,
      personalAccountDisabled: kilocode_users.personal_account_disabled,
    })
    .from(kilocode_users)
    .where(eq(kilocode_users.id, kiloUserId))
    .limit(1);

  if (!user) {
    return { authorized: false, reason: 'unlinked_account', discordUserId };
  }

  if (user.blockedAt || user.personalAccountDisabled) {
    return { authorized: false, reason: 'account_unavailable', discordUserId };
  }

  if (owner.type === 'user') {
    return kiloUserId === owner.id
      ? { authorized: true, discordUserId, kiloUserId }
      : { authorized: false, reason: 'not_installation_owner', discordUserId };
  }

  const isMember = await isOrganizationSessionMember(owner.id, kiloUserId);
  return isMember
    ? { authorized: true, discordUserId, kiloUserId }
    : { authorized: false, reason: 'not_organization_member', discordUserId };
}

async function isOrganizationSessionMember(
  organizationId: string,
  kiloUserId: string
): Promise<boolean> {
  const [organization] = await db
    .select({
      parentOrganizationId: organizations.parent_organization_id,
      deletedAt: organizations.deleted_at,
    })
    .from(organizations)
    .where(eq(organizations.id, organizationId))
    .limit(1);

  if (!organization || organization.deletedAt) {
    return false;
  }

  const [membership] = await db
    .select({ role: organization_memberships.role })
    .from(organization_memberships)
    .where(
      and(
        eq(organization_memberships.organization_id, organizationId),
        eq(organization_memberships.kilo_user_id, kiloUserId),
        inArray(organization_memberships.role, SESSION_ORGANIZATION_ROLES)
      )
    )
    .limit(1);

  if (membership) {
    return true;
  }

  const parentOrganizationId = organization.parentOrganizationId;
  if (!parentOrganizationId) {
    return false;
  }

  const [inheritedMembership] = await db
    .select({ role: organization_memberships.role })
    .from(organization_memberships)
    .where(
      and(
        eq(organization_memberships.organization_id, parentOrganizationId),
        eq(organization_memberships.kilo_user_id, kiloUserId),
        inArray(organization_memberships.role, SESSION_PARENT_ORGANIZATION_ROLES)
      )
    )
    .limit(1);

  return inheritedMembership !== undefined;
}
