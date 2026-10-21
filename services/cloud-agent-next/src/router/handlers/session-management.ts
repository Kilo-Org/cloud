import { TRPCError } from '@trpc/server';
import * as z from 'zod';
import type { WorkerDb } from '@kilocode/db/client';
import { logger, withLogTags } from '../../logger.js';
import { generateSandboxId } from '../../sandbox-id.js';
import type { SessionId, InterruptResult, TRPCContext, SandboxId } from '../../types.js';
import { fetchSessionMetadata } from '../../session/metadata.js';
import { assertControlSessionId } from '../../session/session-id-guard.js';
import { withDORetry } from '../../utils/do-retry.js';
import { getSandboxSessionStub } from '../../sandbox-session/session-stub.js';
import { interruptControlSession } from '../control-plane-session.js';
import { protectedProcedure, publicProcedure, internalApiProtectedProcedure } from '../auth.js';
import {
  sessionIdSchema,
  MessageIdSchema,
  GetSessionInput,
  GetSessionOutput,
  GetSandboxStatusInput,
  GetSandboxStatusOutput,
  GetSessionHealthInput,
  GetSessionHealthOutput,
  GetMessageResultInput,
  GetMessageResultOutput,
  GetLatestAssistantMessageInput,
  GetLatestAssistantMessageOutput,
} from '../schemas.js';
import { readProfileBundle } from '../../session-profile.js';
import type { CloudAgentSessionState } from '../../persistence/types.js';
import type {
  ControlPlaneSessionSnapshot,
  SandboxSessionV2,
} from '../../control-plane/session/session-do.js';
import type { MessageResultRPCResponse } from '../../session/message-result.js';
import { requireCurrentSessionAccess } from '../../session-access.js';
import { getPgDb } from '../../db/pg.js';
import { cli_sessions_v2 } from '@kilocode/db/schema';
import { and, eq } from 'drizzle-orm';
import type { SandboxLifecycleStatus } from '../../shared/sandbox-status.js';
import type { PreparationAttempt } from '../../shared/protocol.js';

function publicRepositoryFields(metadata: CloudAgentSessionState): {
  githubRepo?: string;
  gitUrl?: string;
  platform?: 'github' | 'gitlab' | 'bitbucket';
} {
  const repository = metadata.repository;
  if (!repository) return {};
  switch (repository.type) {
    case 'github':
      return { githubRepo: repository.repo, platform: repository.platform ?? 'github' };
    case 'gitlab':
      return { gitUrl: repository.url, platform: 'gitlab' };
    case 'bitbucket':
      return { gitUrl: repository.url, platform: 'bitbucket' };
    case 'git':
      return { gitUrl: repository.url, platform: repository.platform };
  }
}

/** Projects the control-plane sandbox lifecycle onto the public health enum. */
function sandboxStatusFromLifecycle(
  status: SandboxLifecycleStatus
): 'healthy' | 'destroyed' | 'unreachable' | 'unknown' {
  switch (status) {
    case 'active':
      return 'healthy';
    case 'unreachable':
      return 'unreachable';
    case 'error':
      return 'destroyed';
    default:
      return 'unknown';
  }
}

type WorktreeOwnership = {
  parentSessionId: string | null;
  cloudAgentSessionScopeId: string | null;
};

async function findWorktreeOwnership(
  db: WorkerDb,
  userId: string,
  kiloSessionId: string,
  cloudAgentSessionId: string
): Promise<WorktreeOwnership | null> {
  const [row] = await db
    .select({
      parentSessionId: cli_sessions_v2.parent_session_id,
      cloudAgentSessionScopeId: cli_sessions_v2.cloud_agent_session_scope_id,
    })
    .from(cli_sessions_v2)
    .where(
      and(
        eq(cli_sessions_v2.kilo_user_id, userId),
        eq(cli_sessions_v2.session_id, kiloSessionId),
        eq(cli_sessions_v2.cloud_agent_session_id, cloudAgentSessionId)
      )
    )
    .limit(1);
  return row ?? null;
}

