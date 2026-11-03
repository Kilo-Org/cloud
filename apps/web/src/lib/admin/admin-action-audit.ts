import 'server-only';
import { captureException } from '@sentry/nextjs';
import {
  admin_action_audit_logs,
  organization_memberships,
  organizations,
  type User,
} from '@kilocode/db/schema';
import { ORGANIZATION_PARENT_ACCESS_ROLES } from '@kilocode/app-shared/organizations';
import { and, eq, inArray } from 'drizzle-orm';
import type { AdminActionAuditAction, AdminActionAuditTargetType } from '@kilocode/db/schema-types';
import {
  authViaTokenFromHeaders,
  clientIpFromHeaders,
  type AdminAuditContext,
} from '@kilocode/web-shared/lib/admin/admin-access-log';
import type { OrganizationRole } from '@kilocode/web-shared/lib/organizations/organization-types';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { logExceptInTest } from '@kilocode/web-shared/lib/utils.server';

/**
 * Durable, identity-attributed record of a platform admin action.
 *
 * Every entry is written to `admin_action_audit_logs` and emitted as an
 * `event:"admin_action"` structured log line (Axiom `vercel` dataset). The
 * table is browsable in the admin console and pruned after the retention
 * window; the log line carries request metadata (IP, auth source) that the
 * table deliberately does not store.
 *
 * Record only after the action has succeeded. A failed audit write is reported
 * and flagged with `persisted:false` in the log line, but never thrown: the
 * action has already happened, and failing the request would invite a retry of
 * a non-idempotent operation.
 *
 * `message` and `metadata` are stored and logged verbatim. Never include
 * tokens, credentials, or customer email addresses; reference users and
 * organizations by ID through `target`.
 */

export type AdminActionContext = Omit<AdminAuditContext, 'user'> & {
  user: Pick<User, 'id' | 'google_user_email' | 'google_user_name' | 'is_super_admin'>;
};

export type AdminActionTarget = {
  type: AdminActionAuditTargetType;
  id: string;
};

export type AdminActionEntry = {
  action: AdminActionAuditAction;
  target: AdminActionTarget | null;
  message: string;
  metadata?: Record<string, unknown>;
};

export type AdminActionEvent = {
  event: 'admin_action';
  action: AdminActionAuditAction;
  auditLogId: string | null;
  persisted: boolean;
  kiloUserId: string;
  email: string;
  adminTier: 'super_admin' | 'platform_admin';
  authVia: 'token' | 'session';
  tokenSource: string | null;
  route: string | null;
  ip: string | null;
  targetType: AdminActionAuditTargetType | null;
  targetId: string | null;
  message: string;
  metadata: Record<string, unknown> | null;
};

// Stays well under PostgreSQL's 65,535 bind-parameter limit for bulk actions.
const INSERT_CHUNK_SIZE = 1_000;

export type AdminActionSink = (event: AdminActionEvent) => void;

const defaultSink: AdminActionSink = event => logExceptInTest(JSON.stringify(event));

let currentSink: AdminActionSink = defaultSink;

/** Test-only seam; pass `null` to restore the production sink. */
export function setAdminActionSinkForTest(sink: AdminActionSink | null): void {
  currentSink = sink ?? defaultSink;
}

export async function recordAdminAction(
  ctx: AdminActionContext,
  entry: AdminActionEntry
): Promise<void> {
  await recordAdminActions(ctx, [entry]);
}

/** Records several entries, e.g. one row per user in a bulk action. */
export async function recordAdminActions(
  ctx: AdminActionContext,
  entries: readonly AdminActionEntry[]
): Promise<void> {
  if (entries.length === 0) return;

  const insertedIds: string[] = [];
  try {
    for (let start = 0; start < entries.length; start += INSERT_CHUNK_SIZE) {
      const rows = await db
        .insert(admin_action_audit_logs)
        .values(
          entries.slice(start, start + INSERT_CHUNK_SIZE).map(entry => ({
            action: entry.action,
            actor_id: ctx.user.id,
            actor_email: ctx.user.google_user_email,
            actor_name: ctx.user.google_user_name,
            target_type: entry.target?.type ?? null,
            target_id: entry.target?.id ?? null,
            message: entry.message,
            metadata: entry.metadata ?? null,
          }))
        )
        .returning({ id: admin_action_audit_logs.id });
      insertedIds.push(...rows.map(row => row.id));
    }
  } catch (error) {
    captureException(error, {
      tags: { operation: 'admin_action_audit_insert' },
      extra: { actions: entries.map(entry => entry.action) },
    });
  }

  entries.forEach((entry, index) => {
    emit({
      event: 'admin_action',
      action: entry.action,
      auditLogId: insertedIds[index] ?? null,
      persisted: index < insertedIds.length,
      kiloUserId: ctx.user.id,
      email: ctx.user.google_user_email,
      adminTier: ctx.user.is_super_admin ? 'super_admin' : 'platform_admin',
      authVia: ctx.authViaToken ? 'token' : 'session',
      tokenSource: ctx.tokenSource ?? null,
      route: ctx.trpcPath ?? null,
      ip: ctx.ip ?? null,
      targetType: entry.target?.type ?? null,
      targetId: entry.target?.id ?? null,
      message: entry.message,
      metadata: entry.metadata ?? null,
    });
  });
}

