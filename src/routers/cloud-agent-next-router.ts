import 'server-only';
import { TRPCError } from '@trpc/server';
import { eq as _eq, and as _and } from 'drizzle-orm';
import { baseProcedure, createTRPCRouter } from '@/lib/trpc/init';
import {
  createCloudAgentNextClient,
  rethrowAsPaymentRequired,
} from '@/lib/cloud-agent-next/cloud-agent-client';
import { generateApiToken } from '@/lib/tokens';
import {
  mergeProfileConfiguration,
  ProfileNotFoundError,
} from '@/lib/agent/profile-session-config';
import {
  getGitHubTokenForUser,
  fetchGitHubRepositoriesForUser,
} from '@/lib/cloud-agent/github-integration-helpers';
import {
  getGitLabTokenForUser,
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
} from './cloud-agent-next-schemas';
import { db } from '@/lib/drizzle';
import { cli_sessions_v2 } from '@/db/schema';
import * as z from 'zod';

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
      const authToken = generateApiToken(ctx.user);
      const client = createCloudAgentNextClient(authToken);

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
          gitUrl?: string;
          gitToken?: string;
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
          gitParams = { gitUrl, gitToken };
        } else {
          // GitHub flow: use githubRepo (token will be fetched in cloud-agent-next)
          gitParams = { githubRepo };
        }

        const result = await client.prepareSession({
          ...restInput,
          ...gitParams,
          envVars: merged.envVars,
          encryptedSecrets: merged.encryptedSecrets,
          setupCommands: merged.setupCommands,
        });

        // Insert cli_sessions_v2 with session IDs
        await db
          .insert(cli_sessions_v2)
          .values({
            session_id: result.kiloSessionId,
            kilo_user_id: ctx.user.id,
            cloud_agent_session_id: result.cloudAgentSessionId,
            version: 0,
          })
          .onConflictDoUpdate({
            target: [cli_sessions_v2.session_id, cli_sessions_v2.kilo_user_id],
            set: { cloud_agent_session_id: result.cloudAgentSessionId },
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
      const authToken = generateApiToken(ctx.user);
      const githubToken = await getGitHubTokenForUser(ctx.user.id);
      const client = createCloudAgentNextClient(authToken);

      try {
        return await client.initiateFromPreparedSession({
          cloudAgentSessionId: input.cloudAgentSessionId,
          githubToken,
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
      const authToken = generateApiToken(ctx.user);
      const githubToken = await getGitHubTokenForUser(ctx.user.id);
      const client = createCloudAgentNextClient(authToken);

      try {
        return await client.sendMessage({
          ...input,
          githubToken,
        });
      } catch (error) {
        rethrowAsPaymentRequired(error);
        throw error;
      }
    }),

  /**
   * Interrupt a running session by killing all associated processes.
   */
  interruptSession: baseProcedure
    .input(baseInterruptSessionNextSchema)
    .output(
      z.object({
        success: z.boolean(),
        killedProcessIds: z.array(z.string()),
        failedProcessIds: z.array(z.string()),
        message: z.string(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const authToken = generateApiToken(ctx.user);
      const client = createCloudAgentNextClient(authToken);

      return await client.interruptSession(input.sessionId);
    }),

  /**
   * Get session state from cloud-agent-next DO.
   * Returns sanitized session info (no secrets).
   */
  getSession: baseProcedure
    .input(baseGetSessionNextSchema)
    .output(baseGetSessionNextOutputSchema)
    .query(async ({ ctx, input }) => {
      const authToken = generateApiToken(ctx.user);
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
