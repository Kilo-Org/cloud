import { createTRPCRouter, baseProcedure } from '@/lib/trpc/init';
import { ensureOrganizationAccess } from '@/routers/organizations/utils';
import { TRPCError } from '@trpc/server';
import { and, eq, isNull } from 'drizzle-orm';
import * as z from 'zod';
import { db } from '@/lib/drizzle';
import {
  cloud_agent_webhook_triggers,
  agent_environment_profiles,
  kiloclaw_instances,
} from '@kilocode/db/schema';
import { resolveCloudAgentSessionIds } from '@/lib/webhook-session-resolution';
import { triggerIdSchema, triggerIdCreateSchema } from '@/lib/webhook-trigger-validation';
import {
  validateCronExpression,
  enforcesMinimumInterval,
  isValidTimezone,
} from '@/lib/cron-validation';
import {
  createWorkerTrigger,
  getWorkerTrigger,
  updateWorkerTrigger,
  deleteWorkerTrigger,
  listWorkerRequests,
  buildInboundUrl,
  type EnrichedCapturedRequest,
} from '@/lib/webhook-agent/webhook-agent-client';

// Input schemas
const WebhookTriggerCreateInput = z
  .object({
    triggerId: triggerIdCreateSchema,
    organizationId: z.string().uuid().optional(),
    targetType: z.enum(['cloud_agent', 'kiloclaw_chat']).default('cloud_agent'),
    // KiloClaw Chat target fields
    kiloclawInstanceId: z.string().uuid().optional(),
    // Cloud Agent target fields (optional — required only when targetType = 'cloud_agent')
    githubRepo: z.string().min(1, 'GitHub repo is required').optional(),
    mode: z.enum(['architect', 'code', 'ask', 'debug', 'orchestrator']).optional(),
    model: z.string().min(1, 'Model is required').optional(),
    profileId: z.string().uuid().optional(),
    // Shared fields
    promptTemplate: z
      .string()
      .min(1, 'Prompt template is required')
      .max(10000, 'Prompt template must be 10,000 characters or less'),
    autoCommit: z.boolean().optional(),
    condenseOnComplete: z.boolean().optional(),
    webhookAuth: z
      .object({
        header: z.string().trim().min(1, 'Webhook auth header is required'),
        secret: z.string().trim().min(1, 'Webhook auth secret is required'),
      })
      .optional(),
    // Activation mode: 'webhook' (default) or 'scheduled' (cron-based). Immutable after creation.
    activationMode: z.enum(['webhook', 'scheduled']).default('webhook'),
    cronExpression: z.string().max(100).optional(),
    cronTimezone: z.string().max(50).optional().default('UTC'),
  })
  .superRefine((data, ctx) => {
    if (data.activationMode === 'scheduled') {
      if (!data.cronExpression) {
        ctx.addIssue({
          code: 'custom',
          message: 'Cron expression is required for scheduled triggers',
          path: ['cronExpression'],
        });
      } else {
        const validation = validateCronExpression(data.cronExpression);
        if (!validation.valid) {
          ctx.addIssue({
            code: 'custom',
            message: validation.error ?? 'Invalid cron expression',
            path: ['cronExpression'],
          });
        } else if (!enforcesMinimumInterval(data.cronExpression, data.cronTimezone ?? 'UTC')) {
          ctx.addIssue({
            code: 'custom',
            message: 'Schedule interval must be at least 1 minute',
            path: ['cronExpression'],
          });
        }
      }
      if (data.cronTimezone && !isValidTimezone(data.cronTimezone)) {
        ctx.addIssue({
          code: 'custom',
          message: 'Invalid timezone',
          path: ['cronTimezone'],
        });
      }
      if (data.webhookAuth) {
        ctx.addIssue({
          code: 'custom',
          message: 'Webhook auth is not applicable for scheduled triggers',
          path: ['webhookAuth'],
        });
      }
    }
    if (data.targetType === 'cloud_agent') {
      if (!data.githubRepo)
        ctx.addIssue({ code: 'custom', message: 'GitHub repo is required', path: ['githubRepo'] });
      if (!data.mode) ctx.addIssue({ code: 'custom', message: 'Mode is required', path: ['mode'] });
      if (!data.model)
        ctx.addIssue({ code: 'custom', message: 'Model is required', path: ['model'] });
      if (!data.profileId)
        ctx.addIssue({ code: 'custom', message: 'Profile is required', path: ['profileId'] });
    }
    if (data.targetType === 'kiloclaw_chat') {
      if (!data.kiloclawInstanceId)
        ctx.addIssue({
          code: 'custom',
          message: 'KiloClaw instance is required',
          path: ['kiloclawInstanceId'],
        });
    }
  });

