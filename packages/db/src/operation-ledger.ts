/**
 * Shared per-intent operation ledger (P1-A-08a / DEC-01).
 *
 * One row per `(kilo_user_id, domain, operation_key)` identity. Admission is
 * concurrent-safe: exactly one caller admits, the rest receive the typed
 * duplicate/takeover outcome and never re-execute the effect. Reconciliation
 * of a `reconcile_pending` row is serialized by the same `lease_expires_at`
 * column: exactly one retry atomically claims the lease and reconciles, the
 * rest receive `duplicate_reconcile_in_progress`, and an expired
 * reconciliation lease can be claimed by a later retry. Terminal settles
 * are CAS from `admitted | reconcile_pending`; a second settle is a no-op.
 * The analytics outbox row is written in the same transaction as the settle,
 * so settle-plus-outbox is atomic, and ONLY the helpers in this file insert
 * `analytics_event_outbox` rows (grep-enforced invariant).
 *
 * Retention: rows expire `LEDGER_RETENTION_DAYS` (30) after `admitted_at`. An
 * expired row (any status) is deleted and re-admitted by the next admit.
 * `canonical_result` is bounded at `MAX_CANONICAL_RESULT_BYTES` (4096)
 * serialized bytes; the settle helper rejects larger payloads.
 *
 * Event identity: a definitive outbox `event_uuid` is a deterministic UUIDv5
 * of `` `${ledger_row_id}:${event_name}` ``. An ambiguous phase adds the
 * `:ambiguous` suffix, so later reconciliation can emit the terminal outcome.
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { ExtractTablesWithRelations } from 'drizzle-orm';
import type { NodePgDatabase, NodePgQueryResultHKT } from 'drizzle-orm/node-postgres';
import type { PgTransaction } from 'drizzle-orm/pg-core';
import { ANALYTICS_EVENT_SCHEMAS } from '@kilocode/app-shared/analytics';
import type { AnalyticsEventMap, TerminalOutcomeEventName } from '@kilocode/app-shared/analytics';

import type * as schema from './schema';
import {
  analytics_event_outbox,
  operation_ledgers,
  type AnalyticsEventOutboxRow,
  type NewAnalyticsEventOutboxRow,
  type NewOperationLedgerRow,
  type OperationLedgerRow,
} from './schema';

// ----- constants -----------------------------------------------------------

/** Ledger rows are retained 30 days after admission (the dedupe window). */
export const LEDGER_RETENTION_DAYS = 30;

/** `canonical_result` is bounded at 4096 serialized bytes (DEC-01). */
export const MAX_CANONICAL_RESULT_BYTES = 4096;

/** Fixed UUIDv5 namespace literal for outbox event identities (DEC-01). */
export const EVENT_UUID_NAMESPACE = 'c3a4f8e0-8e34-45b2-9c1d-7a2b5e6d4f10';

/** Mutation taxonomy (DEC-01). */
export const OPERATION_TAXONOMIES = ['safe-retry', 'reconcile-first', 'never-replay'] as const;
export type OperationTaxonomy = (typeof OPERATION_TAXONOMIES)[number];

/** Ledger domains. `create_remote` session identity lives in the DO, not here. */
export const OPERATION_DOMAINS = ['session', 'pr', 'security'] as const;
export type OperationDomain = (typeof OPERATION_DOMAINS)[number];

export const OPERATION_TERMINAL_STATUSES = [
  'completed',
  'failed',
  'no_op',
  'interrupted',
  'superseded',
] as const;
export type TerminalOperationStatus = (typeof OPERATION_TERMINAL_STATUSES)[number];

export const OPERATION_NON_TERMINAL_STATUSES = ['admitted', 'reconcile_pending'] as const;

export function isTerminalOperationStatus(status: string): status is TerminalOperationStatus {
  return (OPERATION_TERMINAL_STATUSES as readonly string[]).includes(status);
}

// ----- connection types ------------------------------------------------------

