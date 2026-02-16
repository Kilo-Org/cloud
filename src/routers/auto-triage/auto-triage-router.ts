/**
 * Auto Triage tRPC Router
 *
 * API endpoints for managing auto-triage tickets and configuration.
 * Supports both organization and personal user auto-triage.
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
  ListTriageTicketsInputSchema,
  ListTriageTicketsForUserInputSchema,
  GetTriageTicketInputSchema,
  RetriggerTriageTicketInputSchema,
  GetAutoTriageConfigInputSchema,
  SaveAutoTriageConfigSchema,
  type Owner,
  type ListTriageTicketsResponse,
} from '@/lib/auto-triage/core/schemas';
import {
  listTriageTickets,
  countTriageTickets,
  getTriageTicketById,
  resetTriageTicketForRetry,
} from '@/lib/auto-triage/db/triage-tickets';
import { getAgentConfig, upsertAgentConfig } from '@/lib/agent-config/db/agent-configs';
import { DEFAULT_AUTO_TRIAGE_CONFIG } from '@/lib/auto-triage';

export const autoTriageRouter = createTRPCRouter({
  /**
   * List triage tickets for an organization
   * Requires organization membership
   */
  listTicketsForOrganization: organizationMemberProcedure
    .input(ListTriageTicketsInputSchema.omit({ organizationId: true }))
    .query(async ({ input, ctx }) => {
      try {
        // organizationId comes from organizationMemberProcedure's input
        // TypeScript doesn't know about it due to .omit(), but it exists at runtime
        const fullInput = input as typeof input & { organizationId: string };

        const owner: Owner = {
          type: 'org',
          id: fullInput.organizationId,
          userId: ctx.user.id,
        };

        const limit = fullInput.limit ?? 50;
        const offset = fullInput.offset ?? 0;

        const [tickets, total] = await Promise.all([
          listTriageTickets({
            owner,
            limit,
            offset,
            status: fullInput.status,
            classification: fullInput.classification,
            repoFullName: fullInput.repoFullName,
          }),
          countTriageTickets({
            owner,
            status: fullInput.status,
            classification: fullInput.classification,
            repoFullName: fullInput.repoFullName,
          }),
        ]);

        const response: ListTriageTicketsResponse = {
          tickets,
          total,
          hasMore: offset + tickets.length < total,
        };

        return successResult(response);
      } catch (error) {
        return failureResult(
          error instanceof Error ? error.message : 'Failed to list triage tickets'
        );
      }
    }),

  /**
   * List triage tickets for the current user (personal)
   */
  listTicketsForUser: baseProcedure
    .input(ListTriageTicketsForUserInputSchema)
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
          listTriageTickets({
            owner,
            limit,
            offset,
            status: input.status,
            classification: input.classification,
            repoFullName: input.repoFullName,
          }),
          countTriageTickets({
            owner,
            status: input.status,
            classification: input.classification,
            repoFullName: input.repoFullName,
          }),
        ]);

        const response: ListTriageTicketsResponse = {
          tickets,
          total,
          hasMore: offset + tickets.length < total,
        };

        return successResult(response);
      } catch (error) {
        return failureResult(
          error instanceof Error ? error.message : 'Failed to list triage tickets'
        );
      }
    }),

  /**
   * Get a specific triage ticket by ID
   * Verifies user ownership
   */
  getTicket: baseProcedure.input(GetTriageTicketInputSchema).query(async ({ input, ctx }) => {
    try {
      const ticket = await getTriageTicketById(input.ticketId);

      if (!ticket) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Triage ticket not found',
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
            message: 'You do not have access to this triage ticket',
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
      return failureResult(error instanceof Error ? error.message : 'Failed to get triage ticket');
    }
  }),

  /**
   * Retrigger a failed triage ticket
   * Resets status to 'pending' and dispatches for processing
   */
  retrigger: baseProcedure
    .input(RetriggerTriageTicketInputSchema)
    .mutation(async ({ input, ctx }) => {
      try {
        const ticket = await getTriageTicketById(input.ticketId);

        if (!ticket) {
          throw new TRPCError({
            code: 'NOT_FOUND',
            message: 'Triage ticket not found',
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
              message: 'You do not have access to this triage ticket',
            });
          }
        } else {
          // Should not happen, but handle edge case
          throw new TRPCError({
            code: 'INTERNAL_SERVER_ERROR',
            message: 'Invalid ticket ownership data',
          });
        }

        // Only allow retriggering failed tickets
        if (ticket.status !== 'failed') {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: `Cannot retrigger a ticket that is ${ticket.status}. Only failed tickets can be retriggered.`,
          });
        }

        // Reset the ticket for retry
        await resetTriageTicketForRetry(input.ticketId);

        return successResult({ message: 'Triage ticket retriggered successfully' });
      } catch (error) {
        if (error instanceof TRPCError) {
          throw error;
        }
        return failureResult(
          error instanceof Error ? error.message : 'Failed to retrigger triage ticket'
        );
      }
    }),

  /**
   * Get auto-triage configuration for an organization
   * Requires organization membership
   */
  getConfig: organizationMemberProcedure
    .input(GetAutoTriageConfigInputSchema.omit({ organizationId: true }))
    .query(async ({ input }) => {
      try {
        // organizationId comes from organizationMemberProcedure's input
        const fullInput = input as typeof input & { organizationId: string };

        const config = await getAgentConfig(fullInput.organizationId, 'auto_triage', 'github');

        if (!config) {
          return successResult({
            config: DEFAULT_AUTO_TRIAGE_CONFIG,
            isEnabled: false,
          });
        }

        return successResult({
          config: config.config,
          isEnabled: config.is_enabled,
        });
      } catch (error) {
        return failureResult(
          error instanceof Error ? error.message : 'Failed to get auto-triage configuration'
        );
      }
    }),

  /**
   * Save auto-triage configuration for an organization
   * Requires organization owner role
   */
  saveConfig: organizationOwnerProcedure
    .input(SaveAutoTriageConfigSchema.omit({ organizationId: true }))
    .mutation(async ({ input, ctx }) => {
      try {
        // organizationId comes from organizationOwnerProcedure's input
        const fullInput = input as typeof input & { organizationId: string };

        // Build config object with defaults for optional fields
        const config = {
          enabled_for_issues: fullInput.enabled_for_issues,
          repository_selection_mode: fullInput.repository_selection_mode,
          selected_repository_ids: fullInput.selected_repository_ids ?? [],
          skip_labels: fullInput.skip_labels ?? [],
          duplicate_threshold: fullInput.duplicate_threshold ?? 0.8,
          auto_create_pr_threshold: fullInput.auto_create_pr_threshold ?? 0.9,
          max_concurrent_per_owner: fullInput.max_concurrent_per_owner ?? 10,
          custom_instructions: fullInput.custom_instructions ?? null,
          model_slug: fullInput.model_slug ?? CLAUDE_SONNET_CURRENT_MODEL_ID,
        };

        await upsertAgentConfig({
          organizationId: fullInput.organizationId,
          agentType: 'auto_triage',
          platform: 'github',
          config,
          isEnabled: fullInput.enabled_for_issues,
          createdBy: ctx.user.id,
        });

        return successResult({ message: 'Auto-triage configuration saved successfully' });
      } catch (error) {
        return failureResult(
          error instanceof Error ? error.message : 'Failed to save auto-triage configuration'
        );
      }
    }),
});
