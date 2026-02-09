import 'server-only';
import { TRPCError } from '@trpc/server';
import { createTRPCRouter } from '@/lib/trpc/init';
import {
  createCloudChatClient,
  rethrowAsPaymentRequired,
} from '@/lib/cloud-agent/cloud-agent-client';
import * as z from 'zod';
import { generateApiToken } from '@/lib/tokens';
import {
  mergeProfileConfiguration,
  ProfileNotFoundError,
} from '@/lib/agent/profile-session-config';
import { organizationMemberProcedure } from '@/routers/organizations/utils';
import {
  getGitHubTokenForOrganization,
  fetchGitHubRepositoriesForOrganization,
} from '@/lib/cloud-agent/github-integration-helpers';
import {
  fetchGitLabRepositoriesForOrganization,
  getGitLabTokenForOrganization,
  getGitLabInstanceUrlForOrganization,
  buildGitLabCloneUrl,
} from '@/lib/cloud-agent/gitlab-integration-helpers';
import {
  baseInitiateSessionSchema,
  baseSendMessageSchema,
  baseSendMessageV2Schema,
  baseInterruptSessionSchema,
  baseGetSessionSchema,
  baseGetSessionOutputSchema,
  basePrepareSessionSchema,
  basePrepareSessionOutputSchema,
  basePrepareLegacySessionSchema,
  basePrepareLegacySessionOutputSchema,
  isPreparedSessionInput,
} from '../cloud-agent-schemas';
import { getBalanceForOrganizationUser } from '@/lib/organizations/organization-usage';
import { db } from '@/lib/drizzle';
import { cliSessions } from '@/db/schema';
import { eq, and } from 'drizzle-orm';
import { deleteBlobs, type FileName } from '@/lib/r2/cli-sessions';

/** Minimum balance required to use Cloud Agent (in dollars) */
const MIN_BALANCE_DOLLARS = 1;

// Extend base schemas with organizationId for organization context
const InitiateSessionInput = baseInitiateSessionSchema.extend({
  organizationId: z.uuid(),
});

const SendMessageInput = baseSendMessageSchema.extend({
  organizationId: z.uuid(),
});

const SendMessageV2Input = baseSendMessageV2Schema.extend({
  organizationId: z.uuid(),
});

const InterruptSessionInput = baseInterruptSessionSchema.extend({
  organizationId: z.uuid(),
});

// For organization context, we need to handle both legacy and new modes
// Legacy: { kiloSessionId, githubRepo, prompt, mode, model, ... }
// New: { cloudAgentSessionId }
const InitiateFromKilocodeSessionLegacyInput = z.object({
  organizationId: z.uuid(),
  kiloSessionId: z.string().uuid(),
  githubRepo: z.string().regex(/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/, 'Invalid repository format'),
  prompt: z.string().min(1),
  mode: z.enum(['architect', 'code', 'ask', 'debug', 'orchestrator']),
  model: z.string().min(1),
  envVars: z.record(z.string().max(256), z.string().max(256)).optional(),
  setupCommands: z.array(z.string().max(500)).max(20).optional(),
  autoCommit: z.boolean().optional().default(false),
});

const InitiateFromPreparedSessionInput = z.object({
  organizationId: z.uuid(),
  cloudAgentSessionId: z.string(),
});

const InitiateFromKilocodeSessionInput = z.union([
  InitiateFromPreparedSessionInput,
  InitiateFromKilocodeSessionLegacyInput,
]);

const ListGitHubRepositoriesInput = z.object({
  organizationId: z.uuid(),
  forceRefresh: z.boolean().optional().default(false),
});

const ListGitLabRepositoriesInput = z.object({
  organizationId: z.uuid(),
  forceRefresh: z.boolean().optional().default(false),
});

const GetSessionInput = baseGetSessionSchema.extend({
  organizationId: z.uuid(),
});

const PrepareSessionInput = basePrepareSessionSchema.extend({
  organizationId: z.uuid(),
});

const PrepareLegacySessionInput = basePrepareLegacySessionSchema.extend({
  organizationId: z.uuid(),
});

