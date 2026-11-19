import { and, eq, sql, type SQL } from 'drizzle-orm';
import { getWorkerDb } from '@kilocode/db/client';
import { cli_sessions_v2 } from '@kilocode/db/schema';
import type { SessionLiveSummary } from '@kilocode/session-ingest-contracts';
import {
  briefingExcerptIsNewer,
  briefingExcerptUpdate,
  type BriefingExcerpt,
  type BriefingExcerptIdentity,
} from '../ingest/briefing-excerpt';

export type LiveSessionColumns = {
  costMicrodollars?: number;
  lastActivityAtIso?: string;
  liveSummary?: { summary: SessionLiveSummary; atIso: string };
  briefingExcerpt?: { excerpt: BriefingExcerpt; receivedAtIso: string };
};

/**
 * Lock-wait bound of the live-column write. The write is best effort and a later write carries
 * newer values, so it gives up on a locked row well before the Worker transaction bound of 10 s
 * and does not hold a Hyperdrive connection while it waits.
 */
export const LIVE_COLUMNS_LOCK_TIMEOUT = '2s';

/**
 * Monotonic live-column write for cost, last_activity_at, and the session
 * card summary. Per-column CASE guards make writes commute, so merged and
 * reordered writes leave the newest values.
 *
 * The summary has no order of its own, so it carries the activity time of
 * the batch that produced it (`atIso`) and is written only when that time is
 * not older than the stored activity. A slower in-flight write of an older
 * batch then leaves the newer summary in place, as the activity guard does.
 *
 * The UPDATE runs in a transaction with a short `lock_timeout`, so a locked
 * row ends the write with `55P03` instead of a wait on a Hyperdrive connection.
 */
export async function persistLiveSessionColumns(
  connectionString: string,
  kiloUserId: string,
  sessionId: string,
  columns: LiveSessionColumns
): Promise<void> {
  const set: {
    total_cost_microdollars?: SQL;
    last_activity_at?: SQL;
    live_summary?: SQL;
    briefing_excerpt?: SQL;
  } = {};

  if (columns.costMicrodollars !== undefined) {
    const cost = columns.costMicrodollars;
    set.total_cost_microdollars = sql`CASE
      WHEN ${cli_sessions_v2.total_cost_microdollars} IS NULL
        OR ${cli_sessions_v2.total_cost_microdollars} < ${cost}
      THEN ${cost}
      ELSE ${cli_sessions_v2.total_cost_microdollars}
    END`;
  }

  if (columns.lastActivityAtIso !== undefined) {
    const activity = columns.lastActivityAtIso;
    set.last_activity_at = sql`CASE
      WHEN ${cli_sessions_v2.last_activity_at} IS NULL
        OR ${cli_sessions_v2.last_activity_at} < ${activity}
      THEN ${activity}
      ELSE ${cli_sessions_v2.last_activity_at}
    END`;
  }

  if (columns.liveSummary !== undefined) {
    // Postgres reads every SET expression against the old row, so this guard
    // compares with the stored activity, not the value set beside it.
    const { summary, atIso } = columns.liveSummary;
    set.live_summary = sql`CASE
      WHEN ${cli_sessions_v2.last_activity_at} IS NULL
        OR ${cli_sessions_v2.last_activity_at} <= ${atIso}
      THEN ${JSON.stringify(summary)}::jsonb
      ELSE ${cli_sessions_v2.live_summary}
    END`;
  }

  if (columns.briefingExcerpt !== undefined) {
    const { excerpt, receivedAtIso } = columns.briefingExcerpt;
    set.briefing_excerpt = briefingExcerptUpdate(excerpt, receivedAtIso);
  }

  if (Object.keys(set).length === 0) return;

  await getWorkerDb(connectionString).transaction(async tx => {
    await tx.execute(sql.raw(`SET LOCAL lock_timeout = '${LIVE_COLUMNS_LOCK_TIMEOUT}'`));
    await tx
      .update(cli_sessions_v2)
      .set(set)
      .where(
        and(eq(cli_sessions_v2.session_id, sessionId), eq(cli_sessions_v2.kilo_user_id, kiloUserId))
      );
  });
}

function maxDefined<T extends number | string>(a: T | undefined, b: T | undefined): T | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return b > a ? b : a;
}

/**
 * Combines two pending writes into one with the result of writing both: each column keeps the
 * value its CASE guard would leave. Ties keep the later write.
 */
export function mergeLiveSessionColumns(
  earlier: LiveSessionColumns,
  later: LiveSessionColumns
): LiveSessionColumns {
  const merged: LiveSessionColumns = {};
  const cost = maxDefined(earlier.costMicrodollars, later.costMicrodollars);
  if (cost !== undefined) merged.costMicrodollars = cost;
  const activity = maxDefined(earlier.lastActivityAtIso, later.lastActivityAtIso);
  if (activity !== undefined) merged.lastActivityAtIso = activity;

  const summary =
    earlier.liveSummary === undefined ||
    (later.liveSummary !== undefined && later.liveSummary.atIso >= earlier.liveSummary.atIso)
      ? later.liveSummary
      : earlier.liveSummary;
  if (summary !== undefined) merged.liveSummary = summary;

  const excerpt =
    earlier.briefingExcerpt === undefined ||
    (later.briefingExcerpt !== undefined &&
      !briefingExcerptIsNewer(earlier.briefingExcerpt.excerpt, later.briefingExcerpt.excerpt))
      ? later.briefingExcerpt
      : earlier.briefingExcerpt;
  if (excerpt !== undefined) merged.briefingExcerpt = excerpt;
  return merged;
}

