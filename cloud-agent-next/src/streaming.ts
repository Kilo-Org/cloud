import { parseSSEStream } from '@cloudflare/sandbox';
import { stripVTControlCharacters } from 'node:util';
import type {
  ExecutionSession,
  SandboxInstance,
  SessionContext,
  StreamEvent,
  SystemErrorEvent,
  SystemInterruptedEvent,
  SystemKilocodeEvent,
  SystemOutputEvent,
} from './types.js';
import { tryParseJson, isTerminalKilocodeEvent } from './streaming-helpers.js';
import type { PersistenceEnv } from './persistence/types.js';
import { logger } from './logger.js';
import { z } from 'zod';
import { withDORetry } from './utils/do-retry.js';
import { downloadImagesToSandbox, buildAttachArgs } from './utils/image-download.js';
import { createR2Client } from './utils/r2-client.js';
import type { Images } from './router/schemas.js';

const uuidSchema = z.uuid();

const DEFAULT_CLI_TIMEOUT_SECONDS = 900;
const STREAM_TIMEOUT_BUFFER_SECONDS = 60;

function emitKilocodeEvent(
  payload: Record<string, unknown>,
  sessionId?: string
): SystemKilocodeEvent {
  return {
    streamEventType: 'kilocode',
    payload,
    sessionId,
  };
}

function emitOutputEvent(
  content: string,
  source: 'stdout' | 'stderr',
  timestamp: string,
  sessionId?: string
): SystemOutputEvent {
  return {
    streamEventType: 'output',
    content: stripVTControlCharacters(content),
    source,
    timestamp,
    sessionId,
  };
}

/**
 * Kills all kilocode processes running in the specific session's workspace.
 * Used for cleanup when stream terminates abnormally.
 */
