/**
 * Auto Triage tRPC Router
 *
 * API endpoints for managing auto-triage tickets and configuration.
 * Supports both organization and personal user auto-triage.
 */

import { createTRPCRouter, baseProcedure, adminProcedure } from '@/lib/trpc/init';
import {
  organizationMemberProcedure,
  organizationBillingProcedure,
  ensureOrganizationAccess,
} from '@/routers/organizations/utils';
import { requireActiveSubscriptionOrTrial } from '@/lib/organizations/trial-middleware';
import { TRPCError } from '@trpc/server';
import { successResult, failureResult } from '@/lib/maybe-result';
import * as z from 'zod';
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
  createTriageTicket,
} from '@/lib/auto-triage/db/triage-tickets';
import { getAgentConfig, upsertAgentConfig } from '@/lib/agent-config/db/agent-configs';
import { DEFAULT_AUTO_TRIAGE_CONFIG } from '@/lib/auto-triage';
import { parseGitHubIssueUrl, fetchIssueForOwner } from '@/lib/auto-triage/github/fetch-issue';
import { tryDispatchPendingTickets } from '@/lib/auto-triage/dispatch/dispatch-pending-tickets';
import { getIntegrationForOwner } from '@/lib/integrations/db/platform-integrations';
import { getBotUserId } from '@/lib/bot-users/bot-user-service';

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
  saveConfig: organizationBillingProcedure
    .input(SaveAutoTriageConfigSchema.omit({ organizationId: true }))
    .mutation(async ({ input, ctx }) => {
      try {
        // organizationId comes from organizationBillingProcedure's input
        const fullInput = input as typeof input & { organizationId: string };

        // Only enforce trial/subscription when enabling — expired orgs must
        // still be able to disable agents whose webhook processors keep running.
        if (fullInput.enabled_for_issues) {
          await requireActiveSubscriptionOrTrial(fullInput.organizationId);
        }

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
          model_slug: fullInput.model_slug ?? 'anthropic/claude-sonnet-4.5',
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

  /**
   * Admin-only: submit an issue URL for triage, mirroring the
   * `issues.opened` webhook path without needing a real webhook.
   *
   * Creates a triage ticket for the given owner (org or personal) by
   * fetching the issue title/body/labels via the owner's GitHub App
   * installation, then kicks dispatch. Status updates appear in the
   * normal ticket list.
   */
  adminSubmitForTriage: adminProcedure
    .input(
      z.object({
        issueUrl: z.string().min(1),
        owner: z.discriminatedUnion('type', [
          z.object({ type: z.literal('org'), organizationId: z.string() }),
          z.object({ type: z.literal('user') }),
        ]),
      })
    )
    .mutation(async ({ input, ctx }) => {
      let parsedUrl;
      try {
        parsedUrl = parseGitHubIssueUrl(input.issueUrl);
      } catch (error) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: error instanceof Error ? error.message : 'Invalid issue URL',
        });
      }

      // Resolve the Owner we'll store on the ticket and use for dispatch.
      // For orgs we mirror issue-webhook-processor.resolveOwner() by
      // preferring the bot user id with a fallback to the integration
      // creator. For personal we use the admin's own user id.
      let owner: Owner;
      if (input.owner.type === 'org') {
        // `getIntegrationForOwner` takes the integrations-module `Owner`
        // which only needs { type, id } — don't synthesise a userId here.
        const integration = await getIntegrationForOwner(
          { type: 'org', id: input.owner.organizationId },
          'github'
        );
        if (!integration) {
          throw new TRPCError({
            code: 'PRECONDITION_FAILED',
            message: 'No GitHub App installation found for this organization.',
          });
        }
        const botUserId = await getBotUserId(input.owner.organizationId, 'auto-triage');
        const fallbackUserId = botUserId ?? integration.kilo_requester_user_id;
        if (!fallbackUserId) {
          throw new TRPCError({
            code: 'PRECONDITION_FAILED',
            message:
              'Could not resolve a user id for this organization (bot user missing and no integration creator). Toggle auto-triage off and on to provision the bot user.',
          });
        }
        owner = {
          type: 'org',
          id: input.owner.organizationId,
          userId: fallbackUserId,
        };
      } else {
        owner = { type: 'user', id: ctx.user.id, userId: ctx.user.id };
      }

      // Pull title/body/labels from GitHub via the owner's installation.
      let issue;
      try {
        issue = await fetchIssueForOwner(owner, parsedUrl);
      } catch (error) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: error instanceof Error ? error.message : 'Failed to fetch issue from GitHub',
        });
      }

      // Look up the integration again for owner.type==='user' to attach
      // platformIntegrationId on the ticket for parity with the webhook path.
      const integration = await getIntegrationForOwner(owner, 'github');

      const ticketId = await createTriageTicket({
        owner,
        platformIntegrationId: integration?.id,
        repoFullName: parsedUrl.repoFullName,
        issueNumber: parsedUrl.issueNumber,
        issueUrl: parsedUrl.issueUrl,
        issueTitle: issue.title,
        issueBody: issue.body,
        issueAuthor: issue.authorLogin,
        issueType: 'issue',
        issueLabels: issue.labels,
      });

      // Same dispatch the webhook processor calls — this hits
      // triageWorkerClient.dispatchTriage → worker POST /triage.
      await tryDispatchPendingTickets(owner);

      return successResult({
        ticketId,
        repoFullName: parsedUrl.repoFullName,
        issueNumber: parsedUrl.issueNumber,
        issueTitle: issue.title,
      });
    }),
});
