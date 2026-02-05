import 'server-only';
import { baseProcedure, createTRPCRouter } from '@/lib/trpc/init';
import * as z from 'zod';
import { db } from '@/lib/drizzle';
import { eq, and, desc, lt } from 'drizzle-orm';
import { TRPCError } from '@trpc/server';
import { TRPCClientError } from '@trpc/client';
import { cli_sessions_v2 } from '@/db/schema';
import { createCloudAgentNextClient } from '@/lib/cloud-agent-next/cloud-agent-client';
import { generateApiToken } from '@/lib/tokens';
import { baseGetSessionNextOutputSchema } from './cloud-agent-next-schemas';

/**
 * Check if an error indicates the session was not found in the cloud-agent DO.
 * This is expected for legacy sessions created before the new DO-based system.
 */
function isSessionNotFoundError(err: unknown): boolean {
  if (err instanceof TRPCClientError) {
    const data = err.data as { code?: string; httpStatus?: number } | undefined;
    const shape = err.shape as { data?: { code?: string; httpStatus?: number } } | undefined;
    // Check TRPC error code
    const code = data?.code ?? shape?.data?.code;
    if (code === 'NOT_FOUND') {
      return true;
    }
    // Also check HTTP status 404
    const httpStatus = data?.httpStatus ?? shape?.data?.httpStatus;
    if (httpStatus === 404) {
      return true;
    }
  }
  return false;
}

const PAGE_SIZE = 10;

/**
 * Fields to select for session list/get operations
 */
const commonSessionFields = {
  session_id: cli_sessions_v2.session_id,
  title: cli_sessions_v2.title,
  cloud_agent_session_id: cli_sessions_v2.cloud_agent_session_id,
  created_at: cli_sessions_v2.created_at,
  updated_at: cli_sessions_v2.updated_at,
  version: cli_sessions_v2.version,
} as const;

const sessionIdField = z.string().min(1);
const cloudAgentSessionIdField = z.string().min(1).max(255);

/**
 * Verify user owns the session. Returns the session if found.
 */
async function getSessionWithOwnerCheck(sessionId: string, userId: string) {
  const [session] = await db
    .select()
    .from(cli_sessions_v2)
    .where(and(eq(cli_sessions_v2.session_id, sessionId), eq(cli_sessions_v2.kilo_user_id, userId)))
    .limit(1);

  if (!session) {
    throw new TRPCError({
      code: 'NOT_FOUND',
      message: 'Session not found',
    });
  }

  return session;
}

const ListSessionsInputSchema = z.object({
  cursor: z.iso.datetime().optional(),
  limit: z.number().min(1).max(50).optional().default(PAGE_SIZE),
  orderBy: z.enum(['created_at', 'updated_at']).optional().default('created_at'),
});

const GetSessionInputSchema = z.object({
  session_id: sessionIdField,
});

const GetByCloudAgentSessionIdInputSchema = z.object({
  cloud_agent_session_id: cloudAgentSessionIdField,
});

/**
 * Router for cli_sessions_v2 table operations.
 * Used by cloud-agent-next for session storage and retrieval.
 *
 * Note: Records in this table are created by the cloud-agent-next worker.
 * This router only queries the data.
 */
