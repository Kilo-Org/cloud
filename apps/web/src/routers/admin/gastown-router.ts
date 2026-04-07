import 'server-only';

import { adminProcedure, createTRPCRouter } from '@/lib/trpc/init';
import { TRPCError } from '@trpc/server';
import * as z from 'zod';
import {
  GASTOWN_SERVICE_URL,
  GASTOWN_CF_ACCESS_CLIENT_ID,
  GASTOWN_CF_ACCESS_CLIENT_SECRET,
  CLOUDFLARE_ACCOUNT_ID,
  CLOUDFLARE_TOWN_DO_NAMESPACE_ID,
  CLOUDFLARE_CONTAINER_DO_NAMESPACE_ID,
} from '@/lib/config.server';
import { generateApiToken } from '@/lib/tokens';
import type { User } from '@kilocode/db/schema';

// ── Zod schemas matching Gastown API response shapes ─────────────────────────

const UserTownRecord = z.object({
  id: z.string(),
  name: z.string(),
  owner_user_id: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
});

const UserRigRecord = z.object({
  id: z.string(),
  town_id: z.string(),
  name: z.string(),
  git_url: z.string(),
  default_branch: z.string(),
  platform_integration_id: z.string().nullable().optional().default(null),
  created_at: z.string(),
  updated_at: z.string(),
});

const BeadRecord = z.object({
  bead_id: z.string(),
  type: z.enum(['issue', 'message', 'escalation', 'merge_request', 'convoy', 'molecule', 'agent']),
  status: z.enum(['open', 'in_progress', 'closed', 'failed']),
  title: z.string(),
  body: z.string().nullable(),
  rig_id: z.string().nullable(),
  parent_bead_id: z.string().nullable(),
  assignee_agent_bead_id: z.string().nullable(),
  priority: z.enum(['low', 'medium', 'high', 'critical']),
  labels: z.array(z.string()),
  metadata: z.record(z.string(), z.unknown()),
  created_by: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
  closed_at: z.string().nullable(),
});

const AgentRecord = z.object({
  id: z.string(),
  rig_id: z.string().nullable(),
  role: z.string(),
  name: z.string(),
  identity: z.string(),
  status: z.string(),
  current_hook_bead_id: z.string().nullable(),
  dispatch_attempts: z.number().default(0),
  last_activity_at: z.string().nullable(),
  checkpoint: z.unknown().optional(),
  created_at: z.string(),
});

const BeadEventRecord = z.object({
  bead_event_id: z.string(),
  bead_id: z.string(),
  agent_id: z.string().nullable(),
  event_type: z.string(),
  old_value: z.string().nullable(),
  new_value: z.string().nullable(),
  metadata: z.record(z.string(), z.unknown()),
  created_at: z.string(),
  rig_id: z.string().optional(),
  rig_name: z.string().optional(),
});

const AlarmStatusRecord = z.object({
  alarm: z.object({
    nextFireAt: z.string().nullable(),
    intervalMs: z.number(),
    intervalLabel: z.string(),
  }),
  agents: z.object({
    working: z.number(),
    idle: z.number(),
    stalled: z.number(),
    dead: z.number(),
    total: z.number(),
  }),
  beads: z.object({
    open: z.number(),
    inProgress: z.number(),
    failed: z.number(),
    triageRequests: z.number(),
  }),
  patrol: z.object({
    guppWarnings: z.number(),
    guppEscalations: z.number(),
    stalledAgents: z.number(),
    orphanedHooks: z.number(),
  }),
  recentEvents: z.array(
    z.object({
      time: z.string(),
      type: z.string(),
      message: z.string(),
    })
  ),
});