/**
 * One live-column write and what the object records in `ingest_meta` after it lands. Each record
 * field is a max-merge in the object, so a merged write records the maximum of its parts.
 */
export type LivePersistRequest = {
  kiloUserId: string;
  sessionId: string;
  columns: LiveSessionColumns;
  activity?: { persistedAtMs: number; valueMs: number };
  cost?: { persistedAtMs: number; microdollars: number };
  liveSummary?: { persistedAtMs: number; visibleChanged: boolean };
  /** Excerpt identities the object marked in flight for this write. */
  excerptsInFlight: BriefingExcerptIdentity[];
};

export function mergeLivePersistRequests(
  earlier: LivePersistRequest,
  later: LivePersistRequest
): LivePersistRequest {
  const merged: LivePersistRequest = {
    kiloUserId: later.kiloUserId,
    sessionId: later.sessionId,
    columns: mergeLiveSessionColumns(earlier.columns, later.columns),
    excerptsInFlight: [...earlier.excerptsInFlight, ...later.excerptsInFlight],
  };
  const activity =
    earlier.activity && later.activity
      ? {
          persistedAtMs: Math.max(earlier.activity.persistedAtMs, later.activity.persistedAtMs),
          valueMs: Math.max(earlier.activity.valueMs, later.activity.valueMs),
        }
      : (earlier.activity ?? later.activity);
  if (activity !== undefined) merged.activity = activity;
  const cost =
    earlier.cost && later.cost
      ? {
          persistedAtMs: Math.max(earlier.cost.persistedAtMs, later.cost.persistedAtMs),
          microdollars: Math.max(earlier.cost.microdollars, later.cost.microdollars),
        }
      : (earlier.cost ?? later.cost);
  if (cost !== undefined) merged.cost = cost;
  const liveSummary =
    earlier.liveSummary && later.liveSummary
      ? {
          persistedAtMs: Math.max(
            earlier.liveSummary.persistedAtMs,
            later.liveSummary.persistedAtMs
          ),
          visibleChanged: earlier.liveSummary.visibleChanged || later.liveSummary.visibleChanged,
        }
      : (earlier.liveSummary ?? later.liveSummary);
  if (liveSummary !== undefined) merged.liveSummary = liveSummary;
  return merged;
}

const LIVE_PERSIST_BACKOFF_INITIAL_MS = 15_000;
const LIVE_PERSIST_BACKOFF_MAX_MS = 120_000;

export function livePersistBackoffMs(consecutiveFailures: number): number {
  return Math.min(
    LIVE_PERSIST_BACKOFF_MAX_MS,
    LIVE_PERSIST_BACKOFF_INITIAL_MS * 2 ** Math.max(0, consecutiveFailures - 1)
  );
}

export type LivePersistQueue<T> = {
  /**
   * Merges `request` into the next write. Starts a write when none is in flight and no backoff
   * applies, and returns its promise, which never rejects. Returns undefined otherwise: the
   * write in flight, or the first request after the backoff, carries the merged values.
   */
  schedule(request: T): Promise<void> | undefined;
  /**
   * Merges `request` into the next write and writes it after the write in flight, also during a
   * backoff. Rejects when the write fails. For callers that must persist final values.
   */
  flush(request: T): Promise<void>;
};

/**
 * Allows at most one live-column write in flight per object. Requests that arrive meanwhile merge
 * into one pending write. After a failure the request stays pending and new requests only merge
 * into it until the backoff ends, so a locked row or a full pool does not get a new write per
 * ingest batch.
 */
export function createLivePersistQueue<T>(deps: {
  merge: (earlier: T, later: T) => T;
  write: (request: T) => Promise<void>;
  onWritten: (request: T) => void;
  onFailed: (request: T, error: unknown) => void;
  now?: () => number;
}): LivePersistQueue<T> {
  const now = deps.now ?? Date.now;
  let pending: T | undefined;
  let inFlight: Promise<void> | undefined;
  let consecutiveFailures = 0;
  let retryAtMs = 0;

  function addPending(request: T): void {
    pending = pending === undefined ? request : deps.merge(pending, request);
  }

  async function writePending(): Promise<void> {
    while (pending !== undefined) {
      const request = pending;
      pending = undefined;
      try {
        await deps.write(request);
      } catch (error) {
        consecutiveFailures += 1;
        retryAtMs = now() + livePersistBackoffMs(consecutiveFailures);
        pending = pending === undefined ? request : deps.merge(request, pending);
        deps.onFailed(request, error);
        throw error;
      }
      consecutiveFailures = 0;
      retryAtMs = 0;
      deps.onWritten(request);
    }
  }

  function start(): Promise<void> {
    const run = writePending().finally(() => {
      inFlight = undefined;
    });
    inFlight = run.catch(() => undefined);
    return run;
  }

  return {
    schedule(request) {
      addPending(request);
      if (inFlight !== undefined || now() < retryAtMs) return undefined;
      return start().catch(() => undefined);
    },
    async flush(request) {
      addPending(request);
      while (inFlight !== undefined) await inFlight;
      if (pending === undefined) return;
      await start();
    },
  };
}