export type LedgerTransaction = PgTransaction<
  NodePgQueryResultHKT,
  typeof schema,
  ExtractTablesWithRelations<typeof schema>
>;

/** Accepts either a `NodePgDatabase` or an open transaction. */
export type LedgerDatabase = NodePgDatabase<typeof schema> | LedgerTransaction;

// ----- public errors ---------------------------------------------------------

/** Thrown when `canonical_result` would exceed 4096 serialized bytes. */
export class CanonicalResultTooLargeError extends Error {
  constructor(bytes: number) {
    super(
      `Operation ledger canonical_result is ${bytes} serialized bytes; the limit is ${MAX_CANONICAL_RESULT_BYTES}`
    );
    this.name = 'CanonicalResultTooLargeError';
  }
}

/** Thrown when an outbox event payload fails the shared catalog schema. */
export class OutboxEventValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OutboxEventValidationError';
  }
}

// ----- input / output types ---------------------------------------------------

export type AdmitOperationInput = {
  /** The acting user. */
  userId: string;
  /** Organization context when the operation is organization-scoped. */
  orgId?: string | null;
  domain: OperationDomain;
  intent: string;
  /** Client-generated UUID, stable across retries of one user intent. */
  operationKey: string;
  /** Domain resource identity (for example `owner/repo#number`). Never analytics. */
  resourceKey?: string | null;
  taxonomy: OperationTaxonomy;
  /** Lease duration for the `admitted` claim, in seconds. */
  leaseSeconds: number;
};

export type AdmitOperationResult =
  | { admission: 'admitted'; row: OperationLedgerRow }
  | { admission: 'duplicate_settled'; row: OperationLedgerRow }
  | { admission: 'duplicate_in_flight'; row: OperationLedgerRow }
  | { admission: 'takeover'; row: OperationLedgerRow }
  | { admission: 'duplicate_reconcile_pending'; row: OperationLedgerRow }
  | { admission: 'duplicate_reconcile_in_progress'; row: OperationLedgerRow };

/** Terminal outbox event input, correlated by event name. */
export type OutboxEventInput = {
  [K in TerminalOutcomeEventName]: {
    eventName: K;
    /** Identity channel (the user's email), not an event property. */
    distinctId: string;
    properties: AnalyticsEventMap[K];
  };
}[TerminalOutcomeEventName];

export type SettleOperationInput = {
  rowId: string;
  status: TerminalOperationStatus;
  outcomeCode?: string | null;
  canonicalResult?: Record<string, unknown> | null;
  outboxEvent?: OutboxEventInput | null;
};

export type SettleOperationResult =
  | { settled: true; row: OperationLedgerRow }
  | { settled: false; row: OperationLedgerRow | null };

export type MarkReconcilePendingInput = {
  rowId: string;
  outboxEvent?: OutboxEventInput | null;
};

// ----- unit-of-work helpers ----------------------------------------------------

/** True when `value` is a database instance rather than an open transaction. */
function isDatabase(database: LedgerDatabase): database is NodePgDatabase<typeof schema> {
  // `drizzle()` attaches `$client` to database instances; transactions never have it.
  return typeof (database as { $client?: unknown }).$client !== 'undefined';
}

/** Runs `work` in its own transaction, or inline when given an open transaction. */
async function runInTransaction<T>(
  database: LedgerDatabase,
  work: (tx: LedgerTransaction) => Promise<T>
): Promise<T> {
  if (isDatabase(database)) {
    return database.transaction(work);
  }
  return work(database);
}

/**
 * Merges `patch` over the row's stored `canonical_result` and enforces the
 * `MAX_CANONICAL_RESULT_BYTES` bound. Throws before any write, so an oversized
 * merge leaves the row unchanged.
 */
function mergeCanonicalResult(
  row: OperationLedgerRow,
  patch: Record<string, unknown> | null | undefined
): Record<string, unknown> {
  const merged = { ...(row.canonical_result ?? {}), ...(patch ?? {}) };
  const bytes = new TextEncoder().encode(JSON.stringify(merged)).length;
  if (bytes > MAX_CANONICAL_RESULT_BYTES) {
    throw new CanonicalResultTooLargeError(bytes);
  }
  return merged;
}

