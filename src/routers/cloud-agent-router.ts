import 'server-only';
import { TRPCError } from '@trpc/server';
import { baseProcedure, createTRPCRouter } from '@/lib/trpc/init';
import {
  createCloudChatClient,
  rethrowAsPaymentRequired,
} from '@/lib/cloud-agent/cloud-agent-client';
import { generateApiToken } from '@/lib/tokens';
import {
  mergeProfileConfiguration,
  ProfileNotFoundError,
} from '@/lib/agent/profile-session-config';
import {
  getGitHubTokenForUser,
  fetchGitHubRepositoriesForUser,
  checkDemoRepositoryFork,
} from '@/lib/cloud-agent/github-integration-helpers';
import {
  fetchGitLabRepositoriesForUser,
  getGitLabTokenForUser,
  getGitLabInstanceUrlForUser,
  buildGitLabCloneUrl,
} from '@/lib/cloud-agent/gitlab-integration-helpers';
import {
  baseInitiateSessionSchema,
  baseInitiateFromKilocodeSessionSchema,
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
} from './cloud-agent-schemas';
import { getBalanceForUser } from '@/lib/user.balance';
import * as z from 'zod';
import { db } from '@/lib/drizzle';
import { cliSessions } from '@/db/schema';
import { eq, and } from 'drizzle-orm';
import { deleteBlobs, type FileName } from '@/lib/r2/cli-sessions';
import { PLATFORM } from '@/lib/integrations/core/constants';

/** Minimum balance required to use Cloud Agent (in dollars) */
const MIN_BALANCE_DOLLARS = 1;

