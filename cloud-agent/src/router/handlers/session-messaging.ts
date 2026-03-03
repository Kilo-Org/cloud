import { TRPCError } from '@trpc/server';
import { getSandbox } from '@cloudflare/sandbox';
import { logger, withLogTags } from '../../logger.js';
import type { SandboxId, SessionId } from '../../types.js';
import { wrapStreamingErrors } from '../../streaming-helpers.js';
import { InvalidSessionMetadataError, SessionService } from '../../session-service.js';
import {
  autoCommitChangesStream,
  cleanupWorkspace,
  createSandboxUsageEvent,
  updateGitRemoteToken,
} from '../../workspace.js';
import { withDORetry } from '../../utils/do-retry.js';
import { protectedProcedure } from '../auth.js';
import { SendMessageInput } from '../schemas.js';
import { translateSessionError } from '../error-handling.js';

/**
 * Creates session messaging handlers.
 * These handlers send messages/prompts to existing sessions.
 */
export function createSessionMessagingHandlers() {
  return {
    /**
     * Send a message/prompt using an existing established session with streaming output
     */
    // Balance validation is performed in worker entry (index.ts) before tRPC handler
    sendMessageStream: protectedProcedure.input(SendMessageInput).subscription(async function* ({
      input,
      ctx,
    }) {
      return yield* withLogTags({ source: 'sendMessageStream' }, async function* () {
        const startTime = Date.now();
        const sessionId: SessionId = input.sessionId as SessionId;

        const sessionService = new SessionService();
        let sandboxId: SandboxId;
        try {
          sandboxId = await sessionService.getSandboxIdForSession(ctx.env, ctx.userId, sessionId);
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
          userId: ctx.userId,
          orgId: sessionService.metadata?.orgId ?? '',
          sandboxId,
          sessionId,
          mode: input.mode,
          model: input.model,
          kiloSessionId: sessionService.metadata?.kiloSessionId,
        });

        logger.debug('Processing message stream');

        // TODO: Handle cleanup on generator teardown (cancel CLI execution if supported by sandbox API)

        async function* sendMessageGenerator() {
          yield {
            streamEventType: 'status',
            message: 'Initializing session...',
            timestamp: new Date().toISOString(),
            sessionId,
          } as const;

          const sandbox = getSandbox(ctx.env.Sandbox, sandboxId);

          yield {
            streamEventType: 'status',
            message: 'Preparing session environment...',
            timestamp: new Date().toISOString(),
            sessionId,
          } as const;

          let prepared;
          try {
            prepared = await sessionService.resume({
              sandbox,
              sandboxId,
              orgId: sessionService.metadata?.orgId ?? '',
              userId: ctx.userId,
              sessionId,
              kilocodeToken: ctx.authToken,
              kilocodeModel: input.model,
              env: ctx.env,
              githubToken: input.githubToken,
              gitToken: input.gitToken,
            });
          } catch (error) {
            translateSessionError(error, sessionId);
          }

          const { context: sessionContext, session, streamKilocodeExec } = prepared;
          logger.withTags({ branchName: sessionContext.branchName }).info('Session prepared');

          // Update githubToken if provided (only for GitHub-based sessions)
          if (input.githubToken) {
            if (!sessionService.metadata?.githubRepo) {
              logger.warn('githubToken provided but session is not GitHub-based, ignoring');
            } else {
              // Update DO for future cold starts (with retry)
              const doKey = `${ctx.userId}:${sessionId}`;
              const githubToken = input.githubToken;
              await withDORetry(
                () =>
                  ctx.env.CLOUD_AGENT_SESSION.get(ctx.env.CLOUD_AGENT_SESSION.idFromName(doKey)),
                stub => stub.updateGithubToken(githubToken),
                'updateGithubToken'
              );

              // Update in-memory metadata for the rest of this request
              sessionService.metadata.githubToken = input.githubToken;
              logger.info('Updated githubToken in session metadata');

              // Update git remote for current warm start
              const gitUrl = `https://github.com/${sessionService.metadata.githubRepo}.git`;
              await updateGitRemoteToken(
                session,
                sessionContext.workspacePath,
                gitUrl,
                input.githubToken
              );
            }
          }

          // Update gitToken if provided (only for gitUrl-based sessions)
          if (input.gitToken) {
            if (!sessionService.metadata?.gitUrl) {
              logger.warn('gitToken provided but session is not gitUrl-based, ignoring');
            } else {
              // Update DO for future cold starts (with retry)
              const doKey = `${ctx.userId}:${sessionId}`;
              const gitToken = input.gitToken;
              await withDORetry(
                () =>
                  ctx.env.CLOUD_AGENT_SESSION.get(ctx.env.CLOUD_AGENT_SESSION.idFromName(doKey)),
                stub => stub.updateGitToken(gitToken),
                'updateGitToken'
              );

              // Update in-memory metadata for the rest of this request
              sessionService.metadata.gitToken = input.gitToken;
              logger.info('Updated gitToken in session metadata');

              // Update git remote for current warm start
              await updateGitRemoteToken(
                session,
                sessionContext.workspacePath,
                sessionService.metadata.gitUrl,
                input.gitToken,
                sessionService.metadata.platform
              );
            }
          }

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

          logger.debug('Executing Kilocode');

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
              sessionService.metadata?.upstreamBranch
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

        yield* wrapStreamingErrors(sendMessageGenerator(), { sessionId, ctx });
      });
    }),
  };
}
