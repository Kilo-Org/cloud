import { TRPCError } from '@trpc/server';
import * as z from 'zod';
import { createAgentSandbox } from '../../agent-sandbox/factory.js';
import { logger, withLogTags } from '../../logger.js';
import { generateSandboxId } from '../../sandbox-id.js';
import type { SessionId, InterruptResult, TRPCContext } from '../../types.js';
import type { SandboxId } from '../../types.js';
import {
  InvalidSessionMetadataError,
  SessionService,
  fetchSessionMetadata,
} from '../../session-service.js';
import { withDORetry } from '../../utils/do-retry.js';
import { protectedProcedure, publicProcedure, internalApiProtectedProcedure } from '../auth.js';
import {
  sessionIdSchema,
  GetSessionInput,
  GetSessionOutput,
  GetSessionHealthInput,
  GetSessionHealthOutput,
  GetMessageResultInput,
  GetMessageResultOutput,
  GetLatestAssistantMessageInput,
  GetLatestAssistantMessageOutput,
} from '../schemas.js';
import { readProfileBundle } from '../../session-profile.js';
import type { CloudAgentSession } from '../../persistence/CloudAgentSession.js';
import type { CloudAgentSessionState } from '../../persistence/types.js';
import type { MessageResultRPCResponse } from '../../session/message-result.js';

function publicRepositoryFields(metadata: CloudAgentSessionState): {
  githubRepo?: string;
  gitUrl?: string;
  platform?: 'github' | 'gitlab';
} {
  const repository = metadata.repository;
  if (!repository) return {};
  if (repository.type === 'github') {
    return { githubRepo: repository.repo, platform: repository.platform ?? 'github' };
  }
  return {
    gitUrl: repository.url,
    platform: repository.platform ?? (repository.type === 'gitlab' ? 'gitlab' : undefined),
  };
}

async function deleteSessionResources(
  sessionId: SessionId,
  userId: string,
  env: TRPCContext['env']
): Promise<{ success: true; message?: string }> {
  logger.setTags({ userId, sessionId });
  logger.info('Starting session deletion');

  try {
    const metadata = await fetchSessionMetadata(env, userId, sessionId);
    if (!metadata) {
      logger.info('Session not found or already deleted');
      return { success: true, message: 'Session not found or already deleted' };
    }

    try {
      const doKey = `${userId}:${sessionId}`;
      await withDORetry(
        () => env.CLOUD_AGENT_SESSION.get(env.CLOUD_AGENT_SESSION.idFromName(doKey)),
        stub => stub.deleteSession(),
        'deleteSession'
      );
      logger.info('Session metadata destroyed');
    } catch (error) {
      logger
        .withFields({ error: error instanceof Error ? error.message : String(error) })
        .error('Failed to destroy session metadata');
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Failed to clean up session metadata',
      });
    }

    logger.info('Session deletion completed successfully');
    return { success: true };
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    const errorMsg = error instanceof Error ? error.message : String(error);
    logger.withFields({ error: errorMsg }).error('Session deletion failed');
    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: `Failed to delete session: ${errorMsg}`,
    });
  }
}

/**
 * Creates session management handlers.
 * These handlers manage session lifecycle (delete, interrupt, logs) and health checks.
 */
