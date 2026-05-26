import 'server-only';
import { baseProcedure, createTRPCRouter } from '@/lib/trpc/init';
import {
  createCloudAgentNextClient,
  rethrowAsPaymentRequired,
} from '@/lib/cloud-agent-next/cloud-agent-client';
import { rethrowAsTerminalError } from '@/lib/cloud-agent-next/terminal-errors';
import { generateCloudAgentToken } from '@/lib/tokens';
import { isFeatureFlagEnabledOrDevelopment } from '@/lib/posthog-feature-flags';
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
  baseCreateTerminalNextSchema,
  baseCreateTerminalNextOutputSchema,
  baseRefreshTerminalTicketNextSchema,
  baseRefreshTerminalTicketNextOutputSchema,
  baseResizeTerminalNextSchema,
  baseResizeTerminalNextOutputSchema,
  baseCloseTerminalNextSchema,
  baseCloseTerminalNextOutputSchema,
  cloudAgentGetImageUploadUrlSchema,
} from './cloud-agent-next-schemas';
import { generateImageUploadUrl } from '@/lib/r2/cloud-agent-attachments';
import * as z from 'zod';
import { PLATFORM } from '@/lib/integrations/core/constants';
import { signStreamTicket } from '@/lib/cloud-agent/stream-ticket';
import { db } from '@/lib/drizzle';
import { verifyUserOwnsSessionV2ByCloudAgentId } from '@/lib/cloud-agent/session-ownership';
import { TRPCError } from '@trpc/server';
import { generateMessageId } from '@/lib/cloud-agent-sdk/message-id';

function buildTerminalUrl(params: {
  cloudAgentSessionId: string;
  ptyId: string;
  ticket: string;
}): string {
  const search = new URLSearchParams({
    cloudAgentSessionId: params.cloudAgentSessionId,
    ptyId: params.ptyId,
    ticket: params.ticket,
  });
  return `/terminal?${search.toString()}`;
}

function createTerminalTicket(params: {
  userId: string;
  cloudAgentSessionId: string;
  ptyId: string;
}) {
  const signed = signStreamTicket({
    purpose: 'terminal',
    userId: params.userId,
    cloudAgentSessionId: params.cloudAgentSessionId,
    ptyId: params.ptyId,
  });

  return {
    wsUrl: buildTerminalUrl({
      cloudAgentSessionId: params.cloudAgentSessionId,
      ptyId: params.ptyId,
      ticket: signed.ticket,
    }),
    ticket: signed.ticket,
    expiresAt: signed.expiresAt,
  };
}

async function assertUserOwnsTerminalSession(
  userId: string,
  cloudAgentSessionId: string
): Promise<void> {
  const sessionOwnership = await verifyUserOwnsSessionV2ByCloudAgentId(
    db,
    userId,
    cloudAgentSessionId
  );

  if (!sessionOwnership) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'Session not found or access denied',
    });
  }
}

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
      if (
        input.devcontainer &&
        !(await isFeatureFlagEnabledOrDevelopment('cloud-agent-devcontainer', ctx.user.id))
      ) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'Dev container sessions are not available',
        });
      }

      const authToken = generateCloudAgentToken(ctx.user);
      const client = createCloudAgentNextClient(authToken);

      const { gitlabProject, githubRepo, ...restInput } = input;

      // Determine git source: GitLab uses gitUrl, GitHub uses githubRepo.
      // Tokens are resolved inside cloud-agent-next via GIT_TOKEN_SERVICE.
      // Profile resolution (repo binding + default + explicit override) also
      // happens in cloud-agent-next; we just forward profileId and any inline
      // envVars/setupCommands/mcpServers overrides.
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

      try {
        return await client.prepareSession({
          ...restInput,
          ...gitParams,
          createdOnPlatform: 'cloud-agent-web',
        });
      } catch (error) {
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
        return await client.sendMessage({
          ...input,
          messageId: input.messageId ?? generateMessageId(),
        });
      } catch (error) {
        rethrowAsPaymentRequired(error);
        throw error;
      }
    }),

  createTerminal: baseProcedure
    .input(baseCreateTerminalNextSchema)
    .output(baseCreateTerminalNextOutputSchema)
    .mutation(async ({ ctx, input }) => {
      await assertUserOwnsTerminalSession(ctx.user.id, input.cloudAgentSessionId);

      try {
        const authToken = generateCloudAgentToken(ctx.user);
        const client = createCloudAgentNextClient(authToken);
        const result = await client.createTerminal(input);
        const terminalTicket = createTerminalTicket({
          userId: ctx.user.id,
          cloudAgentSessionId: input.cloudAgentSessionId,
          ptyId: result.pty.id,
        });

        return {
          pty: result.pty,
          ptyId: result.pty.id,
          ...terminalTicket,
        };
      } catch (error) {
        rethrowAsTerminalError(error);
      }
    }),

  refreshTerminalTicket: baseProcedure
    .input(baseRefreshTerminalTicketNextSchema)
    .output(baseRefreshTerminalTicketNextOutputSchema)
    .mutation(async ({ ctx, input }) => {
      await assertUserOwnsTerminalSession(ctx.user.id, input.cloudAgentSessionId);

      return createTerminalTicket({
        userId: ctx.user.id,
        cloudAgentSessionId: input.cloudAgentSessionId,
        ptyId: input.ptyId,
      });
    }),

  resizeTerminal: baseProcedure
    .input(baseResizeTerminalNextSchema)
    .output(baseResizeTerminalNextOutputSchema)
    .mutation(async ({ ctx, input }) => {
      await assertUserOwnsTerminalSession(ctx.user.id, input.cloudAgentSessionId);

      try {
        const authToken = generateCloudAgentToken(ctx.user);
        const client = createCloudAgentNextClient(authToken);
        return await client.resizeTerminal(input);
      } catch (error) {
        rethrowAsTerminalError(error);
      }
    }),

  closeTerminal: baseProcedure
    .input(baseCloseTerminalNextSchema)
    .output(baseCloseTerminalNextOutputSchema)
    .mutation(async ({ ctx, input }) => {
      await assertUserOwnsTerminalSession(ctx.user.id, input.cloudAgentSessionId);

      try {
        const authToken = generateCloudAgentToken(ctx.user);
        const client = createCloudAgentNextClient(authToken);
        return await client.closeTerminal(input);
      } catch (error) {
        rethrowAsTerminalError(error);
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