export const organizationCloudAgentRouter = createTRPCRouter({
  /**
   * Initiate a new cloud agent session with streaming output (organization context)
   */
  initiateSessionStream: organizationMemberProcedure
    .input(InitiateSessionInput)
    .subscription(async function* ({ ctx, input }) {
      const authToken = generateApiToken(ctx.user);
      const githubToken = await getGitHubTokenForOrganization(input.organizationId);
      const client = createCloudChatClient(authToken);

      const { organizationId, ...restInput } = input;
      try {
        for await (const event of client.initiateSessionStream({
          ...restInput,
          kilocodeOrganizationId: organizationId,
          githubToken,
        })) {
          yield event;
        }
      } catch (error) {
        rethrowAsPaymentRequired(error);
      }
    }),

  /**
   * Initiate a cloud agent session from an existing Kilocode CLI session with streaming output (organization context)
   *
   * Supports two modes:
   * - Legacy: { kiloSessionId, githubRepo, prompt, mode, model, ... } for CLI sessions
   * - New: { cloudAgentSessionId } for prepared sessions (after prepareSession)
   */
  initiateFromKilocodeSessionStream: organizationMemberProcedure
    .input(InitiateFromKilocodeSessionInput)
    .subscription(async function* ({ ctx, input }) {
      const authToken = generateApiToken(ctx.user);
      const githubToken = await getGitHubTokenForOrganization(input.organizationId);
      const client = createCloudChatClient(authToken);

      try {
        // Validate that only one mode's fields are present and detect which mode we're in
        if (isPreparedSessionInput(input)) {
          // Used when resuming a prepared session with cloudAgentSessionId only
          for await (const event of client.initiateFromKilocodeSession({
            cloudAgentSessionId: input.cloudAgentSessionId,
            kilocodeOrganizationId: input.organizationId,
            githubToken,
          })) {
            yield event;
          }
        } else {
          // Used when resuming from a non-cloud session
          const { organizationId, ...restInput } = input;
          for await (const event of client.initiateFromKilocodeSession({
            ...restInput,
            kilocodeOrganizationId: organizationId,
            githubToken,
          })) {
            yield event;
          }
        }
      } catch (error) {
        rethrowAsPaymentRequired(error);
      }
    }),

  /**
   * Prepare a new cloud agent session (organization context).
   *
   * This creates the cliSession in backend and cloud-agent DO entry in one call.
   * The session is in "prepared" state and can be initiated via
   * initiateFromKilocodeSessionStream with just the cloudAgentSessionId.
   */
  prepareSession: organizationMemberProcedure
    .input(PrepareSessionInput)
    .output(basePrepareSessionOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const authToken = generateApiToken(ctx.user);
      const client = createCloudChatClient(authToken);

      const {
        organizationId,
        envVars,
        setupCommands,
        profileName,
        gitlabProject,
        githubRepo,
        ...restInput
      } = input;

      try {
        const merged = await mergeProfileConfiguration({
          profileName,
          owner: { type: 'organization', id: organizationId },
          userId: ctx.user.id,
          envVars,
          setupCommands,
        });

        // Determine git source: GitLab uses gitUrl/gitToken, GitHub uses githubRepo/githubToken
        let gitParams: {
          githubRepo?: string;
          githubToken?: string;
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
          gitParams = { gitUrl, gitToken, platform: 'gitlab' };
        } else {
          // GitHub flow: use githubRepo + githubToken
          const githubToken = await getGitHubTokenForOrganization(organizationId);
          gitParams = { githubRepo, githubToken, platform: 'github' };
        }

        return await client.prepareSession({
          ...restInput,
          ...gitParams,
          envVars: merged.envVars,
          encryptedSecrets: merged.encryptedSecrets,
          setupCommands: merged.setupCommands,
          kilocodeOrganizationId: organizationId,
        });
      } catch (error) {
        if (error instanceof ProfileNotFoundError) {
          throw new TRPCError({ code: 'NOT_FOUND', message: error.message });
        }
        throw error;
      }
    }),

  /**
   * Prepare an legacy cloud agent session (organization context).
   *
   * Stores session params in the DO without creating a new cliSession.
   */
  prepareLegacySession: organizationMemberProcedure
    .input(PrepareLegacySessionInput)
    .output(basePrepareLegacySessionOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const authToken = generateApiToken(ctx.user);
      const client = createCloudChatClient(authToken);

      const {
        organizationId,
        envVars,
        setupCommands,
        profileName,
        gitlabProject,
        githubRepo,
        ...restInput
      } = input;

      try {
        const merged = await mergeProfileConfiguration({
          profileName,
          owner: { type: 'organization', id: organizationId },
          userId: ctx.user.id,
          envVars,
          setupCommands,
        });

        let gitParams: {
          githubRepo?: string;
          githubToken?: string;
          gitUrl?: string;
          gitToken?: string;
          platform?: 'github' | 'gitlab';
        };

        if (gitlabProject) {
          const gitToken = await getGitLabTokenForOrganization(organizationId);
          if (!gitToken) {
            throw new TRPCError({
              code: 'BAD_REQUEST',
              message: 'No GitLab integration found. Please connect your GitLab account first.',
            });
          }
          const instanceUrl = await getGitLabInstanceUrlForOrganization(organizationId);
          const gitUrl = buildGitLabCloneUrl(gitlabProject, instanceUrl);
          gitParams = { gitUrl, gitToken, platform: 'gitlab' };
        } else {
          const githubToken = await getGitHubTokenForOrganization(organizationId);
          gitParams = { githubRepo, githubToken, platform: 'github' };
        }

        return await client.prepareLegacySession({
          ...restInput,
          ...gitParams,
          envVars: merged.envVars,
          encryptedSecrets: merged.encryptedSecrets,
          setupCommands: merged.setupCommands,
          kilocodeOrganizationId: organizationId,
        });
      } catch (error) {
        if (error instanceof ProfileNotFoundError) {
          throw new TRPCError({ code: 'NOT_FOUND', message: error.message });
        }
        throw error;
      }
    }),

  /**
   * Send a message to an existing session with streaming output
   */
  sendMessageStream: organizationMemberProcedure
    .input(SendMessageInput)
    .subscription(async function* ({ ctx, input }) {
      const authToken = generateApiToken(ctx.user);
      const githubToken = await getGitHubTokenForOrganization(input.organizationId);
      const client = createCloudChatClient(authToken);

      try {
        for await (const event of client.sendMessageStream({
          ...input,
          githubToken,
        })) {
          yield event;
        }
      } catch (error) {
        rethrowAsPaymentRequired(error);
      }
    }),

  /**
   * List GitHub repositories accessible by the organization's GitHub integration
   */
  listGitHubRepositories: organizationMemberProcedure
    .input(ListGitHubRepositoriesInput)
    .query(async ({ input }) => {
      return await fetchGitHubRepositoriesForOrganization(input.organizationId, input.forceRefresh);
    }),

  /**
   * List GitLab repositories accessible by the organization's GitLab integration
   */
  listGitLabRepositories: organizationMemberProcedure
    .input(ListGitLabRepositoriesInput)
    .query(async ({ input }) => {
      return await fetchGitLabRepositoriesForOrganization(input.organizationId, input.forceRefresh);
    }),

  /**
   * Delete a session from the cloud agent and the corresponding cliSession (organization context)
   */
  deleteSession: organizationMemberProcedure
    .input(
      z.object({
        organizationId: z.uuid(),
        sessionId: z.string(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const authToken = generateApiToken(ctx.user);
      const client = createCloudChatClient(authToken);

      // First, delete the cloud-agent session (idempotent - returns success if already deleted)
      const result = await client.deleteSession(input.sessionId);

      // Then, find and delete the corresponding cliSession if it exists
      const [cliSession] = await db
        .select()
        .from(cliSessions)
        .where(
          and(
            eq(cliSessions.cloud_agent_session_id, input.sessionId),
            eq(cliSessions.organization_id, input.organizationId),
            eq(cliSessions.kilo_user_id, ctx.user.id)
          )
        )
        .limit(1);

      if (cliSession) {
        // Delete blobs associated with the cliSession
        const blobTypes: FileName[] = [
          'api_conversation_history',
          'task_metadata',
          'ui_messages',
          'git_state',
        ];
        const blobsToDelete = blobTypes.map(filename => ({
          folderName: 'sessions' as const,
          filename,
        }));

        await deleteBlobs(cliSession.session_id, blobsToDelete);

        // Delete the cliSession record
        await db
          .delete(cliSessions)
          .where(
            and(
              eq(cliSessions.session_id, cliSession.session_id),
              eq(cliSessions.organization_id, input.organizationId)
            )
          );
      }

      return result;
    }),

  /**
   * Interrupt a running session (organization context)
   */
  interruptSession: organizationMemberProcedure
    .input(InterruptSessionInput)
    .mutation(async ({ ctx, input }) => {
      const authToken = generateApiToken(ctx.user);
      const client = createCloudChatClient(authToken);
      return await client.interruptSession(input.sessionId);
    }),

  /**
   * Get session state from cloud-agent DO (organization context).
   *
   * Returns sanitized session metadata including lifecycle timestamps
   * (preparedAt, initiatedAt) for idempotency checks. Excludes secrets
   * like tokens and environment variable values.
   */
  getSession: organizationMemberProcedure
    .input(GetSessionInput)
    .output(baseGetSessionOutputSchema)
    .query(async ({ ctx, input }) => {
      const authToken = generateApiToken(ctx.user);
      const client = createCloudChatClient(authToken);
      return await client.getSession(input.cloudAgentSessionId);
    }),

  /**
   * Check if the user has sufficient balance to use Cloud Agent (organization context)
   */
  checkEligibility: organizationMemberProcedure
    .input(z.object({ organizationId: z.uuid() }))
    .query(async ({ ctx, input }) => {
      const { balance } = await getBalanceForOrganizationUser(input.organizationId, ctx.user.id);
      return {
        balance,
        minBalance: MIN_BALANCE_DOLLARS,
        isEligible: balance >= MIN_BALANCE_DOLLARS,
      };
    }),

  /**
   * Initiate a cloud agent session from an existing Kilocode CLI session (V2 mutation, organization context).
   *
   * Unlike the V1 subscription-based endpoint, this returns immediately with
   * execution info including a WebSocket URL for streaming. The client connects
   * to the streamUrl separately to receive events.
   */
  initiateFromKilocodeSessionV2: organizationMemberProcedure
    .input(InitiateFromKilocodeSessionInput)
    .output(
      z.object({
        cloudAgentSessionId: z.string(),
        executionId: z.string(),
        status: z.enum(['queued', 'started']),
        streamUrl: z.string(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const authToken = generateApiToken(ctx.user);
      const githubToken = await getGitHubTokenForOrganization(input.organizationId);
      const client = createCloudChatClient(authToken);

      try {
        if (isPreparedSessionInput(input)) {
          // Used when resuming a prepared session with cloudAgentSessionId only
          return await client.initiateFromKilocodeSessionV2({
            cloudAgentSessionId: input.cloudAgentSessionId,
            kilocodeOrganizationId: input.organizationId,
            githubToken,
          });
        } else {
          // Used when resuming from a non-cloud session
          const { organizationId, ...restInput } = input;
          return await client.initiateFromKilocodeSessionV2({
            ...restInput,
            kilocodeOrganizationId: organizationId,
            githubToken,
          });
        }
      } catch (error) {
        rethrowAsPaymentRequired(error);
        throw error; // unreachable
      }
    }),

  /**
   * Send a message to an existing session (V2 mutation, organization context).
   *
   * Unlike the V1 subscription-based endpoint, this returns immediately with
   * execution info including a WebSocket URL for streaming. The client connects
   * to the streamUrl separately to receive events.
   */
  sendMessageV2: organizationMemberProcedure
    .input(SendMessageV2Input)
    .output(
      z.object({
        cloudAgentSessionId: z.string(),
        executionId: z.string(),
        status: z.enum(['queued', 'started']),
        streamUrl: z.string(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const authToken = generateApiToken(ctx.user);
      const githubToken = await getGitHubTokenForOrganization(input.organizationId);
      const client = createCloudChatClient(authToken);

      try {
        return await client.sendMessageV2({
          ...input,
          githubToken,
        });
      } catch (error) {
        rethrowAsPaymentRequired(error);
        throw error; // unreachable
      }
    }),
});
