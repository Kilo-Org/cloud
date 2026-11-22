import 'server-only';
import { baseProcedure, createTRPCRouter } from '@kilocode/web-shared/lib/trpc/init';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { SESSION_INGEST_WORKER_URL } from '@kilocode/web-shared/lib/config.server';
import {
  CONTROL_PLANE_UPSTREAM_BUDGET_MS,
  fetchWithinBudget,
  readJsonWithinBudget,
  readTextWithinBudget,
} from '@/lib/bounded-service-fetch';
import { generateBoundedInternalServiceToken } from '@kilocode/web-shared/lib/tokens';
import { SESSION_INGEST_AUDIENCE } from '@kilocode/worker-utils/internal-service-token-audiences';
import {
  ensureMemberOrganizationAccess,
  ensureOrganizationAccess,
} from '@kilocode/web-shared/routers/organizations/utils';
import {
  activeSessionSchema,
  listActiveSessions,
  resolveActiveSessionStatus,
  CLOUD_AGENT_CONNECTION_ID,
  type ActiveSession,
} from '@/lib/active-sessions-list';
import { homeWidgetResponseSchema } from '@kilocode/app-shared/home-widget';
import { buildHomeWidgetResponseForUser } from '@/lib/glanceable-agents-snapshot-server';
import { issueHomeWidgetCredential } from '@/lib/auth/home-widget-credential';

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
  // Old CLIs and hibernated attachments omit this metadata. Remove these defaults
  // only after all supported metadata-free producers and attachments have retired.
  kind: z.enum(['cli', 'remote']).default('cli'),
  startedAt: z.string().datetime({ precision: 3 }).length(24).nullable().default(null),
  gitBranch: z.string().max(24).nullable().default(null),
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
      // Absent means the CLI cannot clone up to a message (fork from here).
      sessionCloneAtMessage: z.boolean().optional(),
    })
    .optional(),
});

const connectedInstancesResponseSchema = z.object({
  instances: z.array(connectedInstanceSchema),
});

export type ConnectedInstance = z.infer<typeof connectedInstanceSchema>;

/** Longest upstream error excerpt this module logs (matches the security Worker clients). */
const INSTANCE_ERROR_LOG_EXCERPT_CHARS = 200;

/**
 * Classifies a failed session-ingest body read.
 *
 * Only a body that arrived in full and is not JSON is a bad gateway answer
 * (`SyntaxError` from `JSON.parse`). Every other failure is a transport
 * failure — the read outlived its budget (`ServiceFetchTimeoutError`) or the
 * transfer broke mid-body (`TypeError` from a reset connection or a premature
 * close) — which is the same failure the fetch stage maps to
 * `SERVICE_UNAVAILABLE`, so it stays retryable here too.
 */
function bodyReadFailureError(error: unknown, malformedMessage: string): TRPCError {
  if (error instanceof SyntaxError) {
    return new TRPCError({ code: 'BAD_GATEWAY', message: malformedMessage, cause: error });
  }
  return new TRPCError({
    code: 'SERVICE_UNAVAILABLE',
    message: 'Session ingest is unavailable',
    cause: error,
  });
}

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
 * expiry from the worker body.
 *
 * Only a missing worker URL is PRECONDITION_FAILED. A worker that cannot be
 * reached, or does not answer inside the budget, is SERVICE_UNAVAILABLE — the
 * budget covers the body read too, so a worker that sends headers and then
 * stalls the body fails the same way. A mint response with status 503 or 504
 * is also SERVICE_UNAVAILABLE. Any other non-2xx or malformed mint response is
 * BAD_GATEWAY.
 */