// Note: targetType and kiloclawInstanceId are immutable after creation.
// To change the target type or instance, delete and recreate the trigger.
const WebhookTriggerUpdateInput = z
  .object({
    triggerId: triggerIdSchema,
    organizationId: z.string().uuid().optional(),
    mode: z.enum(['architect', 'code', 'ask', 'debug', 'orchestrator']).optional(),
    model: z.string().min(1).optional(),
    promptTemplate: z.string().min(1).max(10000).optional(),
    profileId: z.string().uuid().optional(),
    autoCommit: z.boolean().nullable().optional(),
    condenseOnComplete: z.boolean().nullable().optional(),
    isActive: z.boolean().optional(),
    webhookAuth: z
      .object({
        header: z.string().trim().min(1).nullable().optional(),
        secret: z.string().trim().min(1).nullable().optional(),
      })
      .optional(),
    // activationMode is immutable — not included in update
    cronExpression: z.string().max(100).optional(),
    cronTimezone: z.string().max(50).optional(),
  })
  .superRefine((data, ctx) => {
    if (data.cronExpression !== undefined) {
      const validation = validateCronExpression(data.cronExpression);
      if (!validation.valid) {
        ctx.addIssue({
          code: 'custom',
          message: validation.error ?? 'Invalid cron expression',
          path: ['cronExpression'],
        });
      } else if (!enforcesMinimumInterval(data.cronExpression, data.cronTimezone ?? 'UTC')) {
        ctx.addIssue({
          code: 'custom',
          message: 'Schedule interval must be at least 1 minute',
          path: ['cronExpression'],
        });
      }
    }
    if (data.cronTimezone !== undefined && !isValidTimezone(data.cronTimezone)) {
      ctx.addIssue({
        code: 'custom',
        message: 'Invalid timezone',
        path: ['cronTimezone'],
      });
    }
  });

/**
 * Helper to verify trigger ownership via PostgreSQL.
 * Returns the trigger record if found and owned by the user/org.
 * Throws NOT_FOUND if trigger doesn't exist or isn't owned.
 */
async function assertTriggerOwnership(
  userId: string,
  triggerId: string,
  organizationId?: string
): Promise<typeof cloud_agent_webhook_triggers.$inferSelect> {
  const whereClause = organizationId
    ? and(
        eq(cloud_agent_webhook_triggers.trigger_id, triggerId),
        eq(cloud_agent_webhook_triggers.organization_id, organizationId)
      )
    : and(
        eq(cloud_agent_webhook_triggers.trigger_id, triggerId),
        eq(cloud_agent_webhook_triggers.user_id, userId),
        isNull(cloud_agent_webhook_triggers.organization_id)
      );

  const [trigger] = await db.select().from(cloud_agent_webhook_triggers).where(whereClause);

  if (!trigger) {
    throw new TRPCError({
      code: 'NOT_FOUND',
      message: 'Trigger not found',
    });
  }

  return trigger;
}

/**
 * Check if a PostgreSQL error is a unique constraint violation.
 */
function isUniqueViolation(error: unknown): boolean {
  // PostgreSQL unique violation error code is 23505
  return (
    error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    (error as { code: string }).code === '23505'
  );
}

/**
 * Helper to clean up orphan DB record when worker returns 404.
 */
async function cleanupOrphanDbRecord(dbTriggerId: string, triggerId: string): Promise<void> {
  console.warn('Cleaning up orphan trigger from PostgreSQL', { triggerId });
  await db
    .delete(cloud_agent_webhook_triggers)
    .where(eq(cloud_agent_webhook_triggers.id, dbTriggerId));
}

