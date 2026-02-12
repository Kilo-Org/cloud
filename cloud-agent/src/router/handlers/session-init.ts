import { getSandbox } from '@cloudflare/sandbox';
import { TRPCError } from '@trpc/server';
import { logger, withLogTags } from '../../logger.js';
import type { CloudAgentTags } from '../../logger.js';
import { generateSandboxId } from '../../sandbox-id.js';
import type { SandboxId, SessionId } from '../../types.js';
import { wrapStreamingErrors } from '../../streaming-helpers.js';
import { generateSessionId, SessionService } from '../../session-service.js';
import {
  autoCommitChangesStream,
  cleanupWorkspace,
  createSandboxUsageEvent,
} from '../../workspace.js';
import { invokeCallback } from '../../callbacks.js';
import { withDORetry } from '../../utils/do-retry.js';
import { protectedProcedure } from '../auth.js';
import {
  InitiateSessionInput,
  InitiateSessionAsyncInput,
  InitiateFromKiloSessionInputCombined,
} from '../schemas.js';
import { translateSessionError } from '../error-handling.js';
import { MetadataSchema } from '../../persistence/schemas.js';

/**
 * Creates session initialization handlers.
 * These handlers create new sessions in the sandbox environment.
 */
export function createSessionInitHandlers() {
  return {
    /**
     * Initialize a new session in a github repository with streaming output
     */
    // Balance validation is performed in worker entry (index.ts) before tRPC handler
    // to ensure proper HTTP status codes (401, 402) are returned before SSE stream opens
    initiateSessionStream: protectedProcedure
      .input(InitiateSessionInput)
      .subscription(async function* ({ input, ctx }) {
        return yield* withLogTags({ source: 'initiateSessionStream' }, async function* () {
          const startTime = Date.now();

          // Keep orgId as the actual organization ID (undefined for personal accounts)
          const orgId = input.kilocodeOrganizationId;

          // Build sandboxId for isolation
          const sandboxId: SandboxId = await generateSandboxId(orgId, ctx.userId, ctx.botId);

          const sessionId: SessionId = generateSessionId();

          logger.setTags({
            userId: ctx.userId,
            orgId: orgId ?? '(personal)',
            botId: ctx.botId,
            sandboxId,
            sessionId,
            mode: input.mode,
            model: input.model,
            githubRepo: input.githubRepo,
          });

          logger.info('Starting session stream initiation');
          const sessionService = new SessionService();

          // TODO: Handle cleanup on generator teardown (cancel CLI execution if supported by sandbox API)

          async function* initiateSessionGenerator() {
            yield {
              streamEventType: 'status',
              message: 'Initializing session...',
              timestamp: new Date().toISOString(),
              sessionId,
            } as const;

            yield {
              streamEventType: 'status',
              message: 'Preparing session environment...',
              timestamp: new Date().toISOString(),
              sessionId,
            } as const;

            let prepared;
            try {
              prepared = await sessionService.initiateWithRetry({
                getSandbox: async () => getSandbox(ctx.env.Sandbox, sandboxId),
                sandboxId,
                orgId,
                userId: ctx.userId,
                sessionId,
                kilocodeToken: ctx.authToken,
                kilocodeModel: input.model,
                githubRepo: input.githubRepo,
                githubToken: input.githubToken,
                gitUrl: input.gitUrl,
                gitToken: input.gitToken,
                platform: input.platform,
                env: ctx.env,
                envVars: input.envVars,
                setupCommands: input.setupCommands,
                mcpServers: input.mcpServers,
                upstreamBranch: input.upstreamBranch,
                botId: ctx.botId,
                createdOnPlatform: input.createdOnPlatform,
              });
            } catch (error) {
              translateSessionError(error, sessionId);
            }

            const { context: sessionContext, session, streamKilocodeExec } = prepared;
            logger
              .withTags({
                workspacePath: sessionContext.workspacePath,
                branchName: sessionContext.branchName,
              })
              .info('Session prepared');

            yield await createSandboxUsageEvent(session, sessionId);

            yield {
              streamEventType: 'status',
              message: 'Session environment ready.',
              timestamp: new Date().toISOString(),
              sessionId,
            } as const;

            yield {
              streamEventType: 'status',
              message: `Starting Kilocode execution in ${input.mode} mode...`,
              timestamp: new Date().toISOString(),
              sessionId,
            } as const;

            logger.info('Executing initial prompt');

            let interrupted = false;
            for await (const event of streamKilocodeExec(input.mode, input.prompt, {
              sessionId,
              images: input.images,
            })) {
              yield event;
              if (event.streamEventType === 'interrupted') {
                interrupted = true;
                break;
              }
            }

            const usageEvent = await createSandboxUsageEvent(session, sessionId);
            yield usageEvent;

            if (interrupted) {
              logger.info('Session execution interrupted; skipping post-exec steps');
              return;
            }

            // Auto-commit if requested
            if (input.autoCommit) {
              yield* autoCommitChangesStream(
                session,
                sessionContext.workspacePath,
                streamKilocodeExec,
                sessionId,
                input.upstreamBranch
              );
            }

            if (usageEvent.isLow) {
              logger.info('Low disk space detected, cleaning up workspace');
              await cleanupWorkspace(
                session,
                sessionContext.workspacePath,
                sessionContext.sessionHome
              );

              yield await createSandboxUsageEvent(session, sessionId);
            }

            const endTime = Date.now();
            const executionTimeMs = endTime - startTime;

            yield {
              streamEventType: 'complete',
              sessionId,
              exitCode: 0,
              metadata: {
                executionTimeMs,
                workspace: sessionContext.workspacePath,
                userId: ctx.userId,
                startedAt: new Date(startTime).toISOString(),
                completedAt: new Date(endTime).toISOString(),
              },
            } as const;
          }

          yield* wrapStreamingErrors(initiateSessionGenerator(), { sessionId, ctx });
        });
      }),

    /**
     * Initialize a new session with callback notification on completion.
     *
     * This endpoint is identical to initiateSessionStream but adds callback support.
     * When the session completes or errors, it will POST to the provided callbackUrl.
     *
     * Use this for fire-and-forget scenarios where the consumer may not maintain
     * a persistent connection to receive SSE events (e.g., code review orchestration).
     *
     */
    // Balance validation is performed in worker entry (index.ts) before tRPC handler
    initiateSessionAsync: protectedProcedure
      .input(InitiateSessionAsyncInput)
      .subscription(async function* ({ input, ctx }) {
        const { callbackUrl, callbackHeaders } = input;

        return yield* withLogTags({ source: 'initiateSessionAsync' }, async function* () {
          const startTime = Date.now();
          const sessionId = generateSessionId();

          // Keep orgId as the actual organization ID (undefined for personal accounts)
          const orgId = input.kilocodeOrganizationId;

          // Build sandboxId for isolation
          const sandboxId: SandboxId = await generateSandboxId(orgId, ctx.userId, ctx.botId);

          logger.setTags({
            userId: ctx.userId,
            orgId: orgId ?? '(personal)',
            botId: ctx.botId,
            sandboxId,
            sessionId,
            mode: input.mode,
            model: input.model,
            githubRepo: input.githubRepo,
            hasCallback: true,
          });

          logger.info('Starting async session with callback');
          const sessionService = new SessionService();

          async function* initiateSessionAsyncGenerator() {
            yield {
              streamEventType: 'status',
              message: 'Initializing session...',
              timestamp: new Date().toISOString(),
              sessionId,
            } as const;

            yield {
              streamEventType: 'status',
              message: 'Preparing session environment...',
              timestamp: new Date().toISOString(),
              sessionId,
            } as const;

            let prepared;
            try {
              prepared = await sessionService.initiateWithRetry({
                getSandbox: async () => getSandbox(ctx.env.Sandbox, sandboxId),
                sandboxId,
                orgId,
                userId: ctx.userId,
                sessionId: sessionId,
                kilocodeToken: ctx.authToken,
                kilocodeModel: input.model,
                githubRepo: input.githubRepo,
                githubToken: input.githubToken,
                gitUrl: input.gitUrl,
                gitToken: input.gitToken,
                platform: input.platform,
                env: ctx.env,
                envVars: input.envVars,
                setupCommands: input.setupCommands,
                mcpServers: input.mcpServers,
                upstreamBranch: input.upstreamBranch,
                botId: ctx.botId,
                createdOnPlatform: input.createdOnPlatform,
                // Use shallow clone for async sessions (faster, less disk space)
                shallow: true,
              });
            } catch (error) {
              translateSessionError(error, sessionId);
            }

            const { context: sessionContext, session, streamKilocodeExec } = prepared;
            logger
              .withTags({
                workspacePath: sessionContext.workspacePath,
                branchName: sessionContext.branchName,
              })
              .info('Session prepared');

            yield await createSandboxUsageEvent(session, sessionId);

            yield {
              streamEventType: 'status',
              message: 'Session environment ready.',
              timestamp: new Date().toISOString(),
              sessionId,
            } as const;

            yield {
              streamEventType: 'status',
              message: `Starting Kilocode execution in ${input.mode} mode...`,
              timestamp: new Date().toISOString(),
              sessionId,
            } as const;

            logger.info('Executing initial prompt');

            // Interrupt polling is enabled for this session to allow for manual interruption.
            // Note: For long-running async workflows (e.g., code reviews), disabling interrupt polling
            // may be necessary to avoid hitting Cloudflare's subrequest limit, but in this context it is set to false.
            // Infrastructure interruptions (RPC disconnects, container failures, etc.) will still be handled appropriately.
            let interrupted = false;
            for await (const event of streamKilocodeExec(input.mode, input.prompt, {
              sessionId,
              skipInterruptPolling: false,
              images: input.images,
            })) {
              yield event;
              if (event.streamEventType === 'interrupted' || event.streamEventType === 'error') {
                interrupted = true;
                break;
              }
            }

            yield await createSandboxUsageEvent(session, sessionId);

            // sessionId is assigned at generator start, so it's always available here
            const confirmedSessionId = sessionId;

            if (interrupted) {
              logger.info('Session execution interrupted/failed; skipping post-exec steps');

              // Invoke callback with interrupted/failed status
              logger.info('Invoking callback for interrupted session');
              await invokeCallback(callbackUrl, callbackHeaders, {
                sessionId: confirmedSessionId,
                status: 'interrupted',
              });

              // Auto-cleanup still happens in the finally block below
              // But skip: auto-commit and complete event
              return;
            }

            // Auto-commit if requested
            logger.info(`Checking for auto-commit request: ${input.autoCommit}`);
            if (input.autoCommit) {
              yield* autoCommitChangesStream(
                session,
                sessionContext.workspacePath,
                streamKilocodeExec,
                confirmedSessionId,
                input.upstreamBranch
              );
            }

            const endTime = Date.now();
            const executionTimeMs = endTime - startTime;

            yield {
              streamEventType: 'complete',
              sessionId: confirmedSessionId,
              exitCode: 0,
              metadata: {
                executionTimeMs,
                workspace: sessionContext.workspacePath,
                userId: ctx.userId,
                startedAt: new Date(startTime).toISOString(),
                completedAt: new Date(endTime).toISOString(),
              },
            } as const;

            // Invoke callback on successful completion
            logger.info('Invoking callback for successful completion');
            await invokeCallback(callbackUrl, callbackHeaders, {
              sessionId: confirmedSessionId,
              status: 'completed',
            });

            // Auto-cleanup - best effort (don't fail if stream already disconnected)
            try {
              logger.info('Auto-cleaning workspace after async session completion');
              await cleanupWorkspace(
                session,
                sessionContext.workspacePath,
                sessionContext.sessionHome
              );

              logger.info('Destroying session metadata after async completion');
              const doKey = `${ctx.userId}:${confirmedSessionId}`;
              await withDORetry(
                () =>
                  ctx.env.CLOUD_AGENT_SESSION.get(ctx.env.CLOUD_AGENT_SESSION.idFromName(doKey)),
                stub => stub.deleteSession(),
                'deleteSession'
              );
            } catch (cleanupError) {
              logger
                .withFields({
                  error:
                    cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
                })
                .warn('Cleanup after async session failed (non-fatal)');
            }
          }

          // Wrap with error handling that also invokes callback on errors
          async function* wrappedGenerator() {
            try {
              yield* initiateSessionAsyncGenerator();
            } catch (error) {
              // Invoke callback on error
              if (sessionId) {
                logger.info('Invoking callback for error');
                await invokeCallback(callbackUrl, callbackHeaders, {
                  sessionId,
                  status: 'failed',
                  errorMessage: error instanceof Error ? error.message : String(error),
                });
              }
              throw error;
            }
          }

          yield* wrapStreamingErrors(wrappedGenerator(), { sessionId: sessionId, ctx });
        });
      }),

    /**
     * Initialize a new cloud-agent session by resuming an existing kilo session.
     *
     * Supports two modes:
     * 1. **Prepared session** (new): Client provides only `cloudAgentSessionId`.
     *    Metadata comes from DO via prepareSession flow.
     * 2. **Legacy mode**: Client provides all params directly (for backwards compatibility).
     */
    // Balance validation is performed in worker entry (index.ts) before tRPC handler
    initiateFromKilocodeSession: protectedProcedure
      .input(InitiateFromKiloSessionInputCombined)
      .subscription(async function* ({ input, ctx }) {
        // Detect which input mode was used:
        // - Prepared session: has cloudAgentSessionId but no prompt
        // - Legacy: has prompt (and kiloSessionId, githubRepo, etc.)
        const isPreparedSession = 'cloudAgentSessionId' in input && !('prompt' in input);

        if (isPreparedSession) {
          // NEW: Prepared session flow
          const preparedInput = input;
          const { cloudAgentSessionId } = preparedInput;

          return yield* withLogTags(
            { source: 'initiateFromKilocodeSession:prepared' },
            async function* () {
              const startTime = Date.now();

              // Get DO ID for atomic initiation
              const doKey = `${ctx.userId}:${cloudAgentSessionId}`;
              const doId = ctx.env.CLOUD_AGENT_SESSION.idFromName(doKey);

              // Atomically initiate - validates state and returns metadata
              const result = await withDORetry(
                () => ctx.env.CLOUD_AGENT_SESSION.get(doId),
                s => s.tryInitiate(),
                'tryInitiate'
              );

              if (!result.success || !result.data) {
                throw new TRPCError({
                  code: 'BAD_REQUEST',
                  message: result.error ?? 'Failed to initiate session',
                });
              }

              // Validate metadata against schema to ensure data integrity
              // This catches any corrupted/malformed data before execution
              const parseResult = MetadataSchema.safeParse(result.data);
              if (!parseResult.success) {
                logger
                  .withFields({ errors: parseResult.error.format() })
                  .error('Metadata schema validation failed after tryInitiate');
                throw new TRPCError({
                  code: 'INTERNAL_SERVER_ERROR',
                  message: 'Session metadata is corrupted or malformed',
                });
              }
              const metadata = parseResult.data;

              // Validate required fields exist in metadata and extract with proper types
              if (
                !metadata.prompt ||
                !metadata.mode ||
                !metadata.model ||
                !metadata.kiloSessionId
              ) {
                throw new TRPCError({
                  code: 'BAD_REQUEST',
                  message:
                    'Session is missing required fields (prompt, mode, model, kiloSessionId)',
                });
              }

              // Validate exactly one git source is present (required by union type)
              if (!metadata.githubRepo && !metadata.gitUrl) {
                throw new TRPCError({
                  code: 'BAD_REQUEST',
                  message: 'Session is missing git source (githubRepo or gitUrl)',
                });
              }
              if (metadata.githubRepo && metadata.gitUrl) {
                throw new TRPCError({
                  code: 'BAD_REQUEST',
                  message: 'Session has both githubRepo and gitUrl - only one is allowed',
                });
              }

              // After validation, extract with explicit types (TypeScript narrows these)
              const execPrompt: string = metadata.prompt;
              const execMode: string = metadata.mode;
              const execModel: string = metadata.model;
              const execKiloSessionId: string = metadata.kiloSessionId;

              // Use the cloudAgentSessionId as our sessionId
              const sessionId = cloudAgentSessionId as SessionId;
              const orgId = metadata.orgId;
              const sandboxId: SandboxId = await generateSandboxId(orgId, ctx.userId, ctx.botId);

              logger.setTags({
                userId: ctx.userId,
                orgId: orgId ?? '(personal)',
                botId: ctx.botId,
                sandboxId,
                sessionId,
                kiloSessionId: execKiloSessionId,
                // Cast mode to expected type - validated via prepareSession schema
                mode: execMode as CloudAgentTags['mode'],
                model: execModel,
                githubRepo: metadata.githubRepo,
                gitUrl: metadata.gitUrl,
                preparedSession: true,
              });

              logger.info('Starting prepared session initiation');
              const sessionService = new SessionService();

              async function* preparedSessionGenerator() {
                yield {
                  streamEventType: 'status',
                  message: 'Resuming from prepared Kilo session...',
                  timestamp: new Date().toISOString(),
                  sessionId,
                } as const;

                yield {
                  streamEventType: 'status',
                  message: 'Preparing session environment...',
                  timestamp: new Date().toISOString(),
                  sessionId,
                } as const;

                let prepared;
                try {
                  // Build base options (shared between GitHub and Git URL sources)
                  const baseOptions = {
                    sandboxId,
                    orgId,
                    userId: ctx.userId,
                    sessionId,
                    kilocodeToken: ctx.authToken,
                    kilocodeModel: execModel,
                    kiloSessionId: execKiloSessionId,
                    env: ctx.env,
                    envVars: metadata.envVars,
                    encryptedSecrets: metadata.encryptedSecrets,
                    setupCommands: metadata.setupCommands,
                    mcpServers: metadata.mcpServers,
                    botId: ctx.botId,
                    // Skip linking - backend already linked during prepareSession
                    skipLinking: true,
                    // Pass existing metadata to preserve preparedAt, initiatedAt, prompt, mode, model, autoCommit
                    existingMetadata: metadata,
                  } as const;

                  // Build git source options based on which source is present
                  // (validation above ensures exactly one is defined)
                  if (metadata.githubRepo) {
                    prepared = await sessionService.initiateFromKiloSessionWithRetry({
                      getSandbox: async () => getSandbox(ctx.env.Sandbox, sandboxId),
                      ...baseOptions,
                      githubRepo: metadata.githubRepo,
                      githubToken: metadata.githubToken,
                    });
                  } else {
                    // metadata.gitUrl is guaranteed to be defined here (validated above)
                    // Use assertion helper to satisfy TypeScript without non-null assertion
                    const gitUrl = metadata.gitUrl;
                    if (!gitUrl) {
                      // This should never happen due to validation above, but satisfies TypeScript
                      throw new TRPCError({
                        code: 'INTERNAL_SERVER_ERROR',
                        message: 'Unexpected: gitUrl is undefined after validation',
                      });
                    }
                    prepared = await sessionService.initiateFromKiloSessionWithRetry({
                      getSandbox: async () => getSandbox(ctx.env.Sandbox, sandboxId),
                      ...baseOptions,
                      gitUrl,
                      gitToken: metadata.gitToken,
                    });
                  }
                } catch (error) {
                  translateSessionError(error, sessionId);
                }

                const { context: sessionContext, session, streamKilocodeExec } = prepared;

                yield await createSandboxUsageEvent(session, sessionId);

                yield {
                  streamEventType: 'status',
                  message: 'Continuing Kilo session...',
                  timestamp: new Date().toISOString(),
                  sessionId,
                } as const;

                // Execute with existing kilo session
                let interrupted = false;
                for await (const event of streamKilocodeExec(execMode, execPrompt, {
                  sessionId,
                })) {
                  yield event;
                  if (event.streamEventType === 'interrupted') {
                    interrupted = true;
                    break;
                  }
                }

                const usageEvent = await createSandboxUsageEvent(session, sessionId);
                yield usageEvent;

                if (interrupted) {
                  logger.info('Session execution interrupted; skipping post-exec steps');
                  return;
                }

                // Auto-commit if requested
                if (metadata.autoCommit) {
                  yield* autoCommitChangesStream(
                    session,
                    sessionContext.workspacePath,
                    streamKilocodeExec,
                    sessionId,
                    metadata.upstreamBranch
                  );
                }

                if (usageEvent.isLow) {
                  logger.info('Low disk space detected, cleaning up workspace');
                  await cleanupWorkspace(
                    session,
                    sessionContext.workspacePath,
                    sessionContext.sessionHome
                  );

                  yield await createSandboxUsageEvent(session, sessionId);
                }

                const endTime = Date.now();
                const executionTimeMs = endTime - startTime;

                yield {
                  streamEventType: 'complete',
                  sessionId,
                  exitCode: 0,
                  metadata: {
                    executionTimeMs,
                    workspace: sessionContext.workspacePath,
                    userId: ctx.userId,
                    startedAt: new Date(startTime).toISOString(),
                    completedAt: new Date(endTime).toISOString(),
                  },
                } as const;
              }

              yield* wrapStreamingErrors(preparedSessionGenerator(), { sessionId, ctx });
            }
          );
        } else {
          // LEGACY: Full params flow - existing implementation
          const legacyInput = input;

          return yield* withLogTags(
            { source: 'initiateFromKilocodeSession:legacy' },
            async function* () {
              const startTime = Date.now();

              const orgId = legacyInput.kilocodeOrganizationId;
              const sandboxId: SandboxId = await generateSandboxId(orgId, ctx.userId, ctx.botId);
              const sessionId: SessionId = generateSessionId();

              logger.setTags({
                userId: ctx.userId,
                orgId: orgId ?? '(personal)',
                botId: ctx.botId,
                sandboxId,
                sessionId,
                kiloSessionId: legacyInput.kiloSessionId,
                mode: legacyInput.mode,
                model: legacyInput.model,
                githubRepo: legacyInput.githubRepo,
                legacyMode: true,
              });

              logger.info('Starting legacy session stream initiation from kilo session');
              const sessionService = new SessionService();

              async function* initiateFromKiloSessionGenerator() {
                yield {
                  streamEventType: 'status',
                  message: 'Resuming from Kilo session...',
                  timestamp: new Date().toISOString(),
                  sessionId,
                } as const;

                yield {
                  streamEventType: 'status',
                  message: 'Preparing session environment...',
                  timestamp: new Date().toISOString(),
                  sessionId,
                } as const;

                let prepared;
                try {
                  prepared = await sessionService.initiateFromKiloSessionWithRetry({
                    getSandbox: async () => getSandbox(ctx.env.Sandbox, sandboxId),
                    sandboxId,
                    orgId,
                    userId: ctx.userId,
                    sessionId,
                    kilocodeToken: ctx.authToken,
                    kilocodeModel: legacyInput.model,
                    kiloSessionId: legacyInput.kiloSessionId,
                    githubRepo: legacyInput.githubRepo,
                    githubToken: legacyInput.githubToken,
                    env: ctx.env,
                    envVars: legacyInput.envVars,
                    setupCommands: legacyInput.setupCommands,
                    mcpServers: legacyInput.mcpServers,
                    botId: ctx.botId,
                  });
                } catch (error) {
                  translateSessionError(error, sessionId);
                }

                const { context: sessionContext, session, streamKilocodeExec } = prepared;

                yield await createSandboxUsageEvent(session, sessionId);

                yield {
                  streamEventType: 'status',
                  message: 'Continuing Kilo session...',
                  timestamp: new Date().toISOString(),
                  sessionId,
                } as const;

                // Execute with existing kilo session
                let interrupted = false;
                for await (const event of streamKilocodeExec(legacyInput.mode, legacyInput.prompt, {
                  sessionId,
                })) {
                  yield event;
                  if (event.streamEventType === 'interrupted') {
                    interrupted = true;
                    break;
                  }
                }

                const usageEvent = await createSandboxUsageEvent(session, sessionId);
                yield usageEvent;

                if (interrupted) {
                  logger.info('Session execution interrupted; skipping post-exec steps');
                  return;
                }

                // Auto-commit if requested
                if (legacyInput.autoCommit) {
                  yield* autoCommitChangesStream(
                    session,
                    sessionContext.workspacePath,
                    streamKilocodeExec,
                    sessionId,
                    undefined // Legacy mode doesn't support upstreamBranch
                  );
                }

                if (usageEvent.isLow) {
                  logger.info('Low disk space detected, cleaning up workspace');
                  await cleanupWorkspace(
                    session,
                    sessionContext.workspacePath,
                    sessionContext.sessionHome
                  );

                  yield await createSandboxUsageEvent(session, sessionId);
                }

                const endTime = Date.now();
                const executionTimeMs = endTime - startTime;

                yield {
                  streamEventType: 'complete',
                  sessionId,
                  exitCode: 0,
                  metadata: {
                    executionTimeMs,
                    workspace: sessionContext.workspacePath,
                    userId: ctx.userId,
                    startedAt: new Date(startTime).toISOString(),
                    completedAt: new Date(endTime).toISOString(),
                  },
                } as const;
              }

              yield* wrapStreamingErrors(initiateFromKiloSessionGenerator(), { sessionId, ctx });
            }
          );
        }
      }),
  };
}