export const cloudAgentRouter = createTRPCRouter({
  /**
   * Initiate a new cloud agent session with streaming output (personal context)
   */
  initiateSessionStream: baseProcedure
    .input(baseInitiateSessionSchema)
    .subscription(async function* ({ ctx, input }) {
      const authToken = generateApiToken(ctx.user);
      const githubToken = await getGitHubTokenForUser(ctx.user.id);
      const client = createCloudChatClient(authToken);

      try {
        for await (const event of client.initiateSessionStream({
          ...input,
          kilocodeOrganizationId: undefined,
          githubToken,
        })) {
          yield event;
        }
      } catch (error) {
        rethrowAsPaymentRequired(error);
      }
    }),

  /**
   * Initiate a cloud agent session from an existing Kilocode CLI session with streaming output (personal context)
   *
   * Supports two modes:
   * - Legacy: { kiloSessionId, githubRepo, prompt, mode, model, ... } for CLI sessions
   * - New: { cloudAgentSessionId } for prepared sessions (after prepareSession)
   */
  initiateFromKilocodeSessionStream: baseProcedure
    .input(baseInitiateFromKilocodeSessionSchema)
    .subscription(async function* ({ ctx, input }) {
      const authToken = generateApiToken(ctx.user);
      const githubToken = await getGitHubTokenForUser(ctx.user.id);
      const client = createCloudChatClient(authToken);

      try {
        // Validate that only one mode's fields are present and detect which mode we're in
        if (isPreparedSessionInput(input)) {
          // Used when resuming a prepared session with cloudAgentSessionId only
          for await (const event of client.initiateFromKilocodeSession({
            cloudAgentSessionId: input.cloudAgentSessionId,
            githubToken,
          })) {
            yield event;
          }
        } else {
          // Used when resuming from a non-cloud session
          for await (const event of client.initiateFromKilocodeSession({
            ...input,
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
   * Prepare a new cloud agent session (creates cliSession in backend, stores params in DO).
   *
   * This creates the DB record and cloud-agent DO entry in one call. The session
   * is in "prepared" state and can be initiated via initiateFromKilocodeSessionStream
   * with just the cloudAgentSessionId.
   */
  prepareSession: baseProcedure
    .input(basePrepareSessionSchema)
    .output(basePrepareSessionOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const authToken = generateApiToken(ctx.user);
      const client = createCloudChatClient(authToken);

      const { envVars, setupCommands, profileName, gitlabProject, githubRepo, ...restInput } =
        input;

      try {
        const merged = await mergeProfileConfiguration({
          profileName,
          owner: { type: 'user', id: ctx.user.id },
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
          const gitToken = await getGitLabTokenForUser(ctx.user.id);
          if (!gitToken) {
            throw new TRPCError({
              code: 'BAD_REQUEST',
              message: 'No GitLab integration found. Please connect your GitLab account first.',
            });
          }
          const instanceUrl = await getGitLabInstanceUrlForUser(ctx.user.id);
          const gitUrl = buildGitLabCloneUrl(gitlabProject, instanceUrl);
          gitParams = { gitUrl, gitToken, platform: PLATFORM.GITLAB };
        } else {
          // GitHub flow: use githubRepo + githubToken
          const githubToken = await getGitHubTokenForUser(ctx.user.id);
          gitParams = { githubRepo, githubToken, platform: PLATFORM.GITHUB };
        }

        return await client.prepareSession({
          ...restInput,
          ...gitParams,
          envVars: merged.envVars,
          encryptedSecrets: merged.encryptedSecrets,
          setupCommands: merged.setupCommands,
        });
      } catch (error) {
        if (error instanceof ProfileNotFoundError) {
          throw new TRPCError({ code: 'NOT_FOUND', message: error.message });
        }
        throw error;
      }
    }),

  /**
   * Prepare an legacy cloud agent session (personal context).
   *
   * This stores session params in the cloud-agent DO without creating a new
   * cliSession, allowing legacy sessions to enter the V2 flow.
   */
  prepareLegacySession: baseProcedure
    .input(basePrepareLegacySessionSchema)
    .output(basePrepareLegacySessionOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const authToken = generateApiToken(ctx.user);
      const client = createCloudChatClient(authToken);

      const { envVars, setupCommands, profileName, gitlabProject, githubRepo, ...restInput } =
        input;

      try {
        const merged = await mergeProfileConfiguration({
          profileName,
          owner: { type: 'user', id: ctx.user.id },
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
          const gitToken = await getGitLabTokenForUser(ctx.user.id);
          if (!gitToken) {
            throw new TRPCError({
              code: 'BAD_REQUEST',
              message: 'No GitLab integration found. Please connect your GitLab account first.',
            });
          }
          const instanceUrl = await getGitLabInstanceUrlForUser(ctx.user.id);
          const gitUrl = buildGitLabCloneUrl(gitlabProject, instanceUrl);
          gitParams = { gitUrl, gitToken, platform: PLATFORM.GITLAB };
        } else {
          const githubToken = await getGitHubTokenForUser(ctx.user.id);
          gitParams = { githubRepo, githubToken, platform: PLATFORM.GITHUB };
        }

        return await client.prepareLegacySession({
          ...restInput,
          ...gitParams,
          envVars: merged.envVars,
          encryptedSecrets: merged.encryptedSecrets,
          setupCommands: merged.setupCommands,
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
  sendMessageStream: baseProcedure.input(baseSendMessageSchema).subscription(async function* ({
    ctx,
    input,
  }) {
    const authToken = generateApiToken(ctx.user);
    const githubToken = await getGitHubTokenForUser(ctx.user.id);
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
   * List GitHub repositories accessible by the user's personal GitHub integration
   */
  listGitHubRepositories: baseProcedure
    .input(z.object({ forceRefresh: z.boolean().optional().default(false) }).optional())
    .query(async ({ ctx, input }) => {
      return await fetchGitHubRepositoriesForUser(ctx.user.id, input?.forceRefresh ?? false);
    }),

  /**
   * List GitLab repositories accessible by the user's personal GitLab integration
   */
  listGitLabRepositories: baseProcedure
    .input(z.object({ forceRefresh: z.boolean().optional().default(false) }).optional())
    .query(async ({ ctx, input }) => {
      return await fetchGitLabRepositoriesForUser(ctx.user.id, input?.forceRefresh ?? false);
    }),

  /**
   * Delete a session from the cloud agent and the corresponding cliSession
   */
  deleteSession: baseProcedure
    .input(z.object({ sessionId: z.string() }))
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
              eq(cliSessions.kilo_user_id, ctx.user.id)
            )
          );
      }

      return result;
    }),

  /**
   * Interrupt a running session
   */
  interruptSession: baseProcedure
    .input(baseInterruptSessionSchema)
    .mutation(async ({ ctx, input }) => {
      const authToken = generateApiToken(ctx.user);
      const client = createCloudChatClient(authToken);
      return await client.interruptSession(input.sessionId);
    }),

  /**
   * Get session state from cloud-agent DO.
   *
   * Returns sanitized session metadata including lifecycle timestamps
   * (preparedAt, initiatedAt) for idempotency checks. Excludes secrets
   * like tokens and environment variable values.
   */
  getSession: baseProcedure
    .input(baseGetSessionSchema)
    .output(baseGetSessionOutputSchema)
    .query(async ({ ctx, input }) => {
      const authToken = generateApiToken(ctx.user);
      const client = createCloudChatClient(authToken);
      return await client.getSession(input.cloudAgentSessionId);
    }),

  /**
   * Check if the user has sufficient balance to use Cloud Agent (personal context)
   */
  checkEligibility: baseProcedure.query(async ({ ctx }) => {
    const { balance } = await getBalanceForUser(ctx.user);
    return {
      balance,
      minBalance: MIN_BALANCE_DOLLARS,
      isEligible: balance >= MIN_BALANCE_DOLLARS,
    };
  }),

  /**
   * Check if the demo repository is already forked
   */
  checkDemoRepositoryFork: baseProcedure
    .output(
      z.object({
        exists: z.boolean(),
        forkedRepo: z.string().nullable(),
        githubUsername: z.string().nullable(),
      })
    )
    .query(async ({ ctx }) => {
      const result = await checkDemoRepositoryFork(ctx.user.id);
      return {
        exists: result.exists,
        forkedRepo: result.forkedRepo,
        githubUsername: result.githubUsername,
      };
    }),

  /**
   * Initiate a cloud agent session from an existing Kilocode CLI session (V2 mutation).
   *
   * Unlike the V1 subscription-based endpoint, this returns immediately with
   * execution info including a WebSocket URL for streaming. The client connects
   * to the streamUrl separately to receive events.
   *
   * Supports two modes:
   * - Legacy: { kiloSessionId, githubRepo, prompt, mode, model, ... } for CLI sessions
   * - New: { cloudAgentSessionId } for prepared sessions (after prepareSession)
   */
  initiateFromKilocodeSessionV2: baseProcedure
    .input(baseInitiateFromKilocodeSessionSchema)
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
      const githubToken = await getGitHubTokenForUser(ctx.user.id);
      const client = createCloudChatClient(authToken);

      try {
        if (isPreparedSessionInput(input)) {
          // Used when resuming a prepared session with cloudAgentSessionId only
          return await client.initiateFromKilocodeSessionV2({
            cloudAgentSessionId: input.cloudAgentSessionId,
            githubToken,
          });
        } else {
          // Used when resuming from a non-cloud session
          return await client.initiateFromKilocodeSessionV2({
            ...input,
            githubToken,
          });
        }
      } catch (error) {
        rethrowAsPaymentRequired(error);
        throw error; // unreachable
      }
    }),

  /**
   * Send a message to an existing session (V2 mutation).
   *
   * Unlike the V1 subscription-based endpoint, this returns immediately with
   * execution info including a WebSocket URL for streaming. The client connects
   * to the streamUrl separately to receive events.
   */
  sendMessageV2: baseProcedure
    .input(baseSendMessageV2Schema)
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
      const githubToken = await getGitHubTokenForUser(ctx.user.id);
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
