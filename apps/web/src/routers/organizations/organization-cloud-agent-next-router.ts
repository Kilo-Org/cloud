import 'server-only';
import { TRPCError } from '@trpc/server';
import { createTRPCRouter } from '@/lib/trpc/init';
import {
  createCloudAgentNextClient,
  rethrowAsPaymentRequired,
} from '@/lib/cloud-agent-next/cloud-agent-client';
import { generateCloudAgentToken } from '@/lib/tokens';
import {
  mergeProfileConfiguration,
  ProfileNotFoundError,
} from '@/lib/agent/profile-session-config';
import {
  organizationMemberProcedure,
  organizationMemberMutationProcedure,
} from '@/routers/organizations/utils';
import {
  getGitHubTokenForOrganization,
  fetchGitHubRepositoriesForOrganization,
} from '@/lib/cloud-agent/github-integration-helpers';
import {
  getGitLabTokenForOrganization,
  getGitLabInstanceUrlForOrganization,
  buildGitLabCloneUrl,
  fetchGitLabRepositoriesForOrganization,
} from '@/lib/cloud-agent/gitlab-integration-helpers';
import {
  basePrepareSessionNextSchema,
  basePrepareSessionNextOutputSchema,
  baseInitiateFromPreparedSessionNextSchema,
  baseInitiateSessionNextOutputSchema,
  baseSendMessageNextSchema,
  baseInterruptSessionNextSchema,
  baseGetSessionNextSchema,
  baseGetSessionNextOutputSchema,
  baseAnswerQuestionNextSchema,
  baseRejectQuestionNextSchema,
  baseAnswerPermissionNextSchema,
} from '../cloud-agent-next-schemas';
import * as z from 'zod';
import { PLATFORM } from '@/lib/integrations/core/constants';

// Extend base schemas with organizationId for organization context
const PrepareSessionInput = basePrepareSessionNextSchema.and(
  z.object({
    organizationId: z.uuid(),
  })
);

const InitiateFromPreparedSessionInput = baseInitiateFromPreparedSessionNextSchema.extend({
  organizationId: z.uuid(),
});

const SendMessageInput = baseSendMessageNextSchema.extend({
  organizationId: z.uuid(),
});

const InterruptSessionInput = baseInterruptSessionNextSchema.extend({
  organizationId: z.uuid(),
});

const GetSessionInput = baseGetSessionNextSchema.extend({
  organizationId: z.uuid(),
});

const AnswerQuestionInput = baseAnswerQuestionNextSchema.extend({
  organizationId: z.uuid(),
});

const RejectQuestionInput = baseRejectQuestionNextSchema.extend({
  organizationId: z.uuid(),
});

const AnswerPermissionInput = baseAnswerPermissionNextSchema.extend({
  organizationId: z.uuid(),
});

const ListGitHubRepositoriesInput = z.object({
  organizationId: z.uuid(),
  forceRefresh: z.boolean().optional().default(false),
});

const ListGitLabRepositoriesInput = z.object({
  organizationId: z.uuid(),
  forceRefresh: z.boolean().optional().default(false),
});

/**
 * Cloud Agent Next Router (Organization Context)
 *
 * This router provides endpoints for the new cloud-agent-next worker that uses:
 * - V2 WebSocket-based API (no SSE streaming)
 * - New message format (Message + Part[])
 * - New modes ('plan' | 'build')
 *
 * All mutations return immediately with execution info; streaming is handled
 * separately via WebSocket connection.
 */
