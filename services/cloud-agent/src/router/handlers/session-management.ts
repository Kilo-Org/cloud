import { TRPCError } from '@trpc/server';
import * as z from 'zod';
import { getSandbox } from '@cloudflare/sandbox';
import { logger, withLogTags } from '../../logger.js';
import { generateSandboxId } from '../../sandbox-id.js';
import type { SessionId, InterruptResult } from '../../types.js';
import type { SandboxId } from '../../types.js';
import type { AgentMode } from '../../schema.js';
import {
  InvalidSessionMetadataError,
  SessionService,
  fetchSessionMetadata,
} from '../../session-service.js';
import {
  cleanupWorkspace,
  getSessionWorkspacePath,
  getSessionHomePath,
  getKilocodeLogFilePath,
  getWrapperLogFilePath,
} from '../../workspace.js';
import { withDORetry } from '../../utils/do-retry.js';
import { protectedProcedure, publicProcedure } from '../auth.js';
import { sessionIdSchema, GetSessionInput, GetSessionOutput } from '../schemas.js';
import { computeExecutionHealth } from '../../core/execution.js';

/**
 * Creates session management handlers.
 * These handlers manage session lifecycle (delete, interrupt, logs) and health checks.
 */
export function createSessionManagementHandlers() {
  const INTERRUPT_GRACE_MS = 2000;
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
        return withLogTags({ source: 'deleteSession' }, async () => {
          const sessionId = input.sessionId as SessionId;
          const { userId, env } = ctx;

          logger.setTags({ userId, sessionId });
          logger.info('Starting session deletion');

          /* - Sandbox deletion is best-effort because the sandbox may already be evicted or unreachable.
           *   Failing here shouldn't block metadata cleanup since the sandbox is ephemeral.
           * - DO/R2 cleanup is not technically critical either because we have life cycle rules,
           *   so the metadata is really semi-persistent state (metadata, CLI state).
           */
          try {
            const metadata = await fetchSessionMetadata(env, userId, sessionId);

            if (!metadata) {
              logger.info('Session not found or already deleted');
              return {
                success: true,
                message: 'Session not found or already deleted',
              };
            }

            const sandboxId: SandboxId = await generateSandboxId(
              metadata.orgId,
              userId,
              metadata.botId
            );

            logger.setTags({ sandboxId, orgId: metadata.orgId ?? '(personal)' });

            const sandbox = getSandbox(env.Sandbox, sandboxId);

            // Clean up workspace directories before deleting sandbox session
            // This prevents disk accumulation from abandoned sessions
            const workspacePath = getSessionWorkspacePath(metadata.orgId, userId, sessionId);
            const sessionHome = getSessionHomePath(sessionId);

            try {
              const session = await sandbox.getSession(sessionId);
              await cleanupWorkspace(session, workspacePath, sessionHome);
              logger.info('Workspace directories cleaned up');
            } catch (error) {
              // Log but don't fail - workspace cleanup is best-effort
              logger
                .withFields({
                  error: error instanceof Error ? error.message : String(error),
                })
                .warn('Failed to clean up workspace directories, continuing with deletion');
            }

            await sandbox
              .deleteSession(sessionId)
              .then(() => logger.info('Cloudflare sandbox session deleted'))
              .catch(error => {
                // Log but don't fail - sandbox cleanup is best-effort
                logger
                  .withFields({
                    error: error instanceof Error ? error.message : String(error),
                  })
                  .warn('Failed to delete Cloudflare sandbox session, continuing with cleanup');
              });

            try {
              const doKey = `${userId}:${sessionId}`;
              await withDORetry(
                () => env.CLOUD_AGENT_SESSION.get(env.CLOUD_AGENT_SESSION.idFromName(doKey)),
                stub => stub.deleteSession(),
                'deleteSession'
              );
              logger.info('Session metadata destroyed');
            } catch (error) {
              const errorMsg = error instanceof Error ? error.message : String(error);
              logger.withFields({ error: errorMsg }).error('Failed to destroy session metadata');

              throw new TRPCError({
                code: 'INTERNAL_SERVER_ERROR',
                message: `Failed to clean up session metadata`,
              });
            }

            logger.info('Session deletion completed successfully');
            return {
              success: true,
            };
          } catch (error) {
            if (error instanceof TRPCError) {
              throw error;
            }

            const errorMsg = error instanceof Error ? error.message : String(error);
            logger.withFields({ error: errorMsg }).error('Session deletion failed');

            throw new TRPCError({
              code: 'INTERNAL_SERVER_ERROR',
              message: `Failed to delete session: ${errorMsg}`,
            });
          }
        });
      }),

    /**
     * Interrupt a running session by killing all associated kilocode processes.
     *
     * This endpoint allows clients to stop running executions in a session without
     * deleting the session itself. Useful for canceling long-running or stuck operations.
     *
     * Idempotency:
     * - Returns success even if no processes are found (already stopped or none running)
     * - Safe to call multiple times for the same session
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
                killedProcessIds: [],
                failedProcessIds: [],
                message: 'Session not found',
              };
            }

            const sandboxId: SandboxId = await generateSandboxId(
              metadata.orgId,
              userId,
              metadata.botId
            );

            logger.setTags({ sandboxId, orgId: metadata.orgId ?? '(personal)' });

            const sandbox = getSandbox(env.Sandbox, sandboxId);

            // Build session context for interrupt service
            const sessionService = new SessionService();
            const context = sessionService.buildContext({
              sandboxId,
              orgId: metadata.orgId,
              userId,
              sessionId,
              upstreamBranch: metadata.upstreamBranch,
              botId: metadata.botId,
            });

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
                .withFields({ message: interruptResult.message ?? 'No active execution' })
                .info('No active execution to interrupt via wrapper');
            }

            await scheduler.wait(INTERRUPT_GRACE_MS);

            const activeExecutionId = await withDORetry(
              getStub,
              stub => stub.getActiveExecutionId(),
              'getActiveExecutionId'
            );

            // Get or create the session to use for killing processes
            const session = await sessionService.getOrCreateSession(
              sandbox,
              context,
              env,
              ctx.authToken,
              metadata.orgId
            );

            // Kill all kilocode processes in this session
            // Use pkill method as a temporary workaround for sandbox API reliability issues
            const usePkill = true;
            const result = await SessionService.interrupt(
              sandbox,
              session,
              context,
              usePkill,
              activeExecutionId ?? undefined
            );

            logger
              .withFields({
                killedCount: result.killedProcessIds.length,
                failedCount: result.failedProcessIds.length,
              })
              .info('Session interruption completed');

            return result;
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
     * Get the CLI log file content for a session.
     *
     * Returns the contents of ~/.kilocode/cli/logs/cli.txt from the session's home directory.
     * This is useful for debugging and monitoring CLI execution.
     */
    getSessionLogs: protectedProcedure
      .input(
        z.object({
          sessionId: sessionIdSchema.describe('Session ID to get logs for'),
        })
      )
      .query(async ({ input, ctx }) => {
        return withLogTags({ source: 'getSessionLogs' }, async () => {
          const sessionId = input.sessionId as SessionId;
          const { userId, env } = ctx;

          logger.setTags({ userId, sessionId });
          logger.info('Fetching session logs');

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

          logger.setTags({ sandboxId, orgId: sessionService.metadata?.orgId ?? '(personal)' });

          const sandbox = getSandbox(env.Sandbox, sandboxId);
          const sessionHome = getSessionHomePath(sessionId);
          const logFilePath = getKilocodeLogFilePath(sessionHome);

          // Get or create a session to read the file
          const context = sessionService.buildContext({
            sandboxId,
            orgId: sessionService.metadata?.orgId,
            userId,
            sessionId,
            botId: sessionService.metadata?.botId,
          });

          const session = await sessionService.getOrCreateSession(
            sandbox,
            context,
            env,
            ctx.authToken,
            sessionService.metadata?.orgId
          );

          logger.withTags({ logFilePath }).debug('Reading log file');

          try {
            const fileInfo = await session.readFile(logFilePath, { encoding: 'utf-8' });

            logger.info('Successfully retrieved session logs');

            return {
              content: fileInfo.content,
              sessionId,
            };
          } catch (error) {
            const errorMsg = error instanceof Error ? error.message : String(error);

            // Check if file doesn't exist
            if (errorMsg.includes('ENOENT') || errorMsg.includes('not found')) {
              throw new TRPCError({
                code: 'NOT_FOUND',
                message: `No log file found for session ${sessionId}. The CLI may not have generated logs yet.`,
              });
            }

            logger.withFields({ error: errorMsg }).error('Failed to read log file');

            throw new TRPCError({
              code: 'INTERNAL_SERVER_ERROR',
              message: `Failed to read log file: ${errorMsg}`,
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
          const metadata = await withDORetry(getStub, s => s.getMetadata(), 'getMetadata');

          // Handle not found
          if (!metadata) {
            logger.info('Session not found');
            throw new TRPCError({
              code: 'NOT_FOUND',
              message: 'Session not found',
            });
          }

          // Fetch queue state from DO
          const activeExecutionId = await withDORetry(
            getStub,
            s => s.getActiveExecutionId(),
            'getActiveExecutionId'
          );

          // Get active execution metadata if there's an active execution
          let activeExecutionStatus:
            | 'pending'
            | 'running'
            | 'completed'
            | 'failed'
            | 'interrupted'
            | null = null;
          let execution: {
            startedAt: number;
            lastHeartbeat?: number;
            processId?: string;
            error?: string;
          } | null = null;

          if (activeExecutionId) {
            const executionData = await withDORetry(
              getStub,
              s => s.getExecution(activeExecutionId),
              'getExecution'
            );
            if (executionData) {
              activeExecutionStatus = executionData.status;
              execution = {
                startedAt: executionData.startedAt,
                lastHeartbeat: executionData.lastHeartbeat,
                processId: executionData.processId,
                error: executionData.error,
              };
            }
          }

          // Get queue depth
          const queuedCount = await withDORetry(getStub, s => s.getQueuedCount(), 'getQueuedCount');

          // Compute sandboxId for log correlation (uses same hash as execution)
          const sandboxId = await generateSandboxId(metadata.orgId, userId, metadata.botId);

          logger.setTags({ sandboxId, orgId: metadata.orgId ?? '(personal)' });
          logger.info('Session metadata retrieved successfully');

          // Compute execution health if there's an active execution
          const executionHealth =
            execution && activeExecutionStatus
              ? computeExecutionHealth(
                  activeExecutionStatus,
                  execution.startedAt,
                  execution.lastHeartbeat
                )
              : null;

          // Sanitize and return safe fields only (no tokens/secrets)
          return {
            sessionId: metadata.sessionId,
            kiloSessionId: metadata.kiloSessionId,
            userId: metadata.userId,
            orgId: metadata.orgId,
            sandboxId,

            githubRepo: metadata.githubRepo,
            gitUrl: metadata.gitUrl,
            // githubToken: OMITTED
            // gitToken: OMITTED

            prompt: metadata.prompt,
            // Cast mode since CloudAgentSessionState.mode is string | undefined
            // but was validated at storage time to be a valid AgentMode
            mode: metadata.mode as AgentMode | undefined,
            model: metadata.model,
            autoCommit: metadata.autoCommit,
            upstreamBranch: metadata.upstreamBranch,

            // Counts only, no actual values
            envVarCount:
              metadata.envVars === undefined ? undefined : Object.keys(metadata.envVars).length,
            setupCommandCount: metadata.setupCommands?.length,
            mcpServerCount:
              metadata.mcpServers === undefined
                ? undefined
                : Object.keys(metadata.mcpServers).length,

            // Execution status (grouped for cleaner API)
            execution:
              activeExecutionId && activeExecutionStatus && execution
                ? {
                    id: activeExecutionId,
                    status: activeExecutionStatus,
                    startedAt: execution.startedAt,
                    lastHeartbeat: execution.lastHeartbeat ?? null,
                    processId: execution.processId ?? null,
                    error: execution.error ?? null,
                    health: executionHealth ?? 'unknown',
                  }
                : null,
            queuedCount,

            // Lifecycle timestamps (critical for idempotency)
            preparedAt: metadata.preparedAt,
            initiatedAt: metadata.initiatedAt,

            callbackTarget: metadata.callbackTarget,

            timestamp: metadata.timestamp,
            version: metadata.version,
          };
        });
      }),

    /**
     * Get the wrapper log file content for a specific execution.
     *
     * Returns the contents of /tmp/kilocode-wrapper-{executionId}.log from the sandbox.
     * This is useful for debugging wrapper startup issues.
     */
    getWrapperLogs: protectedProcedure
      .input(
        z.object({
          sessionId: sessionIdSchema.describe('Session ID'),
          executionId: z.string().describe('Execution ID to get wrapper logs for'),
        })
      )
      .query(async ({ input, ctx }) => {
        return withLogTags({ source: 'getWrapperLogs' }, async () => {
          const sessionId = input.sessionId as SessionId;
          const { executionId } = input;
          const { userId, env } = ctx;

          logger.setTags({ userId, sessionId, executionId });
          logger.info('Fetching wrapper logs');

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

          logger.setTags({ sandboxId, orgId: sessionService.metadata?.orgId ?? '(personal)' });

          const sandbox = getSandbox(env.Sandbox, sandboxId);
          const logFilePath = getWrapperLogFilePath(executionId);

          // Get or create a session to read the file
          const context = sessionService.buildContext({
            sandboxId,
            orgId: sessionService.metadata?.orgId,
            userId,
            sessionId,
            botId: sessionService.metadata?.botId,
          });

          const session = await sessionService.getOrCreateSession(
            sandbox,
            context,
            env,
            ctx.authToken,
            sessionService.metadata?.orgId
          );

          logger.withTags({ logFilePath }).debug('Reading wrapper log file');

          // Fetch running processes for this execution (best-effort)
          let processes: Array<{ pid: number; command: string; status: string }> | undefined;
          try {
            type ProcessInfo = { id: string; status: string; command: string };
            const allProcesses = (await sandbox.listProcesses()) as ProcessInfo[];
            // Filter for processes belonging to this execution
            // The wrapper command includes --execution-id=<executionId>
            processes = allProcesses
              .filter((p: ProcessInfo) => p.command.includes(executionId))
              .map((p: ProcessInfo) => ({
                pid: parseInt(p.id, 10) || 0,
                command: p.command,
                status: p.status,
              }));
          } catch (err) {
            // Sandbox may not be available (evicted, not started, etc.)
            logger.debug('Could not fetch sandbox processes', {
              error: err instanceof Error ? err.message : String(err),
            });
          }

          try {
            const fileInfo = await session.readFile(logFilePath, { encoding: 'utf-8' });

            logger.info('Successfully retrieved wrapper logs');

            return {
              content: fileInfo.content,
              sessionId,
              executionId,
              processes,
            };
          } catch (error) {
            const errorMsg = error instanceof Error ? error.message : String(error);

            // Check if file doesn't exist
            if (errorMsg.includes('ENOENT') || errorMsg.includes('not found')) {
              throw new TRPCError({
                code: 'NOT_FOUND',
                message: `No wrapper log file found for execution ${executionId}. The wrapper may not have started or may have crashed before logging.`,
              });
            }

            logger.withFields({ error: errorMsg }).error('Failed to read wrapper log file');

            throw new TRPCError({
              code: 'INTERNAL_SERVER_ERROR',
              message: `Failed to read wrapper log file: ${errorMsg}`,
            });
          }
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
