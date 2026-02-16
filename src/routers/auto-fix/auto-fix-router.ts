/**
 * Auto Fix tRPC Router
 *
 * API endpoints for managing auto-fix tickets and configuration.
 * Supports both organization and personal user auto-fix.
 */

import { CLAUDE_SONNET_CURRENT_MODEL_ID } from '@/lib/model-constants';
import { createTRPCRouter, baseProcedure } from '@/lib/trpc/init';
import {
  organizationMemberProcedure,
  organizationOwnerProcedure,
  ensureOrganizationAccess,
} from '@/routers/organizations/utils';
import { TRPCError } from '@trpc/server';
import { successResult, failureResult } from '@/lib/maybe-result';
import {
  ListFixTicketsInputSchema,
  ListFixTicketsForUserInputSchema,
  GetFixTicketInputSchema,
  RetriggerFixTicketInputSchema,
  CancelFixTicketInputSchema,
  GetAutoFixConfigInputSchema,
  SaveAutoFixConfigSchema,
  ToggleAutoFixAgentInputSchema,
  type Owner,
  type ListFixTicketsResponse,
  type AutoFixAgentConfig,
  AUTO_FIX_CONSTANTS,
} from '@/lib/auto-fix/core/schemas';
import { DEFAULT_AUTO_FIX_CONFIG } from '@/lib/auto-fix/core/defaults';
import {
  listFixTickets,
  countFixTickets,
  getFixTicketById,
  resetFixTicketForRetry,
  cancelFixTicket,
} from '@/lib/auto-fix/db/fix-tickets';
import {
  getAgentConfigForOwner,
  upsertAgentConfigForOwner,
} from '@/lib/agent-config/db/agent-configs';
import { tryDispatchPendingFixes } from '@/lib/auto-fix/dispatch/dispatch-pending-fixes';

