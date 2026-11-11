import 'server-only';
import { and, asc, eq, inArray, isNull, ne, not, notExists, or, sql } from 'drizzle-orm';
import { canManageOrganization } from '@kilocode/app-shared/organizations';
import {
  byok_api_keys,
  claude_billing_connection_grants,
  claude_billing_connections,
  organization_memberships,
  organizations,
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
export type ClaudeBillingOwnerInput = {
  organizationId?: string;
  scope?: 'shared_services';
};

export type ClaudeBillingShareableLink = {
  payerId: string;
  source: ClaudeBillingOwnerInput;
  label: string;
  connectedAt: string | null;
};

export type ClaudeBillingScopeSharing = {
  shareableLinks: ClaudeBillingShareableLink[];
  sharedWith: string[];
};

export type UnreferencedClaudeBillingPayer = {
  id: string;
  userProfileId: string;
};
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
  fromDb: Database
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
      and(claudeBillingGrantOwnerWhere(owner), isNull(claude_billing_connection_grants.removed_at))
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
  return await findGrantedClaudeBillingConnection(owner, fromDb);
}

function ownerFromColumns(columns: {
  kilo_user_id: string | null;
  organization_id: string | null;
}): ClaudeBillingOwner | null {
  if (columns.organization_id === null) {
    return columns.kilo_user_id ? { kind: 'personal', kiloUserId: columns.kilo_user_id } : null;
  }
  return columns.kilo_user_id
    ? {
        kind: 'member',
        kiloUserId: columns.kilo_user_id,
        organizationId: columns.organization_id,
      }
    : { kind: 'shared_services', organizationId: columns.organization_id };
}

async function freeClaudeBillingOwnerColumns(
  owner: ClaudeBillingOwner,
  exceptPayerId: string | null,
  onDb: WriteDatabase
): Promise<void> {
  const [occupant] = await onDb
    .select()
    .from(claude_billing_connections)
    .where(
      and(
        claudeBillingOwnerWhere(owner),
        ne(claude_billing_connections.status, ClaudeBillingConnectionStatus.Removed),
        ...(exceptPayerId ? [ne(claude_billing_connections.id, exceptPayerId)] : [])
      )
    )
    .limit(1);
  if (!occupant) return;

  const ownerGrantWhere = claudeBillingGrantOwnerWhere(owner);
  const [otherGrant] = await onDb
    .select({
      kilo_user_id: claude_billing_connection_grants.kilo_user_id,
      organization_id: claude_billing_connection_grants.organization_id,
    })
    .from(claude_billing_connection_grants)
    .where(
      and(
        eq(claude_billing_connection_grants.payer_connection_id, occupant.id),
        isNull(claude_billing_connection_grants.removed_at),
        ...(ownerGrantWhere ? [not(ownerGrantWhere)] : [])
      )
    )
    .orderBy(
      asc(claude_billing_connection_grants.created_at),
      asc(claude_billing_connection_grants.id)
    )
    .limit(1);

  if (otherGrant) {
    await onDb
      .update(claude_billing_connections)
      .set({
        kilo_user_id: otherGrant.kilo_user_id,
        organization_id: otherGrant.organization_id,
        updated_at: sql`clock_timestamp()`,
      })
      .where(eq(claude_billing_connections.id, occupant.id));
    return;
  }

  await onDb
    .update(claude_billing_connections)
    .set({
      status: ClaudeBillingConnectionStatus.Removed,
      connection_id: null,
      connected_at: null,
      last_refusal_code: null,
      last_refusal_at: null,
    })
    .where(eq(claude_billing_connections.id, occupant.id));
}

