/**
 * WrapperClient - Client for interacting with the long-running wrapper.
 *
 * This client is used by the Worker/DO to communicate with the wrapper
 * running inside the sandbox container via HTTP.
 */

import { dirname } from 'node:path';
import type { ExecutionSession, SandboxInstance } from '../types.js';
import { logger } from '../logger.js';
import { findWrapperForSession, getWrapperSessionMarker } from './wrapper-manager.js';
import { randomPort } from './ports.js';
import { WRAPPER_VERSION } from '../shared/wrapper-version.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type WrapperClientOptions = {
  /** Sandbox session for exec/writeFile operations */
  session: ExecutionSession;
  /** Wrapper HTTP port (typically 5xxx) */
  port: number;
};

export type ExecutionBinding = {
  executionId: string;
  ingestUrl: string;
  ingestToken: string;
  workerAuthToken: string;
  upstreamBranch?: string;
};

export type EnsureRunningOptions = {
  agentSessionId: string;
  userId: string;
  wrapperPath?: string;
  maxWaitMs?: number;
  workspacePath: string;
  sessionId?: string;
};

export type EnsureWrapperOptions = {
  agentSessionId: string;
  userId: string;
  workspacePath: string;
  sessionId?: string;
};

export type WrapperPromptOptions = {
  prompt?: string;
  parts?: Array<
    { type: 'text'; text: string } | { type: 'file'; mime: string; url: string; filename?: string }
  >;
  model?: { providerID?: string; modelID: string };
  variant?: string;
  agent?: string;
  messageId?: string;
  system?: string;
  tools?: Record<string, boolean>;
  autoCommit?: boolean;
  condenseOnComplete?: boolean;
  execution?: ExecutionBinding;
};

export type WrapperCommandOptions = {
  command: string;
  args?: string;
  execution?: ExecutionBinding;
};

export type WrapperPermissionResponse = 'always' | 'once' | 'reject';

export type WrapperHealthResponse = {
  healthy: boolean;
  state: 'idle' | 'active';
  version: string;
  sessionId: string;
};

export type JobStatus = {
  state: 'idle' | 'active';
  executionId?: string;
  sessionId?: string;
  lastError?: {
    code: string;
    messageId?: string;
    message: string;
    timestamp: number;
  };
};

export type WrapperSessionCommandResponse = unknown;

// ---------------------------------------------------------------------------
// Error Classes
// ---------------------------------------------------------------------------

export class WrapperError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly statusCode: number
  ) {
    super(message);
    this.name = 'WrapperError';
  }
}

export class WrapperNotReadyError extends WrapperError {
  constructor(message: string) {
    super(message, 'NOT_READY', 503);
    this.name = 'WrapperNotReadyError';
  }
}

export class WrapperNoJobError extends WrapperError {
  constructor(message: string) {
    super(message, 'NO_JOB', 400);
    this.name = 'WrapperNoJobError';
  }
}

export class WrapperJobConflictError extends WrapperError {
  constructor(message: string) {
    super(message, 'JOB_CONFLICT', 409);
    this.name = 'WrapperJobConflictError';
  }
}

