import { CLAUDE_SONNET_CURRENT_MODEL_ID } from '@/lib/model-constants';
import { createTRPCRouter } from '@/lib/trpc/init';
import { organizationMemberProcedure, organizationOwnerProcedure } from './utils';
import { fetchGitHubRepositoriesForOrganization } from '@/lib/cloud-agent/github-integration-helpers';
import {
  getAgentConfigForOwner,
  upsertAgentConfigForOwner,
} from '@/lib/agent-config/db/agent-configs';
import { DEFAULT_AUTO_FIX_CONFIG } from '@/lib/auto-fix/core/defaults';
import { z } from 'zod';
import type { Owner, AutoFixAgentConfig } from '@/lib/auto-fix/core/schemas';
import { AUTO_FIX_CONSTANTS } from '@/lib/auto-fix/core/schemas';
import { TRPCError } from '@trpc/server';
import { autoFixRouter } from '@/routers/auto-fix/auto-fix-router';
import { ensureBotUserForOrg } from '@/lib/bot-users/bot-user-service';

const SaveAutoFixConfigInputSchema = z
  .object({
    enabled_for_issues: z.boolean(),
    repository_selection_mode: z.enum(['all', 'selected']),
    selected_repository_ids: z.array(z.number()).optional(),
    skip_labels: z.array(z.string()).optional(),
    required_labels: z.array(z.string()).optional(),
    model_slug: z.string().optional(),
    custom_instructions: z.string().nullable().optional(),
    pr_title_template: z.string().optional(),
    pr_body_template: z.string().nullable().optional(),
    pr_base_branch: z.string().optional(),
    max_pr_creation_time_minutes: z.number().optional(),
  })
  .passthrough(); // Allow organizationId from organizationOwnerProcedure

const ToggleAutoFixAgentInputSchema = z
  .object({
    isEnabled: z.boolean(),
  })
  .passthrough(); // Allow organizationId from organizationOwnerProcedure

