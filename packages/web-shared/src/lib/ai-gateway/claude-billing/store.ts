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
  readDb,
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

/**
 * Clears the row that holds an owner's columns: the row goes to the next live
 * grant, or is retired when no grant keeps it. The occupant's payer key is taken
 * before the read that decides, because the row and its grants change only
 * under that key. `heldLockKeys` names the keys the caller's transaction already
 * holds, and this function adds every key it takes to that same set, so a later
 * owner-column change in the same transaction sees them. A payer key at or below
 * a held one would break the ascending rule, so the transaction restarts.
 */
async function freeClaudeBillingOwnerColumns(
  owner: ClaudeBillingOwner,
  exceptPayerId: string | null,
  heldLockKeys: Set<string>,
  tx: DrizzleTransaction
): Promise<void> {
  const occupantWhere = and(
    claudeBillingOwnerWhere(owner),
    ne(claude_billing_connections.status, ClaudeBillingConnectionStatus.Removed),
    ...(exceptPayerId ? [ne(claude_billing_connections.id, exceptPayerId)] : [])
  );
  // Each pass adds one payer key to the caller's set, and a payer row changes
  // only under its own key, so the loop ends at the first occupant already held.
  for (;;) {
    const [occupant] = await tx
      .select()
      .from(claude_billing_connections)
      .where(occupantWhere)
      .limit(1);
    if (!occupant) return;

    const occupantLockKey = claudeBillingPayerLockKey(occupant.id);
    if (!heldLockKeys.has(occupantLockKey)) {
      if (!isAboveHeldLockKeys(occupantLockKey, heldLockKeys)) {
        throw new ClaudeBillingLockRetry(occupantLockKey);
      }
      await lockClaudeBillingPayer(tx, occupant.id);
      heldLockKeys.add(occupantLockKey);
      // The probe ran unlocked, so the decision needs a read under the key.
      continue;
    }

    const otherGrant = await selectNextActiveGrant(tx, occupant.id, owner);

    if (otherGrant) {
      await writePayerOwnerColumns(tx, occupant.id, otherGrant);
      return;
    }

    await retireClaudeBillingConnection(tx, occupant.id);
    return;
  }
}

/**
 * Stores a fresh profile for a scope and makes it the scope's grant. The clear
 * of an existing occupant and the insert run in one transaction, because the
 * occupant's payer lock must span both statements. The first batch takes the
 * keys an earlier attempt could not take plus this scope's claim key, sorted as
 * one union, so a first grant into an empty scope is serialised. A restart
 * repeats nothing, because the clear and the insert are idempotent.
 */
