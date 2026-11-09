import 'server-only';

import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
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
};

type GrantLookup = {
  id: string;
  actionClass: SupportAccessActionClass;
  expiresAt: string;
  grantOrganizationId: string;
  grantOrganizationName: string | null;
};

/**
 * An active grant on the target organization, or on its live direct parent,
 * admits the target. Both organizations must be live. The order prefers an
 * exact action-class match, then a grant on the organization itself over an
 * inherited one, then the longest remaining lifetime.
 */
async function findUsableGrant(params: {
  actorKiloUserId: string;
  organizationId: string;
  requiredActionClass: SupportAccessActionClass;
}): Promise<GrantLookup | null> {
  const [target] = await db
    .select({
      id: organizations.id,
      name: organizations.name,
      parentOrganizationId: organizations.parent_organization_id,
    })
    .from(organizations)
    .where(and(eq(organizations.id, params.organizationId), isNull(organizations.deleted_at)))
    .limit(1);
  if (!target) return null;

  const organizationIds = [target.id];
  const organizationNames = new Map([[target.id, target.name]]);
  if (target.parentOrganizationId) {
    const [parent] = await db
      .select({ id: organizations.id, name: organizations.name })
      .from(organizations)
      .where(
        and(eq(organizations.id, target.parentOrganizationId), isNull(organizations.deleted_at))
      )
      .limit(1);
    if (parent) {
      organizationIds.push(parent.id);
      organizationNames.set(parent.id, parent.name);
    }
  }

  const [row] = await db
    .select({
      id: support_access_grants.id,
      actionClass: support_access_grants.action_class,
      expiresAt: support_access_grants.expires_at,
      grantOrganizationId: support_access_grants.organization_id,
    })
    .from(support_access_grants)
    .innerJoin(kilocode_users, eq(kilocode_users.id, support_access_grants.actor_kilo_user_id))
    .where(
      and(
        eq(support_access_grants.actor_kilo_user_id, params.actorKiloUserId),
        eq(support_access_grants.status, 'active'),
        sql`${support_access_grants.expires_at} > now()`,
        eq(kilocode_users.is_admin, true),
        isNull(kilocode_users.blocked_reason),
        inArray(support_access_grants.organization_id, organizationIds)
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
        grantOrganizationName: organizationNames.get(row.grantOrganizationId) ?? null,
      }
    : null;
}

/**
 * Distinguishes an expired or revoked grant from "never requested" so the
 * caller can return a specific cause code, per the Failure UX rule. A grant on
 * the target's direct parent counts, so a lapsed inherited grant reports the
 * same reason as a lapsed direct one.
 */
export async function latestSupportGrantStatus(params: {
  actorKiloUserId: string;
  organizationId: string;
}): Promise<'expired' | 'revoked' | null> {
  const [target] = await db
    .select({ parentOrganizationId: organizations.parent_organization_id })
    .from(organizations)
    .where(eq(organizations.id, params.organizationId))
    .limit(1);
  const organizationIds = [params.organizationId];
  if (target?.parentOrganizationId) organizationIds.push(target.parentOrganizationId);

  const [row] = await db
    .select({ status: support_access_grants.status })
    .from(support_access_grants)
    .where(
      and(
        eq(support_access_grants.actor_kilo_user_id, params.actorKiloUserId),
        inArray(support_access_grants.organization_id, organizationIds),
        inArray(support_access_grants.status, ['expired', 'revoked'])
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
    return { access: null, decision: 'deny_not_allowlisted', grantId: null };
  }
  if (isSupportNeverKey(params.key)) {
    return { access: null, decision: 'deny_never_list', grantId: null };
  }
  const grant = await findUsableGrant({
    actorKiloUserId: params.actorKiloUserId,
    organizationId: params.organizationId,
    requiredActionClass: params.requiredActionClass,
  });
  if (!grant) {
    return { access: null, decision: 'deny_no_grant', grantId: null };
  }

  const entry = findSupportAllowEntry({
    surface: params.surface,
    key: params.key,
    actionClass: params.requiredActionClass,
  });
  if (!entry) {
    return { access: null, decision: 'deny_not_allowlisted', grantId: grant.id };
  }
  const grantSatisfies =
    params.requiredActionClass === 'support_read' || grant.actionClass === 'support_write';
  if (!grantSatisfies) {
    return { access: null, decision: 'deny_action_class', grantId: grant.id };
  }
  if (!supportEntrySatisfiesRoles(entry, params.roles)) {
    return { access: null, decision: 'deny_action_class', grantId: grant.id };
  }

  const inventory = findPrivilegedInventoryEntry({
    surface: params.surface,
    route: params.key,
    access: params.requiredActionClass === 'support_write' ? 'write' : 'read',
  });

  const inheritedFromOrganizationId =
    grant.grantOrganizationId === params.organizationId ? null : grant.grantOrganizationId;
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
 * Usage evidence for an admitted write. Best-effort: an evidence insert must
 * never turn an otherwise authorized write into a failure.
 */
export async function recordSupportWriteUse(params: {
  grantId: string;
  actorKiloUserId: string;
  organizationId: string;
  supportActionId: string;
  inheritedFromOrganizationId?: string | null;
}): Promise<void> {
  try {
    await db.insert(support_access_grant_events).values({
      grant_id: params.grantId,
      event_type: 'used_write',
      performed_by_kilo_user_id: params.actorKiloUserId,
      organization_id: params.organizationId,
      action_class: 'support_write',
      metadata: {
        supportActionId: params.supportActionId,
        ...(params.inheritedFromOrganizationId
          ? { inheritedFromOrganizationId: params.inheritedFromOrganizationId }
          : {}),
      },
    });
  } catch {
    warnWriteEvidenceFailure('Support write evidence could not be recorded; continuing');
  }
}
