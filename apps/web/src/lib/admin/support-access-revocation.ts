import 'server-only';

import { and, eq, inArray, sql } from 'drizzle-orm';
import {
  support_access_grant_events,
  support_access_grants,
  type SupportAccessGrantStatus,
} from '@kilocode/db/schema';
import type { DrizzleTransaction } from '@kilocode/web-shared/lib/drizzle';

const OPEN_STATUSES: SupportAccessGrantStatus[] = ['pending', 'active'];

export type RevokedSupportGrant = {
  id: string;
  organizationId: string;
  actionClass: 'support_read' | 'support_write';
};

/**
 * Revokes every open grant held by `actorKiloUserId` in the caller's
 * transaction, so a permission removal and the grant revocation commit
 * together. Events are written in the same transaction as the status change.
 */
export async function revokeOpenSupportGrants(
  tx: DrizzleTransaction,
  params: {
    actorKiloUserId: string;
    reason: string;
    performedByKiloUserId?: string | null;
  }
): Promise<RevokedSupportGrant[]> {
  const revoked = await tx
    .update(support_access_grants)
    .set({
      status: 'revoked',
      revoked_at: sql`now()`,
      revoked_by_kilo_user_id: params.performedByKiloUserId ?? null,
      revoke_reason: params.reason,
    })
    .where(
      and(
        eq(support_access_grants.actor_kilo_user_id, params.actorKiloUserId),
        inArray(support_access_grants.status, OPEN_STATUSES)
      )
    )
    .returning({
      id: support_access_grants.id,
      organizationId: support_access_grants.organization_id,
      actionClass: support_access_grants.action_class,
    });

  if (revoked.length > 0) {
    await tx.insert(support_access_grant_events).values(
      revoked.map(grant => ({
        grant_id: grant.id,
        event_type: 'revoked' as const,
        performed_by_kilo_user_id: params.performedByKiloUserId ?? null,
        organization_id: grant.organizationId,
        action_class: grant.actionClass,
        metadata: { cause: params.reason },
      }))
    );
  }

  return revoked;
}