export const organizationCloudAgentNextRouter = createTRPCRouter({
  /**
   * Prepare a new cloud agent session (organization context).
   *
   * Creates the DB record and cloud-agent-next DO entry in one call.
   * The session is in "prepared" state and can be initiated via
   * initiateFromPreparedSession.
   */
  prepareSession: organizationMemberMutationProcedure
    .input(PrepareSessionInput)
    .output(basePrepareSessionNextOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const authToken = generateCloudAgentToken(ctx.user);
      const client = createCloudAgentNextClient(authToken);

      const {
        envVars,
        setupCommands,
        profileName,
        gitlabProject,
        githubRepo,
        organizationId,
        ...restInput
      } = input;

      try {
        const repoFullName = githubRepo ?? gitlabProject;
        const platform = gitlabProject ? PLATFORM.GITLAB : PLATFORM.GITHUB;

        const merged = await mergeProfileConfiguration({
          profileName,
          owner: { type: 'organization', id: organizationId },
          userId: ctx.user.id,
          repoFullName,
          platform,
          envVars,
          setupCommands,
        });

        // Determine git source: GitLab uses gitUrl/gitToken, GitHub uses githubRepo
        let gitParams: {
          githubRepo?: string;
          gitUrl?: string;
          gitToken?: string;
          platform?: 'github' | 'gitlab';
        };

        if (gitlabProject) {
          // GitLab flow: convert gitlabProject to gitUrl + gitToken
          const gitToken = await getGitLabTokenForOrganization(organizationId);
          if (!gitToken) {
            throw new TRPCError({
              code: 'BAD_REQUEST',
              message: 'No GitLab integration found. Please connect your GitLab account first.',
            });
          }
          const instanceUrl = await getGitLabInstanceUrlForOrganization(organizationId);
          const gitUrl = buildGitLabCloneUrl(gitlabProject, instanceUrl);
          gitParams = { gitUrl, gitToken, platform: PLATFORM.GITLAB };
        } else {
          // GitHub flow: use githubRepo (token will be fetched in cloud-agent-next)
          gitParams = { githubRepo, platform: PLATFORM.GITHUB };
        }

        const result = await client.prepareSession({
          ...restInput,
          ...gitParams,
          createdOnPlatform: 'cloud-agent-web',
          kilocodeOrganizationId: organizationId,
          envVars: merged.envVars,
          encryptedSecrets: merged.encryptedSecrets,
          setupCommands: merged.setupCommands,
        });

        return result;
      } catch (error) {
        if (error instanceof ProfileNotFoundError) {
          throw new TRPCError({ code: 'NOT_FOUND', message: error.message });
        }
        rethrowAsPaymentRequired(error);
        throw error;
      }
    }),

  /**
   * Initiate a prepared session (V2 - WebSocket-based, organization context).
   *
   * Returns immediately with execution info and WebSocket URL for streaming.
   * The client connects to the streamUrl separately to receive events.
   */
  initiateFromPreparedSession: organizationMemberMutationProcedure
    .input(InitiateFromPreparedSessionInput)
    .output(baseInitiateSessionNextOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const authToken = generateCloudAgentToken(ctx.user);
      const client = createCloudAgentNextClient(authToken);

      // No token fetch needed: prepare and initiate happen back-to-back,
      // so tokens stored during prepareSession are still fresh.
      // The DO refreshes GitHub App installation tokens internally.
      try {
        return await client.initiateFromPreparedSession({
          cloudAgentSessionId: input.cloudAgentSessionId,
          kilocodeOrganizationId: input.organizationId,
        });
      } catch (error) {
        rethrowAsPaymentRequired(error);
        throw error;
      }
    }),

  /**
   * Send a message to an existing session (V2 - WebSocket-based, organization context).
   *
   * Returns immediately with execution info and WebSocket URL for streaming.
   * The client connects to the streamUrl separately to receive events.
   */
  sendMessage: organizationMemberMutationProcedure
    .input(SendMessageInput)
    .output(baseInitiateSessionNextOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const authToken = generateCloudAgentToken(ctx.user);
      const client = createCloudAgentNextClient(authToken);

      const { organizationId, ...messageInput } = input;

      // Determine platform to fetch the correct token
      const session = await client.getSession(messageInput.cloudAgentSessionId);
      let githubToken: string | undefined;
      let gitToken: string | undefined;

      if (session.platform === 'gitlab') {
        gitToken = await getGitLabTokenForOrganization(organizationId);
        if (!gitToken) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'No GitLab integration found. Please connect your GitLab account first.',
          });
        }
      } else {
        githubToken = await getGitHubTokenForOrganization(organizationId);
      }

      try {
        return await client.sendMessage({
          ...messageInput,
          githubToken,
          gitToken,
        });
      } catch (error) {
        rethrowAsPaymentRequired(error);
        throw error;
      }
    }),

  /**
   * Interrupt a running session by killing all associated processes (organization context).
   */
  interruptSession: organizationMemberMutationProcedure
    .input(InterruptSessionInput)
    .output(
      z.object({
        success: z.boolean(),
        message: z.string(),
        processesFound: z.boolean(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const authToken = generateCloudAgentToken(ctx.user);
      const client = createCloudAgentNextClient(authToken);

      return await client.interruptSession(input.sessionId);
    }),

  answerQuestion: organizationMemberMutationProcedure
    .input(AnswerQuestionInput)
    .output(z.object({ success: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      const authToken = generateCloudAgentToken(ctx.user);
      const client = createCloudAgentNextClient(authToken);
      return await client.answerQuestion({
        sessionId: input.sessionId,
        questionId: input.questionId,
        answers: input.answers,
      });
    }),

  rejectQuestion: organizationMemberMutationProcedure
    .input(RejectQuestionInput)
    .output(z.object({ success: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      const authToken = generateCloudAgentToken(ctx.user);
      const client = createCloudAgentNextClient(authToken);
      return await client.rejectQuestion({
        sessionId: input.sessionId,
        questionId: input.questionId,
      });
    }),

  answerPermission: organizationMemberMutationProcedure
    .input(AnswerPermissionInput)
    .output(z.object({ success: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      const authToken = generateCloudAgentToken(ctx.user);
      const client = createCloudAgentNextClient(authToken);
      return await client.answerPermission({
        sessionId: input.sessionId,
        permissionId: input.permissionId,
        response: input.response,
      });
    }),

  /**
   * Get session state from cloud-agent-next DO (organization context).
   * Returns sanitized session info (no secrets).
   */
  getSession: organizationMemberProcedure
    .input(GetSessionInput)
    .output(baseGetSessionNextOutputSchema)
    .query(async ({ ctx, input }) => {
      const authToken = generateCloudAgentToken(ctx.user);
      const client = createCloudAgentNextClient(authToken);

      return await client.getSession(input.cloudAgentSessionId);
    }),

  /**
   * List GitHub repositories available for cloud agent sessions (organization context).
   */
  listGitHubRepositories: organizationMemberProcedure
    .input(ListGitHubRepositoriesInput)
    .output(
      z.object({
        repositories: z.array(
          z.object({
            id: z.number(),
            name: z.string(),
            fullName: z.string(),
            private: z.boolean(),
            defaultBranch: z.string().optional(),
          })
        ),
        integrationInstalled: z.boolean(),
        syncedAt: z.string().nullish(),
        errorMessage: z.string().optional(),
      })
    )
    .query(async ({ ctx: _ctx, input }) => {
      const result = await fetchGitHubRepositoriesForOrganization(
        input.organizationId,
        input.forceRefresh
      );
      return {
        repositories: result.repositories,
        integrationInstalled: result.integrationInstalled,
        syncedAt: result.syncedAt,
        errorMessage: result.errorMessage,
      };
    }),

  /**
   * List GitLab repositories available for cloud agent sessions (organization context).
   */
  listGitLabRepositories: organizationMemberProcedure
    .input(ListGitLabRepositoriesInput)
    .output(
      z.object({
        repositories: z.array(
          z.object({
            id: z.number(),
            name: z.string(),
            fullName: z.string(),
            private: z.boolean(),
          })
        ),
        integrationInstalled: z.boolean(),
        syncedAt: z.string().nullish(),
        errorMessage: z.string().optional(),
      })
    )
    .query(async ({ ctx: _ctx, input }) => {
      const result = await fetchGitLabRepositoriesForOrganization(
        input.organizationId,
        input.forceRefresh
      );
      return {
        repositories: result.repositories,
        integrationInstalled: result.integrationInstalled,
        syncedAt: result.syncedAt,
        errorMessage: result.errorMessage,
      };
    }),
});