// ----- admission ----------------------------------------------------------------

function admissionInsertValues(input: AdmitOperationInput, now: Date): NewOperationLedgerRow {
  return {
    operation_key: input.operationKey,
    domain: input.domain,
    intent: input.intent,
    kilo_user_id: input.userId,
    organization_id: input.orgId ?? null,
    resource_key: input.resourceKey ?? null,
    taxonomy: input.taxonomy,
    status: 'admitted',
    admitted_at: now.toISOString(),
    lease_expires_at: new Date(now.getTime() + input.leaseSeconds * 1000).toISOString(),
    expires_at: new Date(now.getTime() + LEDGER_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString(),
  };
}

/**
 * Admits an operation. Concurrent same-key admits produce exactly one
 * `admitted` row; the loser receives the typed duplicate outcome. An expired
 * row (`expires_at` past, any status) is deleted and re-inserted in one
 * transaction. A live-lease `admitted` row is `duplicate_in_flight`; an
 * expired-lease `admitted` row is a compare-and-set `takeover` that renews
 * the lease. A `reconcile_pending` row with an expired/claimable lease is
 * claimed by exactly one retry (`duplicate_reconcile_pending`); concurrent
 * retries during the live reconciliation lease receive
 * `duplicate_reconcile_in_progress` and must not run the effect.
 */
export async function admitOperation(
  database: LedgerDatabase,
  input: AdmitOperationInput
): Promise<AdmitOperationResult> {
  return runInTransaction(database, tx => admitOperationInTransaction(tx, input));
}

async function admitOperationInTransaction(
  tx: LedgerTransaction,
  input: AdmitOperationInput
): Promise<AdmitOperationResult> {
  const now = new Date();

  const existing = await tx
    .select()
    .from(operation_ledgers)
    .where(
      and(
        eq(operation_ledgers.kilo_user_id, input.userId),
        eq(operation_ledgers.domain, input.domain),
        eq(operation_ledgers.operation_key, input.operationKey)
      )
    )
    .for('update')
    .limit(1);

  if (existing.length === 0) {
    // Conflict-safe insert: the unique index on
    // (kilo_user_id, domain, operation_key) arbitrates the race. When a
    // concurrent admit wins, this insert is a silent no-op instead of raising
    // a unique violation. A raised violation would abort the whole transaction
    // (PostgreSQL rejects every later statement with 25P02), so the winner
    // must never be read after a failure.
    const [row] = await tx
      .insert(operation_ledgers)
      .values(admissionInsertValues(input, now))
      .onConflictDoNothing({
        target: [
          operation_ledgers.kilo_user_id,
          operation_ledgers.domain,
          operation_ledgers.operation_key,
        ],
      })
      .returning();

    if (row) {
      return { admission: 'admitted', row };
    }

    // A concurrent admit won the insert race under the same identity key.
    // Read the committed winner and classify it.
    const [winner] = await tx
      .select()
      .from(operation_ledgers)
      .where(
        and(
          eq(operation_ledgers.kilo_user_id, input.userId),
          eq(operation_ledgers.domain, input.domain),
          eq(operation_ledgers.operation_key, input.operationKey)
        )
      )
      .for('update')
      .limit(1);
    if (!winner) {
      throw new Error('Operation ledger row vanished after a conflict-safe insert');
    }
    return evaluateExistingRow(tx, winner, input, now);
  }

  return evaluateExistingRow(tx, existing[0], input, now);
}

async function evaluateExistingRow(
  tx: LedgerTransaction,
  row: OperationLedgerRow,
  input: AdmitOperationInput,
  now: Date
): Promise<AdmitOperationResult> {
  // Expired row (any status): delete + fresh insert in one transaction.
  if (new Date(row.expires_at).getTime() < now.getTime()) {
    await tx.delete(operation_ledgers).where(eq(operation_ledgers.id, row.id));
    const [fresh] = await tx
      .insert(operation_ledgers)
      .values(admissionInsertValues(input, now))
      .returning();
    if (!fresh) {
      throw new Error('Operation ledger re-insert returned no row');
    }
    return { admission: 'admitted', row: fresh };
  }

  if (row.status === 'admitted') {
    if (new Date(row.lease_expires_at).getTime() >= now.getTime()) {
      return { admission: 'duplicate_in_flight', row };
    }
    // Compare-and-set lease takeover: renew only while the lease is still expired.
    const renewedLease = new Date(now.getTime() + input.leaseSeconds * 1000).toISOString();
    const [renewed] = await tx
      .update(operation_ledgers)
      .set({ lease_expires_at: renewedLease })
      .where(
        and(
          eq(operation_ledgers.id, row.id),
          eq(operation_ledgers.status, 'admitted'),
          sql`${operation_ledgers.lease_expires_at} < ${now.toISOString()}::timestamptz`
        )
      )
      .returning();
    return { admission: 'takeover', row: renewed ?? row };
  }

  if (row.status === 'reconcile_pending') {
    // A live reconciliation lease means another retry already claimed it and
    // is reconciling; the caller must surface an in-progress response and must
    // not run the effect.
    if (new Date(row.lease_expires_at).getTime() > now.getTime()) {
      return { admission: 'duplicate_reconcile_in_progress', row };
    }
    // Compare-and-set lease claim: reconcile only while the lease is still
    // claimable. The row lock serializes concurrent claims; the CAS guards a
    // claim renewed between the read and the update.
    const claimedLease = new Date(now.getTime() + input.leaseSeconds * 1000).toISOString();
    const [claimed] = await tx
      .update(operation_ledgers)
      .set({ lease_expires_at: claimedLease })
      .where(
        and(
          eq(operation_ledgers.id, row.id),
          eq(operation_ledgers.status, 'reconcile_pending'),
          sql`${operation_ledgers.lease_expires_at} <= ${now.toISOString()}::timestamptz`
        )
      )
      .returning();
    return { admission: 'duplicate_reconcile_pending', row: claimed ?? row };
  }

  return { admission: 'duplicate_settled', row };
}

// ----- progress and provider reference ------------------------------------------

/**
 * Locks the row, merges `patch` into `canonical_result`, and writes it back
 * under a compare-and-set on non-terminal status. Optionally overwrites
 * `provider_ref` in the same statement. Returns null when the row is missing,
 * terminal, or the CAS did not match.
 */
async function updateNonTerminalRow(
  database: LedgerDatabase,
  rowId: string,
  patch: Record<string, unknown>,
  options: { providerRef?: string | null } = {}
): Promise<OperationLedgerRow | null> {
  return runInTransaction(database, async tx => {
    const [row] = await tx
      .select()
      .from(operation_ledgers)
      .where(eq(operation_ledgers.id, rowId))
      .for('update');

    if (!row || isTerminalOperationStatus(row.status)) {
      return null;
    }

    const [updated] = await tx
      .update(operation_ledgers)
      .set({
        canonical_result: mergeCanonicalResult(row, patch),
        ...(options.providerRef !== undefined ? { provider_ref: options.providerRef } : {}),
      })
      .where(
        and(
          eq(operation_ledgers.id, row.id),
          inArray(operation_ledgers.status, OPERATION_NON_TERMINAL_STATUSES)
        )
      )
      .returning();
    return updated ?? null;
  });
}

/**
 * Merges allocated identifiers into `canonical_result` while the row is
 * non-terminal (`admitted` or `reconcile_pending`). A fresh takeover
 * allocation under a reconcile-pending row must record its new IDs so the next
 * same-key retry reconciles them instead of allocating a third time. Returns
 * the updated row, or null when the row is missing or terminal (the CAS did
 * not match). The merged result is bounded at `MAX_CANONICAL_RESULT_BYTES`
 * serialized bytes: an oversized merge throws `CanonicalResultTooLargeError`
 * and leaves the row unchanged.
 */
export async function recordOperationProgress(
  database: LedgerDatabase,
  rowId: string,
  partialResult: Record<string, unknown>
): Promise<OperationLedgerRow | null> {
  return updateNonTerminalRow(database, rowId, partialResult);
}

export type RecordAcceptanceInput = {
  rowId: string;
  /** The provider reference (for example the worker `messageId`) to store. */
  providerRef: string | null;
  /** Correlation data merged into `canonical_result` (for example `commandId`). */
  canonicalResult: Record<string, unknown>;
};

/**
 * Records a provider acceptance ATOMICALLY: `provider_ref` and the merged
 * `canonical_result` are written in one transaction (P1-A-08e). A failure
 * rolls back both writes, so no partial acceptance state — `provider_ref`
 * without `canonical_result`, or vice versa — can exist for a same-key retry
 * to blind-duplicate a command against. Same bound/CAS semantics as
 * `recordOperationProgress`: only non-terminal rows are updated, the merged
 * result is bounded at `MAX_CANONICAL_RESULT_BYTES` (an oversized merge
 * throws `CanonicalResultTooLargeError` and leaves the row unchanged), and a
 * missing or terminal row returns null.
 */
export async function recordOperationAcceptance(
  database: LedgerDatabase,
  input: RecordAcceptanceInput
): Promise<OperationLedgerRow | null> {
  return updateNonTerminalRow(database, input.rowId, input.canonicalResult, {
    providerRef: input.providerRef,
  });
}

// ----- terminal settle and reconcile ----------------------------------------------

/**
 * Settles a row to a terminal status, CAS from `admitted | reconcile_pending`.
 * A second settle is a no-op returning the stored row. When `outboxEvent` is
 * given, the outbox row is written in the same transaction: settle-plus-outbox
 * is atomic — any outbox failure rolls back the settle. The merged
 * `canonical_result` must fit `MAX_CANONICAL_RESULT_BYTES` serialized bytes.
 */
export async function settleOperation(
  database: LedgerDatabase,
  input: SettleOperationInput
): Promise<SettleOperationResult> {
  return runInTransaction(database, tx => settleOperationInTransaction(tx, input));
}

async function settleOperationInTransaction(
  tx: LedgerTransaction,
  input: SettleOperationInput
): Promise<SettleOperationResult> {
  const [row] = await tx
    .select()
    .from(operation_ledgers)
    .where(eq(operation_ledgers.id, input.rowId))
    .for('update');

  if (!row) {
    return { settled: false, row: null };
  }

  if (isTerminalOperationStatus(row.status)) {
    // Double settle is a no-op.
    return { settled: false, row };
  }

  const mergedCanonical = mergeCanonicalResult(row, input.canonicalResult);

  if (input.outboxEvent) {
    validateOutboxEvent(input.outboxEvent);
  }

  const [updated] = await tx
    .update(operation_ledgers)
    .set({
      status: input.status,
      outcome_code: input.outcomeCode ?? null,
      canonical_result: mergedCanonical,
      settled_at: new Date().toISOString(),
    })
    .where(
      and(
        eq(operation_ledgers.id, row.id),
        inArray(operation_ledgers.status, OPERATION_NON_TERMINAL_STATUSES)
      )
    )
    .returning();

  if (!updated) {
    // Defensive: another writer settled between the lock and the update.
    const [current] = await tx
      .select()
      .from(operation_ledgers)
      .where(eq(operation_ledgers.id, row.id));
    return { settled: false, row: current ?? null };
  }

  if (input.outboxEvent) {
    await insertOutboxEvent(tx, { rowId: row.id, event: input.outboxEvent });
  }

  return { settled: true, row: updated };
}

/**
 * Marks a row `reconcile_pending`, CAS from `admitted`. May emit an
 * `outcome: 'ambiguous'` outbox event (a ledger state change, not an HTTP
 * receipt). The transition also makes the reconciliation lease immediately
 * claimable (`lease_expires_at` set to now), so the next same-key retry can
 * atomically claim it and reconcile instead of waiting out the original
 * admitted lease. Returns the stored row when the CAS did not match (missing
 * or not `admitted`).
 */
export async function markReconcilePending(
  database: LedgerDatabase,
  input: MarkReconcilePendingInput
): Promise<OperationLedgerRow | null> {
  return runInTransaction(database, async tx => {
    const [row] = await tx
      .select()
      .from(operation_ledgers)
      .where(eq(operation_ledgers.id, input.rowId))
      .for('update');

    if (!row) {
      return null;
    }
    if (row.status !== 'admitted') {
      return row;
    }

    if (input.outboxEvent) {
      validateOutboxEvent(input.outboxEvent);
      await insertOutboxEvent(tx, { rowId: row.id, event: input.outboxEvent });
    }

    const now = new Date();
    const [updated] = await tx
      .update(operation_ledgers)
      .set({
        status: 'reconcile_pending',
        lease_expires_at: now.toISOString(),
      })
      .where(and(eq(operation_ledgers.id, row.id), eq(operation_ledgers.status, 'admitted')))
      .returning();
    return updated ?? row;
  });
}

// ----- outbox insert (the only insert path for analytics_event_outbox) -------------

function validateOutboxEvent(event: OutboxEventInput): void {
  const schema = ANALYTICS_EVENT_SCHEMAS[event.eventName];
  if (!schema) {
    throw new OutboxEventValidationError(
      `No catalog schema for analytics event ${event.eventName}`
    );
  }
  const result = schema.safeParse(event.properties);
  if (!result.success) {
    throw new OutboxEventValidationError(
      `Analytics event ${event.eventName} failed schema validation: ${result.error.message}`
    );
  }
}

/**
 * Inserts an outbox row with the deterministic UUIDv5 `event_uuid`. Ambiguous
 * and definitive outcomes have separate identities. A conflict skips a repeat
 * of the same outcome phase. Callers must run `validateOutboxEvent` first.
 */
async function insertOutboxEvent(
  tx: LedgerTransaction,
  params: { rowId: string; event: OutboxEventInput }
): Promise<AnalyticsEventOutboxRow | null> {
  const eventIdentity =
    params.event.properties.outcome === 'ambiguous'
      ? `${params.event.eventName}:ambiguous`
      : params.event.eventName;
  const eventUuid = await computeEventUuid(params.rowId, eventIdentity);

  const values: NewAnalyticsEventOutboxRow = {
    event_uuid: eventUuid,
    event_name: params.event.eventName,
    distinct_id: params.event.distinctId,
    properties: params.event.properties,
    status: 'pending',
    attempts: 0,
  };

  const [inserted] = await tx
    .insert(analytics_event_outbox)
    .values(values)
    .onConflictDoNothing({ target: analytics_event_outbox.event_uuid })
    .returning();
  return inserted ?? null;
}

// ----- deterministic UUIDv5 ---------------------------------------------------------

const NAMESPACE_BYTES = Uint8Array.from(
  EVENT_UUID_NAMESPACE.replace(/-/g, '').match(/../g) ?? [],
  hex => Number.parseInt(hex, 16)
);

/**
 * Deterministic outbox `event_uuid` for a ledger row and event name: UUIDv5
 * (SHA-1 name-based, RFC 4122) of `${rowId}:${eventName}` under
 * `EVENT_UUID_NAMESPACE`. WebCrypto keeps it identical on Node and Workers.
 */
export async function computeEventUuid(rowId: string, eventName: string): Promise<string> {
  const name = new TextEncoder().encode(`${rowId}:${eventName}`);
  const digest = await crypto.subtle.digest('SHA-1', new Uint8Array([...NAMESPACE_BYTES, ...name]));
  const bytes = new Uint8Array(digest).slice(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50; // version 5
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC 4122 variant
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
