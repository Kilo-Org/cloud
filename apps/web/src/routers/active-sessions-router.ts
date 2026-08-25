import 'server-only';
import { baseProcedure, createTRPCRouter } from '@/lib/trpc/init';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { SESSION_INGEST_WORKER_URL } from '@/lib/config.server';
import { generateInternalServiceToken } from '@/lib/tokens';
import { db } from '@/lib/drizzle';
import {
  cli_sessions_v2,
  cloud_agent_session_runs,
  github_branch_pull_requests,
} from '@kilocode/db/schema';
import { and, desc, eq, gt, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm';
import { ensureOrganizationAccess } from '@/routers/organizations/utils';
import { associatedPrSchema, formatAssociatedPr } from './cli-sessions-v2-router';

export const activeSessionSchema = z.object({
  id: z.string(),
  status: z.string(),
  title: z.string(),
  connectionId: z.string(),
  gitUrl: z.string().optional(),
  gitBranch: z.string().optional(),
  createdOnPlatform: z.string().optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
  /**
   * Latest agent activity timestamp from `cli_sessions_v2.last_activity_at`
   * (raw DB text, same treatment as `createdAt`/`updatedAt`). Omitted when
   * the column is NULL or the row was never enriched.
   */
  lastActivityAt: z.string().optional(),
  /**
   * Capabilities advertised by the CLI connection that owns this session.
   * Omitted when the owning connection's latest heartbeat did not include a
   * capabilities object (legacy CLI, or a CLI that predates the field).
   */
  capabilities: z.object({ attachments: z.boolean().optional() }).optional(),
  // Optional: legacy CLIs (predating the `kilo remote` spawner) never
  // report a platform. Only present in the response when the CLI supplied it.
  platform: z.string().optional(),
  /**
   * Optional total session cost from `cli_sessions_v2.total_cost_microdollars`
   * (microdollars, bigint). Only present when the DB row carries a non-null
   * value — null never goes on the wire. Unenriched heartbeat rows (no
   * `cli_sessions_v2` join) omit the key. The wire may legitimately carry
   * zero; display still omits it via `formatSessionTotalCost`.
   */
  totalCostMicrodollars: z.number().optional(),
  /**
   * Associated pull request for this session's branch, merged from the
   * per-tenant PR cache during enrichment. Old clients omit this key;
   * remove optional when every client is past this release.
   */
  associatedPr: associatedPrSchema.optional(),
});

const activeSessionsResponseSchema = z.object({
  sessions: z.array(activeSessionSchema),
});

const connectedInstanceSchema = z.object({
  connectionId: z.string(),
  name: z.string(),
  projectName: z.string(),
  version: z.string().optional(),
  /**
   * Capabilities advertised by this connected CLI instance. Omitted when the
   * CLI's latest attachment did not include a capabilities object (legacy CLI
   * or a build that predates the field).
   */
  capabilities: z.object({ attachments: z.boolean().optional() }).optional(),
});

const connectedInstancesResponseSchema = z.object({
  instances: z.array(connectedInstanceSchema),
});

/**
 * Session Ingest `/api/user/web-ticket` mint response. Parsed at runtime so a
 * malformed 200 fails the mutation instead of returning undefined fields.
 */
const webTicketResponseSchema = z.object({
  ticket: z.string().min(1),
  expiresAt: z.number(),
});

/**
 * A live session as this router returns it: the worker's wire row plus the
 * fields enriched from `cli_sessions_v2`.
 */
export type ActiveSession = z.infer<typeof activeSessionSchema> & {
  /**
   * Owning organization from `cli_sessions_v2`; `null` = personal, which
   * also covers a live session with no `cli_sessions_v2` row (an
   * unattributable session — the server attributes it to personal).
   *
   * This router sets the field on EVERY row it returns, so an absent value
   * on a client-cached row means exactly one thing: that row entered the
   * cache from a WS payload and has never been server-attributed. The
   * client filter relies on that (see the mobile
   * `filterActiveSessionsByOrganization`). The field stays optional in the
   * type only because those WS-inserted cached rows share it.
   */
  organizationId?: string | null;
};
export type ConnectedInstance = z.infer<typeof connectedInstanceSchema>;

/** Sentinel `connectionId` for cloud-agent rows merged when the flag is on. */
export const CLOUD_AGENT_CONNECTION_ID = 'cloud-agent';

/**
 * Warm-idle window for live cloud sessions. Mirrors
 * `KILO_SERVER_IDLE_TIMEOUT_MS_DEFAULT` in
 * services/cloud-agent-next/src/persistence/CloudAgentSession.ts:189-190.
 * Env override drift is accepted (A2).
 */
const CLOUD_AGENT_WARM_IDLE_CUTOFF = sql`now() - interval '15 minutes'`;

const listInputSchema = z
  .object({
    /**
     * Personal/organization context. `undefined` = no context filter (the
     * liveness-resolution callers), `null` = personal only, a uuid = that
     * organization. Mirrors `addOrganizationCondition` in
     * `cli-sessions-v2-router.ts`.
     */
    organizationId: z.uuid().nullable().optional(),
    /**
     * When true, also merge live cloud-agent root sessions from Postgres.
     * Default (absent/false): CLI heartbeat rows only — existing callers
     * stay byte-compatible aside from optional `lastActivityAt`.
     */
    includeCloudAgentSessions: z.boolean().optional(),
  })
  .optional();

type EnrichmentRow = {
  session_id: string;
  created_on_platform: string | null;
  created_at: string;
  updated_at: string;
  status: string | null;
  title: string | null;
  organization_id: string | null;
  last_activity_at: string | null;
  total_cost_microdollars: number | null;
  // Session's own stored PR link, aliased so it never collides with the
  // cache keys below.
  session_pr_platform: string | null;
  session_pr_url: string | null;
  session_pr_number: number | null;
  // Per-tenant PR cache columns from the LEFT JOIN.
  pr_url: string | null;
  pr_number: number | null;
  pr_state: string | null;
  pr_title: string | null;
  pr_head_sha: string | null;
  pr_last_synced_at: string | null;
  pr_review_decision: string | null;
  review_decision_pending: boolean | null;
};

type CloudCandidateRow = EnrichmentRow & {
  git_url: string | null;
  git_branch: string | null;
  cloud_agent_session_id: string | null;
};

/**
 * LEFT JOIN predicate that links a session to its per-tenant PR cache row.
 * Local copy of the v2 router's predicate; intentionally not shared so the
 * two routers do not grow a dependency in this direction.
 */
const sessionPrJoinPredicate = and(
  eq(github_branch_pull_requests.git_url, cli_sessions_v2.git_url),
  eq(github_branch_pull_requests.git_branch, cli_sessions_v2.git_branch),
  or(
    and(
      isNotNull(cli_sessions_v2.organization_id),
      eq(github_branch_pull_requests.owned_by_organization_id, cli_sessions_v2.organization_id)
    ),
    and(
      isNull(cli_sessions_v2.organization_id),
      eq(github_branch_pull_requests.owned_by_user_id, cli_sessions_v2.kilo_user_id)
    )
  )
);

/**
 * Fold an enriched row's flat PR columns into the `associatedPr` shape.
 * Returns `null` when there is no cache PR and no stored session link, so
 * callers can omit the key entirely instead of emitting `associatedPr: null`.
 */
function associatedPrFromRow(row: EnrichmentRow): z.infer<typeof associatedPrSchema> | null {
  return formatAssociatedPr(
    {
      platform: row.session_pr_platform,
      pr_url: row.session_pr_url,
      pr_number: row.session_pr_number,
      updated_at: row.updated_at,
    },
    {
      pr_url: row.pr_url,
      pr_number: row.pr_number,
      pr_state: row.pr_state,
      pr_title: row.pr_title,
      pr_head_sha: row.pr_head_sha,
      pr_last_synced_at: row.pr_last_synced_at,
      pr_review_decision: row.pr_review_decision,
      review_decision_pending: row.review_decision_pending,
    }
  );
}

/**
 * Overlay stored attention (question/permission) onto a live heartbeat
 * status. Non-attention DB values yield to live so busy/idle remain
 * authoritative while the CLI is connected.
 *
 * Must run in the router: client fetchQuery replaces the cache wholesale,
 * so sticky attention held only in client helpers is wiped on every
 * enrichment / reconnect / cli.connected refresh.
 */
export function resolveActiveSessionStatus(
  liveStatus: string,
  storedStatus: string | null | undefined
): string {
  if (storedStatus === 'question' || storedStatus === 'permission') {
    return storedStatus;
  }
  return liveStatus;
}

function mapEnrichedHeartbeatSession(
  session: ActiveSession,
  row: EnrichmentRow | undefined
): ActiveSession {
  if (!row) {
    // Always emit the field, `null` included: an absent `organizationId` on
    // a client-cached row must mean "never server-attributed" and nothing
    // else, or the client filter cannot tell a heartbeat-inserted row apart
    // from a server-attributed personal one (D4/D6).
    return { ...session, organizationId: null };
  }
  const mapped: ActiveSession = {
    ...session,
    status: resolveActiveSessionStatus(session.status, row.status),
    // The tray title must be what a rename wrote, not what the CLI still
    // reports: nothing propagates a cloud rename back to the CLI, so the
    // heartbeat title stays stale forever. A NULL title (never-ingested
    // placeholder row) falls back to the live one.
    title: row.title ?? session.title,
    organizationId: row.organization_id,
    createdOnPlatform: row.created_on_platform ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  if (row.last_activity_at != null) {
    mapped.lastActivityAt = row.last_activity_at;
  }
  if (row.total_cost_microdollars != null) {
    mapped.totalCostMicrodollars = row.total_cost_microdollars;
  }
  const associatedPr = associatedPrFromRow(row);
  if (associatedPr) {
    mapped.associatedPr = associatedPr;
  }
  return mapped;
}

function mapCloudCandidateRow(row: CloudCandidateRow): ActiveSession {
  const mapped: ActiveSession = {
    id: row.session_id,
    // Cloud rows have no live heartbeat source — use the stored status as-is
    // (do NOT run resolveActiveSessionStatus).
    status: row.status ?? '',
    title: row.title ?? '',
    connectionId: CLOUD_AGENT_CONNECTION_ID,
    gitUrl: row.git_url ?? undefined,
    gitBranch: row.git_branch ?? undefined,
    createdOnPlatform: row.created_on_platform ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    // Key ALWAYS emitted, null included (D21) — mobile filter treats an
    // absent key as never-attributed and would hide personal cloud rows.
    organizationId: row.organization_id ?? null,
  };
  if (row.last_activity_at != null) {
    mapped.lastActivityAt = row.last_activity_at;
  }
  if (row.total_cost_microdollars != null) {
    mapped.totalCostMicrodollars = row.total_cost_microdollars;
  }
  const associatedPr = associatedPrFromRow(row);
  if (associatedPr) {
    mapped.associatedPr = associatedPr;
  }
  return mapped;
}

function throwOrgContextFailure(error: unknown): never {
  throw new TRPCError({
    code: 'INTERNAL_SERVER_ERROR',
    message: 'Failed to resolve the organization context for active sessions',
    cause: error,
  });
}

/**
 * Mint a one-use web ticket from Session Ingest for the given user. The
 * returned `token` is the opaque ticket; `expiresAt` is the Unix-seconds
 * expiry from the worker body. A missing worker URL or a non-2xx mint
 * response fails fast with PRECONDITION_FAILED rather than hanging.
 */
async function mintWebTicket(userId: string): Promise<{ token: string; expiresAt: number }> {
  if (!SESSION_INGEST_WORKER_URL) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'Session ingest is not configured',
    });
  }

  const token = generateInternalServiceToken(userId);
  const url = `${SESSION_INGEST_WORKER_URL}/api/user/web-ticket`;

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch (error) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'Session ingest is not configured',
      cause: error,
    });
  }

  if (!response.ok) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'Session ingest is not configured',
    });
  }

  const raw = await response.json();
  const parsed = webTicketResponseSchema.safeParse(raw);
  if (!parsed.success) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'Invalid ticket response from session ingest',
      cause: parsed.error,
    });
  }
  return { token: parsed.data.ticket, expiresAt: parsed.data.expiresAt };
}

