import 'server-only';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import {
  claude_billing_connection_grants,
  claude_billing_connections,
  type ClaudeBillingConnectionRow,
} from '@kilocode/db/schema';
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
type WriteDatabase = typeof db | DrizzleTransaction;

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
    .orderBy(
      sql`${claude_billing_connections.status} = 'removed'`,
      asc(claude_billing_connections.created_at)
    )
    .limit(1);
  return row ?? null;
}

export function claudeBillingGrantOwnerWhere(owner: ClaudeBillingOwner) {
  switch (owner.kind) {
    case 'personal':
      return and(
        eq(claude_billing_connection_grants.kilo_user_id, owner.kiloUserId),
        isNull(claude_billing_connection_grants.organization_id)
      );
    case 'member':
      return and(
        eq(claude_billing_connection_grants.kilo_user_id, owner.kiloUserId),
        eq(claude_billing_connection_grants.organization_id, owner.organizationId)
      );
    case 'shared_services':
      return and(
        eq(claude_billing_connection_grants.organization_id, owner.organizationId),
        isNull(claude_billing_connection_grants.kilo_user_id)
      );
  }
}

async function upsertClaudeBillingGrant(
  owner: ClaudeBillingOwner,
  payerConnectionId: string,
  createdBy: string,
  onDb: WriteDatabase
): Promise<void> {
  await onDb
    .insert(claude_billing_connection_grants)
    .values({
      payer_connection_id: payerConnectionId,
      kilo_user_id: owner.kind === 'shared_services' ? null : owner.kiloUserId,
      organization_id: owner.kind === 'personal' ? null : owner.organizationId,
      created_by: createdBy,
    })
    .onConflictDoNothing();
  await onDb
    .update(claude_billing_connection_grants)
    .set({ payer_connection_id: payerConnectionId, created_by: createdBy, removed_at: null })
    .where(claudeBillingGrantOwnerWhere(owner));
}

export async function activateClaudeBillingGrant(
  owner: ClaudeBillingOwner,
  payerConnectionId: string,
  createdBy: string,
  onDb: WriteDatabase = db
): Promise<void> {
  await upsertClaudeBillingGrant(owner, payerConnectionId, createdBy, onDb);
}

async function findGrantedClaudeBillingConnection(
  owner: ClaudeBillingOwner,
  fromDb: Database,
  includeRemoved: boolean
): Promise<ClaudeBillingConnectionRow | null> {
  const [granted] = await fromDb
    .select({
      connection: claude_billing_connections,
      grantUserId: claude_billing_connection_grants.kilo_user_id,
      grantOrganizationId: claude_billing_connection_grants.organization_id,
      grantCreatedBy: claude_billing_connection_grants.created_by,
    })
    .from(claude_billing_connection_grants)
    .innerJoin(
      claude_billing_connections,
      eq(claude_billing_connection_grants.payer_connection_id, claude_billing_connections.id)
    )
    .where(
      includeRemoved
        ? claudeBillingGrantOwnerWhere(owner)
        : and(
            claudeBillingGrantOwnerWhere(owner),
            isNull(claude_billing_connection_grants.removed_at)
          )
    )
    .limit(1);
  if (granted) {
    return {
      ...granted.connection,
      kilo_user_id: granted.grantUserId,
      organization_id: granted.grantOrganizationId,
      created_by: granted.grantCreatedBy,
    };
  }

  const initial = await getClaudeBillingConnection(owner, fromDb);
  if (!initial) return null;
  const [anyGrant] = await fromDb
    .select({ id: claude_billing_connection_grants.id })
    .from(claude_billing_connection_grants)
    .where(eq(claude_billing_connection_grants.payer_connection_id, initial.id))
    .limit(1);
  return anyGrant ? null : initial;
}

/**
 * Resolves an active payer grant. A payer without any grants belongs to a
 * release that predates grant persistence and remains available to its initial
 * owner until a sharing or removal operation persists the initial grant.
 */
export async function getGrantedClaudeBillingConnection(
  owner: ClaudeBillingOwner,
  fromDb: Database = db
): Promise<ClaudeBillingConnectionRow | null> {
  return await findGrantedClaudeBillingConnection(owner, fromDb, false);
}

