import 'server-only';
import { TRPCError } from '@trpc/server';
import { baseProcedure, createTRPCRouter } from '@/lib/trpc/init';
import {
  createCloudAgentNextClient,
  rethrowAsPaymentRequired,
} from '@/lib/cloud-agent-next/cloud-agent-client';
import { generateCloudAgentToken } from '@/lib/tokens';
import {
  mergeProfileConfiguration,
  ProfileNotFoundError,
} from '@/lib/agent/profile-session-config';
import { fetchGitHubRepositoriesForUser } from '@/lib/cloud-agent/github-integration-helpers';
import {
  getGitLabInstanceUrlForUser,
  buildGitLabCloneUrl,
  fetchGitLabRepositoriesForUser,
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
  cloudAgentGetImageUploadUrlSchema,
} from './cloud-agent-next-schemas';
import { generateImageUploadUrl } from '@/lib/r2/cloud-agent-attachments';
import * as z from 'zod';
import { PLATFORM } from '@/lib/integrations/core/constants';

/**
 * Cloud Agent Next Router (Personal Context)
 *
 * This router provides endpoints for the new cloud-agent-next worker that uses:
 * - V2 WebSocket-based API (no SSE streaming)
 * - New message format (Message + Part[])
 * - New modes ('plan' | 'build')
 *
 * All mutations return immediately with execution info; streaming is handled
 * separately via WebSocket connection.
 */
export const cloudAgentNextRouter = createTRPCRouter({
  /**
   * Prepare a new cloud agent session.
   *
   * Creates the DB record and cloud-agent-next DO entry in one call.
   * The session is in "prepared" state and can be initiated via
   * initiateFromPreparedSession.
   */
  prepareSession: baseProcedure
    .input(basePrepareSessionNextSchema)
    .output(basePrepareSessionNextOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const authToken = generateCloudAgentToken(ctx.user);
      const client = createCloudAgentNextClient(authToken);

      const { envVars, setupCommands, profileName, gitlabProject, githubRepo, ...restInput } =
        input;

      try {
        const repoFullName = githubRepo ?? gitlabProject;
        const platform = gitlabProject ? PLATFORM.GITLAB : PLATFORM.GITHUB;

        const merged = await mergeProfileConfiguration({
          profileName,
          owner: { type: 'user', id: ctx.user.id },
          repoFullName,
          platform,
          envVars,
          setupCommands,
        });

        // Determine git source: GitLab uses gitUrl, GitHub uses githubRepo.
        // Tokens are resolved inside cloud-agent-next via GIT_TOKEN_SERVICE.
        let gitParams: {
          githubRepo?: string;
          gitUrl?: string;
          platform?: 'github' | 'gitlab';
        };

        if (gitlabProject) {
          const instanceUrl = await getGitLabInstanceUrlForUser(ctx.user.id);
          const gitUrl = buildGitLabCloneUrl(gitlabProject, instanceUrl);
          gitParams = { gitUrl, platform: PLATFORM.GITLAB };
        } else {
          gitParams = { githubRepo, platform: PLATFORM.GITHUB };
        }

        const result = await client.prepareSession({
          ...restInput,
          ...gitParams,
          createdOnPlatform: 'cloud-agent-web',
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
   * Initiate a prepared session (V2 - WebSocket-based).
   *
   * Returns immediately with execution info and WebSocket URL for streaming.
   * The client connects to the streamUrl separately to receive events.
   */
  initiateFromPreparedSession: baseProcedure
    .input(baseInitiateFromPreparedSessionNextSchema)
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
        });
      } catch (error) {
        rethrowAsPaymentRequired(error);
        throw error;
      }
    }),

  /**
   * Send a message to an existing session (V2 - WebSocket-based).
   *
   * Returns immediately with execution info and WebSocket URL for streaming.
   * The client connects to the streamUrl separately to receive events.
   */
  sendMessage: baseProcedure
    .input(baseSendMessageNextSchema)
    .output(baseInitiateSessionNextOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const authToken = generateCloudAgentToken(ctx.user);
      const client = createCloudAgentNextClient(authToken);

      // Tokens are refreshed inside cloud-agent-next (GitHub App installation
      // for GitHub, GIT_TOKEN_SERVICE for managed GitLab).
      try {
        return await client.sendMessage(input);
      } catch (error) {
        rethrowAsPaymentRequired(error);
        throw error;
      }
    }),

  /**
   * Generate a presigned URL for uploading an image attachment.
   */
  getImageUploadUrl: baseProcedure
    .input(cloudAgentGetImageUploadUrlSchema)
    .mutation(async ({ ctx, input }) => {
      return generateImageUploadUrl({
        service: 'cloud-agent',
        userId: ctx.user.id,
        messageUuid: input.messageUuid,
        imageId: input.imageId,
        contentType: input.contentType,
        contentLength: input.contentLength,
      });
    }),

  /**
   * Interrupt a running session by killing all associated processes.
   */
  interruptSession: baseProcedure
    .input(baseInterruptSessionNextSchema)
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

  answerQuestion: baseProcedure
    .input(baseAnswerQuestionNextSchema)
    .output(z.object({ success: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      const authToken = generateCloudAgentToken(ctx.user);
      const client = createCloudAgentNextClient(authToken);
      return await client.answerQuestion(input);
    }),

  rejectQuestion: baseProcedure
    .input(baseRejectQuestionNextSchema)
    .output(z.object({ success: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      const authToken = generateCloudAgentToken(ctx.user);
      const client = createCloudAgentNextClient(authToken);
      return await client.rejectQuestion(input);
    }),

  answerPermission: baseProcedure
    .input(baseAnswerPermissionNextSchema)
    .output(z.object({ success: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      const authToken = generateCloudAgentToken(ctx.user);
      const client = createCloudAgentNextClient(authToken);
      return await client.answerPermission(input);
    }),

  /**
   * Get session state from cloud-agent-next DO.
   * Returns sanitized session info (no secrets).
   */
  getSession: baseProcedure
    .input(baseGetSessionNextSchema)
    .output(baseGetSessionNextOutputSchema)
    .query(async ({ ctx, input }) => {
      const authToken = generateCloudAgentToken(ctx.user);
      const client = createCloudAgentNextClient(authToken);

      return await client.getSession(input.cloudAgentSessionId);
    }),

  /**
   * List GitHub repositories available for cloud agent sessions.
   */
  listGitHubRepositories: baseProcedure
    .input(
      z.object({
        forceRefresh: z.boolean().optional().default(false),
      })
    )
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
    .query(async ({ ctx, input }) => {
      const result = await fetchGitHubRepositoriesForUser(ctx.user.id, input.forceRefresh);
      return {
        repositories: result.repositories,
        integrationInstalled: result.integrationInstalled,
        syncedAt: result.syncedAt,
        errorMessage: result.errorMessage,
      };
    }),

  /**
   * List GitLab repositories available for cloud agent sessions.
   */
  listGitLabRepositories: baseProcedure
    .input(
      z.object({
        forceRefresh: z.boolean().optional().default(false),
      })
    )
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
    .query(async ({ ctx, input }) => {
      const result = await fetchGitLabRepositoriesForUser(ctx.user.id, input.forceRefresh);
      return {
        repositories: result.repositories,
        integrationInstalled: result.integrationInstalled,
        syncedAt: result.syncedAt,
        errorMessage: result.errorMessage,
      };
    }),
});