const TownConfigRecord = z.object({
  env_vars: z.record(z.string(), z.string()),
  git_auth: z.object({
    github_token: z.string().optional(),
    gitlab_token: z.string().optional(),
    gitlab_instance_url: z.string().optional(),
    platform_integration_id: z.string().optional(),
  }),
  owner_user_id: z.string().optional(),
  kilocode_token: z.string().optional(),
  default_model: z.string().nullable().optional(),
  role_models: z
    .object({
      mayor: z.string().nullable().optional(),
      refinery: z.string().nullable().optional(),
      polecat: z.string().nullable().optional(),
    })
    .nullable()
    .optional(),
  small_model: z.string().nullable().optional(),
  max_polecats_per_rig: z.number().optional(),
  merge_strategy: z.enum(['direct', 'pr']),
  refinery: z
    .object({
      gates: z.array(z.string()),
      auto_merge: z.boolean(),
      require_clean_merge: z.boolean(),
      code_review: z.boolean(),
      review_mode: z.enum(['rework', 'comments']),
      auto_resolve_pr_feedback: z.boolean(),
      auto_merge_delay_minutes: z.number().nullable(),
    })
    .optional(),
  alarm_interval_active: z.number().optional(),
  alarm_interval_idle: z.number().optional(),
  container: z.object({ sleep_after_minutes: z.number().optional() }).optional(),
  staged_convoys_default: z.boolean().optional(),
  custom_instructions: z
    .object({
      polecat: z.string().optional(),
      refinery: z.string().optional(),
      mayor: z.string().optional(),
    })
    .optional(),
});

const ConvoyDetailRecord = z.object({
  id: z.string(),
  title: z.string(),
  status: z.enum(['active', 'landed']),
  total_beads: z.number(),
  closed_beads: z.number(),
  created_by: z.string().nullable(),
  created_at: z.string(),
  landed_at: z.string().nullable(),
  feature_branch: z.string().nullable(),
  merge_mode: z.string().nullable(),
  beads: z.array(
    z.object({
      bead_id: z.string(),
      title: z.string(),
      status: z.string(),
      rig_id: z.string().nullable(),
      assignee_agent_name: z.string().nullable(),
    })
  ),
  dependency_edges: z.array(
    z.object({
      bead_id: z.string(),
      depends_on_bead_id: z.string(),
    })
  ),
});

// These schemas are for TownDO methods added in bead 0.
// Procedures using them return empty arrays until bead 0 is merged.

const DispatchAttemptRecord = z.object({
  id: z.string(),
  bead_id: z.string().nullable(),
  agent_id: z.string().nullable(),
  attempted_at: z.string(),
  success: z.boolean(),
  error_message: z.string().nullable(),
});

const ContainerEventRecord = z.object({
  id: z.string(),
  event_type: z.string(),
  data: z.record(z.string(), z.unknown()).optional(),
  created_at: z.string(),
});

const CredentialEventRecord = z.object({
  id: z.string(),
  rig_id: z.string().nullable(),
  event_type: z.string(),
  data: z.record(z.string(), z.unknown()).optional(),
  created_at: z.string(),
});

const AdminAuditLogRecord = z.object({
  id: z.string(),
  admin_user_id: z.string(),
  action: z.string(),
  target_type: z.string().nullable(),
  target_id: z.string().nullable(),
  detail: z.record(z.string(), z.unknown()).optional(),
  performed_at: z.string(),
});

// ── Gastown HTTP client ───────────────────────────────────────────────────────

/**
 * Build auth headers for server-side calls to the Gastown worker.
 * Uses the admin user's Kilo JWT (isAdmin: true, gastownAccess: true)
 * plus CF Access service token headers for production.
 */
function buildAdminHeaders(adminUser: User): Record<string, string> {
  const token = generateApiToken(
    adminUser,
    { isAdmin: true, gastownAccess: true },
    { expiresIn: 60 } // 1-minute lifetime — server-side only
  );

  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };

  if (GASTOWN_CF_ACCESS_CLIENT_ID && GASTOWN_CF_ACCESS_CLIENT_SECRET) {
    headers['CF-Access-Client-Id'] = GASTOWN_CF_ACCESS_CLIENT_ID;
    headers['CF-Access-Client-Secret'] = GASTOWN_CF_ACCESS_CLIENT_SECRET;
  }

  return headers;
}

const GastownApiResponseSchema = z.union([
  z.object({ success: z.literal(true), data: z.unknown() }),
  z.object({ success: z.literal(false), error: z.string() }),
]);

function requireGastownUrl(): string {
  if (!GASTOWN_SERVICE_URL) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'GASTOWN_SERVICE_URL is not configured',
    });
  }
  return GASTOWN_SERVICE_URL;
}

