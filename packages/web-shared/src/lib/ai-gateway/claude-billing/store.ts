import 'server-only';
import { and, asc, eq, inArray, isNull, ne, not, notExists, or, sql, type SQL } from 'drizzle-orm';
import { type AnyPgColumn } from 'drizzle-orm/pg-core';
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
import {
  db,
  type DrizzleConnection,
  type DrizzleTransaction,
} from '@kilocode/web-shared/lib/drizzle';
import {
  claudeBillingOwnerMatches,
  type ClaudeBillingOwner,
  type ClaudeBillingOwnerColumns,
} from './owner';
import { specificRefusalCodesFor } from './refusal';

export type { ClaudeBillingOwner } from './owner';

export type ClaudeBillingOwnerInput = {
  organizationId?: string;
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

/**
 * The columns of a row that belongs to an owner: a personal owner names only the
 * person column, an organization owner only the organization column.
 */
function claudeBillingOwnerColumnsWhere(
  kiloUserId: AnyPgColumn,
  organizationId: AnyPgColumn,
  owner: ClaudeBillingOwner
) {
  switch (owner.kind) {
    case 'personal':
      return and(eq(kiloUserId, owner.kiloUserId), isNull(organizationId));
    case 'organization':
      return and(eq(organizationId, owner.organizationId), isNull(kiloUserId));
  }
}

export function claudeBillingOwnerWhere(owner: ClaudeBillingOwner) {
  return claudeBillingOwnerColumnsWhere(
    claude_billing_connections.kilo_user_id,
    claude_billing_connections.organization_id,
    owner
  );
}

/** Rows the caller may see: their own rows, plus the organization rows of the allowed organizations. */
function claudeBillingVisibleWhere(
  kiloUserId: AnyPgColumn,
  organizationId: AnyPgColumn,
  userId: string,
  organizationIds: string[]
) {
  const ownRows = eq(kiloUserId, userId);
  if (organizationIds.length === 0) return ownRows;
  return or(ownRows, and(isNull(kiloUserId), inArray(organizationId, organizationIds)));
}

/** Stable identity for per-owner locks. */
export function claudeBillingOwnerKey(owner: ClaudeBillingOwner): string {
  switch (owner.kind) {
    case 'personal':
      return `user:${owner.kiloUserId}`;
    case 'organization':
      return `org:${owner.organizationId}`;
  }
}

export async function getClaudeBillingConnection(
  owner: ClaudeBillingOwner,
  fromDb: DrizzleConnection = db
): Promise<ClaudeBillingConnectionRow | null> {
  const [row] = await fromDb
    .select()
    .from(claude_billing_connections)
    .where(claudeBillingOwnerWhere(owner))
    .orderBy(
      sql`${claude_billing_connections.status} = ${ClaudeBillingConnectionStatus.Removed}`,
      asc(claude_billing_connections.created_at)
    )
    .limit(1);
  return row ?? null;
}

export function claudeBillingGrantOwnerWhere(owner: ClaudeBillingOwner) {
  return claudeBillingOwnerColumnsWhere(
    claude_billing_connection_grants.kilo_user_id,
    claude_billing_connection_grants.organization_id,
    owner
  );
}

/**
 * The grants that still give their payer to a scope Kilo offers: active, and
 * naming a person or an organization but not both. Only the retired member
 * scope named both, so such a grant holds no payer and never keeps a row or an
 * Anthropic profile alive.
 */
export function liveClaudeBillingGrantWhere() {
  return and(
    isNull(claude_billing_connection_grants.removed_at),
    or(
      isNull(claude_billing_connection_grants.kilo_user_id),
      isNull(claude_billing_connection_grants.organization_id)
    )
  );
}

/**
 * The oldest live grant on this payer becomes its next owner.
 */
async function selectNextActiveGrant(
  onDb: DrizzleConnection,
  payerConnectionId: string,
  excludeOwner: ClaudeBillingOwner | null = null
): Promise<ClaudeBillingOwnerColumns | null> {
  const excludeWhere = excludeOwner ? claudeBillingGrantOwnerWhere(excludeOwner) : undefined;
  const [grant] = await onDb
    .select({
      kilo_user_id: claude_billing_connection_grants.kilo_user_id,
      organization_id: claude_billing_connection_grants.organization_id,
    })
    .from(claude_billing_connection_grants)
    .where(
      and(
        eq(claude_billing_connection_grants.payer_connection_id, payerConnectionId),
        liveClaudeBillingGrantWhere(),
        ...(excludeWhere ? [not(excludeWhere)] : [])
      )
    )
    .orderBy(
      asc(claude_billing_connection_grants.created_at),
      asc(claude_billing_connection_grants.id)
    )
    .limit(1);
  return grant ?? null;
}

function ownerColumns(owner: ClaudeBillingOwner): ClaudeBillingOwnerColumns {
  return {
    kilo_user_id: owner.kind === 'organization' ? null : owner.kiloUserId,
    organization_id: owner.kind === 'personal' ? null : owner.organizationId,
  };
}

export async function activateClaudeBillingGrant(
  owner: ClaudeBillingOwner,
  payerConnectionId: string,
  createdBy: string,
  onDb: DrizzleConnection = db
): Promise<void> {
  await onDb
    .insert(claude_billing_connection_grants)
    .values({
      payer_connection_id: payerConnectionId,
      ...ownerColumns(owner),
      created_by: createdBy,
    })
    .onConflictDoNothing();
  await onDb
    .update(claude_billing_connection_grants)
    .set({ payer_connection_id: payerConnectionId, created_by: createdBy, removed_at: null })
    .where(claudeBillingGrantOwnerWhere(owner));
}

/**
 * A payer row a scope holds through a grant: the row exactly as stored, and the
 * scope grant that gives it to this owner. `connection.created_by` therefore
 * still names the person who linked the payer at Anthropic, while
 * `grant.created_by` names who wrote the grant.
 */
export type ClaudeBillingGrantedConnection = {
  connection: ClaudeBillingConnectionRow;
  grant: ClaudeBillingOwnerColumns & { created_by: string };
};

/**
 * The payer row as the scope that holds it sees it: the grant's owner columns and
 * grant audit column in place of the row's own. Use `connection` instead when the
 * row's own columns are what a decision needs, such as who linked it at Anthropic.
 */
export function claudeBillingEffectiveConnection(
  granted: ClaudeBillingGrantedConnection
): ClaudeBillingConnectionRow {
  return {
    ...granted.connection,
    kilo_user_id: granted.grant.kilo_user_id,
    organization_id: granted.grant.organization_id,
    created_by: granted.grant.created_by,
  };
}

/**
 * Resolves an active payer grant. A payer without any grants belongs to a
 * release that predates grant persistence and remains available to its initial
 * owner until a sharing or removal operation persists the initial grant.
 */
export async function getGrantedClaudeBillingConnection(
  owner: ClaudeBillingOwner,
  fromDb: DrizzleConnection = db
): Promise<ClaudeBillingGrantedConnection | null> {
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
      connection: granted.connection,
      grant: {
        kilo_user_id: granted.grantUserId,
        organization_id: granted.grantOrganizationId,
        created_by: granted.grantCreatedBy,
      },
    };
  }

  const initial = await getClaudeBillingConnection(owner, fromDb);
  if (!initial) return null;
  const [anyGrant] = await fromDb
    .select({ id: claude_billing_connection_grants.id })
    .from(claude_billing_connection_grants)
    .where(eq(claude_billing_connection_grants.payer_connection_id, initial.id))
    .limit(1);
  return anyGrant
    ? null
    : {
        connection: initial,
        grant: {
          kilo_user_id: initial.kilo_user_id,
          organization_id: initial.organization_id,
          created_by: initial.created_by,
        },
      };
}