/** Map wrapper error codes to HTTP status codes */
const ERROR_STATUS_CODES: Record<string, number> = {
  NO_JOB: 400,
  JOB_CONFLICT: 409,
  NOT_FOUND: 404,
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Max attempts for port allocation in ensureWrapper (retry with new random port on failure) */
const MAX_PORT_ATTEMPTS = 3;

// ---------------------------------------------------------------------------
// WrapperClient Implementation
// ---------------------------------------------------------------------------

export class WrapperClient {
  private readonly session: ExecutionSession;
  private readonly port: number;
  private readonly baseUrl: string;

  private shellQuote(value: string): string {
    return `'${value.replace(/'/g, "'\\''")}'`;
  }

  private async runPreflightChecks(options: {
    wrapperPath: string;
    workspacePath: string;
  }): Promise<void> {
    const { wrapperPath, workspacePath } = options;
    const quotedWrapperPath = this.shellQuote(wrapperPath);

    // Verify bun runtime and wrapper binary before the full start+waitForPort loop.
    // A fast `bun --version` catches SIGILL (exit 132) on hosts whose CPU lacks
    // required instructions, missing/corrupt binaries, etc. We also verify the
    // wrapper script exists.
    try {
      const [bunResult, fileResult] = await Promise.allSettled([
        this.session.exec('bun --version', { timeout: 5_000 }),
        this.session.exec(`test -f ${quotedWrapperPath}`, {
          timeout: 5_000,
          cwd: workspacePath,
        }),
      ]);

      if (bunResult.status === 'fulfilled' && bunResult.value.exitCode !== 0) {
        const detail =
          bunResult.value.exitCode === 132
            ? 'SIGILL -- bun binary incompatible with host CPU'
            : `exit code ${bunResult.value.exitCode}`;
        throw new WrapperNotReadyError(
          `Wrapper pre-flight failed: bun runtime is broken (${detail}). stderr: ${bunResult.value.stderr?.trim() ?? '(empty)'}`
        );
      }

      if (fileResult.status === 'fulfilled' && fileResult.value.exitCode !== 0) {
        throw new WrapperNotReadyError(
          `Wrapper pre-flight failed: ${wrapperPath} not found in container`
        );
      }

      if (bunResult.status === 'rejected' && fileResult.status === 'rejected') {
        logger.warn('WrapperClient: pre-flight check failed to execute, proceeding anyway', {
          bunError:
            bunResult.reason instanceof Error ? bunResult.reason.message : String(bunResult.reason),
          fileError:
            fileResult.reason instanceof Error
              ? fileResult.reason.message
              : String(fileResult.reason),
        });
        return;
      }

      if (bunResult.status === 'rejected') {
        logger.warn('WrapperClient: bun pre-flight exec failed, proceeding anyway', {
          error:
            bunResult.reason instanceof Error ? bunResult.reason.message : String(bunResult.reason),
        });
      }

      if (fileResult.status === 'rejected') {
        logger.warn('WrapperClient: file pre-flight exec failed, proceeding anyway', {
          error:
            fileResult.reason instanceof Error
              ? fileResult.reason.message
              : String(fileResult.reason),
        });
      }

      if (bunResult.status === 'fulfilled') {
        logger.debug('WrapperClient: pre-flight passed', {
          bunVersion: bunResult.value.stdout?.trim(),
        });
      }
    } catch (error) {
      if (error instanceof WrapperNotReadyError) throw error;

      logger.warn('WrapperClient: pre-flight check failed unexpectedly, proceeding anyway', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  constructor(options: WrapperClientOptions) {
    this.session = options.session;
    this.port = options.port;
    this.baseUrl = `http://127.0.0.1:${this.port}`;
  }

  /**
   * Make an HTTP request to the wrapper.
   * Uses session.exec to run curl inside the container.
   */
  private async request<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const url = `${this.baseUrl}${path}`;

    // Build curl command as a single string
    let command = `curl -s -X ${method} -H 'Content-Type: application/json'`;

    if (body) {
      // Escape single quotes in JSON
      const json = this.shellQuote(JSON.stringify(body));
      command += ` -d ${json}`;
    }

    command += ` ${this.shellQuote(url)}`;

    // Execute curl in the container
    const result = await this.session.exec(command);

    if (result.exitCode !== 0) {
      const stderr = result.stderr?.trim() ?? '';
      throw new WrapperError(`Request failed: ${stderr || 'curl error'}`, 'REQUEST_FAILED', 500);
    }

    const stdout = result.stdout?.trim() ?? '';
    if (!stdout) {
      // Some endpoints return empty body
      return {} as T;
    }

    try {
      const response = JSON.parse(stdout) as T & { error?: string; message?: string };

      // Check for error response
      if (response.error) {
        const statusCode = ERROR_STATUS_CODES[response.error] ?? 500;

        if (response.error === 'NO_JOB') {
          throw new WrapperNoJobError(response.message ?? 'No job started');
        }
        if (response.error === 'JOB_CONFLICT') {
          throw new WrapperJobConflictError(response.message ?? 'Job conflict');
        }

        throw new WrapperError(response.message ?? response.error, response.error, statusCode);
      }

      return response;
    } catch (e) {
      if (e instanceof WrapperError) throw e;
      throw new WrapperError(`Failed to parse response: ${stdout}`, 'PARSE_ERROR', 500);
    }
  }

  // ---------------------------------------------------------------------------
  // Lifecycle Methods
  // ---------------------------------------------------------------------------

  /**
   * Ensure the wrapper is running and healthy.
   * Starts the wrapper if needed and waits for it to be ready.
   *
   * NOTE: This method assumes the WrapperClient was created with a port.
   * Port retry on EADDRINUSE is handled by the static ensureWrapper() method.
   */
  async ensureRunning(options: EnsureRunningOptions): Promise<void> {
    const {
      agentSessionId,
      userId,
      wrapperPath = '/usr/local/bin/kilocode-wrapper.js',
      maxWaitMs = 30_000,
      workspacePath,
      sessionId,
    } = options;

    // First, try to check health
    try {
      await this.health();
      logger.debug('WrapperClient: wrapper already running');
      return; // Already running
    } catch {
      // Not running, need to start
      logger.debug('WrapperClient: wrapper not running, starting...');
    }

    await this.runPreflightChecks({ wrapperPath, workspacePath });

    // Start the wrapper process using startProcess so it's trackable via listProcesses()
    // The command includes a session marker so we can find this wrapper later
    const sessionMarker = getWrapperSessionMarker(agentSessionId);
    const wrapperLogPath = `/tmp/kilocode-wrapper-${agentSessionId}-${Date.now()}.log`;
    const envParts = [
      `WRAPPER_PORT=${this.port}`,
      `WORKSPACE_PATH=${workspacePath}`,
      `WRAPPER_LOG_PATH=${wrapperLogPath}`,
      `KILO_SESSION_RETRY_LIMIT=5`,
    ];
    const argParts = [`--user-id ${this.shellQuote(userId)}`];
    if (sessionId) {
      argParts.push(`--session-id ${this.shellQuote(sessionId)}`);
    }

    const command = `${envParts.join(' ')} bun run ${this.shellQuote(wrapperPath)} ${sessionMarker} ${argParts.join(' ')}`;

    logger.debug('WrapperClient: starting wrapper process', {
      command,
      port: this.port,
    });

    let proc: Awaited<ReturnType<ExecutionSession['startProcess']>> | undefined;

    try {
      proc = await this.session.startProcess(command, {
        cwd: dirname(workspacePath),
      });

      // Wait for wrapper to become healthy via port check.
      // Race against our own timer because the SDK's built-in timeout may
      // not fire when the process crashes immediately (e.g. EADDRINUSE).
      let waitTimeoutId: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        proc.waitForPort(this.port, {
          mode: 'http',
          path: '/health',
          timeout: maxWaitMs,
        }),
        new Promise<never>((_, reject) => {
          waitTimeoutId = setTimeout(() => reject(new Error('waitForPort timed out')), maxWaitMs);
        }),
      ]);
      clearTimeout(waitTimeoutId);

      logger.debug('WrapperClient: wrapper is ready', { port: this.port, processId: proc.id });
      return;
    } catch (error) {
      const startupError = error instanceof Error ? error : new Error(String(error));

      // Capture process stdout/stderr for diagnostics (best-effort)
      let stdout: string | undefined;
      let stderr: string | undefined;
      if (proc) {
        try {
          let logsTimeoutId: ReturnType<typeof setTimeout> | undefined;
          const logs = await Promise.race([
            proc.getLogs(),
            new Promise<never>((_, reject) => {
              logsTimeoutId = setTimeout(() => reject(new Error('getLogs timed out')), 5_000);
            }),
          ]);
          clearTimeout(logsTimeoutId);
          stdout = logs.stdout;
          stderr = logs.stderr;
        } catch (logError) {
          logger.debug('Failed to read wrapper process logs', {
            port: this.port,
            processId: proc.id,
            error: logError instanceof Error ? logError.message : String(logError),
          });
        }
      }

      // Read the wrapper's own log file for richer diagnostics (logToFile output)
      let wrapperFileLog: string | undefined;
      try {
        const quotedWrapperLogPath = `'${wrapperLogPath.replace(/'/g, "'\\''")}'`;
        const logResult = await this.session.exec(`cat ${quotedWrapperLogPath} 2>/dev/null`);
        const content = logResult.stdout?.trim();
        if (content) {
          wrapperFileLog = content;
        }
      } catch (logFileError) {
        logger.debug('Failed to read wrapper log file', {
          wrapperLogPath,
          error: logFileError instanceof Error ? logFileError.message : String(logFileError),
        });
      }

      // Kill the failed process (proc.kill() is unreliable in the sandbox SDK,
      // so use pkill -f against the session marker).
      try {
        await this.session.exec(`pkill -f -- '${sessionMarker}'`);
      } catch {
        // Process may already be dead - ignore
      }

      const diagParts = [
        startupError.message,
        stdout ? `stdout: ${stdout}` : undefined,
        stderr ? `stderr: ${stderr}` : undefined,
        wrapperFileLog ? `wrapperFileLog: ${wrapperFileLog}` : undefined,
      ]
        .filter(Boolean)
        .join(' | ');

      logger.error('Wrapper startup failed', {
        port: this.port,
        error: startupError.message,
        stdout,
        stderr,
        wrapperFileLog,
      });

      throw new WrapperNotReadyError(
        `Wrapper did not become ready on port ${this.port} within ${maxWaitMs}ms: ${diagParts}`
      );
    }
  }

  /**
   * Ensure a wrapper is running for the given session.
   *
   * This is the main entry point for wrapper lifecycle management:
   * 1. Checks if a wrapper already exists for this session (sandbox-wide search)
   * 2. If found and running, returns a client for it
   * 3. If not found, allocates a port and starts a new wrapper
   *
   * @param sandbox - The sandbox instance (for listing processes across all sessions)
   * @param session - The execution session (for starting processes within session context)
   * @param options - Wrapper startup config
   * @returns A WrapperClient and the root kilo session ID from the wrapper health response
   */
  static async ensureWrapper(
    sandbox: SandboxInstance,
    session: ExecutionSession,
    options: EnsureWrapperOptions
  ): Promise<{ client: WrapperClient; sessionId: string }> {
    const { agentSessionId, workspacePath } = options;

    logger.withFields({ agentSessionId, workspacePath }).info('Ensuring wrapper is running');

    // 1. Check for existing wrapper (sandbox-wide search)
    const existing = await findWrapperForSession(sandbox, agentSessionId);

    if (existing) {
      const { port } = existing;
      logger.withFields({ agentSessionId, port }).info('Found existing wrapper');
      const client = new WrapperClient({ session, port });

      // Verify it's healthy. If so, reuse it.
      try {
        const healthResponse = await client.health();
        if (healthResponse.version === WRAPPER_VERSION) {
          return { client, sessionId: healthResponse.sessionId };
        }

        logger
          .withFields({
            agentSessionId,
            port,
            wrapperVersion: healthResponse.version,
            expectedWrapperVersion: WRAPPER_VERSION,
          })
          .warn('Existing wrapper version mismatch, restarting');

        try {
          await sandbox.exec(`pkill -f -- '${getWrapperSessionMarker(agentSessionId)}'`);
        } catch (error) {
          logger
            .withFields({
              agentSessionId,
              port,
              error: error instanceof Error ? error.message : String(error),
            })
            .warn('Failed to stop version-mismatched wrapper, starting replacement anyway');
        }
      } catch {
        logger
          .withFields({ agentSessionId, port })
          .warn('Existing wrapper not healthy, will start new one');
      }
    }

    // 2. Try starting a new wrapper, retrying with a new random port on failure
    let lastError: Error | undefined;

    for (let attempt = 0; attempt < MAX_PORT_ATTEMPTS; attempt++) {
      const port = randomPort();
      logger
        .withFields({ agentSessionId, port, attempt: attempt + 1 })
        .info('Starting new wrapper');

      const client = new WrapperClient({ session, port });

      try {
        await client.ensureRunning(options);
        const healthResponse = await client.health();
        if (healthResponse.version !== WRAPPER_VERSION) {
          throw new WrapperNotReadyError(
            `Wrapper version mismatch after startup: expected ${WRAPPER_VERSION}, got ${healthResponse.version}`
          );
        }

        return { client, sessionId: healthResponse.sessionId };
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        if (attempt + 1 < MAX_PORT_ATTEMPTS) {
          logger
            .withFields({ agentSessionId, port, attempt: attempt + 1, error: lastError.message })
            .warn('Wrapper startup failed, retrying with different port');
          continue;
        }
      }
    }

    throw lastError ?? new WrapperNotReadyError('Failed to start wrapper after port retries');
  }

  // ---------------------------------------------------------------------------
  // Action Methods (tracked in inflight)
  // ---------------------------------------------------------------------------

  /**
   * Send a prompt to the wrapper.
   * Opens connection if idle, tracks in inflight.
   */
  async prompt(options: WrapperPromptOptions): Promise<{ messageId?: string }> {
    const response = await this.request<{
      status: string;
      messageId?: string;
    }>('POST', '/job/prompt', options);

    return response.messageId !== undefined ? { messageId: response.messageId } : {};
  }

  // ---------------------------------------------------------------------------
  // Action Methods (synchronous, no inflight tracking)
  // ---------------------------------------------------------------------------

  /**
   * Send a command (slash command) to the wrapper.
   * Does NOT open connection or track inflight.
   */
  async command(options: WrapperCommandOptions): Promise<WrapperSessionCommandResponse> {
    const response = await this.request<{
      status: string;
      result: WrapperSessionCommandResponse;
    }>('POST', '/job/command', options);

    return response.result;
  }

  // ---------------------------------------------------------------------------
  // Action Methods (fire-and-forget)
  // ---------------------------------------------------------------------------

  /**
   * Answer a permission request.
   */
  async answerPermission(
    permissionId: string,
    response: WrapperPermissionResponse
  ): Promise<{ success: boolean }> {
    const result = await this.request<{
      status: string;
      success: boolean;
    }>('POST', '/job/answer-permission', { permissionId, response });

    return { success: result.success };
  }

  /**
   * Answer a question.
   */
  async answerQuestion(questionId: string, answers: string[][]): Promise<{ success: boolean }> {
    const result = await this.request<{
      status: string;
      success: boolean;
    }>('POST', '/job/answer-question', { questionId, answers });

    return { success: result.success };
  }

  /**
   * Reject a question.
   */
  async rejectQuestion(questionId: string): Promise<{ success: boolean }> {
    const result = await this.request<{
      status: string;
      success: boolean;
    }>('POST', '/job/reject-question', { questionId });

    return { success: result.success };
  }

  /**
   * Abort the current job.
   */
  async abort(): Promise<void> {
    await this.request<{ status: string }>('POST', '/job/abort', {});
  }

  // ---------------------------------------------------------------------------
  // Status Methods
  // ---------------------------------------------------------------------------

  /**
   * Check wrapper health.
   */
  async health(): Promise<WrapperHealthResponse> {
    return this.request<WrapperHealthResponse>('GET', '/health');
  }

  /**
   * Get current job status.
   */
  async status(): Promise<JobStatus> {
    return this.request<JobStatus>('GET', '/job/status');
  }
}