/** Resolves the payer a scope previously used so OAuth reconnect reuses its profile. */
export async function getClaudeBillingConnectionIncludingRemoved(
  owner: ClaudeBillingOwner,
  fromDb: Database = db
): Promise<ClaudeBillingConnectionRow | null> {
  return await findGrantedClaudeBillingConnection(owner, fromDb, true);
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
  const [row] = await onDb
    .select()
    .from(claude_billing_connections)
    .where(eq(claude_billing_connections.user_profile_id, userProfileId))
    .limit(1);
  if (!row) throw new Error('Claude billing connection row is missing after insert');
  if (!isInitialOwner(row, owner)) {
    const [existingGrant] = await onDb
      .select({ id: claude_billing_connection_grants.id })
      .from(claude_billing_connection_grants)
      .where(
        and(
          claudeBillingGrantOwnerWhere(owner),
          eq(claude_billing_connection_grants.payer_connection_id, row.id)
        )
      )
      .limit(1);
    if (!existingGrant) {
      throw new Error('Claude user profile belongs to another scope');
    }
  }
  await upsertClaudeBillingGrant(owner, row.id, createdBy, onDb);
  return row;
}

export class ClaudeBillingShareError extends Error {
  constructor(readonly reason: 'source_unavailable' | 'target_connected') {
    super(`Claude payer sharing failed: ${reason}`);
  }
}

