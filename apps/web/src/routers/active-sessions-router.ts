import 'server-only';
import { baseProcedure, createTRPCRouter } from '@/lib/trpc/init';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { SESSION_INGEST_WORKER_URL } from '@/lib/config.server';
import { generateInternalServiceToken } from '@/lib/tokens';

export const activeSessionSchema = z.object({
  id: z.string(),
  status: z.string(),
  title: z.string(),
  connectionId: z.string(),
  gitUrl: z.string().optional(),
  gitBranch: z.string().optional(),
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
});

const connectedInstancesResponseSchema = z.object({
  instances: z.array(connectedInstanceSchema),
});

export type ActiveSession = z.infer<typeof activeSessionSchema>;
export type ConnectedInstance = z.infer<typeof connectedInstanceSchema>;

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
