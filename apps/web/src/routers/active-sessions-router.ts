import 'server-only';
import { baseProcedure, createTRPCRouter } from '@/lib/trpc/init';
import { z } from 'zod';
import { and, eq, inArray } from 'drizzle-orm';
import { SESSION_INGEST_WORKER_URL } from '@/lib/config.server';
import { generateInternalServiceToken } from '@/lib/tokens';
import { db } from '@/lib/drizzle';
import { cli_sessions_v2 } from '@kilocode/db/schema';

const activeSessionSchema = z.object({
  id: z.string(),
  status: z.string(),
  title: z.string(),
  connectionId: z.string(),
  gitUrl: z.string().optional(),
  gitBranch: z.string().optional(),
  // Additively enriched from the caller's own stored row, when present.
  createdOnPlatform: z.string().optional(),
  organizationId: z.string().nullable().optional(),
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
      const parsed = activeSessionsResponseSchema.parse(raw);

      if (parsed.sessions.length === 0) {
        return parsed;
      }

      try {
        // Enrich with the caller's own stored metadata. Filtering by
        // `kilo_user_id` keeps another user's stored row from leaking into
        // this response, even if the ingest worker returns an id that the
        // current user does not own.
        const metadata = await db
          .select({
            sessionId: cli_sessions_v2.session_id,
            createdOnPlatform: cli_sessions_v2.created_on_platform,
            organizationId: cli_sessions_v2.organization_id,
            gitUrl: cli_sessions_v2.git_url,
            gitBranch: cli_sessions_v2.git_branch,
          })
          .from(cli_sessions_v2)
          .where(
            and(
              eq(cli_sessions_v2.kilo_user_id, ctx.user.id),
              inArray(
                cli_sessions_v2.session_id,
                parsed.sessions.map(session => session.id)
              )
            )
          );

        const metadataById = new Map(metadata.map(row => [row.sessionId, row]));

        return {
          sessions: parsed.sessions.map(session => {
            const stored = metadataById.get(session.id);
            if (!stored) return session;
            return {
              ...session,
              createdOnPlatform: stored.createdOnPlatform,
              organizationId: stored.organizationId,
              // Stored Git fields are authoritative when present; fall back
              // to the heartbeat-reported values otherwise.
              gitUrl: stored.gitUrl ?? session.gitUrl,
              gitBranch: stored.gitBranch ?? session.gitBranch,
            };
          }),
        };
      } catch (error) {
        console.warn('[active-sessions] enrichment error:', error);
        return parsed;
      }
    } catch (error) {
      console.warn('[active-sessions] error:', error);
      return { sessions: [] as ActiveSession[] };
    }
  }),
});
