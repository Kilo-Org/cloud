import { sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import type { DrizzleTransaction } from '@kilocode/web-shared/lib/drizzle';
import {
  agent_briefing_events,
  cli_sessions_v2,
  microdollar_usage,
  microdollar_usage_metadata,
} from '@kilocode/db/schema';

export const BRIEFING_COUNT_TIMEOUT_MS = 5_000;

type CountDimension = 'sessions' | 'pullRequests' | 'blockers' | 'spend';
export type BriefingCountTimeouts = Partial<Record<CountDimension, number>>;

/**
 * Counts over the whole window, independent of the collected sample. A null
 * dimension timed out; the report then shows the sample's lower bound for it.
 */
export type BriefingExactCounts = {
  sessions: number | null;
  pullRequests: number | null;
  blockers: { count: number; untimestampedStatus: boolean } | null;
  spend: {
    microdollars: number;
    charged: boolean;
    byRoot: Map<string, number>;
    unchargedActivitySessions: number;
  } | null;
};

type CountInput = {
  sessionScope: SQL;
  eventScope: SQL;
  usageScope: SQL;
  nightStartAt: string;
  cutoffAt: string;
  timeoutMs: BriefingCountTimeouts;
};

const events = agent_briefing_events;
const sessions = cli_sessions_v2;
const transitionId = sql`CASE WHEN jsonb_typeof(${events.payload} -> 'transitionId') = 'string' THEN ${events.payload} ->> 'transitionId' ELSE '' END`;

function isQueryCanceled(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  if ('code' in error && error.code === '57014') return true;
  return 'cause' in error && isQueryCanceled(error.cause);
}

/**
 * Runs one count under its own statement timeout inside a savepoint of the
 * collection transaction. A timeout rolls back only the savepoint, so the
 * snapshot and the later queries are unaffected.
 */
async function boundedCount<T>(
  tx: DrizzleTransaction,
  timeoutMs: number,
  query: SQL,
  schema: z.ZodType<T>
): Promise<T | null> {
  try {
    return await tx.transaction(async savepoint => {
      const {
        rows: [setting],
      } = await savepoint.execute<{ previous: string }>(
        sql`SELECT current_setting('statement_timeout') AS previous`
      );
      await savepoint.execute(
        sql`SELECT set_config('statement_timeout', ${`${timeoutMs}ms`}, true)`
      );
      const {
        rows: [row],
      } = await savepoint.execute(query);
      await savepoint.execute(
        sql`SELECT set_config('statement_timeout', ${setting?.previous ?? '0'}, true)`
      );
      return schema.parse(row);
    });
  } catch (error) {
    if (isQueryCanceled(error)) return null;
    throw error;
  }
}

/**
 * Maps each session in the `relevant` CTE to its topmost in-scope ancestor, the
 * report's session group. A session whose ancestry loops has no root, as in the
 * collected sample.
 */
function rootsCte(input: CountInput) {
  return sql`
    tree (session_id, node_id, parent_id, depth, path, cyclic) AS (
      SELECT ${sessions.session_id}, ${sessions.session_id}, ${sessions.parent_session_id}, 0,
        ARRAY[${sessions.session_id}], false
      FROM ${sessions}
      WHERE ${input.sessionScope} AND ${sessions.session_id} IN (SELECT session_id FROM relevant)
      UNION ALL
      SELECT tree.session_id, ${sessions.session_id}, ${sessions.parent_session_id}, tree.depth + 1,
        tree.path || ${sessions.session_id}, ${sessions.session_id} = ANY(tree.path)
      FROM tree
      JOIN ${sessions} ON ${sessions.session_id} = tree.parent_id AND ${input.sessionScope}
      WHERE NOT tree.cyclic
    ),
    roots AS (
      SELECT DISTINCT ON (session_id) session_id, node_id AS root_id
      FROM tree
      WHERE session_id NOT IN (SELECT session_id FROM tree WHERE cyclic)
      ORDER BY session_id, depth DESC
    )`;
}

function eventInWindow(input: CountInput) {
  return sql`${events.occurred_at} >= ${input.nightStartAt}::timestamptz AND ${events.occurred_at} < ${input.cutoffAt}::timestamptz`;
}

function windowUsageCte(input: CountInput) {
  return sql`
    window_usage AS (
      SELECT ${microdollar_usage.id} AS id, ${microdollar_usage.cost} AS cost,
        ${sessions.session_id} AS session_id
      FROM ${microdollar_usage}
      JOIN ${microdollar_usage_metadata} ON ${microdollar_usage_metadata.id} = ${microdollar_usage.id}
      JOIN ${sessions}
        ON (
          ${sessions.session_id} = ${microdollar_usage_metadata.session_id}
          OR ${sessions.cloud_agent_session_id} = ${microdollar_usage_metadata.session_id}
        )
        AND ${input.sessionScope}
      WHERE ${input.usageScope}
        AND ${microdollar_usage.created_at} >= ${input.nightStartAt}::timestamptz
        AND ${microdollar_usage.created_at} < ${input.cutoffAt}::timestamptz
    )`;
}

/** Report groups with any counted evidence in the window, as `aggregateBriefingEvidence` marks them active. */
function sessionsQuery(input: CountInput) {
  return sql`
    WITH RECURSIVE
    window_events AS (
      SELECT ${events.id} AS id, ${events.session_id} AS session_id, ${events.kind} AS kind,
        ${events.url} AS url, ${events.title} AS title, ${events.occurred_at} AS occurred_at,
        ${transitionId} AS transition_id
      FROM ${events}
      WHERE ${input.eventScope} AND ${eventInWindow(input)}
    ),
    ${windowUsageCte(input)},
    relevant AS (
      SELECT session_id FROM window_events UNION SELECT session_id FROM window_usage
    ),
    ${rootsCte(input)},
    first_pull_requests AS (
      SELECT DISTINCT ON (window_events.url) window_events.session_id
      FROM window_events
      JOIN roots ON roots.session_id = window_events.session_id
      WHERE window_events.kind = 'pull_request' AND window_events.url <> ''
      ORDER BY window_events.url, window_events.occurred_at, window_events.transition_id,
        window_events.id
    ),
    active AS (
      SELECT session_id FROM window_events
      WHERE kind IN ('status', 'activity') OR (kind = 'artifact' AND url <> '' AND title <> '')
      UNION SELECT session_id FROM first_pull_requests
      UNION SELECT session_id FROM window_usage
    )
    SELECT count(DISTINCT roots.root_id)::int AS count
    FROM active
    JOIN roots ON roots.session_id = active.session_id`;
}

function pullRequestsQuery(input: CountInput) {
  const opened = sql`${input.eventScope} AND ${events.kind} = 'pull_request' AND ${events.url} <> '' AND ${eventInWindow(input)}`;
  return sql`
    WITH RECURSIVE
    relevant AS (SELECT DISTINCT ${events.session_id} AS session_id FROM ${events} WHERE ${opened}),
    ${rootsCte(input)}
    SELECT count(DISTINCT ${events.url})::int AS count
    FROM ${events}
    JOIN roots ON roots.session_id = ${events.session_id}
    WHERE ${opened}`;
}

/**
 * Sessions whose current blocked interval opened in the window: the same
 * transition rules as `aggregateBriefingEvidence`, folded over every status
 * event from the last one before the night through the cutoff.
 */
function blockersQuery(input: CountInput) {
  const statusColumns = sql`
    ${events.status} AS status, ${events.occurred_at} AS occurred_at, ${events.id} AS id,
    ${transitionId} AS transition_id,
    CASE
      WHEN ${events.payload} -> 'previousStatusKnown' = 'true'::jsonb
        AND jsonb_typeof(${events.payload} -> 'previousStatus') = 'string'
      THEN ${events.payload} ->> 'previousStatus'
    END AS reported_previous_status,
    COALESCE(
      jsonb_typeof(${events.payload}) <> 'null'
        AND (
          jsonb_typeof(${events.payload} -> 'transitionId') IS DISTINCT FROM 'string'
          OR ${events.payload} -> 'previousStatusKnown' IS DISTINCT FROM 'true'::jsonb
        ),
      false
    ) AS untimestamped`;
  const sessionStatus = sql`${input.eventScope} AND ${events.kind} = 'status' AND ${events.session_id} = roots.session_id`;
  return sql`
    WITH RECURSIVE
    relevant AS (
      SELECT DISTINCT ${events.session_id} AS session_id
      FROM ${events}
      WHERE ${input.eventScope} AND ${events.kind} = 'status' AND ${eventInWindow(input)}
    ),
    ${rootsCte(input)},
    status_events AS (
      SELECT roots.session_id, history.*
      FROM roots
      CROSS JOIN LATERAL (
        (
          SELECT ${statusColumns}
          FROM ${events}
          WHERE ${sessionStatus} AND ${events.occurred_at} < ${input.nightStartAt}::timestamptz
          ORDER BY occurred_at DESC, transition_id DESC, id DESC
          LIMIT 1
        )
        UNION ALL
        (
          SELECT ${statusColumns}
          FROM ${events}
          WHERE ${sessionStatus}
            AND ${events.occurred_at} >= ${input.nightStartAt}::timestamptz
            AND ${events.occurred_at} <= ${input.cutoffAt}::timestamptz
        )
      ) AS history
    ),
    steps AS (
      SELECT session_id, occurred_at, untimestamped,
        COALESCE(status IN ('question', 'permission'), false) AS blocked,
        COALESCE((lag(status) OVER w) IN ('question', 'permission'), false) AS after_blocked,
        COALESCE(reported_previous_status, lag(status) OVER w) AS previous_status,
        row_number() OVER w AS position
      FROM status_events
      WINDOW w AS (PARTITION BY session_id ORDER BY occurred_at, transition_id, id)
    ),
    transitions AS (
      SELECT session_id, occurred_at, position, untimestamped,
        blocked AND COALESCE(previous_status IN ('busy', 'idle', 'retry', 'scheduled'), false)
          AS opens,
        blocked AND after_blocked
          AND COALESCE(previous_status IN ('question', 'permission'), false) AS continues
      FROM steps
    ),
    onsets AS (
      SELECT DISTINCT ON (session_id) session_id, opens, occurred_at
      FROM transitions
      WHERE NOT continues
      ORDER BY session_id, position DESC
    )
    SELECT
      (
        SELECT count(*) FROM onsets
        WHERE opens
          AND occurred_at >= ${input.nightStartAt}::timestamptz
          AND occurred_at < ${input.cutoffAt}::timestamptz
      )::int AS count,
      COALESCE(
        (
          SELECT bool_or(untimestamped) FROM transitions
          WHERE occurred_at >= ${input.nightStartAt}::timestamptz
        ),
        false
      ) AS untimestamped`;
}

/**
 * Usage charged to in-scope sessions, each charge once, plus the report groups
 * with activity but no charge, which keep spend coverage from being complete.
 */
function spendQuery(input: CountInput) {
  return sql`
    WITH RECURSIVE
    ${windowUsageCte(input)},
    activity AS (
      SELECT DISTINCT ${events.session_id} AS session_id
      FROM ${events}
      WHERE ${input.eventScope} AND ${events.kind} = 'activity' AND ${eventInWindow(input)}
    ),
    relevant AS (SELECT session_id FROM window_usage UNION SELECT session_id FROM activity),
    ${rootsCte(input)},
    charged AS (
      SELECT DISTINCT ON (window_usage.id) window_usage.id, window_usage.cost, roots.root_id
      FROM window_usage
      JOIN roots ON roots.session_id = window_usage.session_id
      ORDER BY window_usage.id, window_usage.session_id
    ),
    by_root AS (SELECT root_id, sum(cost) AS spend FROM charged GROUP BY root_id)
    SELECT
      (SELECT count(*) FROM charged)::int AS charged,
      (SELECT COALESCE(sum(cost), 0) FROM charged)::text AS microdollars,
      (SELECT COALESCE(jsonb_object_agg(root_id, spend), '{}'::jsonb) FROM by_root) AS by_root,
      (
        SELECT count(DISTINCT roots.root_id)
        FROM activity
        JOIN roots ON roots.session_id = activity.session_id
        WHERE roots.root_id NOT IN (SELECT root_id FROM by_root)
      )::int AS uncharged`;
}

export async function countBriefingEvidence(
  tx: DrizzleTransaction,
  input: CountInput
): Promise<BriefingExactCounts> {
  const timeout = (dimension: CountDimension) =>
    input.timeoutMs[dimension] ?? BRIEFING_COUNT_TIMEOUT_MS;
  const countRow = z.object({ count: z.number() });
  const sessionCount = await boundedCount(tx, timeout('sessions'), sessionsQuery(input), countRow);
  const pullRequestCount = await boundedCount(
    tx,
    timeout('pullRequests'),
    pullRequestsQuery(input),
    countRow
  );
  const blockers = await boundedCount(
    tx,
    timeout('blockers'),
    blockersQuery(input),
    z.object({ count: z.number(), untimestamped: z.boolean() })
  );
  const spend = await boundedCount(
    tx,
    timeout('spend'),
    spendQuery(input),
    z.object({
      charged: z.number(),
      microdollars: z.coerce.number(),
      by_root: z.record(z.string(), z.coerce.number()),
      uncharged: z.number(),
    })
  );
  return {
    sessions: sessionCount?.count ?? null,
    pullRequests: pullRequestCount?.count ?? null,
    blockers: blockers && {
      count: blockers.count,
      untimestampedStatus: blockers.untimestamped,
    },
    spend: spend && {
      microdollars: spend.microdollars,
      charged: spend.charged > 0,
      byRoot: new Map(Object.entries(spend.by_root)),
      unchargedActivitySessions: spend.uncharged,
    },
  };
}
