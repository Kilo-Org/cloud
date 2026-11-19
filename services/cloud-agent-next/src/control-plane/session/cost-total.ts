import { and, asc, eq, gt, gte, lt, lte, sql } from 'drizzle-orm';
import type { DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite';
import { logger } from '../../logger.js';
import { costBackfillState, events, sessionCostTotals } from './sqlite-schema.js';

export const COST_BACKFILL_ROW_LIMIT = 2048;
export const COST_BACKFILL_BYTE_BUDGET = 4 * 1024 * 1024;

type CostKey = { sessionId: string; kiloSessionId: string };

type CostRowFields = {
  session_id: string;
  stream_event_type: string;
  entity_id: string | null;
  payload: string;
};

export type StoredCostRow = CostRowFields & { id: number };

const costColumns = {
  id: events.id,
  session_id: events.session_id,
  stream_event_type: events.stream_event_type,
  entity_id: events.entity_id,
  payload: events.payload,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The dollar contribution of one stored event row, mirroring the original
 * full-scan SQL: kilocode `message/` rows only, both `message.updated` (v1
 * `info`) and `conversation.message.updated` (native `message`) shapes,
 * assistant role only, attributed to the payload's own sessionID. SQLite
 * coerces JSON booleans to integers, so `cost: true` contributes one dollar.
 */
export function messageCostContribution(
  row: CostRowFields
): (CostKey & { dollars: number }) | null {
  if (row.stream_event_type !== 'kilocode') return null;
  if (row.entity_id === null || !row.entity_id.startsWith('message/')) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.payload);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const event = parsed.event;
  if (event !== 'message.updated' && event !== 'conversation.message.updated') return null;
  const properties = parsed.properties;
  if (!isRecord(properties)) return null;
  const native = event === 'conversation.message.updated';
  const container = native ? properties.message : properties.info;
  if (!isRecord(container)) return null;
  const kiloSessionId = native ? properties.sessionID : container.sessionID;
  const role = native ? container.type : container.role;
  if (typeof kiloSessionId !== 'string' || role !== 'assistant') return null;
  const cost = container.cost;
  let dollars = 0;
  if (typeof cost === 'number') dollars = Math.max(0, cost);
  else if (typeof cost === 'boolean') dollars = cost ? 1 : 0;
  return { sessionId: row.session_id, kiloSessionId, dollars };
}

/**
 * The single owner of the durable per-session cost total. The total moves
 * with every cost-bearing row write in the same transaction, so a DO reset
 * can never leave it stale against committed rows. Sessions that predate the
 * total converge through a bounded, resumable backfill keyed by event id.
 */
export function createSessionCostTotals(
  db: DrizzleSqliteDODatabase,
  storage: DurableObjectStorage
) {
  const readState = (): { cursor: number; complete: boolean } => {
    const row = db
      .select({ cursor: costBackfillState.cursor, complete: costBackfillState.complete })
      .from(costBackfillState)
      .where(eq(costBackfillState.id, 1))
      .get();
    return { cursor: row?.cursor ?? 0, complete: (row?.complete ?? 0) === 1 };
  };

  const writeState = (state: { cursor: number; complete: boolean }): void => {
    const values = { id: 1, cursor: state.cursor, complete: state.complete ? 1 : 0 };
    db.insert(costBackfillState)
      .values(values)
      .onConflictDoUpdate({
        target: costBackfillState.id,
        set: { cursor: values.cursor, complete: values.complete },
      })
      .run();
  };

  const readDollars = (key: CostKey): number =>
    db
      .select({ dollars: sessionCostTotals.total_dollars })
      .from(sessionCostTotals)
      .where(
        and(
          eq(sessionCostTotals.session_id, key.sessionId),
          eq(sessionCostTotals.kilo_session_id, key.kiloSessionId)
        )
      )
      .get()?.dollars ?? 0;

  type BackfillState = { cursor: number; complete: boolean };

  /**
   * Only reached when a contribution overflows the double total; never per
   * read. While the backfill is running it sums only the counted id range, so
   * rows the backfill has not reached are not added twice.
   */
  const recomputeScope = (key: CostKey, state: BackfillState): number => {
    const query = db
      .select({
        session_id: events.session_id,
        stream_event_type: events.stream_event_type,
        entity_id: events.entity_id,
        payload: events.payload,
      })
      .from(events)
      .where(
        and(
          eq(events.session_id, key.sessionId),
          gte(events.entity_id, 'message/'),
          lt(events.entity_id, 'message0'),
          state.complete ? undefined : lte(events.id, state.cursor)
        )
      )
      .toSQL();
    let total = 0;
    for (const row of storage.sql.exec<CostRowFields & Record<string, SqlStorageValue>>(
      query.sql,
      ...query.params
    )) {
      const contribution = messageCostContribution(row);
      if (contribution !== null && contribution.kiloSessionId === key.kiloSessionId)
        total += contribution.dollars;
    }
    return total;
  };

  const addDollars = (key: CostKey, delta: number, state: BackfillState): void => {
    if (delta === 0) return;
    let next = readDollars(key) + delta;
    if (!Number.isFinite(next)) {
      // A positive infinite contribution poisons the sum exactly as the old
      // full scan did; reads report 0 until a recompute can replace it.
      next = delta > 0 && !Number.isFinite(delta) ? delta : recomputeScope(key, state);
    }
    db.insert(sessionCostTotals)
      .values({
        session_id: key.sessionId,
        kilo_session_id: key.kiloSessionId,
        total_dollars: next,
      })
      .onConflictDoUpdate({
        target: [sessionCostTotals.session_id, sessionCostTotals.kilo_session_id],
        set: { total_dollars: next },
      })
      .run();
  };

  const backfillStep = (): void => {
    if (readState().complete) return;
    storage.transactionSync(() => {
      const state = readState();
      if (state.complete) return;
      const window = db
        .select({
          id: events.id,
          // SQLite can read the byte length of a text column from record metadata.
          bytes: sql<number>`octet_length(${events.payload})`,
        })
        .from(events)
        .where(gt(events.id, state.cursor))
        .orderBy(asc(events.id))
        .limit(COST_BACKFILL_ROW_LIMIT)
        .all();
      if (window.length === 0) {
        writeState({ cursor: state.cursor, complete: true });
        return;
      }
      let bytes = 0;
      let cutoff = state.cursor;
      for (const row of window) {
        if (cutoff !== state.cursor && bytes + row.bytes > COST_BACKFILL_BYTE_BUDGET) break;
        bytes += row.bytes;
        cutoff = row.id;
      }
      // Use the budgeted rowid range, not an index scan over all message rows.
      const candidates = db
        .select(costColumns)
        .from(events)
        .where(
          and(
            gt(events.id, state.cursor),
            lte(events.id, cutoff),
            sql`+${events.stream_event_type} = 'kilocode'`,
            sql`+${events.entity_id} >= 'message/' and +${events.entity_id} < 'message0'`
          )
        )
        .orderBy(asc(events.id))
        .all();
      const deltas = new Map<string, CostKey & { dollars: number }>();
      for (const row of candidates) {
        const contribution = messageCostContribution(row);
        if (contribution === null || contribution.dollars === 0) continue;
        const key = JSON.stringify([contribution.sessionId, contribution.kiloSessionId]);
        const existing = deltas.get(key);
        if (existing === undefined) deltas.set(key, contribution);
        else existing.dollars += contribution.dollars;
      }
      for (const delta of deltas.values())
        addDollars(delta, delta.dollars, { cursor: cutoff, complete: false });
      writeState({
        cursor: cutoff,
        complete:
          window.length < COST_BACKFILL_ROW_LIMIT && cutoff === window[window.length - 1].id,
      });
    });
  };

  return {
    readRow(entityId: string): StoredCostRow | null {
      return (
        db.select(costColumns).from(events).where(eq(events.entity_id, entityId)).get() ?? null
      );
    },
    /** Runs inside the row-write transaction; `before` is the replaced row, if any. */
    recordWrite(rowId: number, before: StoredCostRow | null): void {
      const state = readState();
      // Rows ahead of the cursor are counted once, when the backfill reaches them.
      if (!state.complete && rowId > state.cursor) return;
      const after = db.select(costColumns).from(events).where(eq(events.id, rowId)).get();
      if (after === undefined) return;
      const beforeContribution = before === null ? null : messageCostContribution(before);
      const afterContribution = messageCostContribution(after);
      if (
        beforeContribution !== null &&
        afterContribution !== null &&
        beforeContribution.sessionId === afterContribution.sessionId &&
        beforeContribution.kiloSessionId === afterContribution.kiloSessionId
      ) {
        addDollars(
          afterContribution,
          afterContribution.dollars - beforeContribution.dollars,
          state
        );
        return;
      }
      if (beforeContribution !== null)
        addDollars(beforeContribution, -beforeContribution.dollars, state);
      if (afterContribution !== null)
        addDollars(afterContribution, afterContribution.dollars, state);
    },
    totalCostMicrodollars(sessionId: string, kiloSessionId: string): number {
      try {
        backfillStep();
      } catch (error) {
        logger
          .withFields({ sessionId, error: error instanceof Error ? error.message : String(error) })
          .error('Session cost backfill failed');
      }
      const dollars = readDollars({ sessionId, kiloSessionId });
      return Number.isFinite(dollars)
        ? Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.round(dollars * 1_000_000)))
        : 0;
    },
  };
}

export type SessionCostTotals = ReturnType<typeof createSessionCostTotals>;
