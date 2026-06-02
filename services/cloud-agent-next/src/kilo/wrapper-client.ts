/**
 * WrapperClient - Client for interacting with the long-running wrapper.
 *
 * This client is used by the Worker/DO to communicate with the wrapper
 * running inside the sandbox container via HTTP.
 */

import { dirname } from 'node:path';
import type { ExecutionSession, SandboxInstance } from '../types.js';
import type { WrapperInstanceLease } from '../agent-sandbox/protocol.js';
import { logger } from '../logger.js';
import {
  discoverSessionWrappers,
  findWrapperForSession,
  findWrapperForSessionInProcesses,
  getWrapperSessionMarker,
} from './wrapper-manager.js';
import { randomPort } from './ports.js';
import {
  buildKiloSessionXdgEnv,
  dockerSocketEnv,
  dockerSocketEnvParts,
  resolveDockerSocketPath,
} from './sandbox-runtime.js';
import { KILO_AGENT_SESSION_LABEL, type DevContainerHandle } from './devcontainer.js';
import { WRAPPER_VERSION } from '../shared/wrapper-version.js';
import { shellQuote, validShellEnvEntries } from './utils.js';
import type {
  WrapperCommandRequest,
  WrapperPromptRequest,
  WrapperSessionReadyRequest,
  WrapperSessionReadySuccessResponse,
} from '../shared/wrapper-bootstrap.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type WrapperClientOptions = {
  /** Sandbox session for exec/writeFile operations */
  session: ExecutionSession;
  /** Wrapper HTTP port (typically 5xxx) */
  port: number;
  /** Transport for wrapper HTTP requests. Defaults to curl through session.exec. */
  transport?: WrapperTransport;
};

export type EnsureRunningOptions = {
  agentSessionId: string;
  userId: string;
  wrapperPath?: string;
  maxWaitMs?: number;
  workspacePath?: string;
  sessionId?: string;
  leasedInstance?: WrapperInstanceLease;
  /**
   * Prepared session runtime environment for Kilo. This is the same env used to
   * create the sandbox execution session; wrapper-owned values below are layered
   * on top at launch time.
   */
  runtimeEnv?: Record<string, string | undefined>;
  /**
   * When set, launch the wrapper *inside* the dev container via `devcontainer
   * exec` instead of `session.startProcess` on the outer sandbox. The wrapper
   * runs from the bind-mounted bundle at `/opt/kilo-cloud/kilocode-wrapper.js`
   * and its HTTP port is reached via the publish set up by `devcontainer up`.
   */
  devcontainer?: DevContainerHandle;
};

export type EnsureWrapperOptions = {
  agentSessionId: string;
  userId: string;
  workspacePath: string;
  sessionId?: string;
  leasedInstance?: WrapperInstanceLease;
  /** See {@link EnsureRunningOptions.runtimeEnv}. */
  runtimeEnv?: Record<string, string | undefined>;
  /** See {@link EnsureRunningOptions.devcontainer}. */
  devcontainer?: DevContainerHandle;
  /**
   * Force the wrapper to listen on this exact port instead of a random one.
   * Used by the devcontainer flow because the port has to be chosen *before*
   * `devcontainer up` (the publish mapping is fixed at container create time).
   * When set, the per-attempt port-retry loop is skipped.
   */
  fixedPort?: number;
};

export type EnsureBootstrapWrapperOptions = {
  agentSessionId: string;
  userId: string;
  wrapperPath?: string;
  maxWaitMs?: number;
  leasedInstance?: WrapperInstanceLease;
};

export type SessionBinding = {
  ingestUrl: string;
  workerAuthToken: string;
  upstreamBranch?: string;
  wrapperRunId: string;
  wrapperGeneration: number;
  wrapperConnectionId: string;
};

export type WrapperPromptOptions = WrapperPromptRequest;

export type WrapperCommandOptions = Pick<WrapperCommandRequest, 'command'> &
  Partial<Omit<WrapperCommandRequest, 'command'>>;

export type WrapperPermissionResponse = 'always' | 'once' | 'reject';

export type WrapperHealthResponse = {
  healthy: boolean;
  state: 'idle' | 'active';
  version: string;
  sessionId: string;
  wrapperInstanceId?: string;
  wrapperInstanceGeneration?: number;
};

export type WrapperPty = {
  id: string;
  title: string;
  command: string;
  args: string[];
  cwd: string;
  status: 'running' | 'exited';
  pid: number;
};

