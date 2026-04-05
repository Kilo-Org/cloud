import 'server-only';
import { baseProcedure, createTRPCRouter } from '@/lib/trpc/init';
import { z } from 'zod';
import { SESSION_INGEST_WORKER_URL } from '@/lib/config.server';
import { generateInternalServiceToken } from '@/lib/tokens';

const activeSessionSchema = z.object({
  id: z.string(),
  status: z.string(),
  title: z.string(),
  connectionId: z.string(),
  gitUrl: z.string().optional(),
  gitBranch: z.string().optional(),
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
      return activeSessionsResponseSchema.parse(raw);
    } catch (error) {
      console.warn('[active-sessions] error:', error);
      return { sessions: [] as ActiveSession[] };
    }
  }),
});
