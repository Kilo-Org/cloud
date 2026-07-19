import 'server-only';
import { baseProcedure, createTRPCRouter } from '@/lib/trpc/init';
import { z } from 'zod';
import { SESSION_INGEST_WORKER_URL } from '@/lib/config.server';
import { generateInternalServiceToken } from '@/lib/tokens';
import { db } from '@/lib/drizzle';
import { cli_sessions_v2 } from '@kilocode/db/schema';
import { and, eq, inArray } from 'drizzle-orm';

const activeSessionSchema = z.object({
  id: z.string(),
  status: z.string(),
  title: z.string(),
  connectionId: z.string(),
  gitUrl: z.string().optional(),
  gitBranch: z.string().optional(),
  createdOnPlatform: z.string().optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
});

const activeSessionsResponseSchema = z.object({
  sessions: z.array(activeSessionSchema),
});

export type ActiveSession = z.infer<typeof activeSessionSchema>;

export const activeSessionsRouter = createTRPCRouter({
  getToken: baseProcedure.query(async ({ ctx }) => {
    const token = generateInternalServiceToken(ctx.user.id);
    return { token };
  }),

  list: baseProcedure.query(async ({ ctx }) => {
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
    }> = [];
    try {
      rows = await db
        .select({
          session_id: cli_sessions_v2.session_id,
          created_on_platform: cli_sessions_v2.created_on_platform,
          created_at: cli_sessions_v2.created_at,
          updated_at: cli_sessions_v2.updated_at,
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
      return parsed;
    }

    const byId = new Map(rows.map(r => [r.session_id, r]));
    const sessions: ActiveSession[] = parsed.sessions.map(session => {
      const row = byId.get(session.id);
      if (!row) {
        return session;
      }
      // Explicit snake_case → camelCase mapping: the mobile client only
      // reads createdOnPlatform/createdAt/updatedAt, so we do not spread
      // the DB row (which carries snake_case keys it never uses).
      return {
        ...session,
        createdOnPlatform: row.created_on_platform ?? undefined,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      };
    });

    return { sessions };
  }),
});