export async function insertClaudeBillingProfile(
  owner: ClaudeBillingOwner,
  userProfileId: string,
  createdBy: string,
  onDb: WriteDatabase = db
): Promise<ClaudeBillingConnectionRow> {
  await freeClaudeBillingOwnerColumns(owner, null, onDb);
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
  constructor(readonly reason: 'source_unavailable' | 'source_forbidden' | 'target_connected') {
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
    const [payerRow] = await tx
      .select()
      .from(claude_billing_connections)
      .where(eq(claude_billing_connections.id, source.id))
      .limit(1);
    if (!payerRow) {
      throw new ClaudeBillingShareError('source_unavailable');
    }
    if (sourceOwner.kind === 'shared_services' && payerRow.created_by !== createdBy) {
      const [callerGrant] = await tx
        .select({ id: claude_billing_connection_grants.id })
        .from(claude_billing_connection_grants)
        .where(
          and(
            eq(claude_billing_connection_grants.payer_connection_id, source.id),
            eq(claude_billing_connection_grants.kilo_user_id, createdBy),
            isNull(claude_billing_connection_grants.removed_at)
          )
        )
        .limit(1);
      if (!callerGrant) {
        throw new ClaudeBillingShareError('source_forbidden');
      }
    }
    await upsertClaudeBillingGrant(sourceOwner, source.id, source.created_by, tx);

    const target = await getGrantedClaudeBillingConnection(targetOwner, tx);
    if (
      target &&
      target.status !== ClaudeBillingConnectionStatus.Removed &&
      target.status !== ClaudeBillingConnectionStatus.Pending
    ) {
      if (target.id === source.id && target.status === ClaudeBillingConnectionStatus.Connected) {
        if (targetOwner.kind === 'personal') {
          await deletePersonalAnthropicByokKey(tx, targetOwner.kiloUserId);
        }
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
    if (targetOwner.kind === 'personal') {
      await deletePersonalAnthropicByokKey(tx, targetOwner.kiloUserId);
    }
    const shared = await getGrantedClaudeBillingConnection(targetOwner, tx);
    if (!shared || shared.id !== source.id) {
      throw new ClaudeBillingShareError('target_connected');
    }
    return shared;
  });
}

async function deletePersonalAnthropicByokKey(
  tx: WriteDatabase,
  kiloUserId: string
): Promise<void> {
  await tx
    .delete(byok_api_keys)
    .where(
      and(
        eq(byok_api_keys.provider_id, 'anthropic'),
        eq(byok_api_keys.kilo_user_id, kiloUserId),
        isNull(byok_api_keys.organization_id)
      )
    );
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

async function reassignPayerOwnerColumns(
  tx: DrizzleTransaction,
  payerConnectionId: string,
  remaining: { kilo_user_id: string | null; organization_id: string | null }
): Promise<void> {
  const nextOwner = ownerFromColumns(remaining);
  if (nextOwner) {
    await freeClaudeBillingOwnerColumns(nextOwner, payerConnectionId, tx);
  }
  await tx
    .update(claude_billing_connections)
    .set({
      kilo_user_id: remaining.kilo_user_id,
      organization_id: remaining.organization_id,
      updated_at: sql`clock_timestamp()`,
    })
    .where(eq(claude_billing_connections.id, payerConnectionId));
}

export async function removeClaudeBillingGrant(
  owner: ClaudeBillingOwner,
  onDb: WriteDatabase = db
): Promise<UnreferencedClaudeBillingPayer | null> {
  return await onDb.transaction(async tx => {
    let connection = await getGrantedClaudeBillingConnection(owner, tx);
    if (!connection) return null;
    await lockClaudeBillingPayer(tx, connection.id);
    connection = await getGrantedClaudeBillingConnection(owner, tx);
    if (!connection) return null;

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
      return { id: connection.id, userProfileId: connection.user_profile_id };
    }

    const [payerRow] = await tx
      .select()
      .from(claude_billing_connections)
      .where(eq(claude_billing_connections.id, connection.id))
      .limit(1);
    if (payerRow && isInitialOwner(payerRow, owner)) {
      await reassignPayerOwnerColumns(tx, connection.id, remaining);
      return null;
    }

    await tx
      .update(claude_billing_connections)
      .set({ updated_at: sql`clock_timestamp()` })
      .where(eq(claude_billing_connections.id, connection.id));
    return null;
  });
}

function ownerToInput(owner: ClaudeBillingOwner): ClaudeBillingOwnerInput {
  switch (owner.kind) {
    case 'personal':
      return {};
    case 'member':
      return { organizationId: owner.organizationId };
    case 'shared_services':
      return { organizationId: owner.organizationId, scope: 'shared_services' };
  }
}

function formatScopeLabel(
  owner: ClaudeBillingOwner,
  orgNames: ReadonlyMap<string, string>
): string {
  if (owner.kind === 'personal') return 'Personal account';
  const orgName = orgNames.get(owner.organizationId) ?? 'Organization';
  return owner.kind === 'shared_services' ? `${orgName} (shared services)` : `${orgName} (member)`;
}

function scopeSortRank(
  owner: ClaudeBillingOwner,
  targetOrganizationId: string | undefined
): number {
  if (owner.kind !== 'personal' && owner.organizationId === targetOrganizationId) {
    return owner.kind === 'member' ? 0 : 1;
  }
  if (owner.kind === 'personal') return 2;
  return owner.kind === 'member' ? 3 : 4;
}

export async function describeClaudeBillingSharing(
  userId: string,
  targetOwner: ClaudeBillingOwner,
  canManageTarget: boolean,
  current: ClaudeBillingConnectionRow | null,
  fromDb: Database = db
): Promise<ClaudeBillingScopeSharing> {
  const memberships = await fromDb
    .select({
      orgId: organization_memberships.organization_id,
      orgName: organizations.name,
      role: organization_memberships.role,
    })
    .from(organization_memberships)
    .innerJoin(organizations, eq(organizations.id, organization_memberships.organization_id))
    .where(
      and(eq(organization_memberships.kilo_user_id, userId), isNull(organizations.deleted_at))
    );

  const orgNames = new Map<string, string>();
  const memberOrgIds = new Set<string>();
  const managedOrgIds = new Set<string>();
  for (const membership of memberships) {
    orgNames.set(membership.orgId, membership.orgName);
    memberOrgIds.add(membership.orgId);
    if (canManageOrganization(membership.role)) {
      managedOrgIds.add(membership.orgId);
    }
  }

  if (managedOrgIds.size > 0) {
    const childOrgs = await fromDb
      .select({ orgId: organizations.id, orgName: organizations.name })
      .from(organizations)
      .where(
        and(
          inArray(organizations.parent_organization_id, [...managedOrgIds]),
          isNull(organizations.deleted_at)
        )
      );
    for (const child of childOrgs) {
      orgNames.set(child.orgId, child.orgName);
      managedOrgIds.add(child.orgId);
    }
  }

  const visibleOrgIds = [...new Set([...memberOrgIds, ...managedOrgIds])];
  const targetKey = claudeBillingOwnerKey(targetOwner);
  const targetOrganizationId =
    targetOwner.kind === 'personal' ? undefined : targetOwner.organizationId;

  let sharedWith: string[] = [];
  if (
    current &&
    (current.status === ClaudeBillingConnectionStatus.Connected ||
      current.status === ClaudeBillingConnectionStatus.BillingUnavailable)
  ) {
    const currentGrants = await fromDb
      .select({
        kilo_user_id: claude_billing_connection_grants.kilo_user_id,
        organization_id: claude_billing_connection_grants.organization_id,
      })
      .from(claude_billing_connection_grants)
      .where(
        and(
          eq(claude_billing_connection_grants.payer_connection_id, current.id),
          isNull(claude_billing_connection_grants.removed_at),
          visibleOrgIds.length > 0
            ? or(
                eq(claude_billing_connection_grants.kilo_user_id, userId),
                and(
                  isNull(claude_billing_connection_grants.kilo_user_id),
                  inArray(claude_billing_connection_grants.organization_id, visibleOrgIds)
                )
              )
            : eq(claude_billing_connection_grants.kilo_user_id, userId)
        )
      );
    const siblingOwners: ClaudeBillingOwner[] = [];
    for (const grant of currentGrants) {
      const owner = ownerFromColumns(grant);
      if (!owner || claudeBillingOwnerKey(owner) === targetKey) continue;
      if (owner.kind === 'member' && !memberOrgIds.has(owner.organizationId)) continue;
      siblingOwners.push(owner);
    }
    siblingOwners.sort(
      (a, b) =>
        scopeSortRank(a, targetOrganizationId) - scopeSortRank(b, targetOrganizationId) ||
        formatScopeLabel(a, orgNames).localeCompare(formatScopeLabel(b, orgNames))
    );
    sharedWith = siblingOwners.map(owner => formatScopeLabel(owner, orgNames));
  }

  const targetAcceptsShare =
    canManageTarget &&
    (!current ||
      current.status === ClaudeBillingConnectionStatus.Removed ||
      current.status === ClaudeBillingConnectionStatus.Pending);
  if (!targetAcceptsShare) {
    return { shareableLinks: [], sharedWith };
  }

  const managedOrgList = [...managedOrgIds];
  const grantedRows = await fromDb
    .select({
      connection: claude_billing_connections,
      grantUserId: claude_billing_connection_grants.kilo_user_id,
      grantOrganizationId: claude_billing_connection_grants.organization_id,
    })
    .from(claude_billing_connection_grants)
    .innerJoin(
      claude_billing_connections,
      eq(claude_billing_connection_grants.payer_connection_id, claude_billing_connections.id)
    )
    .where(
      and(
        isNull(claude_billing_connection_grants.removed_at),
        eq(claude_billing_connections.status, ClaudeBillingConnectionStatus.Connected),
        managedOrgList.length > 0
          ? or(
              eq(claude_billing_connection_grants.kilo_user_id, userId),
              and(
                isNull(claude_billing_connection_grants.kilo_user_id),
                inArray(claude_billing_connection_grants.organization_id, managedOrgList)
              )
            )
          : eq(claude_billing_connection_grants.kilo_user_id, userId)
      )
    );

  const ungrantedRows = await fromDb
    .select()
    .from(claude_billing_connections)
    .where(
      and(
        eq(claude_billing_connections.status, ClaudeBillingConnectionStatus.Connected),
        managedOrgList.length > 0
          ? or(
              eq(claude_billing_connections.kilo_user_id, userId),
              and(
                isNull(claude_billing_connections.kilo_user_id),
                inArray(claude_billing_connections.organization_id, managedOrgList)
              )
            )
          : eq(claude_billing_connections.kilo_user_id, userId),
        notExists(
          fromDb
            .select({ id: claude_billing_connection_grants.id })
            .from(claude_billing_connection_grants)
            .where(
              eq(
                claude_billing_connection_grants.payer_connection_id,
                claude_billing_connections.id
              )
            )
        )
      )
    );

  const byPayer = new Map<
    string,
    { payer: ClaudeBillingConnectionRow; scopes: ClaudeBillingOwner[] }
  >();
  const addScope = (payer: ClaudeBillingConnectionRow, scopeOwner: ClaudeBillingOwner | null) => {
    if (!scopeOwner || claudeBillingOwnerKey(scopeOwner) === targetKey) return;
    if (scopeOwner.kind === 'personal' && scopeOwner.kiloUserId !== userId) return;
    if (
      scopeOwner.kind === 'member' &&
      (scopeOwner.kiloUserId !== userId || !memberOrgIds.has(scopeOwner.organizationId))
    ) {
      return;
    }
    if (scopeOwner.kind === 'shared_services' && !managedOrgIds.has(scopeOwner.organizationId)) {
      return;
    }
    const existing = byPayer.get(payer.id);
    if (!existing) {
      byPayer.set(payer.id, { payer, scopes: [scopeOwner] });
      return;
    }
    const key = claudeBillingOwnerKey(scopeOwner);
    if (!existing.scopes.some(item => claudeBillingOwnerKey(item) === key)) {
      existing.scopes.push(scopeOwner);
    }
  };

  for (const row of grantedRows) {
    addScope(
      row.connection,
      ownerFromColumns({ kilo_user_id: row.grantUserId, organization_id: row.grantOrganizationId })
    );
  }
  for (const row of ungrantedRows) {
    addScope(
      row,
      ownerFromColumns({ kilo_user_id: row.kilo_user_id, organization_id: row.organization_id })
    );
  }

  const shareableLinks: ClaudeBillingShareableLink[] = [];
  for (const { payer, scopes } of byPayer.values()) {
    if (payer.created_by !== userId && !scopes.some(scope => scope.kind !== 'shared_services')) {
      continue;
    }
    scopes.sort(
      (a, b) =>
        scopeSortRank(a, targetOrganizationId) - scopeSortRank(b, targetOrganizationId) ||
        formatScopeLabel(a, orgNames).localeCompare(formatScopeLabel(b, orgNames))
    );
    const primary = scopes[0];
    if (!primary) continue;
    shareableLinks.push({
      payerId: payer.id,
      source: ownerToInput(primary),
      label: scopes.map(scope => formatScopeLabel(scope, orgNames)).join(', '),
      connectedAt: payer.connected_at ? new Date(payer.connected_at).toISOString() : null,
    });
  }

  shareableLinks.sort((a, b) => {
    const aSameOrg =
      targetOrganizationId !== undefined && a.source.organizationId === targetOrganizationId;
    const bSameOrg =
      targetOrganizationId !== undefined && b.source.organizationId === targetOrganizationId;
    if (aSameOrg !== bSameOrg) return aSameOrg ? -1 : 1;
    const aPersonal = a.source.organizationId === undefined;
    const bPersonal = b.source.organizationId === undefined;
    if (aPersonal !== bPersonal) return aPersonal ? -1 : 1;
    return a.label.localeCompare(b.label);
  });

  return { shareableLinks, sharedWith };
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
          await reassignPayerOwnerColumns(tx, payerId, remaining);
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
