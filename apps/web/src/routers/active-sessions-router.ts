import 'server-only';
import { baseProcedure, createTRPCRouter } from '@/lib/trpc/init';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { SESSION_INGEST_WORKER_URL } from '@/lib/config.server';
import { generateInternalServiceToken } from '@/lib/tokens';
import { db } from '@/lib/drizzle';
import { cli_sessions_v2 } from '@kilocode/db/schema';
import { and, eq, inArray } from 'drizzle-orm';
import { ensureOrganizationAccess } from '@/routers/organizations/utils';

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
   * Capabilities advertised by the CLI connection that owns this session.
   * Omitted when the owning connection's latest heartbeat did not include a
   * capabilities object (legacy CLI, or a CLI that predates the field).
   */
  capabilities: z.object({ attachments: z.boolean().optional() }).optional(),
  // Optional: legacy CLIs (predating the `kilo remote` spawner) never
  // report a platform. Only present in the response when the CLI supplied it.
  platform: z.string().optional(),
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

const listInputSchema = z
  .object({
    /**
     * Personal/organization context. `undefined` = no context filter (the
     * liveness-resolution callers), `null` = personal only, a uuid = that
     * organization. Mirrors `addOrganizationCondition` in
     * `cli-sessions-v2-router.ts`.
     */
    organizationId: z.uuid().nullable().optional(),
  })
  .optional();

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

export const activeSessionsRouter = createTRPCRouter({
  getToken: baseProcedure.query(async ({ ctx }) => {
    const token = generateInternalServiceToken(ctx.user.id);
    return { token };
  }),

  list: baseProcedure.input(listInputSchema).query(async ({ ctx, input }) => {
    const organizationId = input?.organizationId;
    if (typeof organizationId === 'string') {
      await ensureOrganizationAccess(ctx, organizationId);
    }

    if (!SESSION_INGEST_WORKER_URL) {
      return { sessions: [] as ActiveSession[] };
    }

    const token = generateInternalServiceToken(ctx.user.id);
    const url = `${SESSION_INGEST_WORKER_URL}/api/sessions/active`;

    // Phase 1: fetch + parse the worker response. Any failure here
    // (HTTP error, malformed JSON, schema mismatch) degrades to an empty
    // list exactly as before — these are "no data" outcomes from the
    // mobile client's point of view.
    let parsed: { sessions: ActiveSession[] };
    try {
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
      });

      if (!response.ok) {
        console.warn(
          `[active-sessions] fetch failed: ${response.status} ${response.statusText}`,
          await response.text().catch(() => '')
        );
        return { sessions: [] as ActiveSession[] };
      }

      const raw = await response.json();
      parsed = activeSessionsResponseSchema.parse(raw);
    } catch (error) {
      console.warn('[active-sessions] error:', error);
      return { sessions: [] as ActiveSession[] };
    }

    // Phase 2: enrich parsed sessions with per-session platform + timestamps
    // by joining against cli_sessions_v2. A DB failure here MUST NOT
    // collapse the list to empty — callers fall back to unenriched rows.
    if (parsed.sessions.length === 0) {
      return parsed;
    }

    const ids = parsed.sessions.map(s => s.id);
    let rows: Array<{
      session_id: string;
      created_on_platform: string | null;
      created_at: string;
      updated_at: string;
      status: string | null;
      title: string | null;
      organization_id: string | null;
    }> = [];
    try {
      rows = await db
        .select({
          session_id: cli_sessions_v2.session_id,
          created_on_platform: cli_sessions_v2.created_on_platform,
          created_at: cli_sessions_v2.created_at,
          updated_at: cli_sessions_v2.updated_at,
          status: cli_sessions_v2.status,
          title: cli_sessions_v2.title,
          organization_id: cli_sessions_v2.organization_id,
        })
        .from(cli_sessions_v2)
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
        return parsed;
      }
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Failed to resolve the organization context for active sessions',
        cause: error,
      });
    }

    const byId = new Map(rows.map(r => [r.session_id, r]));
    const sessions: ActiveSession[] = [];
    for (const session of parsed.sessions) {
      const row = byId.get(session.id);
      // No `cli_sessions_v2` row → unattributable → personal. An SQL-side filter
      // could not tell this case apart from "belongs to another organization".
      const rowOrganizationId = row?.organization_id ?? null;
      if (organizationId !== undefined && rowOrganizationId !== organizationId) {
        continue;
      }
      if (!row) {
        // Always emit the field, `null` included: an absent `organizationId` on
        // a client-cached row must mean "never server-attributed" and nothing
        // else, or the client filter cannot tell a heartbeat-inserted row apart
        // from a server-attributed personal one (D4/D6).
        sessions.push({ ...session, organizationId: null });
        continue;
      }
      sessions.push({
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
      });
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