export const organizationAutoFixRouter = createTRPCRouter({
  listGitHubRepositories: organizationMemberProcedure.query(async ({ input }) => {
    return await fetchGitHubRepositoriesForOrganization(input.organizationId);
  }),

  getAutoFixConfig: organizationMemberProcedure.query(async ({ input, ctx }) => {
    const owner: Owner = {
      type: 'org',
      id: input.organizationId,
      userId: ctx.user.id,
    };

    const config = await getAgentConfigForOwner(owner, 'auto_fix', 'github');

    if (!config) {
      return {
        isEnabled: false,
        ...DEFAULT_AUTO_FIX_CONFIG,
      };
    }

    return {
      isEnabled: config.is_enabled,
      ...(config.config as typeof DEFAULT_AUTO_FIX_CONFIG),
    };
  }),

  saveAutoFixConfig: organizationOwnerProcedure
    .input(SaveAutoFixConfigInputSchema)
    .mutation(async ({ input, ctx }) => {
      try {
        // Extract organizationId from input (provided by organizationOwnerProcedure)
        const typedInput = input as typeof input & { organizationId: string };

        const owner: Owner = {
          type: 'org',
          id: typedInput.organizationId,
          userId: ctx.user.id,
        };

        // Ensure bot user exists when saving config with enabled_for_issues
        if (input.enabled_for_issues) {
          await ensureBotUserForOrg(typedInput.organizationId, 'auto-fix');
        }

        // Build config object with defaults for optional fields
        const config: AutoFixAgentConfig = {
          enabled_for_issues: input.enabled_for_issues,
          repository_selection_mode: input.repository_selection_mode,
          selected_repository_ids: input.selected_repository_ids ?? [],
          skip_labels: input.skip_labels ?? [],
          required_labels: input.required_labels ?? [],
          model_slug: input.model_slug ?? CLAUDE_SONNET_CURRENT_MODEL_ID,
          custom_instructions: input.custom_instructions ?? null,
          pr_title_template: input.pr_title_template ?? 'Fix #{issue_number}: {issue_title}',
          pr_body_template: input.pr_body_template ?? null,
          pr_base_branch: input.pr_base_branch ?? 'main',
          max_pr_creation_time_minutes:
            input.max_pr_creation_time_minutes ??
            AUTO_FIX_CONSTANTS.DEFAULT_MAX_PR_CREATION_TIME_MINUTES,
          max_concurrent_per_owner: AUTO_FIX_CONSTANTS.MAX_CONCURRENT_FIXES_PER_OWNER,
        };

        await upsertAgentConfigForOwner({
          owner,
          agentType: 'auto_fix',
          platform: 'github',
          config,
          isEnabled: input.enabled_for_issues,
          createdBy: ctx.user.id,
        });

        return { success: true, message: 'Auto-fix configuration saved successfully' };
      } catch (error) {
        console.error('Error saving auto-fix config:', error);
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to save auto-fix configuration',
        });
      }
    }),

  toggleAutoFixAgent: organizationOwnerProcedure
    .input(ToggleAutoFixAgentInputSchema)
    .mutation(async ({ input, ctx }) => {
      try {
        // Extract organizationId from input (provided by organizationOwnerProcedure)
        const typedInput = input as typeof input & { organizationId: string };

        const owner: Owner = {
          type: 'org',
          id: typedInput.organizationId,
          userId: ctx.user.id,
        };

        // Ensure bot user exists when enabling auto-fix
        if (input.isEnabled) {
          await ensureBotUserForOrg(typedInput.organizationId, 'auto-fix');
        }

        const existingConfig = await getAgentConfigForOwner(owner, 'auto_fix', 'github');

        if (!existingConfig) {
          // Create default config if it doesn't exist
          const config = {
            ...DEFAULT_AUTO_FIX_CONFIG,
            enabled_for_issues: input.isEnabled,
          };
          await upsertAgentConfigForOwner({
            owner,
            agentType: 'auto_fix',
            platform: 'github',
            config,
            isEnabled: input.isEnabled,
            createdBy: ctx.user.id,
          });
        } else {
          // Update existing config and sync enabled_for_issues with toggle state
          const updatedConfig = {
            ...(existingConfig.config as AutoFixAgentConfig),
            enabled_for_issues: input.isEnabled,
          };
          await upsertAgentConfigForOwner({
            owner,
            agentType: 'auto_fix',
            platform: 'github',
            config: updatedConfig,
            isEnabled: input.isEnabled,
            createdBy: ctx.user.id,
          });
        }

        return {
          success: true,
          message: `Auto-fix ${input.isEnabled ? 'enabled' : 'disabled'} successfully`,
          isEnabled: input.isEnabled,
        };
      } catch (error) {
        console.error('Error toggling auto-fix agent:', error);
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to toggle auto-fix agent',
        });
      }
    }),

  listTickets: organizationMemberProcedure
    .input(
      z.object({
        limit: z.number().optional(),
        offset: z.number().optional(),
        status: z.enum(['pending', 'running', 'completed', 'failed', 'cancelled']).optional(),
        classification: z.enum(['bug', 'feature', 'question', 'unclear']).optional(),
        repoFullName: z.string().optional(),
      })
    )
    .query(async ({ input, ctx }) => {
      // Extract organizationId from input (provided by organizationMemberProcedure)
      const typedInput = input as typeof input & { organizationId: string };

      // Forward to the base router with organizationId
      return await autoFixRouter.createCaller(ctx).listTicketsForOrganization({
        organizationId: typedInput.organizationId,
        limit: input.limit,
        offset: input.offset,
        status: input.status,
        classification: input.classification,
        repoFullName: input.repoFullName,
      });
    }),

  retriggerFix: organizationMemberProcedure
    .input(
      z.object({
        ticketId: z.string().uuid(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      return await autoFixRouter.createCaller(ctx).retrigger({ ticketId: input.ticketId });
    }),

  cancelFix: organizationMemberProcedure
    .input(
      z.object({
        ticketId: z.string().uuid(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      return await autoFixRouter.createCaller(ctx).cancel({ ticketId: input.ticketId });
    }),
});