export async function insertClaudeBillingProfile(
  owner: ClaudeBillingOwner,
  userProfileId: string,
  createdBy: string,
  onDb: DrizzleConnection = db
): Promise<ClaudeBillingConnectionRow> {
  return await withClaudeBillingLockRetry(extraLockKeys =>
    onDb.transaction(async tx => {
      const claimKey = claudeBillingOwnerLockKey(owner);
      await lockClaudeBillingKeys(tx, [...extraLockKeys, claimKey]);
      const heldLockKeys = new Set([...extraLockKeys, claimKey]);
      await freeClaudeBillingOwnerColumns(owner, null, heldLockKeys, tx);
      await tx
        .insert(claude_billing_connections)
        .values({
          ...ownerColumns(owner),
          user_profile_id: userProfileId,
          created_by: createdBy,
        })
        .onConflictDoNothing();
      const [row] = await tx
        .select()
        .from(claude_billing_connections)
        .where(eq(claude_billing_connections.user_profile_id, userProfileId))
        .limit(1);
      if (!row) throw new Error('Claude billing connection row is missing after insert');
      if (!claudeBillingOwnerMatches(row, owner)) {
        const [existingGrant] = await tx
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
      await activateClaudeBillingGrant(owner, row.id, createdBy, tx);
      return row;
    })
  );
}

export class ClaudeBillingShareError extends Error {
  constructor(readonly reason: 'source_unavailable' | 'source_forbidden' | 'target_connected') {
    super(`Claude payer sharing failed: ${reason}`);
  }
}

/**
 * The restart loop could not reach a key order it could hold, so the work did
 * not run. `lockKey` is the key the loop stopped on: one it already held, or one
 * it reached at the safety cap. Callers may retry the request; the internal
 * restart signal stays private.
 */
export class ClaudeBillingLockBusyError extends Error {
  constructor(readonly lockKey: string) {
    super('Claude billing locks stayed busy; retry the request');
  }
}

/**
 * Signals that the transaction would have to wait for a lock key at or below a
 * key it already holds. The transaction aborts, and the caller restarts the
 * operation with that key added to its lock set. `lockKey` is the key the next
 * attempt must take as well. Only a key the loop already collected, or the
 * safety cap, surfaces as `ClaudeBillingLockBusyError`, never as this signal.
 */
class ClaudeBillingLockRetry extends Error {
  constructor(readonly lockKey: string) {
    super('Claude billing locks must be retaken in ascending key order');
  }
}

/**
 * A guard against a logic error, not a policy limit: no legitimate operation
 * reaches it.
 *
 * The real bound is the number of distinct lock keys one operation can discover,
 * which is the claim keys it names plus one payer key per row it touches. Each
 * restart adds one key it has not taken, and a repeated key is a genuine cycle
 * that ends the loop, so the loop can only stop early when a caller discovers
 * more keys than this cap, in which case a bug in the discovery is the cause.
 */
const CLAUDE_BILLING_LOCK_ATTEMPT_CAP = 64;

/** The lock key of a payer row: the grants and the owner columns of that row change under it. */
export function claudeBillingPayerLockKey(payerConnectionId: string): string {
  return `claude_billing_grant:${payerConnectionId}`;
}

/**
 * The lock key of a scope that is taking a payer: `claudeBillingOwnerKey` gives a
 * stable identity per scope. A scope can hold a grant before it holds a row, so
 * the claim key serialises the first grant into a scope. Without it, two shares
 * from different payers into one empty scope would each see no row and both
 * report success.
 */
export function claudeBillingOwnerLockKey(owner: ClaudeBillingOwner): string {
  return `claude_billing_claim:${claudeBillingOwnerKey(owner)}`;
}

/**
 * The lock key that serialises first-time profile creation for a scope.
 *
 * This key sits outside the module's ascending order, and it is safe only under
 * one premise: no transaction ever waits for it while holding a claim or payer
 * key. Nothing else takes a profile key, so no billing writer can be blocked by
 * one, and `ensureClaudeBillingProfile` takes it before it reaches
 * `insertClaudeBillingProfile`, which then takes claim and payer keys. Keep that
 * order if another path ever coordinates profile creation: a reader that took a
 * claim or payer key and then waited on a profile key would close a wait cycle
 * that no retry covers. It is not taken inside `insertClaudeBillingProfile`
 * because first-time creation wraps an external provider call, and sharing must
 * not wait on that call.
 */
export function claudeBillingProfileLockKey(owner: ClaudeBillingOwner): string {
  return `claude_billing_profile:${claudeBillingOwnerKey(owner)}`;
}

async function lockClaudeBillingPayer(tx: DrizzleTransaction, payerConnectionId: string) {
  await lockClaudeBillingKeys(tx, [claudeBillingPayerLockKey(payerConnectionId)]);
}

/**
 * Locks every distinct key in ascending order. Keys come from two namespaces, in
 * this sort order: `claude_billing_claim:` per scope that takes a payer, then
 * `claude_billing_grant:` per payer row.
 *
 * A transaction that holds keys only ever waits for a key greater than every key
 * it holds. Two holders therefore cannot wait for each other, so no wait cycle
 * can form. A caller that would have to wait for a key at or below a key it
 * holds aborts its transaction with `ClaudeBillingLockRetry` and retries from
 * scratch with that key added, which takes the wider set in order. The claim
 * namespace sorts before the payer namespace, so a claim key never has to be
 * taken after a discovered payer key.
 *
 * `claude_billing_profile:` is deliberately not part of this order; see
 * `claudeBillingProfileLockKey` for the premise that keeps it safe.
 */
async function lockClaudeBillingKeys(
  tx: DrizzleTransaction,
  lockKeys: Iterable<string>
): Promise<void> {
  const keys = new Set(lockKeys);
  for (const key of [...keys].sort()) {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${key}))`);
  }
}

/** Locks the payer keys of the given rows, which is `lockClaudeBillingKeys` over their keys. */
async function lockClaudeBillingPayers(
  tx: DrizzleTransaction,
  payerConnectionIds: Iterable<string | null | undefined>
): Promise<void> {
  const lockKeys: string[] = [];
  for (const payerConnectionId of payerConnectionIds) {
    if (payerConnectionId != null) lockKeys.push(claudeBillingPayerLockKey(payerConnectionId));
  }
  await lockClaudeBillingKeys(tx, lockKeys);
}

/** Whether a key sorts above every key the transaction holds, so waiting for it cannot close a cycle. */
function isAboveHeldLockKeys(lockKey: string, heldLockKeys: ReadonlySet<string>): boolean {
  for (const held of heldLockKeys) {
    if (lockKey <= held) return false;
  }
  return true;
}

/**
 * Runs `attempt` again when a transaction asks to retake its locks, and passes
 * the keys every attempt must take as well.
 *
 * Each restart adds the key the attempt could not take, so each one makes
 * progress: that key was outside the collected set, and the next attempt takes it
 * in ascending order with the rest. A restart therefore needs one attempt per
 * distinct lower key an operation discovers, and only two things end the loop
 * early. A key that is already in the collected set cannot change the key order,
 * so the next attempt would fail the same way: that is a genuine cycle. The
 * safety cap, `CLAUDE_BILLING_LOCK_ATTEMPT_CAP`, exists for the same reason. Both
 * surface as `ClaudeBillingLockBusyError` after one `console.warn`, so the
 * restart signal never leaves this function.
 */
async function withClaudeBillingLockRetry<T>(
  attempt: (extraLockKeys: ReadonlySet<string>) => Promise<T>
): Promise<T> {
  const extraLockKeys = new Set<string>();
  for (;;) {
    try {
      return await attempt(extraLockKeys);
    } catch (error) {
      if (!(error instanceof ClaudeBillingLockRetry)) throw error;
      if (
        extraLockKeys.has(error.lockKey) ||
        extraLockKeys.size >= CLAUDE_BILLING_LOCK_ATTEMPT_CAP
      ) {
        console.warn(
          '[claude-billing] lock retry cannot make progress: %s (after %d restarts)',
          error.lockKey,
          extraLockKeys.size
        );
        throw new ClaudeBillingLockBusyError(error.lockKey);
      }
      extraLockKeys.add(error.lockKey);
    }
  }
}

export async function shareClaudeBillingConnection(
  sourceOwner: ClaudeBillingOwner,
  targetOwner: ClaudeBillingOwner,
  createdBy: string,
  onDb: DrizzleConnection = db
): Promise<ClaudeBillingConnectionRow> {
  return await withClaudeBillingPayersLock(
    [sourceOwner, targetOwner],
    async (tx, [source, target]) => {
      if (!source || source.connection.status !== ClaudeBillingConnectionStatus.Connected) {
        throw new ClaudeBillingShareError('source_unavailable');
      }
      // The advisory lock is not taken by a cascade delete, so ask again that the
      // payer still exists and hold it: a key-share lock blocks a parent delete of
      // the account that owns it until this transaction commits. Without one, a
      // grant naming a deleted payer would fail on the foreign key instead of
      // answering as an unavailable source.
      const [livePayer] = await tx
        .select({ id: claude_billing_connections.id })
        .from(claude_billing_connections)
        .where(eq(claude_billing_connections.id, source.connection.id))
        .limit(1)
        .for('key share');
      if (!livePayer) {
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
  remaining: ClaudeBillingOwnerColumns,
  heldLockKeys: Set<string>
): Promise<void> {
  const nextOwner = ownerFromColumns(remaining);
  if (nextOwner) {
    await freeClaudeBillingOwnerColumns(nextOwner, payerConnectionId, heldLockKeys, tx);
  }
  await writePayerOwnerColumns(tx, payerConnectionId, remaining);
}

/**
 * Runs `work` while holding the locks that sharing and removal take, so no grant
 * on the payer changes between a read and the write that follows it.
 *
 * Two namespaces share one ascending total order:
 * - `claude_billing_grant:<payer id>` guards a payer row and its grants. Every
 *   payer whose row or grant `work` changes is locked before the reads that
 *   decide: this helper locks the payer the scope holds now, and a helper that
 *   meets another payer row calls `freeClaudeBillingOwnerColumns`, which takes
 *   that payer's key before it decides anything. A hand-over to a scope that
 *   already has a row is serialised by that payer key, because every reader of
 *   the scope resolves the same row and takes the same key.
 * - `claude_billing_claim:<owner key>` guards a scope that is taking a payer. A
 *   scope can hold a grant before it holds a row, so the claim serialises the
 *   first grant into a scope.
 *
 * Claim keys are taken only in the first batch, for the scopes this entry point
 * names. Nothing takes a claim key later in a transaction: a claim key sorts below
 * every payer key, so taking one after a payer key would break the order.
 *
 * A transaction only ever waits for a key above every key it holds, so no two
 * holders can wait for each other. A re-read that resolves another payer restarts
 * the transaction with the wider key set, and that restart makes progress because
 * the key was outside it. Only a repeated key or the safety cap surfaces as
 * `ClaudeBillingLockBusyError`.
 *
 * `work` also receives the keys this transaction holds, which it must pass to any
 * owner-column change so the ascending rule keeps holding.
 *
 * Because the grant and its payer row arrive together, a caller can read either
 * view without a second query.
 */
export async function withClaudeBillingPayerLock<T>(
  owner: ClaudeBillingOwner,
  work: (
    tx: DrizzleTransaction,
    granted: ClaudeBillingGrantedConnection | null,
    heldLockKeys: Set<string>
  ) => Promise<T>,
  onDb: DrizzleConnection = db
): Promise<T> {
  return await withClaudeBillingLockRetry(extraLockKeys =>
    onDb.transaction(async tx => {
      const claimKey = claudeBillingOwnerLockKey(owner);
      await lockClaudeBillingKeys(tx, [...extraLockKeys, claimKey]);
      // One mutable set per transaction: a change `work` makes adds its keys here,
      // so a later owner-column change in the same transaction sees them.
      const heldLockKeys = new Set([...extraLockKeys, claimKey]);
      let granted = await getGrantedClaudeBillingConnection(owner, tx);
      if (!granted) return await work(tx, null, heldLockKeys);
      const payerLockKey = claudeBillingPayerLockKey(granted.connection.id);
      if (!heldLockKeys.has(payerLockKey)) {
        if (!isAboveHeldLockKeys(payerLockKey, heldLockKeys)) {
          throw new ClaudeBillingLockRetry(payerLockKey);
        }
        await lockClaudeBillingPayer(tx, granted.connection.id);
        heldLockKeys.add(payerLockKey);
      }
      granted = await getGrantedClaudeBillingConnection(owner, tx);
      if (granted && !heldLockKeys.has(claudeBillingPayerLockKey(granted.connection.id))) {
        throw new ClaudeBillingLockRetry(claudeBillingPayerLockKey(granted.connection.id));
      }
      return await work(tx, granted, heldLockKeys);
    })
  );
}

/**
 * Runs `work` while holding the locks of every named scope, which is what sharing
 * needs: it validates the source, activates the target grant and decides whether
 * the target's earlier row still has an owner, and each of those reads must see a
 * payer no other holder can change.
 *
 * The first batch takes the retry extras plus a claim key for every owner in
 * `owners`, sorted as one union, so two first shares into one empty scope cannot
 * both report success. The helper then reads each scope's granted connection,
 * locks the union of those payer keys in ascending order, and re-reads every scope
 * under the locks. Claim keys are never taken after the first batch: a claim key
 * sorts below every payer key, so a later claim would break the order. A re-read
 * that resolves a payer outside the locked union restarts the transaction with the
 * wider union, and that restart makes progress because the payer key was outside
 * it. Only a repeated key or the safety cap surfaces as
 * `ClaudeBillingLockBusyError`. `work` receives the re-read grants in the order of
 * `owners`; a scope without a row contributes `null`. `work` also receives the one
 * key set of this transaction, and every owner-column change it makes adds its
 * keys to that same set.
 */
export async function withClaudeBillingPayersLock<T>(
  owners: readonly ClaudeBillingOwner[],
  work: (
    tx: DrizzleTransaction,
    grants: Array<ClaudeBillingGrantedConnection | null>,
    heldLockKeys: Set<string>
  ) => Promise<T>,
  onDb: DrizzleConnection = db
): Promise<T> {
  return await withClaudeBillingLockRetry(extraLockKeys =>
    onDb.transaction(async tx => {
      // One mutable set per transaction: a change `work` makes adds its keys here,
      // so a later owner-column change in the same transaction sees them.
      const heldLockKeys = new Set(extraLockKeys);
      for (const owner of owners) heldLockKeys.add(claudeBillingOwnerLockKey(owner));
      await lockClaudeBillingKeys(tx, heldLockKeys);

      const probed: Array<ClaudeBillingGrantedConnection | null> = [];
      for (const owner of owners) {
        probed.push(await getGrantedClaudeBillingConnection(owner, tx));
      }
      // A payer key below a held key would have to wait for a lower key, so the
      // attempt aborts and the next one takes the merged set in one batch.
      for (const granted of probed) {
        if (!granted) continue;
        const payerLockKey = claudeBillingPayerLockKey(granted.connection.id);
        if (!heldLockKeys.has(payerLockKey) && !isAboveHeldLockKeys(payerLockKey, heldLockKeys)) {
          throw new ClaudeBillingLockRetry(payerLockKey);
        }
      }
      const discovered = new Set<string>();
      for (const granted of probed) {
        if (granted) discovered.add(granted.connection.id);
      }
      await lockClaudeBillingPayers(tx, discovered);
      for (const payerId of discovered) heldLockKeys.add(claudeBillingPayerLockKey(payerId));

      const grants: Array<ClaudeBillingGrantedConnection | null> = [];
      for (const owner of owners) {
        const granted = await getGrantedClaudeBillingConnection(owner, tx);
        if (granted && !heldLockKeys.has(claudeBillingPayerLockKey(granted.connection.id))) {
          throw new ClaudeBillingLockRetry(claudeBillingPayerLockKey(granted.connection.id));
        }
        grants.push(granted);
      }
      return await work(tx, grants, heldLockKeys);
    })
  );
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

/**
 * Removes a scope's grant inside the caller's transaction, using the granted
 * connection the enclosing helper already resolved. This variant installs no
 * retry of its own: the transaction's owner owns the retry, so a payer row it
 * must free below a held key restarts the whole attempt and takes the merged key
 * set in one ascending batch.
 *
 * `heldLockKeys` is the caller's key set; this function adds to it every key it
 * takes, so a later owner-column change in the same transaction sees them.
 */
export async function removeClaudeBillingGrantWithin(
  tx: DrizzleTransaction,
  owner: ClaudeBillingOwner,
  granted: ClaudeBillingGrantedConnection | null,
  heldLockKeys: Set<string>
): Promise<UnreferencedClaudeBillingPayer | null> {
  if (!granted) return null;

  await activateClaudeBillingGrant(owner, granted.connection.id, granted.grant.created_by, tx);
  await tx
    .update(claude_billing_connection_grants)
    .set({ removed_at: new Date().toISOString() })
    .where(claudeBillingGrantOwnerWhere(owner));
  const remaining = await selectNextActiveGrant(tx, granted.connection.id);

  if (!remaining) {
    await retireClaudeBillingConnection(tx, granted.connection.id);
    return {
      id: granted.connection.id,
      userProfileId: granted.connection.user_profile_id,
    };
  }

  if (claudeBillingOwnerMatches(granted.connection, owner)) {
    await reassignPayerOwnerColumns(tx, granted.connection.id, remaining, heldLockKeys);
    return null;
  }

  await tx
    .update(claude_billing_connections)
    .set({ updated_at: sql`clock_timestamp()` })
    .where(eq(claude_billing_connections.id, granted.connection.id));
  return null;
}

/**
 * Removes a scope's grant in its own transaction, under the locks that sharing
 * takes. This entry point owns the retry, because it owns the transaction: a
 * payer row it must free below a held key restarts the whole attempt with the
 * merged key set. A caller that already holds a transaction calls
 * `removeClaudeBillingGrantWithin` instead, so the enclosing retry owns both key
 * sets.
 */
export async function removeClaudeBillingGrant(
  owner: ClaudeBillingOwner,
  onDb: DrizzleConnection = db
): Promise<UnreferencedClaudeBillingPayer | null> {
  return await withClaudeBillingPayerLock(
    owner,
    async (tx, granted, heldLockKeys) =>
      await removeClaudeBillingGrantWithin(tx, owner, granted, heldLockKeys),
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
 *
 * The transaction locks every payer the person appears on, in the one ascending
 * order the module uses for all three key namespaces, so the deletes and the
 * owner reassignments below only wait for keys above the ones held. It takes no
 * claim key: it names payer rows, not a scope that is taking a payer. One key set
 * covers the whole loop, and every owner-column change adds the keys it takes to
 * it, so a later reassignment sees what an earlier one holds. A reassignment that
 * meets another payer row below a held key restarts the whole attempt: the
 * deletes and the reassignments are idempotent, and each restart adds the key it
 * could not take, so a person with several such payers still finishes. Only a
 * repeated key or the safety cap surfaces as `ClaudeBillingLockBusyError`.
 *
 * The account-deletion transaction calls this with its own `tx`. A restart is
 * then a savepoint restart: PostgreSQL releases the keys a savepoint took when it
 * rolls back to it, and that enclosing transaction holds no other Claude billing
 * key, so the restart keeps the ascending rule with keys nobody else holds.
 */
export async function removeUserClaudeBillingGrants(
  userId: string,
  onDb: DrizzleConnection
): Promise<void> {
  await withClaudeBillingLockRetry(extraLockKeys =>
    onDb.transaction(async tx => {
      await lockClaudeBillingKeys(tx, extraLockKeys);
      const grantPayers = await tx
        .select({ payerId: claude_billing_connection_grants.payer_connection_id })
        .from(claude_billing_connection_grants)
        .where(eq(claude_billing_connection_grants.kilo_user_id, userId));
      const directPayers = await tx
        .select({ payerId: claude_billing_connections.id })
        .from(claude_billing_connections)
        .where(eq(claude_billing_connections.kilo_user_id, userId));
      const payerIds = new Set<string>();
      for (const row of [...grantPayers, ...directPayers]) payerIds.add(row.payerId);
      const discovered = new Set<string>();
      for (const payerId of payerIds) discovered.add(claudeBillingPayerLockKey(payerId));
      // A key below a held key would have to wait for a lower key, so the attempt
      // aborts and the next one takes the merged set in one batch.
      for (const lockKey of discovered) {
        if (!extraLockKeys.has(lockKey) && !isAboveHeldLockKeys(lockKey, extraLockKeys)) {
          throw new ClaudeBillingLockRetry(lockKey);
        }
      }
      await lockClaudeBillingKeys(tx, discovered);
      // One mutable set for the whole loop: each reassignment adds the keys it
      // takes, so a later one sees them.
      const heldLockKeys = new Set([...extraLockKeys, ...discovered]);

      await tx
        .delete(claude_billing_connection_grants)
        .where(eq(claude_billing_connection_grants.kilo_user_id, userId));

      for (const payerId of [...payerIds].sort()) {
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
            await reassignPayerOwnerColumns(tx, payerId, remaining, heldLockKeys);
          }
        }
      }
    })
  );
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

/**
 * A request the customer paid for succeeded, so an earlier refusal no longer
 * applies.
 *
 * Almost every success finds nothing to clear, so the common case must not write:
 * the row keeps its version and no update touches it. An unlocked read of the
 * replica answers whether a refusal is recorded. A replica that misses a refusal
 * recorded moments ago skips this clear, and the next success clears it. A replica
 * that still shows a cleared refusal only falls through to the guarded primary
 * update, which changes nothing. A failed replica read falls back to that update
 * as well. The update matches only the same profile with the same `connected_at`
 * on a connected row, so neither path can undo a removal or a newer reconnect.
 */
export async function clearClaudeBillingRefusal(
  userProfileId: string,
  connectedAt: string,
  onDb: DrizzleConnection = db
): Promise<void> {
  try {
    const [recorded] = await readDb
      .select({ last_refusal_code: claude_billing_connections.last_refusal_code })
      .from(claude_billing_connections)
      .where(
        and(
          eq(claude_billing_connections.user_profile_id, userProfileId),
          eq(claude_billing_connections.connected_at, connectedAt),
          eq(claude_billing_connections.status, ClaudeBillingConnectionStatus.Connected)
        )
      )
      .limit(1);
    if (!recorded?.last_refusal_code) return;
  } catch (error) {
    // An unavailable replica must not stop the clear: the guarded update below
    // re-checks on the primary, exactly as before the pre-check existed.
    console.debug(
      '[claude-billing] refusal pre-check failed, falling back to the primary: %s',
      error instanceof Error ? error.name : 'UnknownError'
    );
  }

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

/**
 * The retry loop and its restart signal, so a test can prove how the loop ends
 * in cases no public path can build: every caller checks the key it holds first,
 * so a repeated key and the safety cap are unreachable through the store.
 */
export const __test__ = {
  withClaudeBillingLockRetry,
  lockRetrySignal: (lockKey: string) => new ClaudeBillingLockRetry(lockKey),
};