/** GET request to the Gastown worker, parsing the response with the given schema. */
async function gastownGet<T>(adminUser: User, path: string, schema: z.ZodType<T>): Promise<T> {
  const baseUrl = requireGastownUrl();
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'GET',
    headers: buildAdminHeaders(adminUser),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new TRPCError({
      code: response.status === 404 ? 'NOT_FOUND' : 'INTERNAL_SERVER_ERROR',
      message: `Gastown ${response.status}: ${body.slice(0, 200)}`,
    });
  }

  const raw = GastownApiResponseSchema.parse(await response.json());
  if (!raw.success) {
    throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: `Gastown error: ${raw.error}` });
  }
  return schema.parse(raw.data);
}

/** PATCH request to the Gastown worker. */
async function gastownPatch<T>(
  adminUser: User,
  path: string,
  body: unknown,
  schema: z.ZodType<T>
): Promise<T> {
  const baseUrl = requireGastownUrl();
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'PATCH',
    headers: buildAdminHeaders(adminUser),
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const responseBody = await response.text().catch(() => '');
    throw new TRPCError({
      code: response.status === 404 ? 'NOT_FOUND' : 'INTERNAL_SERVER_ERROR',
      message: `Gastown ${response.status}: ${responseBody.slice(0, 200)}`,
    });
  }

  const raw = GastownApiResponseSchema.parse(await response.json());
  if (!raw.success) {
    throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: `Gastown error: ${raw.error}` });
  }
  return schema.parse(raw.data);
}

/**
 * Call the Gastown worker's tRPC endpoint (GET query) and return the result.
 * The admin JWT has isAdmin=true which satisfies gastownProcedure.
 * Note: procedures that call verifyTownOwnership will fail for towns not owned
 * by the admin user — those procedures need admin-bypass support in the worker.
 */
async function gastownTrpcGet<T>(
  adminUser: User,
  procedure: string,
  input: unknown,
  schema: z.ZodType<T>
): Promise<T | null> {
  const baseUrl = requireGastownUrl();
  const headers = buildAdminHeaders(adminUser);
  const url = `${baseUrl}/trpc/${procedure}?input=${encodeURIComponent(JSON.stringify(input))}`;
  const response = await fetch(url, { headers });
  if (!response.ok) {
    if (response.status === 404) return null;
    console.error(`[admin/gastown] tRPC proxy ${procedure} failed: ${response.status}`);
    return null;
  }

  const raw: unknown = await response.json();
  const resultSchema = z.object({ result: z.object({ data: schema }) });
  const parsed = resultSchema.safeParse(raw);
  return parsed.success ? parsed.data.result.data : null;
}

/**
 * Call a Gastown worker tRPC mutation (POST) and return the result.
 * Returns null on failure.
 */
async function gastownTrpcMutate<T>(
  adminUser: User,
  procedure: string,
  input: unknown,
  schema: z.ZodType<T>
): Promise<T | null> {
  const baseUrl = requireGastownUrl();
  const headers = buildAdminHeaders(adminUser);
  const url = `${baseUrl}/trpc/${procedure}`;
  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(input),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    console.error(
      `[admin/gastown] tRPC mutate ${procedure} failed: ${response.status} ${body.slice(0, 200)}`
    );
    throw new TRPCError({
      code: response.status === 404 ? 'NOT_FOUND' : 'INTERNAL_SERVER_ERROR',
      message: `Gastown tRPC ${procedure} failed: ${response.status}`,
    });
  }

  const raw: unknown = await response.json();
  const resultSchema = z.object({ result: z.object({ data: schema }) });
  const parsed = resultSchema.safeParse(raw);
  return parsed.success ? parsed.data.result.data : null;
}

// ── Router ────────────────────────────────────────────────────────────────────