export type JobStatus = {
  state: 'idle' | 'active';
  sessionId?: string;
  lastError?: {
    code: string;
    messageId?: string;
    message: string;
    timestamp: number;
  };
};

export type WrapperSessionCommandResponse = unknown;

export type WrapperContainerClientOptions = {
  sandbox: SandboxInstance;
  port: number;
};

export type WrapperTransport = {
  request(method: 'GET' | 'POST', path: string, body?: unknown): Promise<Response>;
};

// ---------------------------------------------------------------------------
// Error Classes
// ---------------------------------------------------------------------------

export class WrapperError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly statusCode: number,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = 'WrapperError';
  }
}

export class WrapperNotReadyError extends WrapperError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, 'NOT_READY', 503, options);
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
  INVALID_REQUEST: 400,
  WORKSPACE_SETUP_FAILED: 503,
  KILO_SERVER_FAILED: 503,
  SEND_ERROR: 500,
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Max attempts for port allocation in ensureWrapper (retry with new random port on failure) */
const MAX_PORT_ATTEMPTS = 3;

function healthMatchesLease(
  health: WrapperHealthResponse,
  leasedInstance: WrapperInstanceLease | undefined,
  allowUnreportedIdentity = false
): boolean {
  if (!leasedInstance) return true;
  if (
    health.wrapperInstanceId === leasedInstance.instanceId &&
    health.wrapperInstanceGeneration === leasedInstance.instanceGeneration
  ) {
    return true;
  }
  return (
    allowUnreportedIdentity &&
    health.wrapperInstanceId === undefined &&
    health.wrapperInstanceGeneration === undefined
  );
}

async function observationMatchesLease(
  sandbox: SandboxInstance,
  agentSessionId: string,
  leasedInstance: WrapperInstanceLease,
  options: { inspectContainers: boolean; expectedContainerId?: string }
): Promise<boolean> {
  const observation = await discoverSessionWrappers(sandbox, agentSessionId, {
    inspectContainers: options.inspectContainers,
  });
  if (observation.status !== 'present' || observation.observed.length !== 1) return false;
  const wrapper = observation.observed[0];
  if (!wrapper) return false;
  if (options.expectedContainerId !== undefined) {
    if (wrapper.representation !== 'container' || wrapper.id !== options.expectedContainerId) {
      return false;
    }
  }
  return (
    wrapper.instanceId === leasedInstance.instanceId &&
    wrapper.instanceGeneration === leasedInstance.instanceGeneration
  );
}

function buildExportFileContent(env: Record<string, string | undefined>): string {
  return `${validShellEnvEntries(env)
    .map(([key, value]) => `export ${key}=${shellQuote(value)}`)
    .join('\n')}\n`;
}

function mergeEnvRecords(...envs: Array<Record<string, string | undefined> | undefined>) {
  return Object.assign({}, ...envs.filter(Boolean)) as Record<string, string | undefined>;
}

// ---------------------------------------------------------------------------
// Transports
// ---------------------------------------------------------------------------

class ExecCurlWrapperTransport implements WrapperTransport {
  private readonly session: ExecutionSession;
  private readonly baseUrl: string;
  private readonly shellQuote: (value: string) => string;

  constructor(options: {
    session: ExecutionSession;
    baseUrl: string;
    shellQuote: (value: string) => string;
  }) {
    this.session = options.session;
    this.baseUrl = options.baseUrl;
    this.shellQuote = options.shellQuote;
  }