async function deleteSessionResources(
  sessionId: SessionId,
  userId: string,
  env: TRPCContext['env'],
  authorizeExistingSession?: () => Promise<void>
): Promise<{ success: true; message?: string }> {
  logger.setTags({ userId, sessionId });
  logger.info('Starting session deletion');

  try {
    const getStub = () => getSandboxSessionStub(env, userId, sessionId);

    const metadata = await fetchSessionMetadata(env, userId, sessionId);
    if (!metadata) {
      logger.info('Session not found or already deleted');
      return { success: true, message: 'Session not found or already deleted' };
    }

    await authorizeExistingSession?.();

    try {
      await withDORetry(getStub, stub => stub.deleteSession(), 'deleteSession');
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
 * These handlers manage session lifecycle and health checks.
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
        const sessionId = input.sessionId as SessionId;
        assertControlSessionId(sessionId);
        return withLogTags({ source: 'deleteSession' }, () =>
          deleteSessionResources(sessionId, ctx.userId, ctx.env, async () => {
            await requireCurrentSessionAccess({
              env: ctx.env,
              kiloUserId: ctx.userId,
              cloudAgentSessionId: sessionId,
            });
          })
        );
      }),

    cleanupSession: internalApiProtectedProcedure
      .input(
        z.object({
          sessionId: sessionIdSchema.describe('Session ID requiring trusted runtime cleanup'),
        })
      )
      .mutation(async ({ input, ctx }) => {
        const sessionId = input.sessionId as SessionId;
        assertControlSessionId(sessionId);
        return withLogTags({ source: 'cleanupSession' }, () =>
          deleteSessionResources(sessionId, ctx.userId, ctx.env)
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
          assertControlSessionId(sessionId);
          const { userId, env } = ctx;

          logger.setTags({ userId, sessionId });
          logger.info('Starting session interruption');
          await requireCurrentSessionAccess({
            env,
            kiloUserId: userId,
            cloudAgentSessionId: sessionId,
          });

          try {
            const notFoundResult: InterruptResult = {
              success: false,
              message: 'Session not found',
              processesFound: false,
            };
            const readMetadata = () => fetchSessionMetadata(env, userId, sessionId);

            if (!(await readMetadata())) {
              logger.info('Session not found');
              return notFoundResult;
            }
            const interruptResult = await interruptControlSession({
              env,
              ownerId: userId,
              sessionId,
            });

            const success = interruptResult !== undefined && interruptResult.state !== 'rejected';
            const message =
              interruptResult === undefined
                ? 'No session work to interrupt'
                : interruptResult.message;

            if (!success) {
              logger
                .withFields({
                  reason: message ?? 'No accepted current messages or pending queued messages',
                })
                .info('No accepted current messages or pending queued messages to interrupt');
            }

            logger.info('Session interruption completed');
            return {
              success,
              message: success
                ? 'Session interruption accepted'
                : (message ?? 'No session work to interrupt'),
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
     * Drop one pending (not yet accepted) queued message by id. Never interrupts
     * the accepted/current run; a missing id or the accepted current message
     * returns `{ dropped: false }`.
     */
    cancelQueuedMessage: protectedProcedure
      .input(
        z.object({
          sessionId: sessionIdSchema.describe('Session ID owning the queued message'),
          messageId: MessageIdSchema.describe('Message ID to drop from the queue'),
        })
      )
      .mutation(async ({ input, ctx }) => {
        return withLogTags({ source: 'cancelQueuedMessage' }, async () => {
          const sessionId = input.sessionId as SessionId;
          assertControlSessionId(sessionId);
          const { userId, env } = ctx;

          logger.setTags({ userId, sessionId });
          logger.info('Canceling queued message');
          await requireCurrentSessionAccess({
            env,
            kiloUserId: userId,
            cloudAgentSessionId: sessionId,
          });

          try {
            const getStub = () => getSandboxSessionStub(env, userId, sessionId);
            return await withDORetry(
              getStub,
              stub => stub.cancelQueuedMessage(input.messageId),
              'cancelQueuedMessage'
            );
          } catch (error) {
            const errorMsg = error instanceof Error ? error.message : String(error);
            logger.withFields({ error: errorMsg }).error('Failed to cancel queued message');
            throw new TRPCError({
              code: 'INTERNAL_SERVER_ERROR',
              message: `Failed to cancel queued message: ${errorMsg}`,
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
          assertControlSessionId(sessionId);
          const { userId, env } = ctx;

          logger.setTags({ userId, sessionId });
          logger.info('Fetching session metadata');
          const sessionAccess = await requireCurrentSessionAccess({
            env,
            kiloUserId: userId,
            cloudAgentSessionId: sessionId,
          });

          // Get DO stub keyed by userId:sessionId for user isolation. The getter
          // returns a fresh stub per retry attempt.
          const getStub = () => getSandboxSessionStub(env, userId, sessionId);

          // Fetch metadata with retry
          const metadata = await withDORetry<
            DurableObjectStub<SandboxSessionV2>,
            CloudAgentSessionState | null
          >(getStub, s => s.getMetadata(), 'getMetadata');

          if (!metadata) {
            logger.info('Session not found');
            throw new TRPCError({
              code: 'NOT_FOUND',
              message: 'Session not found',
            });
          }

          // Current work and the durability watermark come from the control-plane
          // session snapshot.
          const { currentWork, latestEventId, routeReady } = await (async (): Promise<{
            currentWork: {
              messageId: string;
              status: 'pending' | 'running';
              health: 'healthy' | 'stale';
            } | null;
            latestEventId: number | null;
            routeReady: boolean | undefined;
          }> => {
            const snapshot = await withDORetry<
              DurableObjectStub<SandboxSessionV2>,
              ControlPlaneSessionSnapshot
            >(
              () => getSandboxSessionStub(env, userId, sessionId),
              s => s.getSession(),
              'getSession'
            );
            if (snapshot.type !== 'found') {
              return { currentWork: null, latestEventId: null, routeReady: undefined };
            }
            const accepted = snapshot.messages.find(message => message.state === 'accepted');
            const queued = snapshot.messages.find(message => message.state === 'queued');
            return {
              currentWork: accepted
                ? { messageId: accepted.messageId, status: 'running', health: 'healthy' }
                : queued
                  ? { messageId: queued.messageId, status: 'pending', health: 'healthy' }
                  : null,
              latestEventId: snapshot.latestEventId,
              // Route readiness is the control-plane owner of "can this
              // session own a terminal": a terminal requires a ready route.
              routeReady: snapshot.route?.state === 'ready',
            };
          })();

          const sessionMetadata = metadata;
          const metadataProfile = readProfileBundle(sessionMetadata);

          const sandboxId =
            sessionMetadata.workspace?.sandboxId ??
            (await generateSandboxId(
              env.PER_SESSION_SANDBOX_ORG_IDS,
              sessionMetadata.identity.orgId,
              userId,
              sessionMetadata.identity.sessionId,
              sessionMetadata.identity.botId,
              {
                createdOnPlatform: sessionMetadata.identity.createdOnPlatform,
              }
            ));

          logger.setTags({ sandboxId, orgId: sessionMetadata.identity.orgId ?? '(personal)' });
          logger.info('Session metadata retrieved successfully');

          // Worktree ownership lives on the external ownership row, not in DO
          // metadata. Only worktree sessions need that read, so ordinary
          // sessions never touch PostgreSQL here.
          const worktreeId = sessionMetadata.workspace?.worktreeId;
          let worktreeOwnership: WorktreeOwnership | null = null;
          if (worktreeId) {
            worktreeOwnership = await findWorktreeOwnership(
              getPgDb(env),
              userId,
              sessionAccess.kiloSessionId,
              sessionId
            );
          }

          // Sanitize and return safe fields only (no tokens/secrets)
          const repositoryFields = publicRepositoryFields(sessionMetadata);
          return {
            sessionId: sessionMetadata.identity.sessionId,
            kiloSessionId: sessionMetadata.auth.kiloSessionId,
            userId: sessionMetadata.identity.userId,
            orgId: sessionMetadata.identity.orgId,
            sandboxId,

            ...(worktreeId
              ? {
                  worktreeId,
                  parentSessionId: worktreeOwnership?.parentSessionId ?? null,
                  cloudAgentSessionScopeId: worktreeOwnership?.cloudAgentSessionScopeId ?? null,
                }
              : {}),

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
            branchName: sessionMetadata.workspace?.branchName,
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

            // Whether this session's route is ready to accept a terminal.
            // A session without a found snapshot falls back to having been
            // prepared at least once.
            routeReady: routeReady ?? Boolean(sessionMetadata.lifecycle.preparedAt),

            // callbackTarget is intentionally NOT returned: it may carry
            // service-to-service auth headers and is reachable by the
            // session's owning user via the web tRPC surface.

            initialMessageId: sessionMetadata.initialMessage?.id,

            timestamp: sessionMetadata.lifecycle.timestamp,
            version: sessionMetadata.lifecycle.version,
            latestEventId,
          };
        });
      }),

    getSandboxStatus: protectedProcedure
      .input(GetSandboxStatusInput)
      .output(GetSandboxStatusOutput)
      .query(async ({ input, ctx }) => {
        const sessionId = input.cloudAgentSessionId as SessionId;
        assertControlSessionId(sessionId);
        await requireCurrentSessionAccess({
          env: ctx.env,
          kiloUserId: ctx.userId,
          cloudAgentSessionId: sessionId,
        });

        try {
          return await withDORetry(
            () => () => getSandboxSessionStub(ctx.env, ctx.userId, sessionId),
            async getStub => {
              try {
                return GetSandboxStatusOutput.parse(await getStub().getSandboxStatus());
              } catch (error) {
                throw Object.assign(new Error('Sandbox status unavailable'), {
                  retryable:
                    error instanceof Error && 'retryable' in error && error.retryable === true,
                });
              }
            },
            'getSandboxStatus'
          );
        } catch {
          return {
            status: 'unknown',
            provider: 'Unknown',
            observedAt: Date.now(),
            detailCode: 'status_unavailable',
            inactivityTimeoutMs: null,
            estimatedSleepAt: null,
          };
        }
      }),

    getSessionHealth: protectedProcedure
      .input(GetSessionHealthInput)
      .output(GetSessionHealthOutput)
      .mutation(async ({ input, ctx }) => {
        return withLogTags({ source: 'getSessionHealth' }, async () => {
          const sessionId = input.cloudAgentSessionId as SessionId;
          assertControlSessionId(sessionId);
          const { userId, env } = ctx;

          logger.setTags({ userId, sessionId });
          logger.info('Fetching session health');
          await requireCurrentSessionAccess({
            env,
            kiloUserId: userId,
            cloudAgentSessionId: sessionId,
          });

          const getStub = () => getSandboxSessionStub(env, userId, sessionId);

          const metadata = await withDORetry<
            DurableObjectStub<SandboxSessionV2>,
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
              metadata.identity.botId,
              {
                createdOnPlatform: metadata.identity.createdOnPlatform,
              }
            ));

          logger.setTags({ sandboxId, orgId: metadata.identity.orgId ?? '(personal)' });

          const activeMessageWork = await (async (): Promise<{
            messageId: string;
            status: 'pending' | 'running';
            health: 'healthy' | 'stale';
          } | null> => {
            const snapshot = await withDORetry<
              DurableObjectStub<SandboxSessionV2>,
              ControlPlaneSessionSnapshot
            >(
              () => getSandboxSessionStub(env, userId, sessionId),
              s => s.getSession(),
              'getSession'
            );
            if (snapshot.type !== 'found') return null;
            const accepted = snapshot.messages.find(message => message.state === 'accepted');
            const queued = snapshot.messages.find(message => message.state === 'queued');
            return accepted
              ? { messageId: accepted.messageId, status: 'running', health: 'healthy' }
              : queued
                ? { messageId: queued.messageId, status: 'pending', health: 'healthy' }
                : null;
          })();
          const activeExecutionId = activeMessageWork?.messageId;
          const activeExecutionStatus = activeMessageWork?.status;
          const executionHealth = activeMessageWork?.health ?? 'none';

          const sandboxStatus: 'healthy' | 'destroyed' | 'unreachable' | 'unknown' =
            await (async (): Promise<'healthy' | 'destroyed' | 'unreachable' | 'unknown'> => {
              try {
                const snapshot = await withDORetry(
                  () => getSandboxSessionStub(env, userId, sessionId),
                  stub => stub.getSandboxStatus(),
                  'getSandboxStatus'
                );
                return sandboxStatusFromLifecycle(snapshot.status);
              } catch (error) {
                logger
                  .withFields({ error: error instanceof Error ? error.message : String(error) })
                  .warn('Sandbox status read failed');
                return 'unknown';
              }
            })();

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
          assertControlSessionId(sessionId);
          const { userId, env } = ctx;
          await requireCurrentSessionAccess({
            env,
            kiloUserId: userId,
            cloudAgentSessionId: sessionId,
          });
          const getStub = () => getSandboxSessionStub(env, userId, sessionId);

          const response: MessageResultRPCResponse = await withDORetry(
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

    /** The preparation attempts a stream replay builds, so the first page can show them. */
    getPreparationAttempts: protectedProcedure
      .input(GetSessionInput)
      .query(async ({ input, ctx }) => {
        return withLogTags({ source: 'getPreparationAttempts' }, async () => {
          const sessionId = input.cloudAgentSessionId as SessionId;
          assertControlSessionId(sessionId);
          const { userId, env } = ctx;
          await requireCurrentSessionAccess({
            env,
            kiloUserId: userId,
            cloudAgentSessionId: sessionId,
          });
          const attempts: PreparationAttempt[] = await withDORetry(
            () => getSandboxSessionStub(env, userId, sessionId),
            stub => stub.getPreparationAttempts(),
            'getPreparationAttempts'
          );
          return attempts;
        });
      }),

    getLatestAssistantMessage: protectedProcedure
      .input(GetLatestAssistantMessageInput)
      .output(GetLatestAssistantMessageOutput)
      .query(async ({ input, ctx }) => {
        return withLogTags({ source: 'getLatestAssistantMessage' }, async () => {
          const sessionId = input.cloudAgentSessionId as SessionId;
          assertControlSessionId(sessionId);
          const { userId, env } = ctx;

          logger.setTags({ userId, sessionId });
          logger.info('Fetching latest assistant message');
          await requireCurrentSessionAccess({
            env,
            kiloUserId: userId,
            cloudAgentSessionId: sessionId,
          });

          const getStub = () => getSandboxSessionStub(env, userId, sessionId);

          const metadata = await withDORetry<
            DurableObjectStub<SandboxSessionV2>,
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