export const autoFixRouter = createTRPCRouter({
  /**
   * List fix tickets for an organization
   * Requires organization membership
   */
  listTicketsForOrganization: organizationMemberProcedure
    .input(ListFixTicketsInputSchema.omit({ organizationId: true }))
    .query(async ({ input, ctx }) => {
      try {
        // organizationId comes from organizationMemberProcedure's input
        const fullInput = input as typeof input & { organizationId: string };

        const owner: Owner = {
          type: 'org',
          id: fullInput.organizationId,
          userId: ctx.user.id,
        };

        const limit = fullInput.limit ?? 50;
        const offset = fullInput.offset ?? 0;

        const [tickets, total] = await Promise.all([
          listFixTickets({
            owner,
            limit,
            offset,
            status: fullInput.status,
            classification: fullInput.classification,
            repoFullName: fullInput.repoFullName,
          }),
          countFixTickets({
            owner,
            status: fullInput.status,
            classification: fullInput.classification,
            repoFullName: fullInput.repoFullName,
          }),
        ]);

        const response: ListFixTicketsResponse = {
          tickets,
          total,
          hasMore: offset + tickets.length < total,
        };

        return successResult(response);
      } catch (error) {
        return failureResult(error instanceof Error ? error.message : 'Failed to list fix tickets');
      }
    }),

  /**
   * List fix tickets for the current user (personal)
   */
  listTicketsForUser: baseProcedure
    .input(ListFixTicketsForUserInputSchema)
    .query(async ({ input, ctx }) => {
      try {
        const owner: Owner = {
          type: 'user',
          id: ctx.user.id,
          userId: ctx.user.id,
        };

        const limit = input.limit ?? 50;
        const offset = input.offset ?? 0;

        const [tickets, total] = await Promise.all([
          listFixTickets({
            owner,
            limit,
            offset,
            status: input.status,
            classification: input.classification,
            repoFullName: input.repoFullName,
          }),
          countFixTickets({
            owner,
            status: input.status,
            classification: input.classification,
            repoFullName: input.repoFullName,
          }),
        ]);

        const response: ListFixTicketsResponse = {
          tickets,
          total,
          hasMore: offset + tickets.length < total,
        };

        return successResult(response);
      } catch (error) {
        return failureResult(error instanceof Error ? error.message : 'Failed to list fix tickets');
      }
    }),

  /**
   * Get a specific fix ticket by ID
   * Verifies user ownership
   */
  getTicket: baseProcedure.input(GetFixTicketInputSchema).query(async ({ input, ctx }) => {
    try {
      const ticket = await getFixTicketById(input.ticketId);

      if (!ticket) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Fix ticket not found',
        });
      }

      // Authorization check based on owner type
      if (ticket.owned_by_organization_id) {
        // Organization ticket: verify user is org member
        await ensureOrganizationAccess(ctx, ticket.owned_by_organization_id);
      } else if (ticket.owned_by_user_id) {
        // Personal ticket: verify user owns it
        if (ticket.owned_by_user_id !== ctx.user.id) {
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: 'You do not have access to this fix ticket',
          });
        }
      } else {
        // Should not happen, but handle edge case
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Invalid ticket ownership data',
        });
      }

      return successResult({ ticket });
    } catch (error) {
      if (error instanceof TRPCError) {
        throw error;
      }
      return failureResult(error instanceof Error ? error.message : 'Failed to get fix ticket');
    }
  }),

  /**
   * Retrigger a failed fix ticket
   * Resets status to 'pending' and dispatches for processing
   */
  retrigger: baseProcedure.input(RetriggerFixTicketInputSchema).mutation(async ({ input, ctx }) => {
    try {
      const ticket = await getFixTicketById(input.ticketId);

      if (!ticket) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Fix ticket not found',
        });
      }

      // Authorization check based on owner type
      if (ticket.owned_by_organization_id) {
        // Organization ticket: verify user is org member
        await ensureOrganizationAccess(ctx, ticket.owned_by_organization_id);
      } else if (ticket.owned_by_user_id) {
        // Personal ticket: verify user owns it
        if (ticket.owned_by_user_id !== ctx.user.id) {
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: 'You do not have access to this fix ticket',
          });
        }
      } else {
        // Should not happen, but handle edge case
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Invalid ticket ownership data',
        });
      }

      // Only allow retriggering failed, pending, or cancelled tickets
      if (
        ticket.status !== 'failed' &&
        ticket.status !== 'pending' &&
        ticket.status !== 'cancelled'
      ) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: `Cannot retrigger a ticket that is ${ticket.status}. Only failed, pending, or cancelled tickets can be retriggered.`,
        });
      }

      // Determine owner for dispatch
      const owner: Owner = ticket.owned_by_organization_id
        ? {
            type: 'org',
            id: ticket.owned_by_organization_id,
            userId: ctx.user.id,
          }
        : {
            type: 'user',
            id: ticket.owned_by_user_id || ctx.user.id,
            userId: ctx.user.id,
          };

      // Reset the ticket for retry
      await resetFixTicketForRetry(input.ticketId);

      // Trigger dispatch to process pending tickets
      await tryDispatchPendingFixes(owner);

      return successResult({ message: 'Fix ticket retriggered successfully' });
    } catch (error) {
      if (error instanceof TRPCError) {
        throw error;
      }
      return failureResult(
        error instanceof Error ? error.message : 'Failed to retrigger fix ticket'
      );
    }
  }),

  /**
   * Cancel a running fix ticket
   */
  cancel: baseProcedure.input(CancelFixTicketInputSchema).mutation(async ({ input, ctx }) => {
    try {
      const ticket = await getFixTicketById(input.ticketId);

      if (!ticket) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Fix ticket not found',
        });
      }

      // Authorization check based on owner type
      if (ticket.owned_by_organization_id) {
        // Organization ticket: verify user is org member
        await ensureOrganizationAccess(ctx, ticket.owned_by_organization_id);
      } else if (ticket.owned_by_user_id) {
        // Personal ticket: verify user owns it
        if (ticket.owned_by_user_id !== ctx.user.id) {
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: 'You do not have access to this fix ticket',
          });
        }
      } else {
        // Should not happen, but handle edge case
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Invalid ticket ownership data',
        });
      }

      // Only allow cancelling running or pending tickets
      if (ticket.status !== 'running' && ticket.status !== 'pending') {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: `Cannot cancel a ticket that is ${ticket.status}. Only running or pending tickets can be cancelled.`,
        });
      }

      // Cancel the ticket
      await cancelFixTicket(input.ticketId);

      return successResult({ message: 'Fix ticket cancelled successfully' });
    } catch (error) {
      if (error instanceof TRPCError) {
        throw error;
      }
      return failureResult(error instanceof Error ? error.message : 'Failed to cancel fix ticket');
    }
  }),

  /**
   * Get auto-fix configuration for an organization
   * Requires organization membership
   */
  getConfig: organizationMemberProcedure
    .input(GetAutoFixConfigInputSchema.omit({ organizationId: true }))
    .query(async ({ input, ctx }) => {
      try {
        // organizationId comes from organizationMemberProcedure's input
        const fullInput = input as typeof input & { organizationId: string };

        const owner: Owner = {
          type: 'org',
          id: fullInput.organizationId,
          userId: ctx.user.id,
        };

        const config = await getAgentConfigForOwner(owner, 'auto_fix', 'github');

        if (!config) {
          return successResult({
            config: DEFAULT_AUTO_FIX_CONFIG,
            isEnabled: false,
          });
        }

        return successResult({
          config: config.config,
          isEnabled: config.is_enabled,
        });
      } catch (error) {
        return failureResult(
          error instanceof Error ? error.message : 'Failed to get auto-fix configuration'
        );
      }
    }),

  /**
   * Save auto-fix configuration for an organization
   * Requires organization owner role
   */
  saveConfig: organizationOwnerProcedure
    .input(SaveAutoFixConfigSchema.omit({ organizationId: true }))
    .mutation(async ({ input, ctx }) => {
      try {
        // organizationId comes from organizationOwnerProcedure's input
        const fullInput = input as typeof input & { organizationId: string };

        const owner: Owner = {
          type: 'org',
          id: fullInput.organizationId,
          userId: ctx.user.id,
        };

        // Build config object with defaults for optional fields
        const config: AutoFixAgentConfig = {
          enabled_for_issues: fullInput.enabled_for_issues,
          repository_selection_mode: fullInput.repository_selection_mode,
          selected_repository_ids: fullInput.selected_repository_ids ?? [],
          skip_labels: fullInput.skip_labels ?? [],
          required_labels: fullInput.required_labels ?? [],
          model_slug: fullInput.model_slug ?? CLAUDE_SONNET_CURRENT_MODEL_ID,
          custom_instructions: fullInput.custom_instructions ?? null,
          pr_title_template: fullInput.pr_title_template ?? 'Fix #{issue_number}: {issue_title}',
          pr_body_template: fullInput.pr_body_template ?? null,
          pr_base_branch: fullInput.pr_base_branch ?? 'main',
          max_pr_creation_time_minutes:
            fullInput.max_pr_creation_time_minutes ??
            AUTO_FIX_CONSTANTS.DEFAULT_MAX_PR_CREATION_TIME_MINUTES,
          max_concurrent_per_owner:
            fullInput.max_concurrent_per_owner ?? AUTO_FIX_CONSTANTS.MAX_CONCURRENT_FIXES_PER_OWNER,
        };

        await upsertAgentConfigForOwner({
          owner,
          agentType: 'auto_fix',
          platform: 'github',
          config,
          isEnabled: fullInput.enabled_for_issues,
          createdBy: ctx.user.id,
        });

        return successResult({ message: 'Auto-fix configuration saved successfully' });
      } catch (error) {
        return failureResult(
          error instanceof Error ? error.message : 'Failed to save auto-fix configuration'
        );
      }
    }),

  /**
   * Toggle auto-fix agent on/off
   * Requires organization owner role
   */
  toggleAgent: organizationOwnerProcedure
    .input(ToggleAutoFixAgentInputSchema.omit({ organizationId: true }))
    .mutation(async ({ input, ctx }) => {
      try {
        // organizationId comes from organizationOwnerProcedure's input
        const fullInput = input as typeof input & { organizationId: string };

        const owner: Owner = {
          type: 'org',
          id: fullInput.organizationId,
          userId: ctx.user.id,
        };

        const existingConfig = await getAgentConfigForOwner(owner, 'auto_fix', 'github');

        if (!existingConfig) {
          // Create default config if it doesn't exist
          // Set enabled_for_issues to match the toggle state
          const config = {
            ...DEFAULT_AUTO_FIX_CONFIG,
            enabled_for_issues: fullInput.isEnabled,
          };
          await upsertAgentConfigForOwner({
            owner,
            agentType: 'auto_fix',
            platform: 'github',
            config,
            isEnabled: fullInput.isEnabled,
            createdBy: ctx.user.id,
          });
        } else {
          // Update existing config and sync enabled_for_issues with toggle state
          const updatedConfig = {
            ...(existingConfig.config as AutoFixAgentConfig),
            enabled_for_issues: fullInput.isEnabled,
          };
          await upsertAgentConfigForOwner({
            owner,
            agentType: 'auto_fix',
            platform: 'github',
            config: updatedConfig,
            isEnabled: fullInput.isEnabled,
            createdBy: ctx.user.id,
          });
        }

        return successResult({
          message: `Auto-fix ${fullInput.isEnabled ? 'enabled' : 'disabled'} successfully`,
          isEnabled: fullInput.isEnabled,
        });
      } catch (error) {
        return failureResult(
          error instanceof Error ? error.message : 'Failed to toggle auto-fix agent'
        );
      }
    }),
});