function emit(event: AdminActionEvent): void {
  try {
    currentSink(event);
  } catch (error) {
    captureException(error, { tags: { operation: 'admin_action_log' } });
  }
}

export function userActionTarget(userId: string): AdminActionTarget {
  return { type: 'user', id: userId };
}

export function organizationActionTarget(organizationId: string): AdminActionTarget {
  return { type: 'organization', id: organizationId };
}

/**
 * Records an organization write made through the `is_admin` escape hatch, i.e.
 * by a Kilo admin whose own membership in the organization would not have
 * allowed it. Admins acting within a role they actually hold are ordinary
 * members and are not recorded.
 *
 * `requiredRoles` and `membershipScope` must mirror the guard the admin
 * bypassed: some guards accept roles inherited from a parent organization,
 * others only a direct membership. Pass `heldRoles` when the action itself
 * changes the actor's membership (e.g. self-removal) and the roles were read
 * beforehand.
 *
 * Reads stay as `kilo_admin_elevation` log lines; call this only from
 * mutations, after they succeed. Like {@link recordAdminAction} it never
 * throws: if the membership lookup fails, the action is recorded with
 * `heldRoles: null` rather than failing a request that already took effect.
 */
export async function recordElevatedOrganizationAdminAction(
  ctx: AdminActionContext & { user: { is_admin: boolean } },
  params: {
    organizationId: string;
    requiredRoles: readonly OrganizationRole[];
    membershipScope?: OrganizationMembershipScope;
    heldRoles?: OrganizationRole[];
    action: AdminActionAuditAction;
    message: string;
    metadata?: Record<string, unknown>;
  }
): Promise<void> {
  if (!ctx.user.is_admin) return;

  let heldRoles: OrganizationRole[] | null = params.heldRoles ?? null;
  if (heldRoles === null) {
    try {
      heldRoles = await getOrganizationMembershipRoles(
        ctx.user.id,
        params.organizationId,
        params.membershipScope ?? 'direct_or_inherited'
      );
    } catch (error) {
      captureException(error, { tags: { operation: 'admin_action_membership_lookup' } });
    }
  }
  if (heldRoles?.some(role => params.requiredRoles.includes(role))) return;

  await recordAdminAction(ctx, {
    action: params.action,
    target: organizationActionTarget(params.organizationId),
    message: params.message,
    metadata: { ...params.metadata, heldRoles },
  });
}

export type OrganizationMembershipScope = 'direct' | 'direct_or_inherited';

/**
 * The caller's real roles in an organization: direct memberships, plus roles
 * inherited from a parent organization when `scope` allows, mirroring
 * ensureOrganizationAccess for non-admins.
 */
export async function getOrganizationMembershipRoles(
  userId: string,
  organizationId: string,
  scope: OrganizationMembershipScope
): Promise<OrganizationRole[]> {
  const direct = await db
    .select({ role: organization_memberships.role })
    .from(organization_memberships)
    .where(
      and(
        eq(organization_memberships.kilo_user_id, userId),
        eq(organization_memberships.organization_id, organizationId)
      )
    );
  const inherited =
    scope === 'direct'
      ? []
      : await db
          .select({ role: organization_memberships.role })
          .from(organizations)
          .innerJoin(
            organization_memberships,
            and(
              eq(organization_memberships.organization_id, organizations.parent_organization_id),
              eq(organization_memberships.kilo_user_id, userId),
              inArray(organization_memberships.role, ORGANIZATION_PARENT_ACCESS_ROLES)
            )
          )
          .where(eq(organizations.id, organizationId));
  return [...new Set([...direct, ...inherited].map(row => row.role))];
}

/** Audit context for REST route handlers, which have request headers instead of a tRPC context. */
export function adminActionContextFromHeaders(
  user: AdminActionContext['user'] & { is_admin: boolean },
  headersList: Headers
): AdminActionContext & { user: { is_admin: boolean } } {
  return {
    user,
    authViaToken: authViaTokenFromHeaders(headersList),
    tokenSource: null,
    ip: clientIpFromHeaders(headersList),
  };
}
