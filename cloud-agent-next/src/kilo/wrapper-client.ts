/**
 * WrapperClient - Client for interacting with the long-running wrapper.
 *
 * This client is used by the Worker/DO to communicate with the wrapper
 * running inside the sandbox container via HTTP.
 */

import type { ExecutionSession, SandboxInstance } from '../types.js';
import { logger } from '../logger.js';
import {
  findWrapperForSession,
  findAvailableWrapperPort,
  getWrapperSessionMarker,
} from './wrapper-manager.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type WrapperClientOptions = {
  /** Sandbox session for exec/writeFile operations */
  session: ExecutionSession;
  /** Wrapper HTTP port (typically 5xxx) */
  port: number;
};

export type StartJobOptions = {
  executionId: string;
  ingestUrl: string;
  ingestToken: string;
  sessionId: string;
  userId: string;
  kilocodeToken: string;
  kiloSessionId?: string;
  kiloSessionTitle?: string;
};

export type WrapperPromptOptions = {
  prompt?: string;
  parts?: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
  model?: { providerID?: string; modelID: string };
  agent?: string;
  messageId?: string;
  system?: string;
  tools?: Record<string, boolean>;
};

export type WrapperPermissionResponse = 'always' | 'once' | 'reject';

export type WrapperHealthResponse = {
  healthy: boolean;
  state: 'idle' | 'active';
  inflightCount: number;
  version: string;
};

export type JobStatus = {
  state: 'idle' | 'active';
  executionId?: string;
  kiloSessionId?: string;
  inflight: string[];
  inflightCount: number;
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
// WrapperClient Implementation
// ---------------------------------------------------------------------------

export class WrapperClient {
  private readonly session: ExecutionSession;
  private readonly port: number;
  private readonly baseUrl: string;

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
      const json = JSON.stringify(body).replace(/'/g, "'\\''");
      command += ` -d '${json}'`;
    }

    command += ` '${url}'`;

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
   * NOTE: This method assumes the WrapperClient was created with the correct port
   * (either found via findWrapperForSession or allocated via findAvailableWrapperPort).
   * Use the static ensureWrapper() method for the full flow.
   */
  async ensureRunning(options: {
    sessionId: string;
    wrapperPath?: string;
    maxWaitMs?: number;
    pollIntervalMs?: number;
    /** Kilo server port (required for wrapper to connect) */
    kiloServerPort: number;
    /** Workspace path (required by wrapper) */
    workspacePath: string;
  }): Promise<void> {
    const {
      sessionId,
      wrapperPath = '/usr/local/bin/kilocode-wrapper.js',
      maxWaitMs = 30_000,
      kiloServerPort,
      workspacePath,
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

    // Start the wrapper process using startProcess so it's trackable via listProcesses()
    // The command includes a session marker so we can find this wrapper later
    const sessionMarker = getWrapperSessionMarker(sessionId);
    const command = `${sessionMarker} WRAPPER_PORT=${this.port} KILO_SERVER_PORT=${kiloServerPort} WORKSPACE_PATH=${workspacePath} bun run ${wrapperPath}`;

    logger.debug('WrapperClient: starting wrapper process', { command, port: this.port });

    try {
      const proc = await this.session.startProcess(command, {
        cwd: workspacePath,
      });

      // Wait for wrapper to become healthy via port check
      await proc.waitForPort(this.port, {
        mode: 'http',
        path: '/health',
        timeout: maxWaitMs,
      });

      logger.debug('WrapperClient: wrapper is ready', { port: this.port, processId: proc.id });
    } catch (error) {
      throw new WrapperNotReadyError(
        `Wrapper did not become ready within ${maxWaitMs}ms: ${error instanceof Error ? error.message : String(error)}`
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
   * @param sessionId - The cloud-agent session ID
   * @param kiloServerPort - Port where kilo server is running
   * @param workspacePath - Workspace path for the session
   * @returns A WrapperClient connected to the running wrapper
   */
  static async ensureWrapper(
    sandbox: SandboxInstance,
    session: ExecutionSession,
    sessionId: string,
    kiloServerPort: number,
    workspacePath: string
  ): Promise<WrapperClient> {
    logger.withFields({ sessionId, workspacePath }).info('Ensuring wrapper is running');

    // 1. Check for existing wrapper (sandbox-wide search)
    const existing = await findWrapperForSession(sandbox, sessionId);

    if (existing) {
      const { port } = existing;
      logger.withFields({ sessionId, port }).info('Found existing wrapper');
      const client = new WrapperClient({ session, port });

      // Verify it's healthy
      try {
        await client.health();
        return client;
      } catch {
        logger
          .withFields({ sessionId, port })
          .warn('Existing wrapper not healthy, will start new one');
      }
    }

    // 2. Find available port and start new wrapper
    const port = await findAvailableWrapperPort(sandbox, sessionId);
    logger.withFields({ sessionId, port }).info('Starting new wrapper');

    const client = new WrapperClient({ session, port });
    await client.ensureRunning({
      sessionId,
      kiloServerPort,
      workspacePath,
    });

    return client;
  }

  /**
   * Start a new job (creates/resumes kilo session and stores context).
   */
  async startJob(options: StartJobOptions): Promise<{ kiloSessionId: string }> {
    const response = await this.request<{
      status: string;
      kiloSessionId: string;
    }>('POST', '/job/start', options);

    return { kiloSessionId: response.kiloSessionId };
  }

  // ---------------------------------------------------------------------------
  // Action Methods (tracked in inflight)
  // ---------------------------------------------------------------------------

  /**
   * Send a prompt to the wrapper.
   * Opens connection if idle, tracks in inflight.
   */
  async prompt(options: WrapperPromptOptions): Promise<{ messageId: string }> {
    const response = await this.request<{
      status: string;
      messageId: string;
    }>('POST', '/job/prompt', options);

    return { messageId: response.messageId };
  }

  // ---------------------------------------------------------------------------
  // Action Methods (synchronous, no inflight tracking)
  // ---------------------------------------------------------------------------

  /**
   * Send a command (slash command) to the wrapper.
   * Does NOT open connection or track inflight.
   */
  async command(command: string, args?: string): Promise<WrapperSessionCommandResponse> {
    const response = await this.request<{
      status: string;
      result: WrapperSessionCommandResponse;
    }>('POST', '/job/command', { command, args });

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
  async answerQuestion(questionId: string, answers: string[]): Promise<{ success: boolean }> {
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
