import 'server-only';
import { baseProcedure, createTRPCRouter } from '@/lib/trpc/init';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { SESSION_INGEST_WORKER_URL } from '@/lib/config.server';
import { generateInternalServiceToken } from '@/lib/tokens';
import { ensureOrganizationAccess } from '@/routers/organizations/utils';
import {
  activeSessionSchema,
  listActiveSessions,
  resolveActiveSessionStatus,
  CLOUD_AGENT_CONNECTION_ID,
  type ActiveSession,
} from '@/lib/active-sessions-list';

// Re-exported for existing consumers and tests.
export {
  activeSessionSchema,
  resolveActiveSessionStatus,
  CLOUD_AGENT_CONNECTION_ID,
  type ActiveSession,
};

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
  capabilities: z
    .object({
      attachments: z.boolean().optional(),
      // Old form is absent sessionClone; treat missing as incapable until
      // every shipped CLI advertises it.
      sessionClone: z.boolean().optional(),
    })
    .optional(),
});

const connectedInstancesResponseSchema = z.object({
  instances: z.array(connectedInstanceSchema),
});

export type ConnectedInstance = z.infer<typeof connectedInstanceSchema>;

/**
 * Session Ingest `/api/user/web-ticket` mint response. Parsed at runtime so a
 * malformed 200 fails the mutation instead of returning undefined fields.
 */
const webTicketResponseSchema = z.object({
  ticket: z.string().min(1),
  expiresAt: z.number(),
});

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
    return listActiveSessions({
      userId: ctx.user.id,
      organizationId,
      includeCloudAgentSessions,
    });
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