export const cliSessionsV2Router = createTRPCRouter({
  /**
   * List sessions for the current user with cursor-based pagination.
   */
  list: baseProcedure.input(ListSessionsInputSchema).query(async ({ ctx, input }) => {
    const { cursor, limit, orderBy } = input;

    const orderColumn =
      orderBy === 'updated_at' ? cli_sessions_v2.updated_at : cli_sessions_v2.created_at;

    const whereConditions = [eq(cli_sessions_v2.kilo_user_id, ctx.user.id)];

    if (cursor) {
      whereConditions.push(lt(orderColumn, cursor));
    }

    const results = await db
      .select(commonSessionFields)
      .from(cli_sessions_v2)
      .where(and(...whereConditions))
      .orderBy(desc(orderColumn))
      .limit(limit + 1);

    const hasMore = results.length > limit;
    const resultSessions = hasMore ? results.slice(0, limit) : results;

    const nextCursor =
      resultSessions.length > 0
        ? new Date(
            orderBy === 'updated_at'
              ? resultSessions[resultSessions.length - 1].updated_at
              : resultSessions[resultSessions.length - 1].created_at
          ).toISOString()
        : null;

    return {
      cliSessions: resultSessions,
      nextCursor: hasMore ? nextCursor : null,
    };
  }),

  /**
   * Get a single session by session_id.
   */
  get: baseProcedure.input(GetSessionInputSchema).query(async ({ ctx, input }) => {
    const { session_id } = input;

    const [session] = await db
      .select()
      .from(cli_sessions_v2)
      .where(
        and(
          eq(cli_sessions_v2.session_id, session_id),
          eq(cli_sessions_v2.kilo_user_id, ctx.user.id)
        )
      )
      .limit(1);

    if (!session) {
      throw new TRPCError({
        code: 'NOT_FOUND',
        message: 'Session not found',
      });
    }

    return session;
  }),

  /**
   * Get a session by its cloud_agent_session_id.
   * Used for reverse lookup from cloud-agent session ID to kilo session.
   */
  getByCloudAgentSessionId: baseProcedure
    .input(GetByCloudAgentSessionIdInputSchema)
    .query(async ({ ctx, input }) => {
      const { cloud_agent_session_id } = input;

      const [session] = await db
        .select(commonSessionFields)
        .from(cli_sessions_v2)
        .where(
          and(
            eq(cli_sessions_v2.cloud_agent_session_id, cloud_agent_session_id),
            eq(cli_sessions_v2.kilo_user_id, ctx.user.id)
          )
        )
        .limit(1);

      if (!session) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'No kilo session found for this cloud-agent session',
        });
      }

      return session;
    }),

  /**
   * Get messages for a V2 session from R2.
   * Messages are stored as JSON blobs in R2.
   */
  getSessionMessages: baseProcedure
    .input(z.object({ session_id: sessionIdField }))
    .query(async ({ ctx, input }) => {
      // Verify ownership
      await getSessionWithOwnerCheck(input.session_id, ctx.user.id);
      return { messages: [] };

      // TODO: cloud-agent-next
      // const blobKey = getV2MessagesBlobKey(input.session_id);

      // try {
      //   const messages = await getBlobContent(blobKey);
      //   return { messages: messages ?? [] };
      // } catch (error) {
      //   // If blob doesn't exist yet, return empty messages
      //   // This is expected for new sessions before first sync
      //   if (error instanceof Error && error.name === 'NoSuchKey') {
      //     return { messages: [] };
      //   }
      //   throw error;
      // }
    }),

  /**
   * Get a session by session_id with runtime state from the Durable Object.
   *
   * This combines the DB fetch (ownership check + metadata) with the DO fetch
   * (mode, model, repository, execution state) in a single call.
   *
   * For V2 sessions (those with cloud_agent_session_id), this also fetches
   * runtime state from the cloud-agent DO. For CLI sessions without a
   * cloud_agent_session_id, runtimeState will be null.
   */
  getWithRuntimeState: baseProcedure
    .input(GetSessionInputSchema)
    .output(
      z.object({
        // DB fields
        session_id: z.string(),
        title: z.string().nullable(),
        cloud_agent_session_id: z.string().nullable(),
        organization_id: z.string().nullable(),
        created_at: z.coerce.date(),
        updated_at: z.coerce.date(),
        version: z.number(),
        // Runtime state from DO (null for CLI sessions without cloud_agent_session_id)
        runtimeState: baseGetSessionNextOutputSchema.nullable(),
      })
    )
    .query(async ({ ctx, input }) => {
      const { session_id } = input;

      // 1. Fetch from DB with ownership check
      const [session] = await db
        .select()
        .from(cli_sessions_v2)
        .where(
          and(
            eq(cli_sessions_v2.session_id, session_id),
            eq(cli_sessions_v2.kilo_user_id, ctx.user.id)
          )
        )
        .limit(1);

      if (!session) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Session not found',
        });
      }

      // 2. If session has cloud_agent_session_id, fetch runtime state from DO
      let runtimeState: z.infer<typeof baseGetSessionNextOutputSchema> | null = null;

      if (session.cloud_agent_session_id) {
        try {
          const authToken = generateApiToken(ctx.user);
          const client = createCloudAgentNextClient(authToken);
          runtimeState = await client.getSession(session.cloud_agent_session_id);
        } catch (error) {
          // Only swallow "not found" errors - these indicate legacy sessions
          // For transient errors (network, timeout, 5xx), re-throw so the client can retry
          if (isSessionNotFoundError(error)) {
            console.log(
              `Session ${session_id} not found in cloud-agent DO - treating as legacy session`
            );
            // runtimeState stays null
          } else {
            console.error(
              `Failed to fetch runtime state for session ${session_id}:`,
              error instanceof Error ? error.message : error
            );
            throw new TRPCError({
              code: 'INTERNAL_SERVER_ERROR',
              message: 'Failed to fetch session runtime state',
              cause: error,
            });
          }
        }
      }

      return {
        session_id: session.session_id,
        title: session.title,
        cloud_agent_session_id: session.cloud_agent_session_id,
        organization_id: session.organization_id ?? null,
        created_at: session.created_at,
        updated_at: session.updated_at,
        version: session.version,
        runtimeState,
      };
    }),
});
