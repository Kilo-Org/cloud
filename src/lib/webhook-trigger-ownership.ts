import { and, eq, isNull } from 'drizzle-orm';
import { TRPCError } from '@trpc/server';
import { db } from '@/lib/drizzle';
import { cloud_agent_webhook_triggers } from '@kilocode/db/schema';
import { ensureOrganizationAccess } from '@/routers/organizations/utils';
import type { TRPCContext } from '@/lib/trpc/init';

/**
 * Verify the caller has access to the given webhook trigger.
 *
 * For org triggers: checks the trigger exists for the org, then verifies org membership.
 * For personal triggers: checks the trigger exists and belongs to the user.
 *
 * Throws NOT_FOUND if the trigger doesn't exist or the caller lacks access.
 */
export async function verifyWebhookTriggerAccess(
  ctx: TRPCContext,
  triggerId: string,
  organizationId: string | undefined
) {
  const triggerWhereClause = organizationId
    ? and(
        eq(cloud_agent_webhook_triggers.trigger_id, triggerId),
        eq(cloud_agent_webhook_triggers.organization_id, organizationId)
      )
    : and(
        eq(cloud_agent_webhook_triggers.trigger_id, triggerId),
        eq(cloud_agent_webhook_triggers.user_id, ctx.user.id),
        isNull(cloud_agent_webhook_triggers.organization_id)
      );

  const [trigger] = await db.select().from(cloud_agent_webhook_triggers).where(triggerWhereClause);

  if (!trigger) {
    throw new TRPCError({
      code: 'NOT_FOUND',
      message: 'Trigger not found',
    });
  }

  if (organizationId) {
    await ensureOrganizationAccess(ctx, organizationId);
  }

  return trigger;
}
