import 'server-only';
import { createTRPCRouter } from '@/lib/trpc/init';
import {
  createCloudAgentNextClient,
  rethrowAsPaymentRequired,
} from '@/lib/cloud-agent-next/cloud-agent-client';
import { rethrowAsTerminalError } from '@/lib/cloud-agent-next/terminal-errors';
import { generateCloudAgentToken } from '@/lib/tokens';
import { isFeatureFlagEnabledOrDevelopment } from '@/lib/posthog-feature-flags';
import {
  organizationMemberProcedure,
  organizationMemberMutationProcedure,
} from '@/routers/organizations/utils';
import { fetchGitHubRepositoriesForOrganization } from '@/lib/cloud-agent/github-integration-helpers';
import {
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
  baseCreateTerminalNextSchema,
  baseCreateTerminalNextOutputSchema,
  baseRefreshTerminalTicketNextSchema,
  baseRefreshTerminalTicketNextOutputSchema,
  baseResizeTerminalNextSchema,
  baseResizeTerminalNextOutputSchema,
  baseCloseTerminalNextSchema,
  baseCloseTerminalNextOutputSchema,
  cloudAgentGetAttachmentUploadUrlSchema,
  cloudAgentGetImageUploadUrlSchema,
} from '../cloud-agent-next-schemas';
import {
  generateCloudAgentAttachmentUploadUrl,
  generateImageUploadUrl,
} from '@/lib/r2/cloud-agent-attachments';
import * as z from 'zod';
import { PLATFORM } from '@/lib/integrations/core/constants';
import { signStreamTicket } from '@/lib/cloud-agent/stream-ticket';
import { db } from '@/lib/drizzle';
import { verifyOrgOwnsSessionV2ByCloudAgentId } from '@/lib/cloud-agent/session-ownership';
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
  organizationId: string;
  cloudAgentSessionId: string;
  ptyId: string;
}) {
  const signed = signStreamTicket({
    purpose: 'terminal',
    userId: params.userId,
    cloudAgentSessionId: params.cloudAgentSessionId,
    organizationId: params.organizationId,
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

async function assertOrganizationOwnsTerminalSession(params: {
  organizationId: string;
  userId: string;
  cloudAgentSessionId: string;
}): Promise<void> {
  const sessionOwnership = await verifyOrgOwnsSessionV2ByCloudAgentId(
    db,
    params.organizationId,
    params.userId,
    params.cloudAgentSessionId
  );

  if (!sessionOwnership) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'Organization does not own this session',
    });
  }
}

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

const ImageUploadUrlInput = cloudAgentGetImageUploadUrlSchema.extend({
  organizationId: z.uuid(),
});

const AttachmentUploadUrlInput = cloudAgentGetAttachmentUploadUrlSchema.extend({
  organizationId: z.uuid(),
});

const GetSessionInput = baseGetSessionNextSchema.extend({
  organizationId: z.uuid(),
});

const CreateTerminalInput = baseCreateTerminalNextSchema.extend({
  organizationId: z.uuid(),
});

const RefreshTerminalTicketInput = baseRefreshTerminalTicketNextSchema.extend({
  organizationId: z.uuid(),
});

const ResizeTerminalInput = baseResizeTerminalNextSchema.extend({
  organizationId: z.uuid(),
});

