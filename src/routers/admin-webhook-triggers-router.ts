import { adminProcedure, createTRPCRouter } from '@/lib/trpc/init';
import { TRPCError } from '@trpc/server';
import { and, eq, isNull, inArray, desc } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@/lib/drizzle';
import { cloud_agent_webhook_triggers, cliSessions } from '@/db/schema';
import { triggerIdSchema } from '@/lib/webhook-trigger-validation';
import {
  getWorkerTrigger,
  listWorkerRequests,
  buildInboundUrl,
  type EnrichedCapturedRequest,
} from '@/lib/webhook-agent/webhook-agent-client';

const AdminUserScope = z.object({ scope: z.literal('user'), userId: z.string() });
const AdminOrgScope = z.object({
  scope: z.literal('organization'),
  organizationId: z.string().uuid(),
});
const AdminTriggerScopeSchema = z.discriminatedUnion('scope', [AdminUserScope, AdminOrgScope]);

const AdminTriggerListInput = AdminTriggerScopeSchema;

const AdminTriggerGetInput = AdminTriggerScopeSchema.and(
  z.object({
    triggerId: triggerIdSchema,
  })
);

const AdminTriggerRequestsInput = AdminTriggerGetInput.and(
  z.object({
    limit: z.number().min(1).max(100).default(50),
  })
);

function resolveScope(input: z.infer<typeof AdminTriggerScopeSchema>) {
  if (input.scope === 'organization') {
    return { scope: 'org' as const, id: input.organizationId };
  }
  return { scope: 'user' as const, id: input.userId };
}

export const adminWebhookTriggersRouter = createTRPCRouter({
  list: adminProcedure.input(AdminTriggerListInput).query(async ({ input }) => {
    const { scope, id } = resolveScope(input);

    const whereClause =
      scope === 'org'
        ? eq(cloud_agent_webhook_triggers.organization_id, id)
        : and(
            eq(cloud_agent_webhook_triggers.user_id, id),
            isNull(cloud_agent_webhook_triggers.organization_id)
          );

    const triggers = await db
      .select({
        id: cloud_agent_webhook_triggers.id,
        triggerId: cloud_agent_webhook_triggers.trigger_id,
        githubRepo: cloud_agent_webhook_triggers.github_repo,
        isActive: cloud_agent_webhook_triggers.is_active,
        createdAt: cloud_agent_webhook_triggers.created_at,
        updatedAt: cloud_agent_webhook_triggers.updated_at,
      })
      .from(cloud_agent_webhook_triggers)
      .where(whereClause)
      .orderBy(desc(cloud_agent_webhook_triggers.created_at));

    return triggers.map(trigger => ({
      ...trigger,
      inboundUrl: buildInboundUrl(
        scope === 'user' ? id : undefined,
        scope === 'org' ? id : undefined,
        trigger.triggerId
      ),
    }));
  }),

  get: adminProcedure.input(AdminTriggerGetInput).query(async ({ input }) => {
    const { scope, id } = resolveScope(input);

    const whereClause =
      scope === 'org'
        ? and(
            eq(cloud_agent_webhook_triggers.organization_id, id),
            eq(cloud_agent_webhook_triggers.trigger_id, input.triggerId)
          )
        : and(
            eq(cloud_agent_webhook_triggers.user_id, id),
            eq(cloud_agent_webhook_triggers.trigger_id, input.triggerId),
            isNull(cloud_agent_webhook_triggers.organization_id)
          );

    const [trigger] = await db
      .select({
        id: cloud_agent_webhook_triggers.id,
        triggerId: cloud_agent_webhook_triggers.trigger_id,
      })
      .from(cloud_agent_webhook_triggers)
      .where(whereClause);

    if (!trigger) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Trigger not found' });
    }

    const workerResult = await getWorkerTrigger(
      scope === 'user' ? id : undefined,
      scope === 'org' ? id : undefined,
      input.triggerId
    );

    if (workerResult.found === false) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Trigger not found' });
    }

    if (workerResult.found === 'error') {
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Failed to fetch trigger configuration',
      });
    }

    const inboundUrl = buildInboundUrl(
      scope === 'user' ? id : undefined,
      scope === 'org' ? id : undefined,
      input.triggerId
    );

    return {
      ...workerResult.config,
      inboundUrl,
    };
  }),

  listRequests: adminProcedure
    .input(AdminTriggerRequestsInput)
    .query(async ({ input }): Promise<EnrichedCapturedRequest[]> => {
      const { scope, id } = resolveScope(input);

      const whereClause =
        scope === 'org'
          ? and(
              eq(cloud_agent_webhook_triggers.organization_id, id),
              eq(cloud_agent_webhook_triggers.trigger_id, input.triggerId)
            )
          : and(
              eq(cloud_agent_webhook_triggers.user_id, id),
              eq(cloud_agent_webhook_triggers.trigger_id, input.triggerId),
              isNull(cloud_agent_webhook_triggers.organization_id)
            );

      const [trigger] = await db
        .select({
          id: cloud_agent_webhook_triggers.id,
          triggerId: cloud_agent_webhook_triggers.trigger_id,
        })
        .from(cloud_agent_webhook_triggers)
        .where(whereClause);

      if (!trigger) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Trigger not found' });
      }

      const result = await listWorkerRequests(
        scope === 'user' ? id : undefined,
        scope === 'org' ? id : undefined,
        input.triggerId,
        input.limit
      );

      if (!result.success) {
        if (result.isNotFound) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'Trigger not found' });
        }
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to list requests',
        });
      }

      const cloudAgentSessionIds = result.requests
        .map(request => request.cloudAgentSessionId)
        .filter((sessionId): sessionId is string => sessionId !== null);

      const sessionIdMap =
        cloudAgentSessionIds.length > 0
          ? new Map(
              (
                await db
                  .select({
                    cloudAgentSessionId: cliSessions.cloud_agent_session_id,
                    sessionId: cliSessions.session_id,
                  })
                  .from(cliSessions)
                  .where(inArray(cliSessions.cloud_agent_session_id, cloudAgentSessionIds))
              )
                .filter(
                  (session): session is { cloudAgentSessionId: string; sessionId: string } =>
                    session.cloudAgentSessionId !== null
                )
                .map(session => [session.cloudAgentSessionId, session.sessionId])
            )
          : new Map<string, string>();

      return result.requests.map(request => ({
        ...request,
        kiloSessionId: request.cloudAgentSessionId
          ? (sessionIdMap.get(request.cloudAgentSessionId) ?? null)
          : null,
      }));
    }),
});