/**
 * The owner a row or grant describes, or null for a row a retired scope wrote:
 * `member` rows name a person and an organization together, and no current
 * owner names both.
 */
function ownerFromColumns(columns: ClaudeBillingOwnerColumns): ClaudeBillingOwner | null {
  if (columns.kilo_user_id && columns.organization_id) return null;
  if (columns.kilo_user_id) return { kind: 'personal', kiloUserId: columns.kilo_user_id };
  if (columns.organization_id) {
    return { kind: 'organization', organizationId: columns.organization_id };
  }
  return null;
}

/**
 * Whether a scope can take a share: it holds no payer row yet, or its row is
 * removed or still pending. Any other status is a live payer, so a share over it
 * would replace a link the scope is using.
 */
function claudeBillingTargetAcceptsShare(status: ClaudeBillingConnectionStatus | null): boolean {
  return (
    status === null ||
    status === ClaudeBillingConnectionStatus.Removed ||
    status === ClaudeBillingConnectionStatus.Pending
  );
}

/**
 * Puts a payer row into the removed state. The columns that retire a row live
 * here, so every path that retires one writes the same set.
 */
async function retireClaudeBillingConnection(
  onDb: DrizzleConnection,
  connectionId: string
): Promise<void> {
  await onDb
    .update(claude_billing_connections)
    .set({
      status: ClaudeBillingConnectionStatus.Removed,
      connection_id: null,
      connected_at: null,
      last_refusal_code: null,
      last_refusal_at: null,
    })
    .where(eq(claude_billing_connections.id, connectionId));
}