const CloseTerminalInput = baseCloseTerminalNextSchema.extend({
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
      if (
        input.devcontainer &&
        !(await isFeatureFlagEnabledOrDevelopment('cloud-agent-devcontainer', input.organizationId))
      ) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'Dev container sessions are not available',
        });
      }

      const authToken = generateCloudAgentToken(ctx.user);
      const client = createCloudAgentNextClient(authToken);

      const { gitlabProject, githubRepo, organizationId, attachments, images, ...restInput } =
        input;

      // Profile resolution happens inside cloud-agent-next. Tokens are resolved
      // there as well via GIT_TOKEN_SERVICE. We forward profileId + inline
      // envVars/setupCommands/mcpServers overrides unchanged.
      let gitParams: {
        githubRepo?: string;
        gitUrl?: string;
        platform?: 'github' | 'gitlab';
      };

      if (gitlabProject) {
        const instanceUrl = await getGitLabInstanceUrlForOrganization(organizationId);
        const gitUrl = buildGitLabCloneUrl(gitlabProject, instanceUrl);
        gitParams = { gitUrl, platform: PLATFORM.GITLAB };
      } else {
        gitParams = { githubRepo, platform: PLATFORM.GITHUB };
      }

      try {
        return await client.prepareSession({
          ...restInput,
          ...gitParams,
          attachments: attachments ?? images,
          createdOnPlatform: 'cloud-agent-web',
          kilocodeOrganizationId: organizationId,
        });
      } catch (error) {
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

      // Tokens are refreshed inside cloud-agent-next (GitHub App installation
      // for GitHub, GIT_TOKEN_SERVICE for managed GitLab). organizationId is
      // consumed by the membership middleware; it is not forwarded.
      try {
        return await client.sendMessage({
          cloudAgentSessionId: input.cloudAgentSessionId,
          payload: input.payload,
          autoCommit: input.autoCommit,
          messageId: input.messageId ?? generateMessageId(),
          attachments: input.attachments ?? input.images,
        });
      } catch (error) {
        rethrowAsPaymentRequired(error);
        throw error;
      }
    }),

  createTerminal: organizationMemberMutationProcedure
    .input(CreateTerminalInput)
    .output(baseCreateTerminalNextOutputSchema)
    .mutation(async ({ ctx, input }) => {
      await assertOrganizationOwnsTerminalSession({
        organizationId: input.organizationId,
        userId: ctx.user.id,
        cloudAgentSessionId: input.cloudAgentSessionId,
      });

      try {
        const authToken = generateCloudAgentToken(ctx.user);
        const client = createCloudAgentNextClient(authToken);
        const result = await client.createTerminal({
          cloudAgentSessionId: input.cloudAgentSessionId,
          cols: input.cols,
          rows: input.rows,
        });
        const terminalTicket = createTerminalTicket({
          userId: ctx.user.id,
          organizationId: input.organizationId,
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

  refreshTerminalTicket: organizationMemberMutationProcedure
    .input(RefreshTerminalTicketInput)
    .output(baseRefreshTerminalTicketNextOutputSchema)
    .mutation(async ({ ctx, input }) => {
      await assertOrganizationOwnsTerminalSession({
        organizationId: input.organizationId,
        userId: ctx.user.id,
        cloudAgentSessionId: input.cloudAgentSessionId,
      });

      return createTerminalTicket({
        userId: ctx.user.id,
        organizationId: input.organizationId,
        cloudAgentSessionId: input.cloudAgentSessionId,
        ptyId: input.ptyId,
      });
    }),

  resizeTerminal: organizationMemberMutationProcedure
    .input(ResizeTerminalInput)
    .output(baseResizeTerminalNextOutputSchema)
    .mutation(async ({ ctx, input }) => {
      await assertOrganizationOwnsTerminalSession({
        organizationId: input.organizationId,
        userId: ctx.user.id,
        cloudAgentSessionId: input.cloudAgentSessionId,
      });

      try {
        const authToken = generateCloudAgentToken(ctx.user);
        const client = createCloudAgentNextClient(authToken);
        return await client.resizeTerminal({
          cloudAgentSessionId: input.cloudAgentSessionId,
          ptyId: input.ptyId,
          cols: input.cols,
          rows: input.rows,
        });
      } catch (error) {
        rethrowAsTerminalError(error);
      }
    }),

  closeTerminal: organizationMemberMutationProcedure
    .input(CloseTerminalInput)
    .output(baseCloseTerminalNextOutputSchema)
    .mutation(async ({ ctx, input }) => {
      await assertOrganizationOwnsTerminalSession({
        organizationId: input.organizationId,
        userId: ctx.user.id,
        cloudAgentSessionId: input.cloudAgentSessionId,
      });

      try {
        const authToken = generateCloudAgentToken(ctx.user);
        const client = createCloudAgentNextClient(authToken);
        return await client.closeTerminal({
          cloudAgentSessionId: input.cloudAgentSessionId,
          ptyId: input.ptyId,
        });
      } catch (error) {
        rethrowAsTerminalError(error);
      }
    }),

  /**
   * Generate a presigned URL for uploading an image attachment.
   */
  getImageUploadUrl: organizationMemberMutationProcedure
    .input(ImageUploadUrlInput)
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
   * Generate a presigned URL for uploading a canonical Cloud Agent attachment.
   */
  getAttachmentUploadUrl: organizationMemberMutationProcedure
    .input(AttachmentUploadUrlInput)
    .mutation(async ({ ctx, input }) => {
      return generateCloudAgentAttachmentUploadUrl({
        userId: ctx.user.id,
        messageUuid: input.messageUuid,
        attachmentId: input.attachmentId,
        contentType: input.contentType,
        contentLength: input.contentLength,
      });
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