export const activeSessionsRouter = createTRPCRouter({
  /**
   * Mint a web ticket. This is the path forward: minting is not idempotent,
   * so it belongs on a mutation.
   */
  createWebTicket: baseProcedure.mutation(({ ctx }) => mintWebTicket(ctx.user.id)),

  /**
   * TODO: remove once no shipped client calls this. Superseded by
   * `createWebTicket`. Store builds and installed extensions cannot update in
   * step with the server, so the procedure has to stay a query: tRPC answers a
   * query-shaped call to a mutation with 405, and fails the whole batch with
   * 400 "Cannot mix procedure types in call" when it is batched beside a query.
   * Drop it when the mobile and extension releases that call `createWebTicket`
   * have rolled out and the getToken traffic in Axiom reaches zero.
   */
  getToken: baseProcedure.query(({ ctx }) => mintWebTicket(ctx.user.id)),

  list: baseProcedure.input(listInputSchema).query(async ({ ctx, input }) => {
    const organizationId = input?.organizationId;
    const includeCloudAgentSessions = input?.includeCloudAgentSessions === true;
    if (typeof organizationId === 'string') {
      await ensureOrganizationAccess(ctx, organizationId);
    }

    // Phase 1: fetch + parse the worker response. Any failure here
    // (HTTP error, malformed JSON, schema mismatch) degrades to an empty
    // list exactly as before — these are "no data" outcomes from the
    // mobile client's point of view. With includeCloudAgentSessions, all
    // three early exits fall through to the cloud-candidates query (D11).
    let parsed: { sessions: ActiveSession[] } = { sessions: [] };

    if (!SESSION_INGEST_WORKER_URL) {
      if (!includeCloudAgentSessions) {
        return { sessions: [] as ActiveSession[] };
      }
    } else {
      const token = generateInternalServiceToken(ctx.user.id);
      const url = `${SESSION_INGEST_WORKER_URL}/api/sessions/active`;

      try {
        const response = await fetch(url, {
          headers: { Authorization: `Bearer ${token}` },
        });

        if (!response.ok) {
          console.warn(
            `[active-sessions] fetch failed: ${response.status} ${response.statusText}`,
            await response.text().catch(() => '')
          );
          if (!includeCloudAgentSessions) {
            return { sessions: [] as ActiveSession[] };
          }
        } else {
          const raw = await response.json();
          parsed = activeSessionsResponseSchema.parse(raw);
        }
      } catch (error) {
        console.warn('[active-sessions] error:', error);
        if (!includeCloudAgentSessions) {
          return { sessions: [] as ActiveSession[] };
        }
      }
    }

    // Phase 2a — Query 1: enrich heartbeat sessions from cli_sessions_v2.
    // Independent try/catch from Query 2 (D16). Skipped when there are no
    // heartbeat ids (never an empty inArray).
    const ids = parsed.sessions.map(s => s.id);
    let enrichmentRows: EnrichmentRow[] = [];
    let enrichmentFailed = false;

    if (ids.length > 0) {
      try {
        enrichmentRows = await db
          .select({
            session_id: cli_sessions_v2.session_id,
            created_on_platform: cli_sessions_v2.created_on_platform,
            created_at: cli_sessions_v2.created_at,
            updated_at: cli_sessions_v2.updated_at,
            status: cli_sessions_v2.status,
            title: cli_sessions_v2.title,
            organization_id: cli_sessions_v2.organization_id,
            last_activity_at: cli_sessions_v2.last_activity_at,
            total_cost_microdollars: cli_sessions_v2.total_cost_microdollars,
            session_pr_platform: cli_sessions_v2.platform,
            session_pr_url: cli_sessions_v2.pr_url,
            session_pr_number: cli_sessions_v2.pr_number,
            pr_url: github_branch_pull_requests.pr_url,
            pr_number: github_branch_pull_requests.pr_number,
            pr_state: github_branch_pull_requests.pr_state,
            pr_title: github_branch_pull_requests.pr_title,
            pr_head_sha: github_branch_pull_requests.pr_head_sha,
            pr_last_synced_at: github_branch_pull_requests.pr_last_synced_at,
            pr_review_decision: github_branch_pull_requests.pr_review_decision,
            review_decision_pending: github_branch_pull_requests.review_decision_pending,
          })
          .from(cli_sessions_v2)
          .leftJoin(github_branch_pull_requests, sessionPrJoinPredicate)
          .where(
            and(
              eq(cli_sessions_v2.kilo_user_id, ctx.user.id),
              inArray(cli_sessions_v2.session_id, ids)
            )
          );
      } catch (error) {
        console.warn('[active-sessions] enrichment db query failed:', error);
        // Attribution is unknowable without the join. An unfiltered caller (web,
        // `resolveSession`) keeps the existing best-effort unenriched passthrough —
        // a DB blip must not collapse its list. A filtered caller cannot be
        // answered at all: calling every row personal would lie (breaking AC 1)
        // and returning an empty list would silently blank the tray with no
        // explanation. So fail the query and let the client's already-shipped
        // retryable state handle it (D11).
        if (organizationId === undefined) {
          enrichmentFailed = true;
          if (!includeCloudAgentSessions) {
            return parsed;
          }
        } else {
          throwOrgContextFailure(error);
        }
      }
    } else if (!includeCloudAgentSessions) {
      // Flag-off empty heartbeats: today's short-circuit (no DB).
      return parsed;
    }

    let sessions: ActiveSession[];
    if (enrichmentFailed) {
      // Unfiltered + flag on: keep wire rows unenriched, still attempt cloud.
      sessions = [...parsed.sessions];
    } else {
      const byId = new Map(enrichmentRows.map(r => [r.session_id, r]));
      sessions = [];
      for (const session of parsed.sessions) {
        const row = byId.get(session.id);
        // No `cli_sessions_v2` row → unattributable → personal. An SQL-side filter
        // could not tell this case apart from "belongs to another organization".
        const rowOrganizationId = row?.organization_id ?? null;
        if (organizationId !== undefined && rowOrganizationId !== organizationId) {
          continue;
        }
        sessions.push(mapEnrichedHeartbeatSession(session, row));
      }
    }

    // Phase 2b — Query 2: live cloud-agent candidates (flag-on only).
    // Own try/catch; failure semantics mirror Query 1 (D16).
    if (includeCloudAgentSessions) {
      try {
        const orgPredicate =
          organizationId === null
            ? isNull(cli_sessions_v2.organization_id)
            : typeof organizationId === 'string'
              ? eq(cli_sessions_v2.organization_id, organizationId)
              : undefined;

        const livePredicate = or(
          sql`EXISTS (
            SELECT 1 FROM ${cloud_agent_session_runs}
            WHERE ${cloud_agent_session_runs.cloud_agent_session_id} = ${cli_sessions_v2.cloud_agent_session_id}
              AND ${cloud_agent_session_runs.terminal_at} IS NULL
          )`,
          and(
            eq(cli_sessions_v2.status, 'idle'),
            gt(cli_sessions_v2.status_updated_at, CLOUD_AGENT_WARM_IDLE_CUTOFF)
          )
        );

        const cloudRows: CloudCandidateRow[] = await db
          .select({
            session_id: cli_sessions_v2.session_id,
            created_on_platform: cli_sessions_v2.created_on_platform,
            created_at: cli_sessions_v2.created_at,
            updated_at: cli_sessions_v2.updated_at,
            status: cli_sessions_v2.status,
            title: cli_sessions_v2.title,
            organization_id: cli_sessions_v2.organization_id,
            git_url: cli_sessions_v2.git_url,
            git_branch: cli_sessions_v2.git_branch,
            last_activity_at: cli_sessions_v2.last_activity_at,
            total_cost_microdollars: cli_sessions_v2.total_cost_microdollars,
            cloud_agent_session_id: cli_sessions_v2.cloud_agent_session_id,
            session_pr_platform: cli_sessions_v2.platform,
            session_pr_url: cli_sessions_v2.pr_url,
            session_pr_number: cli_sessions_v2.pr_number,
            pr_url: github_branch_pull_requests.pr_url,
            pr_number: github_branch_pull_requests.pr_number,
            pr_state: github_branch_pull_requests.pr_state,
            pr_title: github_branch_pull_requests.pr_title,
            pr_head_sha: github_branch_pull_requests.pr_head_sha,
            pr_last_synced_at: github_branch_pull_requests.pr_last_synced_at,
            pr_review_decision: github_branch_pull_requests.pr_review_decision,
            review_decision_pending: github_branch_pull_requests.review_decision_pending,
          })
          .from(cli_sessions_v2)
          .leftJoin(github_branch_pull_requests, sessionPrJoinPredicate)
          .where(
            and(
              eq(cli_sessions_v2.kilo_user_id, ctx.user.id),
              isNull(cli_sessions_v2.parent_session_id),
              isNotNull(cli_sessions_v2.cloud_agent_session_id),
              orgPredicate,
              livePredicate
            )
          )
          .orderBy(desc(cli_sessions_v2.created_at))
          .limit(50);

        const heartbeatIds = new Set(sessions.map(s => s.id));
        for (const row of cloudRows) {
          // CLI adoption wins: keep the worker row's real connectionId/status.
          if (heartbeatIds.has(row.session_id)) continue;
          sessions.push(mapCloudCandidateRow(row));
        }
      } catch (error) {
        console.warn('[active-sessions] cloud candidates db query failed:', error);
        if (organizationId !== undefined) {
          throwOrgContextFailure(error);
        }
        // Unfiltered: skip cloud merge, return heartbeat rows as built.
      }
    }

    return { sessions };
  }),

  /**
   * Live snapshot of every `kilo remote` instance currently connected for the
   * authenticated user. Unlike `list` (which swallows upstream errors into
   * `{sessions: []}`), this throws a `TRPCError` on failure so the mobile
   * UI can distinguish a retryable transport error from a genuine empty
   * state. The companion `getToken` call is owned by C2.
   */
  listInstances: baseProcedure.query(async ({ ctx }) => {
    if (!SESSION_INGEST_WORKER_URL) {
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'SESSION_INGEST_WORKER_URL is not configured',
      });
    }

    const token = generateInternalServiceToken(ctx.user.id);
    const url = `${SESSION_INGEST_WORKER_URL}/api/instances/active`;

    let response: Response;
    try {
      response = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
      });
    } catch (error) {
      console.warn('[active-sessions.instances] fetch error:', error);
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Failed to reach session-ingest worker',
        cause: error,
      });
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      console.warn(
        `[active-sessions.instances] non-2xx: ${response.status} ${response.statusText}`,
        body
      );
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: `Session-ingest worker returned ${response.status}`,
      });
    }

    const raw = await response.json();
    return connectedInstancesResponseSchema.parse(raw);
  }),
});