export function createSessionManagementHandlers() {
  return {
    /**
     * Delete a session and clean up all associated resources.
     *
     * Idempotency:
     * - Returns success if session doesn't exist (already deleted or never created)
     * - Safe to call multiple times for the same session
     */
    deleteSession: protectedProcedure
      .input(
        z.object({
          sessionId: sessionIdSchema.describe('Session ID to delete'),
        })
      )
      .mutation(async ({ input, ctx }) => {
        return withLogTags({ source: 'deleteSession' }, () =>
          deleteSessionResources(input.sessionId as SessionId, ctx.userId, ctx.env)
        );
      }),

    cleanupSession: internalApiProtectedProcedure
      .input(
        z.object({
          sessionId: sessionIdSchema.describe('Session ID requiring trusted runtime cleanup'),
        })
      )
      .mutation(async ({ input, ctx }) => {
        return withLogTags({ source: 'cleanupSession' }, () =>
          deleteSessionResources(input.sessionId as SessionId, ctx.userId, ctx.env)
        );
      }),

    /**
     * Interrupt current session work through the owning Durable Object.
     * The DO may signal a connected wrapper immediately and durably supervises
     * physical cleanup without letting this route issue provider teardown.
     */
    interruptSession: protectedProcedure
      .input(
        z.object({
          sessionId: sessionIdSchema.describe('Session ID to interrupt'),
        })
      )
      .mutation(async ({ input, ctx }): Promise<InterruptResult> => {
        return withLogTags({ source: 'interruptSession' }, async () => {
          const sessionId = input.sessionId as SessionId;
          const { userId, env } = ctx;

          logger.setTags({ userId, sessionId });
          logger.info('Starting session interruption');

          try {
            const metadata = await fetchSessionMetadata(env, userId, sessionId);

            if (!metadata) {
              logger.info('Session not found');
              return {
                success: false,
                message: 'Session not found',
                processesFound: false,
              };
            }

            // Mark session as interrupted in DO before killing processes (with retry)
            // This signals the streaming generator to stop
            const doKey = `${userId}:${sessionId}`;
            const getStub = () =>
              env.CLOUD_AGENT_SESSION.get(env.CLOUD_AGENT_SESSION.idFromName(doKey));

            await withDORetry(getStub, stub => stub.markAsInterrupted(), 'markAsInterrupted');

            const interruptResult = await withDORetry(
              getStub,
              stub => stub.interruptExecution(),
              'interruptExecution'
            );

            if (!interruptResult.success) {
              logger
                .withFields({
                  message:
                    interruptResult.message ??
                    'No accepted current messages or pending queued messages',
                })
                .info('No accepted current messages or pending queued messages to interrupt');
            }

            logger.info('Session interruption completed');
            return {
              success: interruptResult.success,
              message: interruptResult.success
                ? 'Session interruption accepted'
                : (interruptResult.message ?? 'No session work to interrupt'),
              processesFound: false,
            };
          } catch (error) {
            const errorMsg = error instanceof Error ? error.message : String(error);
            logger.withFields({ error: errorMsg }).error('Session interruption failed');

            throw new TRPCError({
              code: 'INTERNAL_SERVER_ERROR',
              message: `Failed to interrupt session: ${errorMsg}`,
            });
          }
        });
      }),

    /**
     * Get session metadata.
     *
     * Returns sanitized session metadata (no secrets) including lifecycle timestamps.
     * Useful for frontend idempotency - checking if a session was already initiated
     * before a page refresh.
     *
     * Security:
     * - Excludes: githubToken, gitToken, envVars values, setupCommands, mcpServers configs
     * - Includes: counts of envVars, setupCommands, mcpServers for debugging
     */
    getSession: protectedProcedure
      .input(GetSessionInput)
      .output(GetSessionOutput)
      .query(async ({ input, ctx }) => {
        return withLogTags({ source: 'getSession' }, async () => {
          const sessionId = input.cloudAgentSessionId as SessionId;
          const { userId, env } = ctx;

          logger.setTags({ userId, sessionId });
          logger.info('Fetching session metadata');

          // Get DO stub keyed by userId:sessionId for user isolation
          const doKey = `${userId}:${sessionId}`;
          const getStub = () =>
            env.CLOUD_AGENT_SESSION.get(env.CLOUD_AGENT_SESSION.idFromName(doKey));

          // Fetch metadata with retry
          const metadata = await withDORetry<
            DurableObjectStub<CloudAgentSession>,
            CloudAgentSessionState | null
          >(getStub, s => s.getMetadata(), 'getMetadata');

          // Handle not found
          if (!metadata) {
            logger.info('Session not found');
            throw new TRPCError({
              code: 'NOT_FOUND',
              message: 'Session not found',
            });
          }

          const currentWork = await withDORetry(
            getStub,
            s => s.getCurrentMessageWork(),
            'getCurrentMessageWork'
          );

          // Compute sandboxId for log correlation
          const sessionMetadata = metadata;
          const metadataProfile = readProfileBundle(sessionMetadata);

          const sandboxId =
            sessionMetadata.workspace?.sandboxId ??
            (await generateSandboxId(
              env.PER_SESSION_SANDBOX_ORG_IDS,
              sessionMetadata.identity.orgId,
              userId,
              sessionMetadata.identity.sessionId,
              sessionMetadata.identity.botId
            ));

          logger.setTags({ sandboxId, orgId: sessionMetadata.identity.orgId ?? '(personal)' });
          logger.info('Session metadata retrieved successfully');

          // Sanitize and return safe fields only (no tokens/secrets)
          const repositoryFields = publicRepositoryFields(sessionMetadata);
          return {
            sessionId: sessionMetadata.identity.sessionId,
            kiloSessionId: sessionMetadata.auth.kiloSessionId,
            userId: sessionMetadata.identity.userId,
            orgId: sessionMetadata.identity.orgId,
            sandboxId,

            githubRepo: repositoryFields.githubRepo,
            gitUrl: repositoryFields.gitUrl,
            platform: repositoryFields.platform,
            // githubToken: OMITTED
            // gitToken: OMITTED

            prompt: sessionMetadata.initialMessage?.prompt,
            // mode is validated against built-in and profile runtime-agent slugs at storage time
            mode: sessionMetadata.agent?.mode,
            model: sessionMetadata.agent?.model,
            variant: sessionMetadata.agent?.variant,
            autoCommit: sessionMetadata.finalization?.autoCommit,
            upstreamBranch: sessionMetadata.repository?.upstreamBranch,
            runtimeAgents: metadataProfile.runtimeAgents?.map(agent => ({
              slug: agent.slug,
              name: agent.name,
              model: agent.config.model ?? undefined,
              variant: agent.config.variant,
            })),

            // Preserve the execution-shaped public field using only current
            // message-native activity; stranded execution-era rows are not current work.
            execution: currentWork
              ? {
                  id: currentWork.messageId,
                  status: currentWork.status,
                  startedAt: sessionMetadata.lifecycle.timestamp,
                  lastHeartbeat: null,
                  processId: null,
                  error: null,
                  health: currentWork.health,
                }
              : null,

            // Lifecycle timestamps (critical for idempotency)
            preparedAt: sessionMetadata.lifecycle.preparedAt,
            initiatedAt: sessionMetadata.lifecycle.initiatedAt,

            // callbackTarget is intentionally NOT returned: it may carry
            // service-to-service auth headers and is reachable by the
            // session's owning user via the web tRPC surface.

            initialMessageId: sessionMetadata.initialMessage?.id,

            timestamp: sessionMetadata.lifecycle.timestamp,
            version: sessionMetadata.lifecycle.version,
          };
        });
      }),

    getSessionHealth: protectedProcedure
      .input(GetSessionHealthInput)
      .output(GetSessionHealthOutput)
      .mutation(async ({ input, ctx }) => {
        return withLogTags({ source: 'getSessionHealth' }, async () => {
          const sessionId = input.cloudAgentSessionId as SessionId;
          const { userId, env } = ctx;

          logger.setTags({ userId, sessionId });
          logger.info('Fetching session health');

          const doKey = `${userId}:${sessionId}`;
          const getStub = () =>
            env.CLOUD_AGENT_SESSION.get(env.CLOUD_AGENT_SESSION.idFromName(doKey));

          const metadata = await withDORetry<
            ReturnType<typeof getStub>,
            CloudAgentSessionState | null
          >(getStub, s => s.getMetadata(), 'getMetadata');

          if (!metadata) {
            logger.info('Session not found');
            throw new TRPCError({
              code: 'NOT_FOUND',
              message: 'Session not found',
            });
          }

          const sandboxId: SandboxId =
            metadata.workspace?.sandboxId ??
            (await generateSandboxId(
              env.PER_SESSION_SANDBOX_ORG_IDS,
              metadata.identity.orgId,
              userId,
              metadata.identity.sessionId,
              metadata.identity.botId
            ));

          logger.setTags({ sandboxId, orgId: metadata.identity.orgId ?? '(personal)' });

          // Stranded legacy execution rows from pre-message deployments do not
          // represent resumable current work and must not gate continuation.
          const activeMessageWork = await withDORetry(
            getStub,
            s => s.getCurrentMessageWork(),
            'getCurrentMessageWork'
          );
          const activeExecutionId = activeMessageWork?.messageId;
          const activeExecutionStatus = activeMessageWork?.status;
          const executionHealth = activeMessageWork?.health ?? 'none';

          let sandboxStatus: 'healthy' | 'unreachable' = 'healthy';
          try {
            await createAgentSandbox(env, metadata).probeHealth();
          } catch (error) {
            sandboxStatus = 'unreachable';
            logger
              .withFields({ error: error instanceof Error ? error.message : String(error) })
              .warn('Sandbox health probe failed');
          }

          logger.info('Session health retrieved successfully', {
            sandboxStatus,
            executionHealth,
            activeExecutionId: activeExecutionId ?? undefined,
            activeExecutionStatus,
          });

          return {
            cloudAgentSessionId: sessionId,
            sandboxId,
            sandboxStatus,
            executionHealth,
            activeExecutionId: activeExecutionId ?? undefined,
            activeExecutionStatus,
          };
        });
      }),

    getMessageResult: protectedProcedure
      .input(GetMessageResultInput)
      .output(GetMessageResultOutput)
      .query(async ({ input, ctx }) => {
        return withLogTags({ source: 'getMessageResult' }, async () => {
          const sessionId = input.cloudAgentSessionId as SessionId;
          const { userId, env } = ctx;
          const doKey = `${userId}:${sessionId}`;
          const getStub = () =>
            env.CLOUD_AGENT_SESSION.get(env.CLOUD_AGENT_SESSION.idFromName(doKey));

          const response = await withDORetry<
            DurableObjectStub<CloudAgentSession>,
            MessageResultRPCResponse
          >(
            getStub,
            async stub => await stub.getMessageResult(input.messageId),
            'getMessageResult'
          );
          if (response.type === 'session-not-found') {
            throw new TRPCError({ code: 'NOT_FOUND', message: 'Session not found' });
          }
          if (response.type === 'message-not-found') {
            throw new TRPCError({ code: 'NOT_FOUND', message: 'Message not found' });
          }
          if (response.type === 'state-invalid') {
            throw new TRPCError({
              code: 'INTERNAL_SERVER_ERROR',
              message: 'Message result unavailable',
            });
          }

          return response.result;
        });
      }),

    getLatestAssistantMessage: protectedProcedure
      .input(GetLatestAssistantMessageInput)
      .output(GetLatestAssistantMessageOutput)
      .query(async ({ input, ctx }) => {
        return withLogTags({ source: 'getLatestAssistantMessage' }, async () => {
          const sessionId = input.cloudAgentSessionId as SessionId;
          const { userId, env } = ctx;

          logger.setTags({ userId, sessionId });
          logger.info('Fetching latest assistant message');

          const doKey = `${userId}:${sessionId}`;
          const getStub = () =>
            env.CLOUD_AGENT_SESSION.get(env.CLOUD_AGENT_SESSION.idFromName(doKey));

          const metadata = await withDORetry<
            DurableObjectStub<CloudAgentSession>,
            CloudAgentSessionState | null
          >(getStub, s => s.getMetadata(), 'getMetadata');
          if (!metadata) {
            logger.info('Session not found');
            throw new TRPCError({
              code: 'NOT_FOUND',
              message: 'Session not found',
            });
          }

          const message = await withDORetry(
            getStub,
            s => s.getLatestAssistantMessage(),
            'getLatestAssistantMessage'
          );

          return {
            cloudAgentSessionId: sessionId,
            message,
          };
        });
      }),

    /**
     * Get all log files and running processes for a session's sandbox.
     *
     * Discovers wrapper logs from /tmp and CLI logs from the session home directory.
     * Useful for debugging wrapper startup and CLI issues.
     */
    getWrapperLogs: internalApiProtectedProcedure
      .input(
        z.object({
          sessionId: sessionIdSchema.describe('Session ID'),
        })
      )
      .query(async ({ input, ctx }) => {
        return withLogTags({ source: 'getWrapperLogs' }, async () => {
          const sessionId = input.sessionId as SessionId;
          const { userId, env } = ctx;

          logger.setTags({ userId, sessionId });
          logger.info('Fetching all session logs');

          // Fetch session metadata to get sandboxId and validate ownership
          const sessionService = new SessionService();
          let sandboxId: SandboxId;
          try {
            sandboxId = await sessionService.getSandboxIdForSession(env, userId, sessionId);
          } catch (error) {
            if (error instanceof InvalidSessionMetadataError) {
              throw new TRPCError({
                code: 'PRECONDITION_FAILED',
                message: `Session metadata is invalid or unavailable. Please re-initiate session ${sessionId}.`,
              });
            }

            if (error instanceof TRPCError) {
              throw error;
            }

            throw new TRPCError({
              code: 'INTERNAL_SERVER_ERROR',
              message: `Failed to load session metadata for ${sessionId}.`,
            });
          }

          logger.setTags({
            sandboxId,
            orgId: sessionService.metadata?.identity.orgId ?? '(personal)',
          });

          const metadata = sessionService.metadata;
          if (!metadata) {
            throw new TRPCError({
              code: 'PRECONDITION_FAILED',
              message: 'Session metadata is invalid or unavailable.',
            });
          }

          const logs = await createAgentSandbox(env, metadata).readWrapperLogs();
          if (!logs) {
            throw new TRPCError({
              code: 'PRECONDITION_FAILED',
              message: 'Wrapper logs are unavailable because the session wrapper is not running',
            });
          }

          logger.info('Successfully retrieved session logs', {
            fileCount: Object.keys(logs.files).length,
          });

          return {
            sessionId,
            files: logs.files,
            processes: logs.processes,
          };
        });
      }),

    /**
     * Health check endpoint
     */
    health: publicProcedure.query(() => {
      return {
        status: 'ok',
        timestamp: new Date().toISOString(),
        version: '1.0.0-trpc',
      };
    }),
  };
}
