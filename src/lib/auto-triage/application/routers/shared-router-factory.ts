import type { baseProcedure } from '@/lib/trpc/init';
import type { TRPCContext } from '@/lib/trpc/init';
import { TRPCError } from '@trpc/server';
import * as z from 'zod';
import type { AutoTriageAgentConfig } from '@/lib/auto-triage/core/schemas';
import { PRIMARY_DEFAULT_MODEL } from '@/lib/models';
import { DEFAULT_AUTO_TRIAGE_CONFIG } from '@/lib/auto-triage/core/defaults';
import { AUTO_TRIAGE_CONSTANTS } from '@/lib/auto-triage/core/constants';
import {
  listTriageTickets,
  countTriageTickets,
  getTriageTicketById,
  resetTriageTicketForRetry,
  interruptTriageTicket,
} from '@/lib/auto-triage/db/triage-tickets';
import type { Owner } from '@/lib/auto-triage/db/types';
import { successResult, failureResult } from '@/lib/maybe-result';
import { tryDispatchPendingTickets } from '@/lib/auto-triage/dispatch/dispatch-pending-tickets';
import { ensureBotUserForOrg } from '@/lib/bot-users/bot-user-service';

type OwnerResolver = (ctx: TRPCContext, input: unknown) => Owner | Promise<Owner>;

type AuditLogParams = {
  owner: Owner;
  ctx: TRPCContext;
  message: string;
};

type AuditLogger = (params: AuditLogParams) => Promise<void>;

type IntegrationResult = {
  integration_status: string | null;
  platform_account_login: string | null;
  repository_access: string | null;
  installed_at: Date | string | null;
  suspended_at: Date | string | null;
} | null;

type IntegrationGetter = (owner: Owner) => Promise<IntegrationResult>;

type GitHubRepositoriesResult = {
  integrationInstalled: boolean;
  repositories: {
    id: number;
    name: string;
    fullName: string;
    private: boolean;
  }[];
  errorMessage?: string;
};

type RepositoryFetcher = (owner: Owner) => Promise<GitHubRepositoriesResult>;

type AgentConfigResult = {
  is_enabled: boolean;
  config: unknown;
} | null;

type AgentConfigGetter = (
  owner: Owner,
  agentType: string,
  platform: string
) => Promise<AgentConfigResult>;

type AgentConfigUpserter = (params: {
  owner: Owner;
  agentType: string;
  platform: string;
  config: AutoTriageAgentConfig;
  createdBy: string;
}) => Promise<void>;

type AgentEnabledSetter = (
  owner: Owner,
  agentType: string,
  platform: string,
  isEnabled: boolean
) => Promise<void>;

type TicketOwnershipVerifier = (
  ticket: { owned_by_organization_id: string | null; owned_by_user_id: string | null },
  owner: Owner
) => boolean;

type RouterFactoryParams = {
  ownerResolver: OwnerResolver;
  auditLogger?: AuditLogger;
  integrationGetter: IntegrationGetter;
  repositoryFetcher: RepositoryFetcher;
  agentConfigGetter: AgentConfigGetter;
  agentConfigUpserter: AgentConfigUpserter;
  agentEnabledSetter: AgentEnabledSetter;
  ticketOwnershipVerifier: TicketOwnershipVerifier;
};

const SaveAutoTriageConfigInputSchema = z.object({
  enabled_for_issues: z.boolean(),
  repository_selection_mode: z.enum(['all', 'selected']),
  selected_repository_ids: z.array(z.number().int().positive()).optional(),
  skip_labels: z.array(z.string()).optional(),
  required_labels: z.array(z.string()).optional(),
  duplicate_threshold: z.number().min(0).max(1).optional(),
  auto_fix_threshold: z.number().min(0).max(1).optional(),
  auto_create_pr_threshold: z.number().min(0).max(1).optional(),
  max_concurrent_per_owner: z.number().int().positive().optional(),
  custom_instructions: z.string().nullable().optional(),
  model_slug: z.string().optional(),
  pr_branch_prefix: z.string().optional(),
  pr_title_template: z.string().optional(),
  pr_body_template: z.string().optional(),
  pr_base_branch: z.string().optional(),
  max_classification_time_minutes: z.number().int().positive().min(1).max(15).optional(),
  max_pr_creation_time_minutes: z.number().int().positive().min(5).max(30).optional(),
});

