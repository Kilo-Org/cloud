import { TRPCError } from '@trpc/server';
import * as z from 'zod';
import { getSandbox } from '@cloudflare/sandbox';
import { logger, withLogTags } from '../../logger.js';
import { generateSandboxId, getSandboxNamespace } from '../../sandbox-id.js';
import type { SessionId, InterruptResult } from '../../types.js';
import type { SandboxId } from '../../types.js';
import {
  InvalidSessionMetadataError,
  SessionService,
  fetchSessionMetadata,
} from '../../session-service.js';
import { cleanupWorkspace, getSessionWorkspacePath, getSessionHomePath } from '../../workspace.js';
import { withDORetry } from '../../utils/do-retry.js';
import { protectedProcedure, publicProcedure, internalApiProtectedProcedure } from '../auth.js';
import {
  sessionIdSchema,
  GetSessionInput,
  GetSessionOutput,
  GetSessionHealthInput,
  GetSessionHealthOutput,
  GetLatestAssistantMessageInput,
  GetLatestAssistantMessageOutput,
} from '../schemas.js';
import { readProfileBundle } from '../../session-profile.js';
import type { CloudAgentSession } from '../../persistence/CloudAgentSession.js';
import type { CloudAgentSessionState } from '../../persistence/types.js';

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

            const sandbox = getSandbox(getSandboxNamespace(env, sandboxId), sandboxId);

            // Clean up workspace directories before deleting sandbox session
            // This prevents disk accumulation from abandoned sessions
            const workspacePath = getSessionWorkspacePath(
              metadata.identity.orgId,
              userId,
              sessionId
            );
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

            const targetExecutionId = interruptResult.executionId;
            if (!targetExecutionId) {
              logger.info('Session interruption completed');
              return {
                success: true,
                message: 'Queued session messages interrupted',
                processesFound: false,
              };
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

            const sandbox = getSandbox(getSandboxNamespace(env, sandboxId), sandboxId);

            // Build session context for interrupt service
            const sessionService = new SessionService();
            const context = sessionService.buildContext({
              sandboxId,
              orgId: metadata.identity.orgId,
              userId,
              sessionId,
              upstreamBranch: metadata.repository?.upstreamBranch,
              botId: metadata.identity.botId,
            });

            await scheduler.wait(INTERRUPT_GRACE_MS);

            // Get or create the session to use for killing processes
            const session = await sessionService.getOrCreateSession({
              sandbox,
              context,
              env,
              originalToken: ctx.authToken,
              originalOrgId: metadata.identity.orgId,
              createdOnPlatform: metadata.identity.createdOnPlatform,
              appendSystemPrompt: metadata.agent?.appendSystemPrompt,
              profile: readProfileBundle(metadata),
            });

            // Kill all kilocode processes in this session
            // Use pkill method as a temporary workaround for sandbox API reliability issues
            const usePkill = true;
            const result = await SessionService.interrupt(
              sandbox,
              session,
              context,
              usePkill,
              targetExecutionId
            );

            logger.info('Session interruption completed');

            // If no processes were found but there's still a runtime execution,
            // the wrapper is already dead - fail the stale execution immediately.
            // Note: pkill always returns killedProcessIds: [], so we check
            // processesFound instead to distinguish "killed" from "nothing to kill".
            if (!result.processesFound && targetExecutionId) {
              logger
                .withFields({ executionId: targetExecutionId })
                .info('No processes found during interrupt - failing stale runtime execution');

              await withDORetry(
                getStub,
                stub =>
                  stub.failExecutionRpc({
                    executionId: targetExecutionId,
                    error: 'Interrupted - no running processes found',
                  }),
                'failExecutionRpc'
              );
            }

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

          const sandbox = getSandbox(getSandboxNamespace(env, sandboxId), sandboxId);
          let sandboxStatus: 'healthy' | 'unreachable' = 'healthy';
          try {
            await sandbox.listProcesses();
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

          const sandbox = getSandbox(getSandboxNamespace(env, sandboxId), sandboxId);

          // Get or create a session to read files
          const context = sessionService.buildContext({
            sandboxId,
            orgId: sessionService.metadata?.identity.orgId,
            userId,
            sessionId,
            botId: sessionService.metadata?.identity.botId,
          });

          const session = await sessionService.getOrCreateSession({
            sandbox,
            context,
            env,
            originalToken: ctx.authToken,
            originalOrgId: sessionService.metadata?.identity.orgId,
            createdOnPlatform: sessionService.metadata?.identity.createdOnPlatform,
            appendSystemPrompt: sessionService.metadata?.agent?.appendSystemPrompt,
            profile: sessionService.metadata
              ? readProfileBundle(sessionService.metadata)
              : undefined,
          });

          // Discover all log files from the sandbox
          const logPaths: string[] = [];

          // 1. Wrapper logs: /tmp/kilocode-wrapper-*.log (one per execution)
          try {
            const tmpFiles = await session.listFiles('/tmp');
            if (tmpFiles.success) {
              for (const f of tmpFiles.files) {
                if (
                  f.type === 'file' &&
                  f.name.startsWith('kilocode-wrapper-') &&
                  f.name.endsWith('.log')
                ) {
                  logPaths.push(f.absolutePath);
                }
              }
            }
          } catch {
            logger.debug('Could not list /tmp for wrapper logs');
          }

          // 2. CLI logs: {sessionHome}/.local/share/kilo/log/ (matches wrapper R2 uploader)
          const sessionHome = getSessionHomePath(sessionId);
          const cliLogsDir = `${sessionHome}/.local/share/kilo/log`;
          try {
            const cliFiles = await session.listFiles(cliLogsDir, { recursive: true });
            if (cliFiles.success) {
              for (const f of cliFiles.files) {
                if (f.type === 'file') {
                  logPaths.push(f.absolutePath);
                }
              }
            }
          } catch {
            logger.debug('Could not list CLI logs directory', { cliLogsDir });
          }

          // Read all discovered files in parallel (best-effort per file)
          const files: Record<string, string> = {};
          const readResults = await Promise.allSettled(
            logPaths.map(async path => {
              const fileInfo = await session.readFile(path, { encoding: 'utf-8' });
              return { path, content: fileInfo.content };
            })
          );
          for (const result of readResults) {
            if (result.status === 'fulfilled') {
              files[result.value.path] = result.value.content;
            }
          }

          // Fetch running processes (best-effort)
          let processes: Array<{ pid: number; command: string; status: string }> | undefined;
          try {
            type ProcessInfo = { id: string; status: string; command: string };
            const allProcesses = (await sandbox.listProcesses()) as ProcessInfo[];
            processes = allProcesses.map((p: ProcessInfo) => ({
              pid: parseInt(p.id, 10) || 0,
              command: p.command,
              status: p.status,
            }));
          } catch (err) {
            logger.debug('Could not fetch sandbox processes', {
              error: err instanceof Error ? err.message : String(err),
            });
          }

          logger.info('Successfully retrieved session logs', {
            fileCount: Object.keys(files).length,
          });

          return {
            sessionId,
            files,
            processes,
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
