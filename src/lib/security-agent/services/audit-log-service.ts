/**
 * Security Audit Log Service
 *
 * Provides append-only audit logging for all security agent actions.
 * Follows the createAuditLog pattern from src/lib/organizations/organization-audit-logs.ts.
 */

import 'server-only';
import { security_audit_log } from '@/db/schema';
import type { SecurityAuditLogEntry } from '@/db/schema';
import type { DrizzleTransaction } from '@/lib/drizzle';
import { db } from '@/lib/drizzle';
import { SecurityAuditLogAction } from '../core/enums';
import type { SecurityReviewOwner } from '../core/types';
import { captureException } from '@sentry/nextjs';

export { SecurityAuditLogAction };

type CreateSecurityAuditLogParams = {
  owner: SecurityReviewOwner;
  actor_id: string | null;
  actor_email: string | null;
  actor_name: string | null;
  action: SecurityAuditLogAction;
  resource_type: string;
  resource_id: string;
  before_state?: Record<string, unknown>;
  after_state?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  tx?: DrizzleTransaction;
};

export async function createSecurityAuditLog(
  params: CreateSecurityAuditLogParams
): Promise<SecurityAuditLogEntry> {
  const {
    owner,
    actor_id,
    actor_email,
    actor_name,
    action,
    resource_type,
    resource_id,
    before_state,
    after_state,
    metadata,
    tx,
  } = params;

  const owned_by_organization_id =
    'organizationId' in owner ? (owner.organizationId ?? null) : null;
  const owned_by_user_id = 'userId' in owner ? (owner.userId ?? null) : null;

  const [entry] = await (tx ?? db)
    .insert(security_audit_log)
    .values({
      owned_by_organization_id,
      owned_by_user_id,
      actor_id,
      actor_email,
      actor_name,
      action,
      resource_type,
      resource_id,
      before_state,
      after_state,
      metadata,
    })
    .returning();

  return entry;
}

/**
 * Fire-and-forget audit log: logs errors to Sentry instead of throwing.
 * Use this in paths where audit logging should never block the main operation.
 */
export function logSecurityAudit(params: CreateSecurityAuditLogParams): void {
  createSecurityAuditLog(params).catch(error => {
    captureException(error, {
      tags: { operation: 'createSecurityAuditLog' },
      extra: { action: params.action, resource_type: params.resource_type },
    });
  });
}

/** Replace internal Kilo admin actor details with a generic placeholder for non-admin requestors. */
export function maskKiloAdminActors<
  T extends { actor_id: string | null; actor_email: string | null; actor_name: string | null },
>(logs: T[], isRequestingUserKiloAdmin: boolean): T[] {
  if (isRequestingUserKiloAdmin) return logs;
  return logs.map(log => {
    if (log.actor_email && log.actor_email.endsWith('@kilocode.ai')) {
      return {
        ...log,
        actor_id: '00000000-0000-0000-0000-000000000000',
        actor_email: 'admin@kilocode.ai',
        actor_name: 'Kilo Admin',
      };
    }
    return log;
  });
}