async function mintWebTicket(userId: string): Promise<{ token: string; expiresAt: number }> {
  if (!SESSION_INGEST_WORKER_URL) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'Session ingest is not configured',
    });
  }

  const token = generateBoundedInternalServiceToken(userId, {
    audience: SESSION_INGEST_AUDIENCE,
    expiresIn: 60 * 60,
  });
  const url = `${SESSION_INGEST_WORKER_URL}/api/user/web-ticket`;
  const startedAt = Date.now();

  let response: Response;
  try {
    // Bounded: a worker that never answers rejects inside the budget with
    // `ServiceFetchTimeoutError`, which the catch below maps to
    // SERVICE_UNAVAILABLE exactly as any other transport failure.
    response = await fetchWithinBudget(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch (error) {
    throw new TRPCError({
      code: 'SERVICE_UNAVAILABLE',
      message: 'Session ingest is unavailable',
      cause: error,
    });
  }

  if (!response.ok) {
    // The mint reports a retryable condition with 503: the Durable Object hop
    // was unavailable or outlived its budget inside the worker, so a retry can
    // still mint. Keep that retryability instead of flattening it into a
    // gateway error the client would treat as final.
    if (response.status === 503 || response.status === 504) {
      throw new TRPCError({
        code: 'SERVICE_UNAVAILABLE',
        message: 'Session ingest is unavailable',
      });
    }
    throw new TRPCError({
      code: 'BAD_GATEWAY',
      message: `Session ingest failed to mint a ticket (status ${response.status})`,
    });
  }

  let raw: unknown;
  try {
    raw = await readJsonWithinBudget(
      response,
      CONTROL_PLANE_UPSTREAM_BUDGET_MS - (Date.now() - startedAt),
      CONTROL_PLANE_UPSTREAM_BUDGET_MS
    );
  } catch (error) {
    throw bodyReadFailureError(error, 'Invalid ticket response from session ingest');
  }
  const parsed = webTicketResponseSchema.safeParse(raw);
  if (!parsed.success) {
    throw new TRPCError({
      code: 'BAD_GATEWAY',
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

  /** Foreground JS consumers use normal user auth; native background reads use the dedicated widget route. */
  widgetSnapshot: baseProcedure
    .input(z.object({ organizationId: z.uuid().nullable() }))
    .output(homeWidgetResponseSchema)
    .query(async ({ ctx, input }) => {
      if (input.organizationId !== null) {
        // A personal widget never uses the platform-admin elevation bypass and
        // never accepts a support grant.
        await ensureMemberOrganizationAccess(ctx.user, input.organizationId);
      }
      return buildHomeWidgetResponseForUser({
        userId: ctx.user.id,
        organizationId: input.organizationId,
      });
    }),

  widgetCredential: baseProcedure
    .input(z.object({ organizationId: z.uuid().nullable() }))
    .output(z.object({ token: z.string().min(1), expiresAt: z.number().int().positive() }))
    .query(({ ctx, input }) =>
      issueHomeWidgetCredential(ctx.user, input.organizationId, ctx.headersList)
    ),

  /**
   * Live snapshot of every `kilo remote` instance currently connected for the
   * authenticated user.
   *
   * Both this and `list` report a failed session-ingest read as
   * `SERVICE_UNAVAILABLE`: neither returns a bare empty list, which reads as
   * "nothing runs". This procedure classifies failures exactly like
   * `mintWebTicket` — transport failure or 503/504 stays retryable as
   * `SERVICE_UNAVAILABLE`, any other non-2xx or malformed body is
   * `BAD_GATEWAY`. The companion `getToken` call is owned by C2.
   */
  listInstances: baseProcedure.query(async ({ ctx }) => {
    if (!SESSION_INGEST_WORKER_URL) {
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'SESSION_INGEST_WORKER_URL is not configured',
      });
    }

    const token = generateBoundedInternalServiceToken(ctx.user.id, {
      audience: SESSION_INGEST_AUDIENCE,
      expiresIn: 60 * 60,
    });
    const url = `${SESSION_INGEST_WORKER_URL}/api/instances/active`;
    const startedAt = Date.now();
    // What the headers left of the one budget both the fetch and the body read
    // must fit in: a worker that stalls mid-body cannot hold the poll open.
    const remainingBudgetMs = () => CONTROL_PLANE_UPSTREAM_BUDGET_MS - (Date.now() - startedAt);

    let response: Response;
    try {
      response = await fetchWithinBudget(url, {
        headers: { Authorization: `Bearer ${token}` },
      });
    } catch (error) {
      // A worker that cannot be reached, or outlives the budget, is retryable:
      // the caller retries this code instead of treating it as a final fault.
      console.warn('[active-sessions.instances] fetch error:', error);
      throw new TRPCError({
        code: 'SERVICE_UNAVAILABLE',
        message: 'Session ingest is unavailable',
        cause: error,
      });
    }

    if (!response.ok) {
      if (response.status === 503 || response.status === 504) {
        // The worker reports a retryable condition with 503/504, and that is
        // already known from the status line. Answer it before touching the
        // body: a worker that sends the status and then stalls the body must
        // not hold the poll for the rest of the budget to report an error the
        // code already knows. Keep it retryable instead of flattening it into a
        // gateway error the client would treat as final.
        console.warn(
          `[active-sessions.instances] non-2xx: ${response.status} ${response.statusText}`
        );
        throw new TRPCError({
          code: 'SERVICE_UNAVAILABLE',
          message: 'Session ingest is unavailable',
        });
      }
      // Every other non-2xx is unclassified text. Read a bounded excerpt of it
      // inside what the headers left of the budget — never the whole payload on
      // a polled procedure — and report the failure as a bad gateway.
      let excerpt: string | null = null;
      try {
        // The cap is the excerpt length itself, so a long error page is neither
        // buffered to its end nor sliced after the fact.
        const text = await readTextWithinBudget(
          response,
          remainingBudgetMs(),
          CONTROL_PLANE_UPSTREAM_BUDGET_MS,
          INSTANCE_ERROR_LOG_EXCERPT_CHARS
        );
        // The first 200 characters of the upstream error body, whatever its
        // content type.
        excerpt = text;
      } catch {
        // A body that outlives the budget adds no note; the status below is the
        // whole report.
      }
      console.warn(
        `[active-sessions.instances] non-2xx: ${response.status} ${response.statusText}`,
        ...(excerpt === null ? [] : [excerpt])
      );
      throw new TRPCError({
        code: 'BAD_GATEWAY',
        message: `Session ingest worker returned ${response.status}`,
      });
    }

    let raw: unknown;
    try {
      raw = await readJsonWithinBudget(
        response,
        remainingBudgetMs(),
        CONTROL_PLANE_UPSTREAM_BUDGET_MS
      );
    } catch (error) {
      // A stalled body is the same transport failure the fetch raises; a body
      // that arrived but is not JSON is a bad gateway answer.
      console.warn('[active-sessions.instances] body read failed:', error);
      throw bodyReadFailureError(error, 'Invalid instance response from session ingest');
    }
    const parsed = connectedInstancesResponseSchema.safeParse(raw);
    if (!parsed.success) {
      throw new TRPCError({
        code: 'BAD_GATEWAY',
        message: 'Invalid instance response from session ingest',
        cause: parsed.error,
      });
    }
    return parsed.data;
  }),
});
