import 'server-only';

import { and, desc, eq, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';
import { alias, type AnyPgColumn } from 'drizzle-orm/pg-core';
import {
  kilocode_users,
  organizations,
  support_access_grant_events,
  support_access_grants,
  type SupportAccessActionClass,
} from '@kilocode/db/schema';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { sentryLogger } from '@kilocode/web-shared/lib/utils.server';

const warnWriteEvidenceFailure = sentryLogger('support_access_write_evidence', 'warning');
import { findPrivilegedInventoryEntry } from '@kilocode/web-shared/lib/admin/privileged-inventory';
import {
  findSupportAllowEntry,
  isSupportNeverKey,
  supportEntrySatisfiesRoles,
  type SupportContext,
  type SupportDecision,
  type SupportSurface,
} from '@kilocode/web-shared/lib/admin/support-access';

export type SupportResolution = {
  access: SupportContext | null;
  decision: SupportDecision;
  grantId: string | null;
  inheritedFromOrganizationId: string | null;
};

type GrantLookup = {
  id: string;
  actionClass: SupportAccessActionClass;
  expiresAt: string;
  grantOrganizationId: string;
  grantOrganizationName: string | null;
};

const targetOrganization = alias(organizations, 'target_organization');
const grantOrganization = alias(organizations, 'grant_organization');
const parentOrganization = alias(organizations, 'parent_organization');
/** The organization with this id is present and not soft-deleted. */
function liveTarget(organizationId: string): SQL | undefined {
  return and(eq(targetOrganization.id, organizationId), isNull(targetOrganization.deleted_at));
}

/** The target's still-linked direct parent is present and not soft-deleted. */
function liveParentOfTarget(): SQL | undefined {
  return and(
    eq(parentOrganization.id, targetOrganization.parent_organization_id),
    isNull(parentOrganization.deleted_at)
  );
}

/** A grant column names the target organization or its live direct parent. */
function grantOnTargetOrLiveParent(
  organizationColumn: AnyPgColumn,
  targetOrganizationId: string
): SQL | undefined {
  return or(
    eq(organizationColumn, targetOrganizationId),
    eq(organizationColumn, parentOrganization.id)
  );
}

/**
 * An active grant on the target organization, or on its live direct parent,
 * admits the target. Target liveness, the parent link, parent liveness, and
 * the grant are all read in one statement, so a detach or a soft delete that
 * lands between checks cannot admit a child. The order prefers an exact
 * action-class match, then a grant on the organization itself over an
 * inherited one, then the longest remaining lifetime. The actor must also be an
 * available admin account: both block columns are read, as `isBlockedAccount`
 * does.
 */
async function findUsableGrant(params: {
  actorKiloUserId: string;
  organizationId: string;
  requiredActionClass: SupportAccessActionClass;
}): Promise<GrantLookup | null> {
  const [row] = await db
    .select({
      id: support_access_grants.id,
      actionClass: support_access_grants.action_class,
      expiresAt: support_access_grants.expires_at,
      grantOrganizationId: support_access_grants.organization_id,
      grantOrganizationName: grantOrganization.name,
    })
    .from(support_access_grants)
    .innerJoin(kilocode_users, eq(kilocode_users.id, support_access_grants.actor_kilo_user_id))
    .innerJoin(targetOrganization, liveTarget(params.organizationId))
    .innerJoin(
      grantOrganization,
      and(
        eq(grantOrganization.id, support_access_grants.organization_id),
        isNull(grantOrganization.deleted_at)
      )
    )
    .leftJoin(parentOrganization, liveParentOfTarget())
    .where(
      and(
        eq(support_access_grants.actor_kilo_user_id, params.actorKiloUserId),
        eq(support_access_grants.status, 'active'),
        sql`${support_access_grants.expires_at} > now()`,
        eq(kilocode_users.is_admin, true),
        isNull(kilocode_users.blocked_at),
        isNull(kilocode_users.blocked_reason),
        grantOnTargetOrLiveParent(grantOrganization.id, params.organizationId)
      )
    )
    .orderBy(
      sql`${support_access_grants.action_class} = ${params.requiredActionClass} DESC`,
      sql`(${support_access_grants.organization_id} = ${params.organizationId}) DESC`,
      desc(support_access_grants.expires_at)
    )
    .limit(1);

  return row && row.expiresAt !== null
    ? {
        id: row.id,
        actionClass: row.actionClass,
        expiresAt: row.expiresAt,
        grantOrganizationId: row.grantOrganizationId,
        grantOrganizationName: row.grantOrganizationName,
      }
    : null;
}

/**
 * Distinguishes an expired or revoked grant from "never requested" so the
 * caller can return a specific cause code, per the Failure UX rule. The grant
 * read mirrors {@link findUsableGrant}'s placement rule: the target's own
 * lapsed grant reports even when the target is deleted, while only a still
 * linked, live direct parent's lapsed grant does — a lapsed inherited grant
 * reports the same reason as a lapsed direct one, and a deleted parent's does
 * not report at all.
 */
export async function latestSupportGrantStatus(params: {
  actorKiloUserId: string;
  organizationId: string;
}): Promise<'expired' | 'revoked' | null> {
  const [row] = await db
    .select({ status: support_access_grants.status })
    .from(support_access_grants)
    .leftJoin(targetOrganization, liveTarget(params.organizationId))
    .leftJoin(parentOrganization, liveParentOfTarget())
    .where(
      and(
        eq(support_access_grants.actor_kilo_user_id, params.actorKiloUserId),
        inArray(support_access_grants.status, ['expired', 'revoked']),
        grantOnTargetOrLiveParent(support_access_grants.organization_id, params.organizationId)
      )
    )
    .orderBy(desc(support_access_grants.requested_at))
    .limit(1);
  return row?.status === 'expired' || row?.status === 'revoked' ? row.status : null;
}

/**
 * Evaluates whether an active support grant authorizes one exact surface.
 * Callers only invoke this while `SUPPORT_ACCESS_ENABLED` is on.
 */
export async function evaluateSupportAccess(params: {
  actorKiloUserId: string;
  organizationId: string;
  requiredActionClass: SupportAccessActionClass;
  roles: readonly string[] | undefined;
  surface: SupportSurface;
  key: string | null;
  supportActionId: string | null;
}): Promise<SupportResolution> {
  if (params.key === null) {
    return {
      access: null,
      decision: 'deny_not_allowlisted',
      grantId: null,
      inheritedFromOrganizationId: null,
    };
  }
  if (isSupportNeverKey(params.key)) {
    return {
      access: null,
      decision: 'deny_never_list',
      grantId: null,
      inheritedFromOrganizationId: null,
    };
  }
  const grant = await findUsableGrant({
    actorKiloUserId: params.actorKiloUserId,
    organizationId: params.organizationId,
    requiredActionClass: params.requiredActionClass,
  });
  if (!grant) {
    return {
      access: null,
      decision: 'deny_no_grant',
      grantId: null,
      inheritedFromOrganizationId: null,
    };
  }

  const inheritedFromOrganizationId =
    grant.grantOrganizationId === params.organizationId ? null : grant.grantOrganizationId;
  const entry = findSupportAllowEntry({
    surface: params.surface,
    key: params.key,
    actionClass: params.requiredActionClass,
  });
  if (!entry) {
    return {
      access: null,
      decision: 'deny_not_allowlisted',
      grantId: grant.id,
      inheritedFromOrganizationId,
    };
  }
  const grantSatisfies =
    params.requiredActionClass === 'support_read' || grant.actionClass === 'support_write';
  if (!grantSatisfies) {
    return {
      access: null,
      decision: 'deny_action_class',
      grantId: grant.id,
      inheritedFromOrganizationId,
    };
  }
  if (!supportEntrySatisfiesRoles(entry, params.roles)) {
    return {
      access: null,
      // The grant exists and its class fits; the allowlisted entry's stand-in
      // role is simply more than the grant's actor may stand in for.
      decision: 'deny_actor_permission',
      grantId: grant.id,
      inheritedFromOrganizationId,
    };
  }

  const inventory = findPrivilegedInventoryEntry({
    surface: params.surface,
    route: params.key,
    access: params.requiredActionClass === 'support_write' ? 'write' : 'read',
  });

  return {
    access: {
      kind: 'support',
      grantId: grant.id,
      organizationId: params.organizationId,
      actionClass: params.requiredActionClass,
      expiresAt: grant.expiresAt,
      supportActionId: params.supportActionId ?? params.key,
      inventoryId: inventory?.id ?? null,
      inheritedFromOrganizationId,
      inheritedFromOrganizationName:
        inheritedFromOrganizationId === null ? null : grant.grantOrganizationName,
    },
    decision: 'support_grant',
    grantId: grant.id,
    inheritedFromOrganizationId,
  };
}

export async function isLiveOrganization(organizationId: string): Promise<boolean> {
  const state = await organizationState(organizationId);
  return state === 'live';
}

export async function organizationState(
  organizationId: string
): Promise<'missing' | 'deleted' | 'live'> {
  const [organization] = await db
    .select({ deletedAt: organizations.deleted_at })
    .from(organizations)
    .where(eq(organizations.id, organizationId))
    .limit(1);
  if (!organization) return 'missing';
  return organization.deletedAt === null ? 'live' : 'deleted';
}

/**
 * Usage evidence for an admitted write. The event's `organization_id` names
 * the organization the grant belongs to (the live parent for an inherited
 * grant), matching the grant it references; `targetOrganizationId` records the
 * child organization that was actually written. Best-effort: an evidence
 * insert must never turn an otherwise authorized write into a failure.
 */
export async function recordSupportWriteUse(params: {
  grantId: string;
  actorKiloUserId: string;
  grantOrganizationId: string;
  targetOrganizationId: string;
  supportActionId: string;
}): Promise<void> {
  try {
    await db.insert(support_access_grant_events).values({
      grant_id: params.grantId,
      event_type: 'used_write',
      performed_by_kilo_user_id: params.actorKiloUserId,
      organization_id: params.grantOrganizationId,
      action_class: 'support_write',
      metadata: {
        supportActionId: params.supportActionId,
        targetOrganizationId: params.targetOrganizationId,
      },
    });
  } catch {
    warnWriteEvidenceFailure('Support write evidence could not be recorded; continuing');
  }
}