/**
 * Writes the owner columns of a payer row and stamps it as changed. Both columns
 * are always written together, so a row never keeps the scope it had.
 */
async function writePayerOwnerColumns(
  onDb: DrizzleConnection,
  connectionId: string,
  columns: ClaudeBillingOwnerColumns
): Promise<void> {
  await onDb
    .update(claude_billing_connections)
    .set({
      kilo_user_id: columns.kilo_user_id,
      organization_id: columns.organization_id,
      updated_at: sql`clock_timestamp()`,
    })
    .where(eq(claude_billing_connections.id, connectionId));
}

async function freeClaudeBillingOwnerColumns(
  owner: ClaudeBillingOwner,
  exceptPayerId: string | null,
  onDb: DrizzleConnection
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

  const otherGrant = await selectNextActiveGrant(onDb, occupant.id, owner);

  if (otherGrant) {
    await writePayerOwnerColumns(onDb, occupant.id, otherGrant);
    return;
  }

  await retireClaudeBillingConnection(onDb, occupant.id);
}

export async function insertClaudeBillingProfile(
  owner: ClaudeBillingOwner,
  userProfileId: string,
  createdBy: string,
  onDb: DrizzleConnection = db
): Promise<ClaudeBillingConnectionRow> {
  await freeClaudeBillingOwnerColumns(owner, null, onDb);
  await onDb
    .insert(claude_billing_connections)
    .values({
      ...ownerColumns(owner),
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
  if (!claudeBillingOwnerMatches(row, owner)) {
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
  await activateClaudeBillingGrant(owner, row.id, createdBy, onDb);
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
  onDb: DrizzleConnection = db
): Promise<ClaudeBillingConnectionRow> {
  return await withClaudeBillingPayerLock(
    sourceOwner,
    async (tx, source) => {
      if (!source || source.connection.status !== ClaudeBillingConnectionStatus.Connected) {
        throw new ClaudeBillingShareError('source_unavailable');
      }
      if (sourceOwner.kind === 'organization' && source.connection.created_by !== createdBy) {
        // A grant that names both a person and an organization was written by the
        // retired member scope and is not live, so it cannot authorize a share.
        const [callerGrant] = await tx
          .select({ id: claude_billing_connection_grants.id })
          .from(claude_billing_connection_grants)
          .where(
            and(
              eq(claude_billing_connection_grants.payer_connection_id, source.connection.id),
              eq(claude_billing_connection_grants.kilo_user_id, createdBy),
              liveClaudeBillingGrantWhere()
            )
          )
          .limit(1);
        if (!callerGrant) {
          throw new ClaudeBillingShareError('source_forbidden');
        }
      }
      await activateClaudeBillingGrant(
        sourceOwner,
        source.connection.id,
        source.grant.created_by,
        tx
      );

      const target = await getGrantedClaudeBillingConnection(targetOwner, tx);
      if (target && !claudeBillingTargetAcceptsShare(target.connection.status)) {
        // The one share a scope that already holds a payer can take again: its own
        // connected row, so a repeated share is idempotent instead of a conflict.
        if (
          target.connection.id === source.connection.id &&
          target.connection.status === ClaudeBillingConnectionStatus.Connected
        ) {
          if (targetOwner.kind === 'personal') {
            await deletePersonalAnthropicByokKey(tx, targetOwner.kiloUserId);
          }
          return claudeBillingEffectiveConnection(target);
        }
        throw new ClaudeBillingShareError('target_connected');
      }

      await activateClaudeBillingGrant(targetOwner, source.connection.id, createdBy, tx);
      if (
        target &&
        target.connection.id !== source.connection.id &&
        target.connection.status === ClaudeBillingConnectionStatus.Pending
      ) {
        const remaining = await selectNextActiveGrant(tx, target.connection.id);
        if (!remaining) {
          // A Pending row never carries the retirement columns: only the insert
          // default writes Pending, and the approval callback sets the columns.
          await retireClaudeBillingConnection(tx, target.connection.id);
        }
      }
      if (targetOwner.kind === 'personal') {
        await deletePersonalAnthropicByokKey(tx, targetOwner.kiloUserId);
      }
      const shared = await getGrantedClaudeBillingConnection(targetOwner, tx);
      if (!shared || shared.connection.id !== source.connection.id) {
        throw new ClaudeBillingShareError('target_connected');
      }
      return claudeBillingEffectiveConnection(shared);
    },
    onDb
  );
}

async function deletePersonalAnthropicByokKey(
  tx: DrizzleConnection,
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

async function reassignPayerOwnerColumns(
  tx: DrizzleTransaction,
  payerConnectionId: string,
  remaining: ClaudeBillingOwnerColumns
): Promise<void> {
  const nextOwner = ownerFromColumns(remaining);
  if (nextOwner) {
    await freeClaudeBillingOwnerColumns(nextOwner, payerConnectionId, tx);
  }
  await writePayerOwnerColumns(tx, payerConnectionId, remaining);
}

/**
 * Runs `work` while holding the payer lock that sharing and removal take, so no
 * grant on the payer changes between a read and the write that follows it. The
 * helper reads the scope's granted connection, locks the payer, re-reads the
 * grant under that lock, and passes the re-read grant, or null when the scope
 * has no row, to `work`. Because the grant and its payer row arrive together, a
 * caller can read either view without a second query.
 */
export async function withClaudeBillingPayerLock<T>(
  owner: ClaudeBillingOwner,
  work: (tx: DrizzleTransaction, granted: ClaudeBillingGrantedConnection | null) => Promise<T>,
  onDb: DrizzleConnection = db
): Promise<T> {
  return await onDb.transaction(async tx => {
    let granted = await getGrantedClaudeBillingConnection(owner, tx);
    if (!granted) return await work(tx, null);
    await lockClaudeBillingPayer(tx, granted.connection.id);
    granted = await getGrantedClaudeBillingConnection(owner, tx);
    return await work(tx, granted);
  });
}

/**
 * The payer `removeClaudeBillingGrant` would retire for this scope, or null when
 * the scope has no link or another live grant keeps its payer. Removal asks this
 * before it retires anything, so it can end Kilo's link at Anthropic first and
 * leave the row in place when that fails.
 */
export async function findRetiringClaudeBillingPayer(
  owner: ClaudeBillingOwner,
  fromDb: DrizzleConnection = db
): Promise<UnreferencedClaudeBillingPayer | null> {
  const connection = await getGrantedClaudeBillingConnection(owner, fromDb);
  if (!connection) return null;
  const remaining = await selectNextActiveGrant(fromDb, connection.connection.id, owner);
  return remaining
    ? null
    : { id: connection.connection.id, userProfileId: connection.connection.user_profile_id };
}

export async function removeClaudeBillingGrant(
  owner: ClaudeBillingOwner,
  onDb: DrizzleConnection = db
): Promise<UnreferencedClaudeBillingPayer | null> {
  return await withClaudeBillingPayerLock(
    owner,
    async (tx, connection) => {
      if (!connection) return null;

      await activateClaudeBillingGrant(
        owner,
        connection.connection.id,
        connection.grant.created_by,
        tx
      );
      await tx
        .update(claude_billing_connection_grants)
        .set({ removed_at: new Date().toISOString() })
        .where(claudeBillingGrantOwnerWhere(owner));
      const remaining = await selectNextActiveGrant(tx, connection.connection.id);

      if (!remaining) {
        await retireClaudeBillingConnection(tx, connection.connection.id);
        return {
          id: connection.connection.id,
          userProfileId: connection.connection.user_profile_id,
        };
      }

      if (claudeBillingOwnerMatches(connection.connection, owner)) {
        await reassignPayerOwnerColumns(tx, connection.connection.id, remaining);
        return null;
      }

      await tx
        .update(claude_billing_connections)
        .set({ updated_at: sql`clock_timestamp()` })
        .where(eq(claude_billing_connections.id, connection.connection.id));
      return null;
    },
    onDb
  );
}

function ownerToInput(owner: ClaudeBillingOwner): ClaudeBillingOwnerInput {
  switch (owner.kind) {
    case 'personal':
      return {};
    case 'organization':
      return { organizationId: owner.organizationId };
  }
}

function formatScopeLabel(
  owner: ClaudeBillingOwner,
  orgNames: ReadonlyMap<string, string>
): string {
  if (owner.kind === 'personal') return 'Personal account';
  return orgNames.get(owner.organizationId) ?? 'Organization';
}

function scopeSortRank(
  owner: ClaudeBillingOwner,
  targetOrganizationId: string | undefined
): number {
  if (owner.kind === 'organization' && owner.organizationId === targetOrganizationId) return 0;
  if (owner.kind === 'personal') return 1;
  return 2;
}

/**
 * The scope order every list in this module uses: the target organization first,
 * then personal scopes, then other organizations.
 */
function compareScopeRank(
  a: ClaudeBillingOwner,
  b: ClaudeBillingOwner,
  targetOrganizationId: string | undefined
): number {
  return scopeSortRank(a, targetOrganizationId) - scopeSortRank(b, targetOrganizationId);
}

function compareScopes(
  a: ClaudeBillingOwner,
  b: ClaudeBillingOwner,
  targetOrganizationId: string | undefined,
  orgNames: ReadonlyMap<string, string>
): number {
  return (
    compareScopeRank(a, b, targetOrganizationId) ||
    formatScopeLabel(a, orgNames).localeCompare(formatScopeLabel(b, orgNames))
  );
}

export async function describeClaudeBillingSharing(
  userId: string,
  targetOwner: ClaudeBillingOwner,
  canManageTarget: boolean,
  current: ClaudeBillingConnectionRow | null,
  fromDb: DrizzleConnection = db
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
          liveClaudeBillingGrantWhere(),
          claudeBillingVisibleWhere(
            claude_billing_connection_grants.kilo_user_id,
            claude_billing_connection_grants.organization_id,
            userId,
            visibleOrgIds
          )
        )
      );
    const siblingOwners: ClaudeBillingOwner[] = [];
    for (const grant of currentGrants) {
      const owner = ownerFromColumns(grant);
      if (!owner || claudeBillingOwnerKey(owner) === targetKey) continue;
      siblingOwners.push(owner);
    }
    siblingOwners.sort((a, b) => compareScopes(a, b, targetOrganizationId, orgNames));
    sharedWith = siblingOwners.map(owner => formatScopeLabel(owner, orgNames));
  }

  const targetAcceptsShare =
    canManageTarget && claudeBillingTargetAcceptsShare(current?.status ?? null);
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
        liveClaudeBillingGrantWhere(),
        eq(claude_billing_connections.status, ClaudeBillingConnectionStatus.Connected),
        claudeBillingVisibleWhere(
          claude_billing_connection_grants.kilo_user_id,
          claude_billing_connection_grants.organization_id,
          userId,
          managedOrgList
        )
      )
    );

  const ungrantedRows = await fromDb
    .select()
    .from(claude_billing_connections)
    .where(
      and(
        eq(claude_billing_connections.status, ClaudeBillingConnectionStatus.Connected),
        claudeBillingVisibleWhere(
          claude_billing_connections.kilo_user_id,
          claude_billing_connections.organization_id,
          userId,
          managedOrgList
        ),
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
    if (scopeOwner.kind === 'organization' && !managedOrgIds.has(scopeOwner.organizationId)) {
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

  const collected: Array<{
    primary: ClaudeBillingOwner;
    link: ClaudeBillingShareableLink;
  }> = [];
  for (const { payer, scopes } of byPayer.values()) {
    if (payer.created_by !== userId && !scopes.some(scope => scope.kind === 'personal')) {
      continue;
    }
    scopes.sort((a, b) => compareScopes(a, b, targetOrganizationId, orgNames));
    const primary = scopes[0];
    if (!primary) continue;
    collected.push({
      primary,
      link: {
        payerId: payer.id,
        source: ownerToInput(primary),
        label: scopes.map(scope => formatScopeLabel(scope, orgNames)).join(', '),
        connectedAt: payer.connected_at ? new Date(payer.connected_at).toISOString() : null,
      },
    });
  }

  collected.sort(
    (a, b) =>
      compareScopeRank(a.primary, b.primary, targetOrganizationId) ||
      a.link.label.localeCompare(b.link.label)
  );

  return {
    shareableLinks: collected.map(item => item.link),
    sharedWith,
  };
}

/**
 * Clears the grants a deleted person held. An organization connection and its
 * grant stay when the connector is erased: the connection belongs to the
 * organization, and the row keeps `created_by` as the record of who linked it
 * until an organization owner reconnects it. Routing and the billing card
 * report that connection as requiring a reconnect while its connector is gone.
 */
export async function removeUserClaudeBillingGrants(
  userId: string,
  onDb: DrizzleConnection
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
      const remaining = await selectNextActiveGrant(tx, payerId);

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
 * Columns that refusal bookkeeping may change on a connected row.
 */
type ConnectedClaudeBillingConnectionChange = Partial<
  Pick<ClaudeBillingConnectionRow, 'status' | 'last_refusal_at'>
> & { last_refusal_code?: string | null | SQL };

/**
 * Updates only the connected row that refused the request: the same profile with
 * the same `connected_at`, so a removal or a newer reconnect is never undone.
 * `updated_at` keeps its value because an approval already in flight is keyed on it.
 */
async function updateConnectedClaudeBillingConnection(
  userProfileId: string,
  connectedAt: string,
  change: ConnectedClaudeBillingConnectionChange,
  onDb: DrizzleConnection = db
): Promise<void> {
  await onDb
    .update(claude_billing_connections)
    .set({
      ...change,
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

/**
 * Anthropic refused a request for this profile with `user_profile_not_billable`
 * or `user_profile_billing_not_authorized`. Later requests fail without an
 * upstream call until an admin acts. Only a connected row changes, so a removal
 * or a newer reconnect is never undone.
 */
export async function markClaudeBillingUnavailable(
  userProfileId: string,
  refusalCode: string,
  connectedAt: string,
  onDb: DrizzleConnection = db
): Promise<void> {
  await updateConnectedClaudeBillingConnection(
    userProfileId,
    connectedAt,
    {
      status: ClaudeBillingConnectionStatus.BillingUnavailable,
      last_refusal_code: refusalCode,
      last_refusal_at: new Date().toISOString(),
    },
    onDb
  );
}

/** Records a refusal that leaves the connection usable, such as a spend limit. */
export async function recordClaudeBillingRefusal(
  userProfileId: string,
  refusalCode: string,
  connectedAt: string,
  onDb: DrizzleConnection = db
): Promise<void> {
  const keptCodes = specificRefusalCodesFor(refusalCode);
  await updateConnectedClaudeBillingConnection(
    userProfileId,
    connectedAt,
    {
      // A status-only code says only what the stored specific code already said,
      // so the specific one stays; a specific code always replaces what it finds.
      last_refusal_code: keptCodes.length
        ? sql`case when ${claude_billing_connections.last_refusal_code} in (${sql.join(
            keptCodes.map(code => sql`${code}`),
            sql`, `
          )}) then ${claude_billing_connections.last_refusal_code} else ${refusalCode} end`
        : refusalCode,
      last_refusal_at: new Date().toISOString(),
    },
    onDb
  );
}

/** A request the customer paid for succeeded, so an earlier refusal no longer applies. */
export async function clearClaudeBillingRefusal(
  userProfileId: string,
  connectedAt: string,
  onDb: DrizzleConnection = db
): Promise<void> {
  await updateConnectedClaudeBillingConnection(
    userProfileId,
    connectedAt,
    {
      last_refusal_code: null,
      last_refusal_at: null,
    },
    onDb
  );
}