export const adminGastownRouter = createTRPCRouter({
  // ── User → Towns ─────────────────────────────────────────────────────────

  /**
   * List all towns owned by a given user.
   * Calls: GET /api/users/:userId/towns (kiloAuthMiddleware, no ownership check)
   */
  getUserTowns: adminProcedure
    .input(z.object({ userId: z.string().uuid() }))
    .output(z.array(UserTownRecord))
    .query(({ input, ctx }) => {
      return gastownGet(ctx.user, `/api/users/${input.userId}/towns`, z.array(UserTownRecord));
    }),

  /**
   * List all rigs for all towns owned by a given user.
   * Calls: GET /api/users/:userId/towns/:townId/rigs for each town.
   */
  getUserRigs: adminProcedure
    .input(z.object({ userId: z.string().uuid() }))
    .output(z.array(UserRigRecord))
    .query(async ({ input, ctx }) => {
      const towns = await gastownGet(
        ctx.user,
        `/api/users/${input.userId}/towns`,
        z.array(UserTownRecord)
      );

      const rigLists = await Promise.all(
        towns.map(town =>
          gastownGet(
            ctx.user,
            `/api/users/${input.userId}/towns/${town.id}/rigs`,
            z.array(UserRigRecord)
          ).catch((): z.infer<typeof UserRigRecord>[] => [])
        )
      );

      return rigLists.flat();
    }),

  // ── Town inspection ───────────────────────────────────────────────────────

  /**
   * Get the alarm status snapshot for a town.
   * Calls the admin-bypass gastown.adminGetAlarmStatus endpoint.
   */
  getTownHealth: adminProcedure
    .input(z.object({ townId: z.string().uuid() }))
    .output(AlarmStatusRecord.nullable())
    .query(async ({ input, ctx }) => {
      return gastownTrpcGet(
        ctx.user,
        'gastown.adminGetAlarmStatus',
        { townId: input.townId },
        AlarmStatusRecord
      );
    }),

  /**
   * Get Cloudflare dashboard links for a town.
   * Fetches DO IDs from the gastown worker and constructs CF dashboard URLs.
   * Gracefully degrades when env vars are not configured.
   */
  getCloudflareLinks: adminProcedure
    .input(z.object({ townId: z.string().uuid() }))
    .output(
      z.object({
        workerLogsUrl: z.string(),
        containerInstanceUrl: z.string().nullable(),
        townDoLogsUrl: z.string().nullable(),
        containerDoLogsUrl: z.string().nullable(),
      })
    )
    .query(async ({ input, ctx }) => {
      const accountId = CLOUDFLARE_ACCOUNT_ID;
      if (!accountId) {
        return {
          workerLogsUrl:
            'https://dash.cloudflare.com/workers/services/view/gastown/production/logs/live',
          containerInstanceUrl: null,
          townDoLogsUrl: null,
          containerDoLogsUrl: null,
        };
      }

      const debugInfo = await gastownGet(
        ctx.user,
        `/api/towns/${input.townId}/cloudflare-debug`,
        z.object({ containerDoId: z.string().nullable(), townDoId: z.string() })
      ).catch(() => null);

      const townDoNamespaceId = CLOUDFLARE_TOWN_DO_NAMESPACE_ID;
      const containerDoNamespaceId = CLOUDFLARE_CONTAINER_DO_NAMESPACE_ID;

      return {
        workerLogsUrl: `https://dash.cloudflare.com/${accountId}/workers/services/view/gastown/production/logs/live`,
        // containerDoId is only non-null when the container is actually running
        containerInstanceUrl: debugInfo?.containerDoId
          ? `https://dash.cloudflare.com/${accountId}/workers/containers/app-gastown/instances/${debugInfo.containerDoId}`
          : null,
        townDoLogsUrl:
          townDoNamespaceId && debugInfo
            ? `https://dash.cloudflare.com/${accountId}/workers/durable-objects/view/${townDoNamespaceId}/${debugInfo.townDoId}/logs`
            : null,
        containerDoLogsUrl:
          containerDoNamespaceId && debugInfo?.containerDoId
            ? `https://dash.cloudflare.com/${accountId}/workers/durable-objects/view/${containerDoNamespaceId}/${debugInfo.containerDoId}/logs`
            : null,
      };
    }),

  /**
   * List all beads in a town, with optional filters.
   * The user-facing tRPC listBeads requires a rigId and verifies ownership.
   * Admin-level town-wide listing requires bead 0 admin endpoints on the worker.
   * Until then, callers can use getUserRigs + per-rig listBeads via the tRPC client.
   */
  listBeads: adminProcedure
    .input(
      z.object({
        townId: z.string().uuid(),
        status: z.enum(['open', 'in_progress', 'closed', 'failed']).optional(),
        type: z
          .enum(['issue', 'message', 'escalation', 'merge_request', 'convoy', 'molecule', 'agent'])
          .optional(),
        limit: z.number().int().positive().max(500).default(200),
      })
    )
    .output(z.array(BeadRecord))
    .query(async ({ input, ctx }) => {
      const result = await gastownTrpcGet(
        ctx.user,
        'gastown.adminListBeads',
        { townId: input.townId, status: input.status, type: input.type, limit: input.limit },
        z.array(BeadRecord)
      );
      return result ?? [];
    }),

  getBead: adminProcedure
    .input(z.object({ townId: z.string().uuid(), beadId: z.string().uuid() }))
    .output(BeadRecord.nullable())
    .query(async ({ input, ctx }) => {
      return gastownTrpcGet(
        ctx.user,
        'gastown.adminGetBead',
        { townId: input.townId, beadId: input.beadId },
        BeadRecord
      );
    }),

  /**
   * Get bead events for a town or specific bead.
   */
  getBeadEvents: adminProcedure
    .input(
      z.object({
        townId: z.string().uuid(),
        beadId: z.string().uuid().optional(),
        since: z.string().optional(),
        limit: z.number().int().positive().max(500).default(100),
      })
    )
    .output(z.array(BeadEventRecord))
    .query(async ({ input, ctx }) => {
      const result = await gastownTrpcGet(
        ctx.user,
        'gastown.adminGetTownEvents',
        { townId: input.townId, beadId: input.beadId, since: input.since, limit: input.limit },
        z.array(BeadEventRecord)
      );
      return result ?? [];
    }),

  /**
   * List all agents in a town.
   * The user-facing tRPC listAgents requires rigId and ownership verification.
   * Admin-level town-wide listing requires bead 0 admin endpoints.
   */
  listAgents: adminProcedure
    .input(z.object({ townId: z.string().uuid() }))
    .output(z.array(AgentRecord))
    .query(async ({ input, ctx }) => {
      const result = await gastownTrpcGet(
        ctx.user,
        'gastown.adminListAgents',
        { townId: input.townId },
        z.array(AgentRecord)
      );
      return result ?? [];
    }),

  /**
   * Get agent events from the AgentDO.
   * The HTTP endpoint for agent events uses agent JWT auth.
   * Admin access requires bead 0 admin bypass endpoint.
   */
  getAgentEvents: adminProcedure
    .input(
      z.object({
        townId: z.string().uuid(),
        agentId: z.string().uuid(),
        afterId: z.number().int().optional(),
        limit: z.number().int().positive().max(500).default(100),
      })
    )
    .output(z.array(z.unknown()))
    .query(async ({ input }) => {
      // Requires admin-bypass endpoint on the Gastown worker (bead 0).
      void input;
      return [];
    }),

  /**
   * List dispatch attempts for a town, optionally filtered by bead or agent.
   * Requires bead 0 (TownDO.listDispatchAttempts).
   */
  listDispatchAttempts: adminProcedure
    .input(
      z.object({
        townId: z.string().uuid(),
        beadId: z.string().uuid().optional(),
        agentId: z.string().uuid().optional(),
      })
    )
    .output(z.array(DispatchAttemptRecord))
    .query(async ({ input }) => {
      void input;
      return [];
    }),

  /**
   * List container events for a town.
   * Requires bead 0 (TownDO.listContainerEvents).
   */
  listContainerEvents: adminProcedure
    .input(
      z.object({
        townId: z.string().uuid(),
        since: z.string().optional(),
      })
    )
    .output(z.array(ContainerEventRecord))
    .query(async ({ input }) => {
      void input;
      return [];
    }),

  /**
   * List credential events for a town, optionally filtered by rig.
   * Requires bead 0 (TownDO.listCredentialEvents).
   */
  listCredentialEvents: adminProcedure
    .input(
      z.object({
        townId: z.string().uuid(),
        rigId: z.string().uuid().optional(),
      })
    )
    .output(z.array(CredentialEventRecord))
    .query(async ({ input }) => {
      void input;
      return [];
    }),

  /**
   * List the admin audit log for a town.
   * Requires bead 0 (TownDO.listAdminAuditLog).
   */
  listAuditLog: adminProcedure
    .input(z.object({ townId: z.string().uuid() }))
    .output(z.array(AdminAuditLogRecord))
    .query(async ({ input }) => {
      void input;
      return [];
    }),

  /**
   * Get the town config.
   * Calls: GET /api/towns/:townId/config (kiloAuthMiddleware, no ownership check).
   */
  getTownConfig: adminProcedure
    .input(z.object({ townId: z.string().uuid() }))
    .output(TownConfigRecord)
    .query(({ input, ctx }) => {
      return gastownGet(ctx.user, `/api/towns/${input.townId}/config`, TownConfigRecord);
    }),

  /**
   * Get convoy status (convoy + tracked beads) for a specific convoyId.
   * Calls tRPC gastown.listConvoys and filters by convoyId.
   * Requires admin-bypass support for verifyTownOwnership (bead 0).
   */
  getConvoyStatus: adminProcedure
    .input(z.object({ townId: z.string().uuid(), convoyId: z.string().uuid() }))
    .output(ConvoyDetailRecord.nullable())
    .query(async ({ input, ctx }) => {
      const convoys = await gastownTrpcGet(
        ctx.user,
        'gastown.listConvoys',
        { townId: input.townId },
        z.array(ConvoyDetailRecord)
      );
      if (!convoys) return null;
      return convoys.find(c => c.id === input.convoyId) ?? null;
    }),

  /**
   * List all convoys in a town.
   * Calls tRPC gastown.listConvoys (requires admin-bypass for verifyTownOwnership).
   */
  listConvoys: adminProcedure
    .input(z.object({ townId: z.string().uuid() }))
    .output(z.array(ConvoyDetailRecord))
    .query(async ({ input, ctx }) => {
      const result = await gastownTrpcGet(
        ctx.user,
        'gastown.listConvoys',
        { townId: input.townId },
        z.array(ConvoyDetailRecord)
      );
      return result ?? [];
    }),

  // ── Admin interventions ───────────────────────────────────────────────────

  forceResetAgent: adminProcedure
    .input(z.object({ townId: z.string().uuid(), agentId: z.string().uuid() }))
    .mutation(async ({ input, ctx }) => {
      await gastownTrpcMutate(
        ctx.user,
        'gastown.adminForceResetAgent',
        { townId: input.townId, agentId: input.agentId },
        z.void().or(z.null())
      );
    }),

  forceCloseBead: adminProcedure
    .input(z.object({ townId: z.string().uuid(), beadId: z.string().uuid() }))
    .mutation(async ({ input, ctx }) => {
      await gastownTrpcMutate(
        ctx.user,
        'gastown.adminForceCloseBead',
        { townId: input.townId, beadId: input.beadId },
        BeadRecord
      );
    }),

  forceFailBead: adminProcedure
    .input(z.object({ townId: z.string().uuid(), beadId: z.string().uuid() }))
    .mutation(async ({ input, ctx }) => {
      await gastownTrpcMutate(
        ctx.user,
        'gastown.adminForceFailBead',
        { townId: input.townId, beadId: input.beadId },
        BeadRecord
      );
    }),

  forceRestartContainer: adminProcedure
    .input(z.object({ townId: z.string().uuid() }))
    .mutation(async ({ input, ctx }) => {
      await gastownTrpcMutate(
        ctx.user,
        'gastown.adminForceRestartContainer',
        { townId: input.townId },
        z.void().or(z.null())
      );
    }),

  /** Force-retry a stalled review queue entry. Not yet implemented on the worker. */
  forceRetryReview: adminProcedure
    .input(z.object({ townId: z.string().uuid(), entryId: z.string().uuid() }))
    .mutation(async ({ input }) => {
      void input;
      throw new TRPCError({
        code: 'METHOD_NOT_SUPPORTED',
        message: 'Review retry requires manual re-submission — not yet implemented.',
      });
    }),

  /** Force-refresh git credentials for a rig. Not yet implemented on the worker. */
  forceRefreshCredentials: adminProcedure
    .input(z.object({ townId: z.string().uuid(), rigId: z.string().uuid() }))
    .mutation(async ({ input }) => {
      void input;
      throw new TRPCError({
        code: 'METHOD_NOT_SUPPORTED',
        message: 'Credential refresh not yet implemented.',
      });
    }),

  /**
   * Admin-level town config update.
   * Calls: PATCH /api/towns/:townId/config (kiloAuthMiddleware, no ownership check).
   */
  updateTownConfig: adminProcedure
    .input(
      z.object({
        townId: z.string().uuid(),
        update: TownConfigRecord.partial(),
      })
    )
    .output(TownConfigRecord)
    .mutation(({ input, ctx }) => {
      return gastownPatch(
        ctx.user,
        `/api/towns/${input.townId}/config`,
        input.update,
        TownConfigRecord
      );
    }),
});