async function killKilocodeProcesses(
  sandbox: SandboxInstance,
  session: ExecutionSession,
  context: SessionContext
): Promise<void> {
  try {
    interface ProcessInfo {
      id: string;
      status: string;
      command: string;
    }

    const processes = await sandbox.listProcesses();
    const targetProcesses = processes.filter((proc: ProcessInfo) => {
      const isRunning = proc.status === 'running';
      const isKilocode = proc.command.includes('kilocode');
      const isInWorkspace = proc.command.includes(`--workspace=${context.workspacePath}`);
      return isRunning && isKilocode && isInWorkspace;
    });

    if (targetProcesses.length === 0) {
      logger.debug('No kilocode processes to kill during cleanup');
      return;
    }

    for (const proc of targetProcesses) {
      try {
        await session.killProcess(proc.id, 'SIGTERM');
        logger.info('Killed kilocode process during cleanup', { processId: proc.id });
      } catch (err) {
        logger.warn('Failed to kill kilocode process', {
          processId: proc.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  } catch (err) {
    logger.warn('Failed to list processes for cleanup', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Streams Kilocode CLI execution output as structured events using async generators.
 * Parses nd-json output from stdout and wraps Kilocode JSON events in SystemKilocodeEvent.
 * All events use streamEventType discriminator.
 *
 * Includes safeguards for termination:
 * - Server-side timeout (CLI timeout + 2 minutes buffer) to catch hanging streams
 * - Detection of terminal Kilocode events (e.g., api_req_failed) that indicate unrecoverable states
 * - Process cleanup when stream terminates abnormally
 */
export async function* streamKilocodeExecution(
  sandbox: SandboxInstance,
  session: ExecutionSession,
  sessionCtx: SessionContext,
  mode: string,
  prompt: string,
  options?: {
    sessionId?: string;
    skipInterruptPolling?: boolean;
    isFirstExecution?: boolean;
    kiloSessionId?: string;
    images?: Images;
  },
  env?: PersistenceEnv
): AsyncGenerator<StreamEvent> {
  const cliTimeoutSeconds = Number(env?.CLI_TIMEOUT_SECONDS ?? DEFAULT_CLI_TIMEOUT_SECONDS);
  const streamTimeoutSeconds = cliTimeoutSeconds + STREAM_TIMEOUT_BUFFER_SECONDS;
  const tmpFile = `/tmp/kilocode-prompt-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`;
  await session.writeFile(tmpFile, prompt);

  // Download images if provided
  let attachArgs = '';
  if (
    options?.images &&
    env?.R2_ATTACHMENTS_READONLY_ACCESS_KEY_ID &&
    env?.R2_ATTACHMENTS_READONLY_SECRET_ACCESS_KEY &&
    env?.R2_ENDPOINT &&
    env?.R2_ATTACHMENTS_BUCKET &&
    sessionCtx.userId
  ) {
    const r2Client = createR2Client({
      accessKeyId: env.R2_ATTACHMENTS_READONLY_ACCESS_KEY_ID,
      secretAccessKey: env.R2_ATTACHMENTS_READONLY_SECRET_ACCESS_KEY,
      endpoint: env.R2_ENDPOINT,
    });

    const { localPaths, errors } = await downloadImagesToSandbox(
      r2Client,
      env.R2_ATTACHMENTS_BUCKET,
      session,
      sessionCtx.userId,
      options.images
    );

    if (errors.length > 0) {
      throw new Error(`Failed to download images: ${errors.join(', ')}`);
    }

    attachArgs = buildAttachArgs(localPaths);
  }

  // Use provided kiloSessionId when resuming; otherwise skip --session
  const kiloSessionId: string | undefined = options?.kiloSessionId;
  const sessionFlag = kiloSessionId ? ` --session=${kiloSessionId}` : '';

  const command = `HOME=${sessionCtx.sessionHome} cat ${tmpFile} | kilocode --mode=${mode} --workspace=${sessionCtx.workspacePath} --auto --timeout=${cliTimeoutSeconds} --json${sessionFlag} ${attachArgs}`;
  const stream = await session.execStream(command);
  const { sessionId, skipInterruptPolling } = options ?? {};

  let kiloSessionIdCaptured = false; // Track if we've already captured a kiloSessionId
  let abnormalTermination = false;
  let terminationReason = '';

  // Set up server-side timeout as a safety net
  let streamTimeoutId: ReturnType<typeof setTimeout> | null = null;
  const streamTimeoutPromise = new Promise<never>((_, reject) => {
    streamTimeoutId = setTimeout(() => {
      reject(new Error('STREAM_TIMEOUT'));
    }, streamTimeoutSeconds * 1000);
  });

  // Set up interrupt detection if we have access to the DO and polling is not skipped
  // skipInterruptPolling is used for automated sessions (e.g., code reviews) where
  // manual interruption is not needed and we want to avoid DO subrequest overhead
  let interruptPromise: Promise<never> | null = null;
  let interruptInterval: ReturnType<typeof setInterval> | null = null;
  if (env && !skipInterruptPolling) {
    const doKey = `${sessionCtx.userId}:${sessionCtx.sessionId}`;

    // Clear any stale interrupt flag from previous runs (with retry)
    await withDORetry(
      () => env.CLOUD_AGENT_SESSION.get(env.CLOUD_AGENT_SESSION.idFromName(doKey)),
      stub => stub.clearInterrupted(),
      'clearInterrupted'
    );

    // Create a promise that rejects when interrupt is detected
    // Note: isInterrupted() polling does NOT use retry wrapper - the 10-second interval
    // provides natural retry behavior, and we want to avoid excessive subrequests
    interruptPromise = new Promise((_, reject) => {
      const handle = setInterval(async () => {
        try {
          const metadataDO = env.CLOUD_AGENT_SESSION.get(env.CLOUD_AGENT_SESSION.idFromName(doKey));
          const interrupted = await metadataDO.isInterrupted();
          if (interrupted) {
            clearInterval(handle);
            logger.info('External interrupt detected, cancelling stream');
            reject(new Error('EXTERNAL_INTERRUPT'));
          }
        } catch (err) {
          logger.error('Failed to check interrupt status', { error: String(err) });
        }
      }, 10_000); // Poll every 10 seconds to avoid hitting Cloudflare's 1000 subrequest limit
      interruptInterval = handle;
    });
  }

  try {
    // Create async iterator from parseSSEStream
    const streamIterator = parseSSEStream(stream)[Symbol.asyncIterator]();

    while (true) {
      // Race between getting the next event, interrupt detection, and server-side timeout
      const nextPromise = streamIterator.next();
      const racers: Promise<IteratorResult<unknown, unknown>>[] = [nextPromise];

      // Add interrupt promise if available (not for skipInterruptPolling sessions)
      if (interruptPromise) {
        racers.push(interruptPromise);
      }

      // Always add server-side timeout
      racers.push(streamTimeoutPromise);

      const result = await Promise.race(racers);

      if (result.done) break;

      const rawEvent = result.value;
      if (typeof rawEvent !== 'object' || !rawEvent) continue;
      const event = rawEvent as Record<string, unknown>;
      if (typeof event.type !== 'string') continue;

      const timestamp = new Date().toISOString();

      switch (event.type) {
        case 'stdout': {
          const data = String(event.data || '');
          const lines = data.split('\n').filter((line: string) => line.trim());

          for (const line of lines) {
            const parsed = tryParseJson(line);

            if (parsed !== null) {
              // Check if this is a session_created event
              if (
                parsed.event === 'session_created' &&
                parsed.sessionId &&
                !kiloSessionIdCaptured
              ) {
                const capturedSessionId = String(parsed.sessionId);
                const uuidResult = uuidSchema.safeParse(capturedSessionId);
                if (uuidResult.success) {
                  kiloSessionIdCaptured = true;

                  // Store the kiloSessionId in the durable object with retry (non-blocking)
                  if (env) {
                    const doKey = `${sessionCtx.userId}:${sessionCtx.sessionId}`;

                    try {
                      await withDORetry(
                        () =>
                          env.CLOUD_AGENT_SESSION.get(env.CLOUD_AGENT_SESSION.idFromName(doKey)),
                        stub => stub.updateKiloSessionId(capturedSessionId),
                        'updateKiloSessionId'
                      );
                      logger
                        .withFields({ kiloSessionId: capturedSessionId })
                        .info('Captured Kilo CLI session ID');
                    } catch (error) {
                      logger
                        .withFields({
                          kiloSessionId: capturedSessionId,
                          error: error instanceof Error ? error.message : String(error),
                        })
                        .error('Failed to save kiloSessionId');
                      // Continue streaming despite failure
                    }
                  }
                } else {
                  logger
                    .withFields({ invalidSessionId: capturedSessionId })
                    .warn('Invalid kiloSessionId format, expected UUID');
                }
              } else if (parsed.event === 'session_created' && kiloSessionIdCaptured) {
                logger
                  .withFields({ sessionId: String(parsed.sessionId) })
                  .warn('Duplicate session_created event ignored');
              }

              // Check if this is a terminal event that should stop the stream
              const terminalCheck = isTerminalKilocodeEvent(parsed);
              if (terminalCheck.isTerminal) {
                logger.warn('Terminal Kilocode event detected', {
                  eventType: parsed.type,
                  ask: parsed.ask,
                  reason: terminalCheck.reason,
                });

                // Emit the terminal event so client knows what happened
                yield emitKilocodeEvent(parsed, sessionId);

                // Set termination state and throw to exit the loop
                abnormalTermination = true;
                terminationReason = terminalCheck.reason ?? 'Terminal event received';
                throw new Error('TERMINAL_EVENT');
              }

              yield emitKilocodeEvent(parsed, sessionId);
            } else {
              yield emitOutputEvent(line, 'stdout', timestamp, sessionId);
            }
          }
          break;
        }

        case 'stderr': {
          yield emitOutputEvent(String(event.data || ''), 'stderr', timestamp, sessionId);
          break;
        }

        case 'complete': {
          const exitCode = Number.parseInt(String(event.exitCode || 0));

          // Check if this was an interrupt (SIGINT=130, SIGTERM=143, SIGKILL=137)
          if (exitCode === 130 || exitCode === 143 || exitCode === 137) {
            const reason =
              exitCode === 130
                ? 'Interrupted (SIGINT)'
                : exitCode === 143
                  ? 'Terminated (SIGTERM)'
                  : 'Killed (SIGKILL)';
            yield {
              streamEventType: 'interrupted',
              sessionId: options?.sessionId ?? sessionCtx.sessionId,
              timestamp: new Date().toISOString(),
              reason,
            } satisfies SystemInterruptedEvent;
            return; // Exit generator, closing the stream
          }

          // Handle timeout (exit code 124)
          if (exitCode === 124) {
            throw new Error(
              `CLI execution exceeded the ${cliTimeoutSeconds}s timeout limit. ` +
                `The AI agent's task execution took too long. Try simplifying your request.`
            );
          }

          // Handle other failures
          if (exitCode !== 0) {
            logger.withFields({ exitCode }).error('Streaming execution failed');
            throw new Error(`CLI exited with code ${exitCode}`);
          }

          // Success case
          logger.info('Streaming execution completed');
          return;
        }

        case 'error': {
          yield {
            streamEventType: 'error',
            error: String(event.error || 'Unknown error'),
            timestamp,
            sessionId,
          };
          break;
        }
      }
    }
  } catch (error) {
    // Check if this was due to external interrupt
    if (error instanceof Error && error.message === 'EXTERNAL_INTERRUPT') {
      // Stream was cancelled due to external interrupt
      yield {
        streamEventType: 'interrupted',
        sessionId: sessionId ?? sessionCtx.sessionId,
        timestamp: new Date().toISOString(),
        reason: 'Interrupted by user request',
      } satisfies SystemInterruptedEvent;
      return;
    }

    // Check if this was a stream timeout
    if (error instanceof Error && error.message === 'STREAM_TIMEOUT') {
      logger.error('Stream timeout exceeded', {
        sessionId: sessionId ?? sessionCtx.sessionId,
        timeoutSeconds: streamTimeoutSeconds,
      });
      abnormalTermination = true;
      terminationReason = `Stream timeout exceeded (${streamTimeoutSeconds / 60} minutes)`;

      // Emit error event before cleanup
      yield {
        streamEventType: 'error',
        error: terminationReason,
        timestamp: new Date().toISOString(),
        sessionId,
      } satisfies SystemErrorEvent;

      // Don't re-throw, let finally block handle cleanup
      return;
    }

    // Check if this was a terminal event
    if (error instanceof Error && error.message === 'TERMINAL_EVENT') {
      logger.warn('Stream terminated due to terminal event', {
        sessionId: sessionId ?? sessionCtx.sessionId,
        reason: terminationReason,
      });

      // Emit error event (the terminal event itself was already emitted)
      yield {
        streamEventType: 'error',
        error: terminationReason,
        timestamp: new Date().toISOString(),
        sessionId,
      } satisfies SystemErrorEvent;

      // Don't re-throw, let finally block handle cleanup
      return;
    }

    // Handle infrastructure errors (RPC disconnections and DO issues)
    if (error instanceof Error) {
      const errorMsg = error.message;

      // Check for known infrastructure error patterns (matching VibeSDK's approach)
      const isInfrastructureError =
        // Container/RPC disconnections
        errorMsg.includes('disconnected prematurely') ||
        errorMsg.includes('Network connection lost') ||
        errorMsg.includes('Container service disconnected') ||
        errorMsg.includes('RPC') ||
        // Durable Object errors (from initial clearInterrupted() call)
        errorMsg.includes('Internal error in Durable Object storage') ||
        errorMsg.includes('Durable Object reset');

      if (isInfrastructureError) {
        // lazy guess whether this is a deployment-related DO reset
        const isDeployment = errorMsg.includes('Durable Object reset because its code was updated');

        logger[isDeployment ? 'info' : 'warn']('Infrastructure error during stream', {
          sessionId: sessionId ?? sessionCtx.sessionId,
          error: errorMsg,
          reason: isDeployment ? 'deployment' : 'infrastructure_issue',
        });

        // Note: Don't set abnormalTermination = true
        // The container/DO is already dead/resetting, so cleanup attempts would fail.
        // This is different from STREAM_TIMEOUT where container is still alive.
        yield {
          streamEventType: 'interrupted',
          sessionId: sessionId ?? sessionCtx.sessionId,
          timestamp: new Date().toISOString(),
          reason: 'Stream interrupted - please retry / resume',
        } satisfies SystemInterruptedEvent;

        return;
      }
    }

    // If not a known termination type, re-throw the error
    throw error;
  } finally {
    // Clear the server-side timeout
    if (streamTimeoutId) {
      clearTimeout(streamTimeoutId);
    }

    if (interruptInterval) {
      clearInterval(interruptInterval);
    }

    // Kill running kilocode processes on abnormal termination
    if (abnormalTermination) {
      logger.info('Cleaning up kilocode processes after abnormal termination');
      await killKilocodeProcesses(sandbox, session, sessionCtx);
    }

    await Promise.allSettled([session.deleteFile(tmpFile)]);
  }
}
