import 'server-only';

import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import {
  kilocode_users,
  organizations,
  support_access_grants,
  type SupportAccessActionClass,
} from '@kilocode/db/schema';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { findPrivilegedInventoryEntry } from '@kilocode/web-shared/lib/admin/privileged-inventory';
import {
  findSupportAllowEntry,
  getSupportAccessMode,
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
};

async function findUsableGrant(params: {
  actorKiloUserId: string;
  organizationId: string;
}): Promise<GrantLookup | null> {
  const [row] = await db
    .select({
      id: support_access_grants.id,
      actionClass: support_access_grants.action_class,
      expiresAt: support_access_grants.expires_at,
    })
    .from(support_access_grants)
    .innerJoin(kilocode_users, eq(kilocode_users.id, support_access_grants.actor_kilo_user_id))
    .innerJoin(organizations, eq(organizations.id, support_access_grants.organization_id))
    .where(
      and(
        eq(support_access_grants.actor_kilo_user_id, params.actorKiloUserId),
        eq(support_access_grants.organization_id, params.organizationId),
        eq(support_access_grants.status, 'active'),
        sql`${support_access_grants.expires_at} > now()`,
        eq(kilocode_users.is_admin, true),
        eq(kilocode_users.can_request_support_org_access, true),
        isNull(kilocode_users.blocked_reason),
        isNull(organizations.deleted_at)
      )
    )
    .orderBy(desc(support_access_grants.expires_at))
    .limit(1);

  return row && row.expiresAt !== null
    ? { id: row.id, actionClass: row.actionClass, expiresAt: row.expiresAt }
    : null;
}

/**
 * Distinguishes an expired or revoked grant from "never requested" so the
 * caller can return a specific cause code, per the Failure UX rule.
 */
export async function latestSupportGrantStatus(params: {
  actorKiloUserId: string;
  organizationId: string;
}): Promise<'expired' | 'revoked' | null> {
  const [row] = await db
    .select({ status: support_access_grants.status })
    .from(support_access_grants)
    .where(
      and(
        eq(support_access_grants.actor_kilo_user_id, params.actorKiloUserId),
        eq(support_access_grants.organization_id, params.organizationId),
        inArray(support_access_grants.status, ['expired', 'revoked'])
      )
    )
    .orderBy(desc(support_access_grants.requested_at))
    .limit(1);
  return row?.status === 'expired' || row?.status === 'revoked' ? row.status : null;
}

/**
 * Evaluates whether an active support grant authorizes one exact surface.
 *
 * `mode` gates whether the grant is honored: only `enforce` returns a
 * `SupportContext`. `observe` still measures the decision so telemetry can show
 * what the cutover would do.
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
  const mode = getSupportAccessMode();
  if (params.key === null) {
    return { access: null, decision: 'deny_not_allowlisted', grantId: null };
  }
  if (isSupportNeverKey(params.key)) {
    return { access: null, decision: 'deny_never_list', grantId: null };
  }
  if (mode === 'off') {
    return { access: null, decision: 'deny_no_grant', grantId: null };
  }

  const grant = await findUsableGrant({
    actorKiloUserId: params.actorKiloUserId,
    organizationId: params.organizationId,
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

  return {
    access: {
      kind: 'support',
      grantId: grant.id,
      organizationId: params.organizationId,
      actionClass: params.requiredActionClass,
      expiresAt: grant.expiresAt,
      supportActionId: params.supportActionId ?? params.key,
      inventoryId: inventory?.id ?? null,
    },
    decision: 'support_grant',
    grantId: grant.id,
  };
}

export async function isLiveOrganization(organizationId: string): Promise<boolean> {
  const [organization] = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(and(eq(organizations.id, organizationId), isNull(organizations.deleted_at)))
    .limit(1);
  return organization !== undefined;
}