  async request(method: 'GET' | 'POST', path: string, body?: unknown): Promise<Response> {
    const url = `${this.baseUrl}${path}`;
    let command = `curl -s -X ${method} -H 'Content-Type: application/json'`;

    if (body) {
      command += ` -d ${this.shellQuote(JSON.stringify(body))}`;
    }

    command += ` ${this.shellQuote(url)}`;

    const result = await this.session.exec(command);
    if (result.exitCode !== 0) {
      const stderr = result.stderr?.trim() ?? '';
      throw new WrapperError(`Request failed: ${stderr || 'curl error'}`, 'REQUEST_FAILED', 500);
    }

    return new Response(result.stdout ?? '', {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

export class ContainerFetchWrapperTransport implements WrapperTransport {
  private readonly sandbox: SandboxInstance;
  private readonly port: number;

  constructor(options: { sandbox: SandboxInstance; port: number }) {
    this.sandbox = options.sandbox;
    this.port = options.port;
  }

  async request(method: 'GET' | 'POST', path: string, body?: unknown): Promise<Response> {
    const url = new URL(`http://localhost:${this.port}${path}`);
    const request = new Request(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return this.sandbox.containerFetch(request, this.port);
  }
}

// ---------------------------------------------------------------------------
// WrapperClient Implementation
// ---------------------------------------------------------------------------

export class WrapperClient {
  private readonly session: ExecutionSession;
  private readonly port: number;
  private readonly baseUrl: string;
  private readonly transport: WrapperTransport;

  /**
   * Wrap a wrapper-start command line so it runs inside the dev container via
   * `devcontainer exec --workspace-folder ... --id-label kilo.agentSession=...`.
   *
   * The inner string (env vars + `bun run …`) is passed to `sh -c` so the
   * env-var prefix syntax keeps working unchanged. Double-shell escaping is
   * handled by `shellQuote`.
   */
  private buildDevContainerExecCommand(
    devcontainer: DevContainerHandle,
    innerCommand: string
  ): string {
    return [
      'devcontainer exec',
      `--workspace-folder ${shellQuote(devcontainer.workspacePath)}`,
      // --config is required: without it the CLI re-reads the user's
      // on-disk devcontainer.json and loses our remoteUser/remoteEnv
      // overrides (see DevContainerHandle.overrideConfigPath).
      `--config ${shellQuote(devcontainer.overrideConfigPath)}`,
      `--id-label ${shellQuote(`${KILO_AGENT_SESSION_LABEL}=${devcontainer.agentSessionId}`)}`,
      '--',
      'sh -c',
      shellQuote(innerCommand),
    ].join(' ');
  }

  private async runPreflightChecks(options: {
    wrapperPath: string;
    workspacePath: string;
  }): Promise<void> {
    const { wrapperPath, workspacePath } = options;
    const quotedWrapperPath = shellQuote(wrapperPath);

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

  private shellQuote(value: string): string {
    return shellQuote(value);
  }

  constructor(options: WrapperClientOptions) {
    this.session = options.session;
    this.port = options.port;
    this.baseUrl = `http://127.0.0.1:${this.port}`;
    this.transport =
      options.transport ??
      new ExecCurlWrapperTransport({
        session: options.session,
        baseUrl: this.baseUrl,
        shellQuote: value => this.shellQuote(value),
      });
  }

  /**
   * Make an HTTP request to the wrapper.
   */
  private async request<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const response = await this.transport.request(method, path, body);
    const responseText = await response.text();

    if (!responseText.trim()) {
      // Some endpoints return empty body
      return {} as T;
    }

    try {
      const parsed = JSON.parse(responseText) as T & {
        error?: string;
        message?: string;
        retryable?: boolean;
      };

      // Check for error response
      if (parsed.error || !response.ok) {
        const errorCode = parsed.error ?? `HTTP_${response.status}`;
        const statusCode = ERROR_STATUS_CODES[errorCode] ?? response.status ?? 500;
        logger
          .withFields({ method, path, port: this.port, errorCode, statusCode })
          .warn('Wrapper HTTP request returned an application error');

        if (errorCode === 'NO_JOB') {
          throw new WrapperNoJobError(parsed.message ?? 'No job started');
        }
        if (errorCode === 'JOB_CONFLICT') {
          throw new WrapperJobConflictError(parsed.message ?? 'Job conflict');
        }

        throw new WrapperError(parsed.message ?? errorCode, errorCode, statusCode);
      }

      return parsed;
    } catch (e) {
      if (e instanceof WrapperError) throw e;
      logger
        .withFields({
          method,
          path,
          port: this.port,
          responseBytes: responseText.length,
          statusCode: response.status,
        })
        .error('Failed to parse wrapper HTTP response');
      throw new WrapperError(`Failed to parse response: ${responseText}`, 'PARSE_ERROR', 500);
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
  async ensureRunning(options: EnsureRunningOptions): Promise<{ started: boolean }> {
    const {
      agentSessionId,
      userId,
      wrapperPath = '/usr/local/bin/kilocode-wrapper.js',
      maxWaitMs = 30_000,
      workspacePath,
      sessionId,
      leasedInstance,
      runtimeEnv,
      devcontainer,
    } = options;

    // First, try to check health
    try {
      await this.health();
      logger.debug('WrapperClient: wrapper already running');
      return { started: false };
    } catch {
      // Not running, need to start
      logger.debug('WrapperClient: wrapper not running, starting...');
    }

    if (!devcontainer) {
      // Outer-sandbox preflight: bun + wrapper bundle at /usr/local/bin/.
      // For the devcontainer flow these checks would have to run inside the
      // container (skip for now - failure surfaces clearly via waitForPort).
      await this.runPreflightChecks({ wrapperPath, workspacePath: workspacePath ?? '/' });
    }

    // Start the wrapper process using startProcess so it's trackable via listProcesses()
    // The command includes a session marker so we can find this wrapper later
    const sessionMarker = getWrapperSessionMarker(agentSessionId);
    const wrapperLogPath = `/tmp/kilocode-wrapper-${agentSessionId}-${Date.now()}.log`;
    // DOCKER_HOST lets the outer-sandbox wrapper (and anything kilo spawns)
    // talk to the sandbox dockerd. Devcontainer sessions intentionally do not
    // mount or expose that socket inside the user container.
    const dockerSocketPath = await resolveDockerSocketPath(this.session);
    const dockerEnvParts = devcontainer ? [] : dockerSocketEnvParts(dockerSocketPath);
    const devContainerEnv = devcontainer ? dockerSocketEnv(dockerSocketPath) : undefined;
    // When running inside a dev container, the wrapper sees the *inner*
    // workspace path (set by `devcontainer up`'s remoteWorkspaceFolder).
    const innerWorkspacePath = devcontainer?.innerWorkspaceFolder ?? workspacePath;
    const wrapperEnv: Record<string, string | undefined> = {
      WRAPPER_PORT: String(this.port),
      WORKSPACE_PATH: innerWorkspacePath,
      WRAPPER_LOG_PATH: wrapperLogPath,
      KILO_SESSION_RETRY_LIMIT: '5',
      KILO_CLOUD_AGENT: '1',
      ...(leasedInstance
        ? {
            WRAPPER_INSTANCE_ID: leasedInstance.instanceId,
            WRAPPER_INSTANCE_GENERATION: String(leasedInstance.instanceGeneration),
          }
        : {}),
    };
    const commandEnvParts = [
      `WRAPPER_PORT=${this.port}`,
      ...(innerWorkspacePath ? [`WORKSPACE_PATH=${innerWorkspacePath}`] : []),
      `WRAPPER_LOG_PATH=${wrapperLogPath}`,
      `KILO_SESSION_RETRY_LIMIT=5`,
      `KILO_CLOUD_AGENT=1`,
      // Environment markers let pre-lease wrapper bundles launch during a rolling deploy.
      ...(leasedInstance
        ? [
            `WRAPPER_INSTANCE_ID=${shellQuote(leasedInstance.instanceId)}`,
            `WRAPPER_INSTANCE_GENERATION=${leasedInstance.instanceGeneration}`,
          ]
        : []),
      ...dockerEnvParts,
    ];
    const devContainerSessionHome =
      devcontainer && runtimeEnv
        ? (runtimeEnv.SESSION_HOME ?? runtimeEnv.HOME ?? '/tmp')
        : undefined;
    const processEnv = mergeEnvRecords(
      runtimeEnv,
      devContainerSessionHome ? buildKiloSessionXdgEnv(devContainerSessionHome) : undefined,
      wrapperEnv,
      devcontainer ? undefined : dockerSocketEnv(dockerSocketPath)
    );
    const argParts = [`--user-id ${shellQuote(userId)}`];
    if (sessionId) {
      argParts.push(`--session-id ${shellQuote(sessionId)}`);
    }

    // The wrapper bundle lives at `/opt/kilo-cloud/kilocode-wrapper.js` inside
    // the dev container (bind-mounted read-only); on the outer sandbox we use
    // the caller-provided `wrapperPath` (default `/usr/local/bin/...`).
    const effectiveWrapperPath = devcontainer ? '/opt/kilo-cloud/kilocode-wrapper.js' : wrapperPath;

    let envFilePath: string | undefined;
    let envFileWritten = false;
    let innerCommand = `${commandEnvParts.join(' ')} bun run ${shellQuote(effectiveWrapperPath)} ${sessionMarker} ${argParts.join(' ')}`;
    if (devContainerSessionHome) {
      envFilePath = `${devContainerSessionHome}/tmp/kilo-wrapper-env-${agentSessionId}-${Date.now()}.sh`;
      await this.session.writeFile(envFilePath, buildExportFileContent(processEnv));
      envFileWritten = true;
      innerCommand = `. ${shellQuote(envFilePath)} && rm -f ${shellQuote(envFilePath)} && ${innerCommand}`;
    }
    const command = devcontainer
      ? this.buildDevContainerExecCommand(devcontainer, innerCommand)
      : innerCommand;
    // The outer process cwd just needs to exist — `bun run` immediately
    // re-chdirs to WORKSPACE_PATH in main.ts. Use the parent of the workspace
    // path either way (the workspace itself may not exist outside the
    // devcontainer if the user's `workspaceMount` differs).
    const cwd = workspacePath ? dirname(workspacePath) : '/';

    logger.debug('WrapperClient: starting wrapper process', {
      command,
      port: this.port,
      devcontainer: devcontainer ? { containerId: devcontainer.containerId } : undefined,
    });

    let proc: Awaited<ReturnType<ExecutionSession['startProcess']>> | undefined;

    try {
      proc = await this.session.startProcess(command, {
        cwd,
        env: devcontainer ? devContainerEnv : processEnv,
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
      return { started: true };
    } catch (error) {
      const startupError = error instanceof Error ? error : new Error(String(error));

      if (envFileWritten && envFilePath) {
        try {
          await this.session.exec(`rm -f ${shellQuote(envFilePath)}`);
        } catch (cleanupError) {
          logger.warn('Failed to clean up wrapper env file after startup failure', {
            envFilePath,
            error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
          });
        }
      }

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
        `Wrapper did not become ready on port ${this.port} within ${maxWaitMs}ms: ${diagParts}`,
        { cause: startupError }
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
          let allowUnreportedIdentity = false;
          if (
            options.leasedInstance &&
            healthResponse.wrapperInstanceId === undefined &&
            healthResponse.wrapperInstanceGeneration === undefined
          ) {
            allowUnreportedIdentity = await observationMatchesLease(
              sandbox,
              agentSessionId,
              options.leasedInstance,
              {
                inspectContainers: existing.kind === 'container',
                ...(existing.kind === 'container'
                  ? { expectedContainerId: existing.process.id }
                  : {}),
              }
            );
          }
          if (
            options.leasedInstance &&
            !healthMatchesLease(healthResponse, options.leasedInstance, allowUnreportedIdentity)
          ) {
            throw new WrapperNotReadyError(
              `Existing wrapper does not match leased physical instance ${options.leasedInstance.instanceId}`
            );
          }
          return { client, sessionId: healthResponse.sessionId };
        }

        if (options.leasedInstance) {
          throw new WrapperNotReadyError(
            'Existing leased wrapper reported an incompatible version'
          );
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
          // The wrapper might be running in a dev container (different PID
          // namespace — outer pkill can't see it). For that case kill only
          // the inner wrapper process via `devcontainer exec ... -- pkill`
          // so the dev container stays alive and the next attempt reuses it
          // via its `--id-label`.
          const sessionMarker = getWrapperSessionMarker(agentSessionId);
          if (options.devcontainer) {
            const dc = options.devcontainer;
            const innerPkill = `pkill -f -- ${shellQuote(sessionMarker)}`;
            const dockerEnv = dockerSocketEnv(await resolveDockerSocketPath(sandbox));
            await sandbox.exec(
              [
                'devcontainer exec',
                `--workspace-folder ${shellQuote(dc.workspacePath)}`,
                `--config ${shellQuote(dc.overrideConfigPath)}`,
                `--id-label ${shellQuote(`${KILO_AGENT_SESSION_LABEL}=${dc.agentSessionId}`)}`,
                '--',
                'sh -c',
                shellQuote(innerPkill),
              ].join(' '),
              { env: dockerEnv }
            );
          } else {
            await sandbox.exec(`pkill -f -- ${shellQuote(sessionMarker)}`);
          }
        } catch (error) {
          logger
            .withFields({
              agentSessionId,
              port,
              error: error instanceof Error ? error.message : String(error),
            })
            .warn('Failed to stop version-mismatched wrapper, starting replacement anyway');
        }
      } catch (error) {
        if (options.leasedInstance) {
          throw error;
        }
        logger
          .withFields({ agentSessionId, port })
          .warn('Existing wrapper not healthy, will start new one');
      }
    }

    // 2. Try starting a new wrapper, retrying with a new random port on failure.
    //    Port retry only applies when the caller hasn't pinned a port — the
    //    devcontainer flow has to commit to a port at `devcontainer up` time
    //    because the publish mapping is fixed at container create.
    let lastError: Error | undefined;
    const maxAttempts = options.fixedPort !== undefined ? 1 : MAX_PORT_ATTEMPTS;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const port = options.fixedPort ?? randomPort();
      logger
        .withFields({ agentSessionId, port, attempt: attempt + 1 })
        .info('Starting new wrapper');

      const client = new WrapperClient({ session, port });

      try {
        const running = await client.ensureRunning(options);
        const healthResponse = await client.health();
        if (healthResponse.version !== WRAPPER_VERSION) {
          throw new WrapperNotReadyError(
            `Wrapper version mismatch after startup: expected ${WRAPPER_VERSION}, got ${healthResponse.version}`
          );
        }
        let allowUnreportedIdentity = false;
        if (
          running.started &&
          options.leasedInstance &&
          healthResponse.wrapperInstanceId === undefined &&
          healthResponse.wrapperInstanceGeneration === undefined
        ) {
          allowUnreportedIdentity = await observationMatchesLease(
            sandbox,
            agentSessionId,
            options.leasedInstance,
            { inspectContainers: options.devcontainer !== undefined }
          );
        }
        if (!healthMatchesLease(healthResponse, options.leasedInstance, allowUnreportedIdentity)) {
          throw new WrapperNotReadyError(
            'Started wrapper did not report the leased physical instance'
          );
        }

        return { client, sessionId: healthResponse.sessionId };
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        if (attempt + 1 < maxAttempts) {
          logger
            .withFields({ agentSessionId, port, attempt: attempt + 1, error: lastError.message })
            .warn('Wrapper startup failed, retrying with different port');
          continue;
        }
      }
    }

    throw lastError ?? new WrapperNotReadyError('Failed to start wrapper after port retries');
  }

  static async ensureBootstrapWrapper(
    sandbox: SandboxInstance,
    session: ExecutionSession,
    options: EnsureBootstrapWrapperOptions
  ): Promise<{ client: WrapperClient }> {
    const { agentSessionId } = options;

    logger.withFields({ agentSessionId }).info('Ensuring bootstrap wrapper is running');

    const existing = findWrapperForSessionInProcesses(
      await sandbox.listProcesses(),
      agentSessionId
    );
    if (existing) {
      const { port } = existing;
      const client = new WrapperClient({
        session,
        port,
        transport: new ContainerFetchWrapperTransport({ sandbox, port }),
      });
      try {
        const healthResponse = await client.health();
        if (healthResponse.version === WRAPPER_VERSION) {
          const allowUnreportedIdentity =
            options.leasedInstance !== undefined &&
            healthResponse.wrapperInstanceId === undefined &&
            healthResponse.wrapperInstanceGeneration === undefined
              ? await observationMatchesLease(sandbox, agentSessionId, options.leasedInstance, {
                  inspectContainers: false,
                })
              : false;
          if (
            options.leasedInstance &&
            !healthMatchesLease(healthResponse, options.leasedInstance, allowUnreportedIdentity)
          ) {
            throw new WrapperNotReadyError(
              `Existing bootstrap wrapper does not match leased physical instance ${options.leasedInstance.instanceId}`
            );
          }
          return { client };
        }
        if (options.leasedInstance) {
          throw new WrapperNotReadyError(
            'Existing leased bootstrap wrapper reported an incompatible version'
          );
        }
        await sandbox.exec(`pkill -f -- '${getWrapperSessionMarker(agentSessionId)}'`);
      } catch (error) {
        if (options.leasedInstance) throw error;
        logger
          .withFields({ agentSessionId, port })
          .warn('Existing bootstrap wrapper not healthy, will start new one');
      }
    }

    let lastError: Error | undefined;
    for (let attempt = 0; attempt < MAX_PORT_ATTEMPTS; attempt++) {
      const port = randomPort();
      const client = new WrapperClient({
        session,
        port,
        transport: new ContainerFetchWrapperTransport({ sandbox, port }),
      });
      try {
        const running = await client.ensureRunning(options);
        const healthResponse = await client.health();
        if (healthResponse.version !== WRAPPER_VERSION) {
          throw new WrapperNotReadyError(
            `Wrapper version mismatch after startup: expected ${WRAPPER_VERSION}, got ${healthResponse.version}`
          );
        }
        const allowUnreportedIdentity =
          running.started &&
          options.leasedInstance !== undefined &&
          healthResponse.wrapperInstanceId === undefined &&
          healthResponse.wrapperInstanceGeneration === undefined
            ? await observationMatchesLease(sandbox, agentSessionId, options.leasedInstance, {
                inspectContainers: false,
              })
            : false;
        if (!healthMatchesLease(healthResponse, options.leasedInstance, allowUnreportedIdentity)) {
          throw new WrapperNotReadyError(
            'Started bootstrap wrapper did not report the leased physical instance'
          );
        }
        return { client };
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        if (attempt + 1 < MAX_PORT_ATTEMPTS) {
          logger
            .withFields({ agentSessionId, port, attempt: attempt + 1, error: lastError.message })
            .warn('Bootstrap wrapper startup failed, retrying with different port');
        }
      }
    }

    throw lastError ?? new WrapperNotReadyError('Failed to start bootstrap wrapper');
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

  async ensureSessionReady(
    request: WrapperSessionReadyRequest
  ): Promise<WrapperSessionReadySuccessResponse> {
    return this.request<WrapperSessionReadySuccessResponse>('POST', '/session/ready', request);
  }

  async updateRuntimeEnvironment(env: Record<string, string>): Promise<void> {
    await this.request<{ status: 'updated' }>('POST', '/session/environment', { env });
  }

  // ---------------------------------------------------------------------------
  // Action Methods (synchronous, no inflight tracking)
  // ---------------------------------------------------------------------------

  /** Send a command (slash command) to the wrapper. */
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
    response: WrapperPermissionResponse,
    message?: string
  ): Promise<{ success: boolean }> {
    const result = await this.request<{
      status: string;
      success: boolean;
    }>('POST', '/job/answer-permission', { permissionId, response, message });

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

/**
 * Wrapper client that talks to the already-running wrapper over containerFetch.
 * Used for terminal support so WebSocket/HTTP proxying goes through the wrapper
 * without starting a new wrapper process or using sandbox terminal primitives.
 */
export class WrapperContainerClient {
  private readonly sandbox: SandboxInstance;
  private readonly port: number;

  constructor(options: WrapperContainerClientOptions) {
    this.sandbox = options.sandbox;
    this.port = options.port;
  }

  private async request<T extends object>(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    body?: unknown
  ): Promise<T> {
    const response = await this.sandbox.containerFetch(
      `http://container${path}`,
      {
        method,
        headers: { 'Content-Type': 'application/json' },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      },
      this.port
    );

    const text = await response.text();
    const data = text ? (JSON.parse(text) as T & { error?: string; message?: string }) : ({} as T);

    const errorPayload = data as { error?: string; message?: string };
    if (!response.ok || errorPayload.error) {
      const errorCode = errorPayload.error ?? 'REQUEST_FAILED';
      logger
        .withFields({ method, path, port: this.port, statusCode: response.status, errorCode })
        .warn('Wrapper container HTTP request returned an application error');
      const message =
        typeof errorPayload.message === 'string'
          ? errorPayload.message
          : `Wrapper request failed with status ${response.status}`;
      throw new WrapperError(message, errorCode, response.status);
    }

    return data;
  }

  async health(): Promise<WrapperHealthResponse> {
    return this.request<WrapperHealthResponse>('GET', '/health');
  }

  async createTerminal(size?: { cols: number; rows: number }): Promise<WrapperPty> {
    return this.request<WrapperPty>('POST', '/pty', size);
  }

  async resizeTerminal(
    ptyId: string,
    size: {
      cols: number;
      rows: number;
    }
  ): Promise<WrapperPty> {
    return this.request<WrapperPty>('PUT', `/pty/${encodeURIComponent(ptyId)}`, size);
  }

  async closeTerminal(ptyId: string): Promise<{ success: boolean }> {
    return this.request<{ success: boolean }>('DELETE', `/pty/${encodeURIComponent(ptyId)}`);
  }

  async connectTerminal(ptyId: string, request: Request): Promise<Response> {
    return this.sandbox.wsConnect(
      new Request(`http://container/pty/${encodeURIComponent(ptyId)}/connect`, request),
      this.port
    );
  }
}