export function createAutoTriageRouter({
  ownerResolver,
  auditLogger,
  integrationGetter,
  repositoryFetcher,
  agentConfigGetter,
  agentConfigUpserter,
  agentEnabledSetter,
  ticketOwnershipVerifier,
}: RouterFactoryParams) {
  return {
    /**
     * Gets the GitHub App installation status
     */
    getGitHubStatus: async ({ ctx, input }: { ctx: TRPCContext; input: unknown }) => {
      const owner = await ownerResolver(ctx, input);
      const integration = await integrationGetter(owner);

      if (!integration || integration.integration_status !== 'active') {
        return {
          connected: false,
          integration: null,
        };
      }

      return {
        connected: true,
        integration: {
          accountLogin: integration.platform_account_login,
          repositorySelection: integration.repository_access,
          installedAt: integration.installed_at,
          isValid: !integration.suspended_at,
        },
      };
    },

    /**
     * List GitHub repositories accessible by the integration
     */
    listGitHubRepositories: async ({ ctx, input }: { ctx: TRPCContext; input: unknown }) => {
      const owner = await ownerResolver(ctx, input);
      return await repositoryFetcher(owner);
    },

    /**
     * Gets the auto-triage agent configuration
     */
    getAutoTriageConfig: async ({ ctx, input }: { ctx: TRPCContext; input: unknown }) => {
      const owner = await ownerResolver(ctx, input);
      const config = await agentConfigGetter(owner, 'auto_triage', 'github');

      if (!config) {
        // Return default configuration
        return DEFAULT_AUTO_TRIAGE_CONFIG;
      }

      const cfg = config.config as AutoTriageAgentConfig;
      return {
        isEnabled: config.is_enabled,
        enabled_for_issues: cfg.enabled_for_issues || false,
        repository_selection_mode: cfg.repository_selection_mode || 'all',
        selected_repository_ids: cfg.selected_repository_ids || [],
        skip_labels: cfg.skip_labels || [],
        required_labels: cfg.required_labels || [],
        duplicate_threshold:
          cfg.duplicate_threshold || AUTO_TRIAGE_CONSTANTS.DEFAULT_DUPLICATE_THRESHOLD,
        auto_fix_threshold:
          cfg.auto_fix_threshold || AUTO_TRIAGE_CONSTANTS.DEFAULT_AUTO_PR_THRESHOLD,
        auto_create_pr_threshold:
          cfg.auto_create_pr_threshold || AUTO_TRIAGE_CONSTANTS.DEFAULT_AUTO_PR_THRESHOLD,
        max_concurrent_per_owner:
          cfg.max_concurrent_per_owner || AUTO_TRIAGE_CONSTANTS.MAX_CONCURRENT_TICKETS_PER_OWNER,
        custom_instructions: cfg.custom_instructions || null,
        model_slug: cfg.model_slug || PRIMARY_DEFAULT_MODEL,
        max_classification_time_minutes: cfg.max_classification_time_minutes || 5,
        max_pr_creation_time_minutes: cfg.max_pr_creation_time_minutes || 15,
      };
    },

    /**
     * Saves the auto-triage agent configuration
     */
    saveAutoTriageConfig: {
      inputSchema: SaveAutoTriageConfigInputSchema,
      handler: async ({
        ctx,
        input,
      }: {
        ctx: TRPCContext;
        input: z.infer<typeof SaveAutoTriageConfigInputSchema>;
      }) => {
        try {
          const owner = await ownerResolver(ctx, input);

          // Ensure bot user exists when saving config for organizations with enabled_for_issues
          if (owner.type === 'org' && input.enabled_for_issues) {
            await ensureBotUserForOrg(owner.id, 'auto-triage');
          }

          await agentConfigUpserter({
            owner,
            agentType: 'auto_triage',
            platform: 'github',
            config: {
              enabled_for_issues: input.enabled_for_issues,
              repository_selection_mode: input.repository_selection_mode,
              selected_repository_ids: input.selected_repository_ids || [],
              skip_labels: input.skip_labels || [],
              required_labels: input.required_labels || [],
              duplicate_threshold:
                input.duplicate_threshold ?? AUTO_TRIAGE_CONSTANTS.DEFAULT_DUPLICATE_THRESHOLD,
              auto_fix_threshold:
                input.auto_fix_threshold ?? AUTO_TRIAGE_CONSTANTS.DEFAULT_AUTO_PR_THRESHOLD,
              auto_create_pr_threshold:
                input.auto_create_pr_threshold ?? AUTO_TRIAGE_CONSTANTS.DEFAULT_AUTO_PR_THRESHOLD,
              max_concurrent_per_owner:
                input.max_concurrent_per_owner ??
                AUTO_TRIAGE_CONSTANTS.MAX_CONCURRENT_TICKETS_PER_OWNER,
              custom_instructions: input.custom_instructions || null,
              model_slug: input.model_slug || PRIMARY_DEFAULT_MODEL,
              pr_branch_prefix: input.pr_branch_prefix ?? 'auto-triage',
              pr_title_template: input.pr_title_template ?? 'Fix #{issue_number}: {issue_title}',
              pr_body_template: input.pr_body_template,
              pr_base_branch: input.pr_base_branch ?? 'main',
              max_classification_time_minutes: input.max_classification_time_minutes ?? 5,
              max_pr_creation_time_minutes: input.max_pr_creation_time_minutes ?? 15,
            },
            createdBy: ctx.user.id,
          });

          // Audit log (if provided)
          if (auditLogger) {
            await auditLogger({
              owner,
              ctx,
              message: 'Updated Auto Triage Agent configuration',
            });
          }

          return { success: true };
        } catch (error) {
          console.error('Error saving auto-triage config:', error);
          throw new TRPCError({
            code: 'INTERNAL_SERVER_ERROR',
            message: 'Failed to save auto-triage configuration',
          });
        }
      },
    },

    /**
     * Toggles the auto-triage agent on/off
     */
    toggleAutoTriageAgent: {
      inputSchema: z.object({
        isEnabled: z.boolean(),
      }),
      handler: async ({ ctx, input }: { ctx: TRPCContext; input: { isEnabled: boolean } }) => {
        try {
          const owner = await ownerResolver(ctx, input);

          // Get existing config to update enabled_for_issues
          const existingConfig = await agentConfigGetter(owner, 'auto_triage', 'github');

          if (existingConfig) {
            // Update the config to sync enabled_for_issues with toggle state
            const currentConfig = existingConfig.config as AutoTriageAgentConfig;
            const updatedConfig: AutoTriageAgentConfig = {
              enabled_for_issues: input.isEnabled,
              repository_selection_mode: currentConfig.repository_selection_mode,
              selected_repository_ids: currentConfig.selected_repository_ids,
              skip_labels: currentConfig.skip_labels,
              required_labels: currentConfig.required_labels,
              duplicate_threshold: currentConfig.duplicate_threshold,
              auto_fix_threshold: currentConfig.auto_fix_threshold,
              max_concurrent_per_owner: currentConfig.max_concurrent_per_owner,
              custom_instructions: currentConfig.custom_instructions,
              model_slug: currentConfig.model_slug,
              max_classification_time_minutes: currentConfig.max_classification_time_minutes,
              auto_create_pr_threshold: currentConfig.auto_create_pr_threshold,
              pr_branch_prefix: currentConfig.pr_branch_prefix,
              pr_title_template: currentConfig.pr_title_template,
              pr_body_template: currentConfig.pr_body_template,
              pr_base_branch: currentConfig.pr_base_branch,
              max_pr_creation_time_minutes: currentConfig.max_pr_creation_time_minutes,
            };
            await agentConfigUpserter({
              owner,
              agentType: 'auto_triage',
              platform: 'github',
              config: updatedConfig,
              createdBy: ctx.user.id,
            });
          }

          await agentEnabledSetter(owner, 'auto_triage', 'github', input.isEnabled);

          // Audit log (if provided)
          if (auditLogger) {
            await auditLogger({
              owner,
              ctx,
              message: `${input.isEnabled ? 'Enabled' : 'Disabled'} AI Auto Triage Agent`,
            });
          }

          return { success: true, isEnabled: input.isEnabled };
        } catch (error) {
          console.error('Error toggling auto-triage agent:', error);
          throw new TRPCError({
            code: 'INTERNAL_SERVER_ERROR',
            message: 'Failed to toggle auto-triage agent',
          });
        }
      },
    },

    /**
     * Retry a failed triage ticket
     * Resets status to pending and triggers dispatch
     */
    retryTicket: {
      inputSchema: z.object({
        ticketId: z.string().uuid(),
      }),
      handler: async ({ ctx, input }: { ctx: TRPCContext; input: { ticketId: string } }) => {
        try {
          // 1. Get ticket and verify ownership
          const ticket = await getTriageTicketById(input.ticketId);

          if (!ticket) {
            throw new TRPCError({
              code: 'NOT_FOUND',
              message: 'Ticket not found',
            });
          }

          // 2. Verify ticket belongs to owner
          const owner = await ownerResolver(ctx, input);
          if (!ticketOwnershipVerifier(ticket, owner)) {
            throw new TRPCError({
              code: 'FORBIDDEN',
              message: 'Ticket does not belong to this owner',
            });
          }

          // 3. Verify ticket is in failed or actioned state
          if (ticket.status !== 'failed' && ticket.status !== 'actioned') {
            throw new TRPCError({
              code: 'BAD_REQUEST',
              message: 'Only failed or actioned tickets can be retried',
            });
          }

          // 4. Reset ticket to pending
          await resetTriageTicketForRetry(input.ticketId);

          // 5. Trigger dispatch to process pending tickets
          await tryDispatchPendingTickets(owner);

          // 6. Audit log (if provided)
          if (auditLogger) {
            await auditLogger({
              owner,
              ctx,
              message: `Retried auto-triage ticket ${input.ticketId}`,
            });
          }

          return successResult({ ticketId: input.ticketId });
        } catch (error) {
          if (error instanceof TRPCError) throw error;

          console.error('Error retrying triage ticket:', error);
          throw new TRPCError({
            code: 'INTERNAL_SERVER_ERROR',
            message: 'Failed to retry triage ticket',
          });
        }
      },
    },

    /**
     * Interrupt a pending or analyzing triage ticket
     * Sets status to failed and frees the concurrency slot
     */
    interruptTicket: {
      inputSchema: z.object({
        ticketId: z.string().uuid(),
      }),
      handler: async ({ ctx, input }: { ctx: TRPCContext; input: { ticketId: string } }) => {
        try {
          // 1. Get ticket and verify ownership
          const ticket = await getTriageTicketById(input.ticketId);

          if (!ticket) {
            throw new TRPCError({
              code: 'NOT_FOUND',
              message: 'Ticket not found',
            });
          }

          // 2. Verify ticket belongs to owner
          const owner = await ownerResolver(ctx, input);
          if (!ticketOwnershipVerifier(ticket, owner)) {
            throw new TRPCError({
              code: 'FORBIDDEN',
              message: 'Ticket does not belong to this owner',
            });
          }

          // 3. Verify ticket is in pending or analyzing state
          if (ticket.status !== 'pending' && ticket.status !== 'analyzing') {
            throw new TRPCError({
              code: 'BAD_REQUEST',
              message: 'Only pending or analyzing tickets can be interrupted',
            });
          }

          // 4. Interrupt the ticket (status-guarded to avoid TOCTOU race)
          const wasInterrupted = await interruptTriageTicket(input.ticketId);

          if (!wasInterrupted) {
            // Ticket moved to a terminal state between our check and the update
            throw new TRPCError({
              code: 'CONFLICT',
              message: 'Ticket has already completed and cannot be interrupted',
            });
          }

          // 5. Dispatch pending tickets to free the concurrency slot
          await tryDispatchPendingTickets(owner);

          // 6. Audit log (if provided)
          if (auditLogger) {
            await auditLogger({
              owner,
              ctx,
              message: `Interrupted auto-triage ticket ${input.ticketId}`,
            });
          }

          return { success: true };
        } catch (error) {
          if (error instanceof TRPCError) throw error;

          console.error('Error interrupting triage ticket:', error);
          throw new TRPCError({
            code: 'INTERNAL_SERVER_ERROR',
            message: 'Failed to interrupt triage ticket',
          });
        }
      },
    },

    /**
     * List triage tickets
     */
    listTickets: {
      inputSchema: z.object({
        limit: z
          .number()
          .int()
          .positive()
          .max(AUTO_TRIAGE_CONSTANTS.MAX_PAGE_SIZE)
          .optional()
          .default(10),
        offset: z.number().int().nonnegative().optional().default(0),
        status: z.enum(['pending', 'analyzing', 'actioned', 'failed', 'skipped']).optional(),
        classification: z.enum(['bug', 'feature', 'question', 'duplicate', 'unclear']).optional(),
        repoFullName: z.string().optional(),
      }),
      handler: async ({
        ctx,
        input,
      }: {
        ctx: TRPCContext;
        input: {
          limit: number;
          offset: number;
          status?: 'pending' | 'analyzing' | 'actioned' | 'failed' | 'skipped';
          classification?: 'bug' | 'feature' | 'question' | 'duplicate' | 'unclear';
          repoFullName?: string;
        };
      }) => {
        try {
          const owner = await ownerResolver(ctx, input);

          const [tickets, total] = await Promise.all([
            listTriageTickets({
              owner,
              limit: input.limit,
              offset: input.offset,
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

          return successResult({
            tickets,
            total,
            hasMore: input.offset + tickets.length < total,
          });
        } catch (error) {
          return failureResult(
            error instanceof Error ? error.message : 'Failed to list triage tickets'
          );
        }
      },
    },
  };
}

export function wrapSharedHandlersInRouter(
  handlers: ReturnType<typeof createAutoTriageRouter>,
  procedure: typeof baseProcedure
) {
  return {
    getGitHubStatus: procedure.query(handlers.getGitHubStatus),
    listGitHubRepositories: procedure.query(handlers.listGitHubRepositories),
    getAutoTriageConfig: procedure.query(handlers.getAutoTriageConfig),
    saveAutoTriageConfig: procedure
      .input(handlers.saveAutoTriageConfig.inputSchema)
      .mutation(handlers.saveAutoTriageConfig.handler),
    toggleAutoTriageAgent: procedure
      .input(handlers.toggleAutoTriageAgent.inputSchema)
      .mutation(handlers.toggleAutoTriageAgent.handler),
    retryTicket: procedure
      .input(handlers.retryTicket.inputSchema)
      .mutation(handlers.retryTicket.handler),
    interruptTicket: procedure
      .input(handlers.interruptTicket.inputSchema)
      .mutation(handlers.interruptTicket.handler),
    listTickets: procedure
      .input(handlers.listTickets.inputSchema)
      .query(handlers.listTickets.handler),
  };
}