async function lockClaudeBillingPayer(tx: DrizzleTransaction, payerConnectionId: string) {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtext(${`claude_billing_grant:${payerConnectionId}`}))`
  );
}

export async function shareClaudeBillingConnection(
  sourceOwner: ClaudeBillingOwner,
  targetOwner: ClaudeBillingOwner,
  createdBy: string,
  onDb: WriteDatabase = db
): Promise<ClaudeBillingConnectionRow> {
  return await onDb.transaction(async tx => {
    let source = await getGrantedClaudeBillingConnection(sourceOwner, tx);
    if (!source || source.status !== ClaudeBillingConnectionStatus.Connected) {
      throw new ClaudeBillingShareError('source_unavailable');
    }
    await lockClaudeBillingPayer(tx, source.id);
    source = await getGrantedClaudeBillingConnection(sourceOwner, tx);
    if (!source || source.status !== ClaudeBillingConnectionStatus.Connected) {
      throw new ClaudeBillingShareError('source_unavailable');
    }
    await upsertClaudeBillingGrant(sourceOwner, source.id, source.created_by, tx);

    const target = await getGrantedClaudeBillingConnection(targetOwner, tx);
    if (
      target &&
      target.status !== ClaudeBillingConnectionStatus.Removed &&
      target.status !== ClaudeBillingConnectionStatus.Pending
    ) {
      if (target.id === source.id && target.status === ClaudeBillingConnectionStatus.Connected) {
        return target;
      }
      throw new ClaudeBillingShareError('target_connected');
    }

    await upsertClaudeBillingGrant(targetOwner, source.id, createdBy, tx);
    if (
      target &&
      target.id !== source.id &&
      target.status === ClaudeBillingConnectionStatus.Pending
    ) {
      const [otherActiveGrant] = await tx
        .select({ id: claude_billing_connection_grants.id })
        .from(claude_billing_connection_grants)
        .where(
          and(
            eq(claude_billing_connection_grants.payer_connection_id, target.id),
            isNull(claude_billing_connection_grants.removed_at)
          )
        )
        .limit(1);
      if (!otherActiveGrant) {
        await tx
          .update(claude_billing_connections)
          .set({ status: ClaudeBillingConnectionStatus.Removed })
          .where(eq(claude_billing_connections.id, target.id));
      }
    }
    const shared = await getGrantedClaudeBillingConnection(targetOwner, tx);
    if (!shared || shared.id !== source.id) {
      throw new ClaudeBillingShareError('target_connected');
    }
    return shared;
  });
}

function isInitialOwner(row: ClaudeBillingConnectionRow, owner: ClaudeBillingOwner): boolean {
  switch (owner.kind) {
    case 'personal':
      return row.kilo_user_id === owner.kiloUserId && row.organization_id === null;
    case 'member':
      return row.kilo_user_id === owner.kiloUserId && row.organization_id === owner.organizationId;
    case 'shared_services':
      return row.kilo_user_id === null && row.organization_id === owner.organizationId;
  }
}

async function reassignErasedUserPayerOwner(
  tx: DrizzleTransaction,
  payerConnectionId: string,
  remaining: { kilo_user_id: string | null; organization_id: string | null }
): Promise<void> {
  await tx
    .update(claude_billing_connections)
    .set({
      kilo_user_id: remaining.kilo_user_id,
      organization_id: remaining.organization_id,
    })
    .where(eq(claude_billing_connections.id, payerConnectionId));
}

export async function removeClaudeBillingGrant(
  owner: ClaudeBillingOwner,
  onDb: WriteDatabase = db
): Promise<void> {
  await onDb.transaction(async tx => {
    let connection = await getGrantedClaudeBillingConnection(owner, tx);
    if (!connection) return;
    await lockClaudeBillingPayer(tx, connection.id);
    connection = await getGrantedClaudeBillingConnection(owner, tx);
    if (!connection) return;

    await upsertClaudeBillingGrant(owner, connection.id, connection.created_by, tx);
    await tx
      .update(claude_billing_connection_grants)
      .set({ removed_at: new Date().toISOString() })
      .where(claudeBillingGrantOwnerWhere(owner));
    const [remaining] = await tx
      .select({
        kilo_user_id: claude_billing_connection_grants.kilo_user_id,
        organization_id: claude_billing_connection_grants.organization_id,
      })
      .from(claude_billing_connection_grants)
      .where(
        and(
          eq(claude_billing_connection_grants.payer_connection_id, connection.id),
          isNull(claude_billing_connection_grants.removed_at)
        )
      )
      .orderBy(
        asc(claude_billing_connection_grants.created_at),
        asc(claude_billing_connection_grants.id)
      )
      .limit(1);

    if (!remaining) {
      await tx
        .update(claude_billing_connections)
        .set({
          status: ClaudeBillingConnectionStatus.Removed,
          connection_id: null,
          connected_at: null,
          last_refusal_code: null,
          last_refusal_at: null,
        })
        .where(eq(claude_billing_connections.id, connection.id));
      return;
    }
    await tx
      .update(claude_billing_connections)
      .set({ updated_at: sql`clock_timestamp()` })
      .where(eq(claude_billing_connections.id, connection.id));
  });
}

export async function removeUserClaudeBillingGrants(
  userId: string,
  onDb: WriteDatabase
): Promise<void> {
  await onDb.transaction(async tx => {
    const grantPayers = await tx
      .select({ payerId: claude_billing_connection_grants.payer_connection_id })
      .from(claude_billing_connection_grants)
      .where(eq(claude_billing_connection_grants.kilo_user_id, userId));
    const directPayers = await tx
      .select({ payerId: claude_billing_connections.id })
      .from(claude_billing_connections)
      .where(eq(claude_billing_connections.kilo_user_id, userId));
    const payerIds = [...new Set([...grantPayers, ...directPayers].map(row => row.payerId))].sort();
    for (const payerId of payerIds) {
      await lockClaudeBillingPayer(tx, payerId);
    }

    await tx
      .delete(claude_billing_connection_grants)
      .where(eq(claude_billing_connection_grants.kilo_user_id, userId));

    for (const payerId of payerIds) {
      const [remaining] = await tx
        .select({
          kilo_user_id: claude_billing_connection_grants.kilo_user_id,
          organization_id: claude_billing_connection_grants.organization_id,
        })
        .from(claude_billing_connection_grants)
        .where(
          and(
            eq(claude_billing_connection_grants.payer_connection_id, payerId),
            isNull(claude_billing_connection_grants.removed_at)
          )
        )
        .orderBy(
          asc(claude_billing_connection_grants.created_at),
          asc(claude_billing_connection_grants.id)
        )
        .limit(1);

      if (!remaining) {
        await tx
          .delete(claude_billing_connections)
          .where(eq(claude_billing_connections.id, payerId));
      } else {
        const [payerRow] = await tx
          .select()
          .from(claude_billing_connections)
          .where(eq(claude_billing_connections.id, payerId))
          .limit(1);
        if (payerRow?.kilo_user_id === userId) {
          await reassignErasedUserPayerOwner(tx, payerId, remaining);
        }
      }
    }
  });
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
