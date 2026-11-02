import 'server-only';
import { cloud_agent_sidebar_preferences } from '@kilocode/db/schema';
import { TRPCError } from '@trpc/server';
import { and, eq, isNull } from 'drizzle-orm';
import * as z from 'zod';
import { DEFAULT_WORKSPACE_ORDER, workspaceOrderSchema } from '@/lib/cloud-agent/workspace-folders';
import { createTRPCRouter } from '@kilocode/web-shared/lib/trpc/init';
import { cloudAgentSidebarScopeProcedure, type SidebarScope } from './cloud-agent-sidebar-scope';

const preferencesOutputSchema = z.object({ workspaceOrder: workspaceOrderSchema });

function scopeCondition(scope: SidebarScope) {
  return and(
    eq(cloud_agent_sidebar_preferences.kilo_user_id, scope.userId),
    scope.organizationId === null
      ? isNull(cloud_agent_sidebar_preferences.organization_id)
      : eq(cloud_agent_sidebar_preferences.organization_id, scope.organizationId)
  );
}

export const cloudAgentSidebarPreferencesRouter = createTRPCRouter({
  get: cloudAgentSidebarScopeProcedure.output(preferencesOutputSchema).query(async ({ ctx }) => {
    const [preference] = await ctx.sidebarDb
      .select({ workspaceOrder: cloud_agent_sidebar_preferences.workspace_order })
      .from(cloud_agent_sidebar_preferences)
      .where(scopeCondition(ctx.sidebarScope))
      .limit(1);

    return {
      workspaceOrder: preference
        ? workspaceOrderSchema.parse(preference.workspaceOrder)
        : DEFAULT_WORKSPACE_ORDER,
    };
  }),

  set: cloudAgentSidebarScopeProcedure
    .input(z.object({ workspaceOrder: workspaceOrderSchema }))
    .output(preferencesOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const [inserted] = await ctx.sidebarDb
        .insert(cloud_agent_sidebar_preferences)
        .values({
          kilo_user_id: ctx.sidebarScope.userId,
          organization_id: ctx.sidebarScope.organizationId,
          workspace_order: input.workspaceOrder,
        })
        .onConflictDoNothing()
        .returning({ workspaceOrder: cloud_agent_sidebar_preferences.workspace_order });

      if (inserted) {
        return { workspaceOrder: workspaceOrderSchema.parse(inserted.workspaceOrder) };
      }

      const [updated] = await ctx.sidebarDb
        .update(cloud_agent_sidebar_preferences)
        .set({ workspace_order: input.workspaceOrder })
        .where(scopeCondition(ctx.sidebarScope))
        .returning({ workspaceOrder: cloud_agent_sidebar_preferences.workspace_order });

      if (!updated) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Could not save sidebar preferences',
        });
      }
      return { workspaceOrder: workspaceOrderSchema.parse(updated.workspaceOrder) };
    }),
});
