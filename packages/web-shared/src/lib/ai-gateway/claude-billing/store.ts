import 'server-only';
import { and, eq, isNull } from 'drizzle-orm';
import { claude_billing_connections, type ClaudeBillingConnectionRow } from '@kilocode/db/schema';
import { ClaudeBillingConnectionStatus } from '@kilocode/db/schema-types';
import { db, type DrizzleTransaction, type readDb } from '@kilocode/web-shared/lib/drizzle';

/**
 * Who a Claude billing connection belongs to: the person's personal account,
 * the person's own requests in one organization, or the organization's shared
 * services. A request uses only the connection of the owner it runs for.
 */
export type ClaudeBillingOwner =
  | { kind: 'personal'; kiloUserId: string }
  | { kind: 'member'; kiloUserId: string; organizationId: string }
  | { kind: 'shared_services'; organizationId: string };

type Database = typeof db | typeof readDb | DrizzleTransaction;

export function claudeBillingOwnerWhere(owner: ClaudeBillingOwner) {
  switch (owner.kind) {
    case 'personal':
      return and(
        eq(claude_billing_connections.kilo_user_id, owner.kiloUserId),
        isNull(claude_billing_connections.organization_id)
      );
    case 'member':
      return and(
        eq(claude_billing_connections.kilo_user_id, owner.kiloUserId),
        eq(claude_billing_connections.organization_id, owner.organizationId)
      );
    case 'shared_services':
      return and(
        eq(claude_billing_connections.organization_id, owner.organizationId),
        isNull(claude_billing_connections.kilo_user_id)
      );
  }
}

/** Stable identity for per-owner locks. */
export function claudeBillingOwnerKey(owner: ClaudeBillingOwner): string {
  switch (owner.kind) {
    case 'personal':
      return `user:${owner.kiloUserId}`;
    case 'member':
      return `member:${owner.organizationId}:${owner.kiloUserId}`;
    case 'shared_services':
      return `org:${owner.organizationId}`;
  }
}

export async function getClaudeBillingConnection(
  owner: ClaudeBillingOwner,
  fromDb: Database = db
): Promise<ClaudeBillingConnectionRow | null> {
  const [row] = await fromDb
    .select()
    .from(claude_billing_connections)
    .where(claudeBillingOwnerWhere(owner))
    .limit(1);
  return row ?? null;
}

/** Stores the owner's new user profile; a concurrent start that won keeps its own. */
export async function insertClaudeBillingProfile(
  owner: ClaudeBillingOwner,
  userProfileId: string,
  createdBy: string,
  onDb: Database = db
): Promise<ClaudeBillingConnectionRow> {
  await onDb
    .insert(claude_billing_connections)
    .values({
      kilo_user_id: owner.kind === 'shared_services' ? null : owner.kiloUserId,
      organization_id: owner.kind === 'personal' ? null : owner.organizationId,
      user_profile_id: userProfileId,
      created_by: createdBy,
    })
    .onConflictDoNothing();
  const row = await getClaudeBillingConnection(owner, onDb);
  if (!row) throw new Error('Claude billing connection row is missing after insert');
  return row;
}

/**
 * Anthropic refused a request for this profile with `user_profile_not_billable`.
 * Later requests fail without an upstream call until an admin acts. Only a
 * connected row changes, so a removal or a newer reconnect is never undone.
 */
export async function markClaudeBillingUnavailable(
  userProfileId: string,
  refusalCode: string,
  connectedAt: string
): Promise<void> {
  await db
    .update(claude_billing_connections)
    .set({
      status: ClaudeBillingConnectionStatus.BillingUnavailable,
      last_refusal_code: refusalCode,
      // Request bookkeeping must not invalidate an approval already in flight.
      updated_at: claude_billing_connections.updated_at,
      last_refusal_at: new Date().toISOString(),
    })
    .where(
      and(
        eq(claude_billing_connections.user_profile_id, userProfileId),
        eq(claude_billing_connections.connected_at, connectedAt),
        eq(claude_billing_connections.status, ClaudeBillingConnectionStatus.Connected)
      )
    );
}

/** Records a refusal that leaves the connection usable, such as a spend limit. */
export async function recordClaudeBillingRefusal(
  userProfileId: string,
  refusalCode: string,
  connectedAt: string
): Promise<void> {
  await db
    .update(claude_billing_connections)
    .set({
      last_refusal_code: refusalCode,
      last_refusal_at: new Date().toISOString(),
      updated_at: claude_billing_connections.updated_at,
    })
    .where(
      and(
        eq(claude_billing_connections.user_profile_id, userProfileId),
        eq(claude_billing_connections.connected_at, connectedAt),
        eq(claude_billing_connections.status, ClaudeBillingConnectionStatus.Connected)
      )
    );
}

/** A request the customer paid for succeeded, so an earlier refusal no longer applies. */
export async function clearClaudeBillingRefusal(
  userProfileId: string,
  connectedAt: string
): Promise<void> {
  await db
    .update(claude_billing_connections)
    .set({
      last_refusal_code: null,
      last_refusal_at: null,
      updated_at: claude_billing_connections.updated_at,
    })
    .where(
      and(
        eq(claude_billing_connections.user_profile_id, userProfileId),
        eq(claude_billing_connections.connected_at, connectedAt),
        eq(claude_billing_connections.status, ClaudeBillingConnectionStatus.Connected)
      )
    );
}