/**
 * Helper to validate profile ownership.
 * Throws NOT_FOUND if the profile is missing or not accessible by the owner.
 */
async function assertProfileOwnership(
  userId: string,
  organizationId: string | undefined,
  profileId: string
): Promise<void> {
  const [profile] = await db
    .select({ id: agent_environment_profiles.id })
    .from(agent_environment_profiles)
    .where(
      organizationId
        ? and(
            eq(agent_environment_profiles.id, profileId),
            eq(agent_environment_profiles.owned_by_organization_id, organizationId)
          )
        : and(
            eq(agent_environment_profiles.id, profileId),
            eq(agent_environment_profiles.owned_by_user_id, userId)
          )
    );

  if (!profile) {
    throw new TRPCError({
      code: 'NOT_FOUND',
      message: 'Profile not found or not accessible',
    });
  }
}

export const webhookTriggersRouter = createTRPCRouter({
  /**
   * List triggers for current user or organization.
   * Reads from PostgreSQL only (can't enumerate DOs).
   */
  list: baseProcedure
    .input(
      z.object({
        organizationId: z.string().uuid().optional(),
        targetType: z.enum(['cloud_agent', 'kiloclaw_chat']).optional(),
        activationMode: z.enum(['webhook', 'scheduled']).optional(),
      })
    )
    .query(async ({ ctx, input }) => {
      const userId = ctx.user.id;

      // Verify org membership if organizationId provided
      if (input.organizationId) {
        await ensureOrganizationAccess(ctx, input.organizationId);
      }

      // Query PostgreSQL with ownership + optional target type filter
      const ownerFilter = input.organizationId
        ? eq(cloud_agent_webhook_triggers.organization_id, input.organizationId)
        : and(
            eq(cloud_agent_webhook_triggers.user_id, userId),
            isNull(cloud_agent_webhook_triggers.organization_id)
          );
      const filters = [ownerFilter];
      if (input.targetType)
        filters.push(eq(cloud_agent_webhook_triggers.target_type, input.targetType));
      if (input.activationMode)
        filters.push(eq(cloud_agent_webhook_triggers.activation_mode, input.activationMode));
      const whereClause = and(...filters);

      const triggers = await db
        .select({
          id: cloud_agent_webhook_triggers.id,
          triggerId: cloud_agent_webhook_triggers.trigger_id,
          targetType: cloud_agent_webhook_triggers.target_type,
          githubRepo: cloud_agent_webhook_triggers.github_repo,
          kiloclawInstanceId: cloud_agent_webhook_triggers.kiloclaw_instance_id,
          isActive: cloud_agent_webhook_triggers.is_active,
          activationMode: cloud_agent_webhook_triggers.activation_mode,
          cronExpression: cloud_agent_webhook_triggers.cron_expression,
          cronTimezone: cloud_agent_webhook_triggers.cron_timezone,
          createdAt: cloud_agent_webhook_triggers.created_at,
          updatedAt: cloud_agent_webhook_triggers.updated_at,
        })
        .from(cloud_agent_webhook_triggers)
        .where(whereClause)
        .orderBy(cloud_agent_webhook_triggers.created_at);

      return triggers.map(trigger => ({
        ...trigger,
        inboundUrl: buildInboundUrl(
          input.organizationId ? undefined : userId,
          input.organizationId,
          trigger.triggerId
        ),
      }));
    }),

  /**
   * Get a single trigger's configuration.
   * Worker is authoritative - PostgreSQL is used for ownership verification only.
   */
  get: baseProcedure
    .input(
      z.object({
        triggerId: triggerIdSchema,
        organizationId: z.string().uuid().optional(),
      })
    )
    .query(async ({ ctx, input }) => {
      const userId = ctx.user.id;

      // Verify org membership if organizationId provided
      if (input.organizationId) {
        await ensureOrganizationAccess(ctx, input.organizationId);
      }

      // Verify ownership via PostgreSQL
      await assertTriggerOwnership(userId, input.triggerId, input.organizationId);

      // Fetch authoritative config from worker
      const workerResult = await getWorkerTrigger(
        input.organizationId ? undefined : userId,
        input.organizationId,
        input.triggerId
      );

      if (workerResult.found === false) {
        // Worker confirmed 404 - keep DB record for investigation
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Trigger not found',
        });
      }

      if (workerResult.found === 'error') {
        // Transient error - don't delete DB record, just fail the request
        console.error('Worker returned error for get', {
          triggerId: input.triggerId,
          error: workerResult.error,
          status: workerResult.status,
        });
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to fetch trigger configuration',
        });
      }

      // Build inbound URL
      const inboundUrl = buildInboundUrl(
        input.organizationId ? undefined : userId,
        input.organizationId,
        input.triggerId
      );

      return {
        ...workerResult.config,
        inboundUrl,
      };
    }),

  /**
   * Create a new trigger.
   * DB-first with unique conflict and ambiguous failure handling.
   * Profile is referenced by ID - resolved at runtime in the worker.
   */
  create: baseProcedure.input(WebhookTriggerCreateInput).mutation(async ({ ctx, input }) => {
    const userId = ctx.user.id;

    // Verify org membership if organizationId provided
    if (input.organizationId) {
      await ensureOrganizationAccess(ctx, input.organizationId, ['owner', 'member']);
    }

    // KiloClaw Chat triggers are personal only — org-scoped triggers would fail at delivery
    if (input.targetType === 'kiloclaw_chat' && input.organizationId) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: 'KiloClaw Chat triggers are not supported for organizations',
      });
    }

    // Target-specific validation (superRefine guarantees required fields per target type)
    if (input.targetType === 'cloud_agent') {
      if (!input.profileId) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Profile is required for Cloud Agent triggers',
        });
      }
      await assertProfileOwnership(userId, input.organizationId, input.profileId);
    }
    if (input.targetType === 'kiloclaw_chat') {
      if (!input.kiloclawInstanceId) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'KiloClaw instance is required' });
      }
      // Verify user owns the KiloClaw instance and it's not destroyed
      const [instance] = await db
        .select({ id: kiloclaw_instances.id })
        .from(kiloclaw_instances)
        .where(
          and(
            eq(kiloclaw_instances.id, input.kiloclawInstanceId),
            eq(kiloclaw_instances.user_id, userId),
            isNull(kiloclaw_instances.destroyed_at)
          )
        )
        .limit(1);
      if (!instance) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'KiloClaw instance not found or not accessible',
        });
      }
    }

    // Insert into PostgreSQL first - unique constraint is source of truth
    let dbRecord: typeof cloud_agent_webhook_triggers.$inferSelect;
    try {
      const [inserted] = await db
        .insert(cloud_agent_webhook_triggers)
        .values({
          trigger_id: input.triggerId,
          user_id: input.organizationId ? null : userId,
          organization_id: input.organizationId ?? null,
          target_type: input.targetType,
          activation_mode: input.activationMode,
          kiloclaw_instance_id: input.kiloclawInstanceId ?? null,
          github_repo: input.githubRepo ?? null,
          is_active: true,
          profile_id: input.profileId ?? null,
          cron_expression: input.cronExpression ?? null,
          cron_timezone: input.cronTimezone ?? 'UTC',
        })
        .returning();
      dbRecord = inserted;
    } catch (error) {
      // Unique constraint violation = trigger already exists
      if (isUniqueViolation(error)) {
        throw new TRPCError({
          code: 'CONFLICT',
          message: `Trigger Name "${input.triggerId}" already exists`,
        });
      }
      throw error;
    }

    // Create in worker (only if DB insert succeeded)
    // Wrap in try/catch to handle network errors
    let workerResult: Awaited<ReturnType<typeof createWorkerTrigger>>;
    try {
      workerResult = await createWorkerTrigger(
        input.organizationId ? undefined : userId,
        input.organizationId,
        input.triggerId,
        {
          targetType: input.targetType,
          kiloclawInstanceId: input.kiloclawInstanceId,
          githubRepo: input.githubRepo,
          mode: input.mode,
          model: input.model,
          promptTemplate: input.promptTemplate,
          profileId: input.profileId,
          autoCommit: input.autoCommit,
          condenseOnComplete: input.condenseOnComplete,
          webhookAuth: input.webhookAuth,
          activationMode: input.activationMode,
          cronExpression: input.cronExpression,
          cronTimezone: input.cronTimezone,
        }
      );
    } catch (error) {
      // Network error or JSON parse error - rollback DB
      console.error('Worker request failed with exception, rolling back DB', {
        triggerId: input.triggerId,
        error: error instanceof Error ? error.message : String(error),
      });
      await db
        .delete(cloud_agent_webhook_triggers)
        .where(eq(cloud_agent_webhook_triggers.id, dbRecord.id));
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Failed to create trigger - worker unavailable',
      });
    }

    if (!workerResult.success) {
      // Worker failed to create trigger - rollback DB
      console.error('Worker failed to create trigger, rolling back DB', {
        triggerId: input.triggerId,
        error: workerResult.error,
        status: workerResult.status,
      });
      await db
        .delete(cloud_agent_webhook_triggers)
        .where(eq(cloud_agent_webhook_triggers.id, dbRecord.id));
      if (workerResult.isConflict) {
        throw new TRPCError({
          code: 'CONFLICT',
          message: `Trigger Name "${input.triggerId}" already exists`,
        });
      }
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Failed to create trigger',
      });
    }

    // Build inbound URL
    const inboundUrl = buildInboundUrl(
      input.organizationId ? undefined : userId,
      input.organizationId,
      input.triggerId
    );

    return {
      id: dbRecord.id,
      triggerId: input.triggerId,
      targetType: input.targetType,
      activationMode: input.activationMode,
      githubRepo: input.githubRepo ?? null,
      isActive: true,
      createdAt: dbRecord.created_at,
      inboundUrl,
    };
  }),

  /**
   * Update a trigger's configuration.
   * Worker-first, then DB.
   * Profile is referenced by ID - resolved at runtime in the worker.
   */
  update: baseProcedure.input(WebhookTriggerUpdateInput).mutation(async ({ ctx, input }) => {
    const userId = ctx.user.id;

    // Verify org membership if organizationId provided
    if (input.organizationId) {
      await ensureOrganizationAccess(ctx, input.organizationId, ['owner', 'member']);
    }

    // Verify ownership via PostgreSQL
    const dbTrigger = await assertTriggerOwnership(userId, input.triggerId, input.organizationId);

    // Validate profile ownership if profileId provided
    if (input.profileId) {
      await assertProfileOwnership(userId, input.organizationId, input.profileId);
    }

    const hasUpdates = [
      input.mode,
      input.model,
      input.promptTemplate,
      input.profileId,
      input.autoCommit,
      input.condenseOnComplete,
      input.isActive,
      input.webhookAuth,
      input.cronExpression,
      input.cronTimezone,
    ].some(value => value !== undefined);

    if (!hasUpdates) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: 'No updates provided',
      });
    }

    // Build update payload
    // Use null to explicitly clear fields, undefined to leave unchanged
    // Cron fields only apply to scheduled triggers — ignore for webhook triggers
    const isScheduledTrigger = dbTrigger.activation_mode === 'scheduled';
    const updatePayload: Parameters<typeof updateWorkerTrigger>[3] = {
      mode: input.mode,
      model: input.model,
      promptTemplate: input.promptTemplate,
      isActive: input.isActive,
      profileId: input.profileId,
      autoCommit: input.autoCommit,
      condenseOnComplete: input.condenseOnComplete,
      webhookAuth: input.webhookAuth,
      cronExpression: isScheduledTrigger ? input.cronExpression : undefined,
      cronTimezone: isScheduledTrigger ? input.cronTimezone : undefined,
    };

    // Update in worker
    const workerResult = await updateWorkerTrigger(
      input.organizationId ? undefined : userId,
      input.organizationId,
      input.triggerId,
      updatePayload
    );

    if (!workerResult.success) {
      if (workerResult.isNotFound) {
        // Worker doesn't have this trigger - clean up DB and return NOT_FOUND
        await cleanupOrphanDbRecord(dbTrigger.id, input.triggerId);
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Trigger not found',
        });
      }
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Failed to update trigger',
      });
    }

    // Update PostgreSQL (isActive/profileId/updatedAt)
    await db
      .update(cloud_agent_webhook_triggers)
      .set({
        ...(input.isActive !== undefined ? { is_active: input.isActive } : {}),
        ...(input.profileId !== undefined ? { profile_id: input.profileId } : {}),
        ...(isScheduledTrigger && input.cronExpression !== undefined
          ? { cron_expression: input.cronExpression }
          : {}),
        ...(isScheduledTrigger && input.cronTimezone !== undefined
          ? { cron_timezone: input.cronTimezone }
          : {}),
        updated_at: new Date().toISOString(),
      })
      .where(eq(cloud_agent_webhook_triggers.id, dbTrigger.id));

    // Build inbound URL
    const inboundUrl = buildInboundUrl(
      input.organizationId ? undefined : userId,
      input.organizationId,
      input.triggerId
    );

    return {
      ...workerResult.config,
      inboundUrl,
    };
  }),

  /**
   * Delete a trigger.
   * Worker-first, then DB.
   */
  delete: baseProcedure
    .input(
      z.object({
        triggerId: triggerIdSchema,
        organizationId: z.string().uuid().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.user.id;

      // Verify org membership if organizationId provided
      if (input.organizationId) {
        await ensureOrganizationAccess(ctx, input.organizationId, ['owner', 'member']);
      }

      // Verify ownership via PostgreSQL
      const dbTrigger = await assertTriggerOwnership(userId, input.triggerId, input.organizationId);

      // Delete from worker
      const workerResult = await deleteWorkerTrigger(
        input.organizationId ? undefined : userId,
        input.organizationId,
        input.triggerId
      );

      if (!workerResult.success) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to delete trigger',
        });
      }

      // Delete from PostgreSQL
      await db
        .delete(cloud_agent_webhook_triggers)
        .where(eq(cloud_agent_webhook_triggers.id, dbTrigger.id));

      return { success: true };
    }),

  /**
   * List captured requests for a trigger.
   * Proxies to worker and enriches with kiloSessionId from PostgreSQL.
   */
  listRequests: baseProcedure
    .input(
      z.object({
        triggerId: triggerIdSchema,
        organizationId: z.string().uuid().optional(),
        limit: z.number().min(1).max(100).default(50),
      })
    )
    .query(async ({ ctx, input }): Promise<EnrichedCapturedRequest[]> => {
      const userId = ctx.user.id;

      // Verify org membership if organizationId provided
      if (input.organizationId) {
        await ensureOrganizationAccess(ctx, input.organizationId);
      }

      // Verify ownership via PostgreSQL
      const dbTrigger = await assertTriggerOwnership(userId, input.triggerId, input.organizationId);

      // Fetch from worker
      const result = await listWorkerRequests(
        input.organizationId ? undefined : userId,
        input.organizationId,
        input.triggerId,
        input.limit
      );

      if (!result.success) {
        if (result.isNotFound) {
          // Worker doesn't have this trigger - clean up DB and return NOT_FOUND
          await cleanupOrphanDbRecord(dbTrigger.id, input.triggerId);
          throw new TRPCError({
            code: 'NOT_FOUND',
            message: 'Trigger not found',
          });
        }
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to list requests',
        });
      }

      // Enrich requests with kiloSessionId by looking up cloudAgentSessionId in cli_sessions
      const cloudAgentSessionIds = result.requests
        .map(r => r.cloudAgentSessionId)
        .filter((id): id is string => id !== null);

      const sessionIdMap = await resolveCloudAgentSessionIds(cloudAgentSessionIds);

      return result.requests.map(request => ({
        ...request,
        kiloSessionId: request.cloudAgentSessionId
          ? (sessionIdMap.get(request.cloudAgentSessionId) ?? null)
          : null,
      }));
    }),
});
