/**
 * Kilo Server Manager
 *
 * Manages the lifecycle of kilo serve instances within sandboxes.
 * Each cloud-agent session gets its own kilo server, identified by a
 * command marker (KILO_CLOUD_SESSION={sessionId}) embedded in the process command.
 *
 * This allows us to:
 * 1. Find existing servers by scanning listProcesses()
 * 2. Avoid port collisions between sessions
 * 3. Reuse servers across multiple executions in the same session
 */

import type { SandboxInstance, ExecutionSession } from '../types.js';
import { logger } from '../logger.js';

// Re-export Process type from sandbox for consumers
type Process = Awaited<ReturnType<SandboxInstance['listProcesses']>>[number];

/** Starting port for kilo servers */
const KILO_SERVER_START_PORT = 4096;

/** Port range size for session-based port allocation */
const KILO_SERVER_PORT_RANGE = 1000;

/** Timeout for waiting for server to become healthy */
const KILO_SERVER_STARTUP_TIMEOUT_MS = 60_000;

/** Timeout for creating a CLI session via curl (30 seconds) */
const KILO_CLI_SESSION_CREATE_TIMEOUT_SECONDS = 30;

/** Environment variable marker to identify which session owns a server */
const KILO_CLOUD_SESSION_MARKER = 'KILO_CLOUD_SESSION';

/** Maximum retry attempts when port bind fails due to race condition */
const MAX_PORT_RETRY_ATTEMPTS = 3;

/**
 * Information about a running kilo server.
 */
export type KiloServerInfo = {
  port: number;
  process: Process;
};

/**
 * Extract port number from a kilo serve command string.
 * Parses "--port XXXX" from the command.
 *
 * @param command - The full command string
 * @returns The port number, or null if not found
 */
export function extractPortFromCommand(command: string): number | null {
  // Match --port followed by whitespace and digits
  const match = command.match(/--port\s+(\d+)/);
  if (match && match[1]) {
    const port = parseInt(match[1], 10);
    if (!isNaN(port) && port > 0 && port < 65536) {
      return port;
    }
  }
  return null;
}

/**
 * Extract session ID from a kilo serve command string.
 * Parses "KILO_CLOUD_SESSION=XXX" from the command.
 *
 * @param command - The full command string
 * @returns The session ID, or null if not found
 */
export function extractSessionIdFromCommand(command: string): string | null {
  const marker = `${KILO_CLOUD_SESSION_MARKER}=`;
  const idx = command.indexOf(marker);
  if (idx === -1) {
    return null;
  }

  // Extract everything after the marker until whitespace
  const startIdx = idx + marker.length;
  const endIdx = command.indexOf(' ', startIdx);
  if (endIdx === -1) {
    return command.slice(startIdx);
  }
  return command.slice(startIdx, endIdx);
}

/**
 * Find an existing kilo server for the given session.
 * Scans listProcesses() for a command containing KILO_CLOUD_SESSION={sessionId}.
 *
 * @param sandbox - The sandbox instance to search in
 * @param sessionId - The cloud-agent session ID to find
 * @returns Server info if found, null otherwise
 */
export async function findKiloServerForSession(
  sandbox: SandboxInstance,
  sessionId: string
): Promise<KiloServerInfo | null> {
  const processes = await sandbox.listProcesses();
  const marker = `${KILO_CLOUD_SESSION_MARKER}=${sessionId}`;

  for (const proc of processes) {
    if (proc.command.includes(marker) && proc.command.includes('kilo serve')) {
      const status = proc.status;
      if (status === 'running' || status === 'starting') {
        const port = extractPortFromCommand(proc.command);
        if (port !== null) {
          logger
            .withFields({ sessionId, port, processId: proc.id, status })
            .debug('Found existing kilo server for session');
          return { port, process: proc };
        }
      }
    }
  }

  return null;
}

/**
 * Find all ports currently in use by kilo serve processes.
 * Used to avoid port collisions when starting a new server.
 *
 * @param sandbox - The sandbox instance to search in
 * @returns Set of ports currently in use
 */
export async function findUsedKiloPorts(sandbox: SandboxInstance): Promise<Set<number>> {
  const processes = await sandbox.listProcesses();
  const usedPorts = new Set<number>();

  for (const proc of processes) {
    if (proc.command.includes('kilo serve')) {
      const status = proc.status;
      if (status === 'running' || status === 'starting') {
        const port = extractPortFromCommand(proc.command);
        if (port !== null) {
          usedPorts.add(port);
        }
      }
    }
  }

  return usedPorts;
}

/**
 * Derive a preferred port from a sessionId using a simple hash.
 * This ensures the same session consistently tries the same port first,
 * improving cache locality and making debugging easier.
 *
 * @param sessionId - The cloud-agent session ID
 * @returns A port number in the range [KILO_SERVER_START_PORT, KILO_SERVER_START_PORT + KILO_SERVER_PORT_RANGE)
 */
export function derivePortFromSessionId(sessionId: string): number {
  // Simple hash: sum of char codes modulo port range
  let hash = 0;
  for (let i = 0; i < sessionId.length; i++) {
    hash = (hash * 31 + sessionId.charCodeAt(i)) >>> 0; // unsigned 32-bit
  }
  return KILO_SERVER_START_PORT + (hash % KILO_SERVER_PORT_RANGE);
}

/**
 * Find an available port, starting from the session-derived preferred port.
 * Falls back to scanning if the preferred port is in use.
 *
 * @param sandbox - The sandbox instance to check
 * @param sessionId - The session ID to derive the preferred port from
 * @returns First available port
 */
export async function findAvailablePort(
  sandbox: SandboxInstance,
  sessionId: string
): Promise<number> {
  const usedPorts = await findUsedKiloPorts(sandbox);
  const preferredPort = derivePortFromSessionId(sessionId);

  // Try preferred port first
  if (!usedPorts.has(preferredPort)) {
    return preferredPort;
  }

  // Fall back to scanning from preferred port
  for (let offset = 1; offset < KILO_SERVER_PORT_RANGE; offset++) {
    const port =
      KILO_SERVER_START_PORT +
      ((preferredPort - KILO_SERVER_START_PORT + offset) % KILO_SERVER_PORT_RANGE);
    if (!usedPorts.has(port)) {
      return port;
    }
  }

  // If all ports in range are used, scan beyond
  for (let port = KILO_SERVER_START_PORT + KILO_SERVER_PORT_RANGE; port < 65535; port++) {
    if (!usedPorts.has(port)) {
      return port;
    }
  }

  // Extremely unlikely to reach here
  throw new Error('No available ports for kilo server');
}

/**
 * Build the kilo serve command with session marker.
 *
 * @param sessionId - The cloud-agent session ID
 * @param port - The port to listen on
 * @returns The full command string
 */
export function buildKiloServeCommand(sessionId: string, port: number): string {
  // Using env var prefix to mark the session, then kilo serve command
  // The cwd is set via startProcess options, so no cd needed here
  return `${KILO_CLOUD_SESSION_MARKER}=${sessionId} kilo serve --port ${port} --hostname 127.0.0.1`;
}

/**
 * Ensure a kilo server is running for the given session.
 *
 * This function:
 * 1. Checks if a server already exists for this session (sandbox-wide search)
 * 2. If found and running, returns its port
 * 3. If found and starting, waits for it to become healthy
 * 4. If not found, starts a new server within the execution session and waits for healthy
 * 5. Handles race conditions by retrying with a different port if bind fails
 *
 * @param sandbox - The sandbox instance (for listing processes across all sessions)
 * @param session - The execution session (for starting processes within session context)
 * @param sessionId - The cloud-agent session ID
 * @param workspacePath - The workspace directory for the session
 * @returns The port the server is listening on
 */
export async function ensureKiloServer(
  sandbox: SandboxInstance,
  session: ExecutionSession,
  sessionId: string,
  workspacePath: string
): Promise<number> {
  logger.withFields({ sessionId, workspacePath }).info('Ensuring kilo server is running');

  // 1. Check for existing server (sandbox-wide search)
  const existing = await findKiloServerForSession(sandbox, sessionId);

  if (existing) {
    const { process: proc, port } = existing;

    if (proc.status === 'running') {
      logger.withFields({ sessionId, port }).info('Reusing existing kilo server');
      return port;
    }

    if (proc.status === 'starting') {
      logger.withFields({ sessionId, port }).info('Found starting kilo server, waiting for ready');
      try {
        await proc.waitForPort(port, {
          mode: 'http',
          path: '/global/health',
          timeout: KILO_SERVER_STARTUP_TIMEOUT_MS,
        });
        logger.withFields({ sessionId, port }).info('Kilo server is now ready');
        return port;
      } catch (error) {
        // Server failed to start, will try to start a new one
        logger
          .withFields({
            sessionId,
            port,
            error: error instanceof Error ? error.message : String(error),
          })
          .warn('Existing kilo server failed to become ready');
      }
    }
  }

  // 2. Start a new server within the execution session
  let lastError: Error | undefined;

  for (let attempt = 0; attempt < MAX_PORT_RETRY_ATTEMPTS; attempt++) {
    const port = await findAvailablePort(sandbox, sessionId);
    const command = buildKiloServeCommand(sessionId, port);
    let proc: Process | undefined;

    logger
      .withFields({ sessionId, port, attempt: attempt + 1, command })
      .info('Starting new kilo server');

    try {
      proc = await session.startProcess(command, {
        cwd: workspacePath,
      });

      // Wait for server to become healthy
      await proc.waitForPort(port, {
        mode: 'http',
        path: '/global/health',
        timeout: KILO_SERVER_STARTUP_TIMEOUT_MS,
      });

      logger
        .withFields({ sessionId, port, processId: proc.id })
        .info('Kilo server started successfully');
      return port;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      let stderr: string | undefined;
      let stdout: string | undefined;
      if (proc) {
        try {
          const logs = await proc.getLogs();
          stdout = logs.stdout;
          stderr = logs.stderr;
        } catch (logError) {
          logger.debug('Failed to read kilo server process logs', {
            sessionId,
            port,
            processId: proc.id,
            error: logError instanceof Error ? logError.message : String(logError),
          });
        }
      }

      // Check if this might be a port collision (race condition)
      // Another session may have grabbed the port between our check and bind
      const errorMessage = lastError.message.toLowerCase();
      const isPortConflict =
        errorMessage.includes('address already in use') ||
        errorMessage.includes('eaddrinuse') ||
        errorMessage.includes('bind');

      if (isPortConflict && attempt + 1 < MAX_PORT_RETRY_ATTEMPTS) {
        logger
          .withFields({ sessionId, port, attempt: attempt + 1, error: lastError.message })
          .warn('Port conflict, retrying with different port');
        continue;
      }

      // Not a port conflict or max retries reached
      logger
        .withFields({
          sessionId,
          port,
          attempt: attempt + 1,
          error: lastError.message,
          stdout,
          stderr,
        })
        .error('Failed to start kilo server');
    }
  }

  throw lastError ?? new Error('Failed to start kilo server after retries');
}

/**
 * Stop the kilo server for a session (if running).
 * Called during cleanup or intentional shutdown.
 *
 * @param sandbox - The sandbox instance
 * @param sessionId - The cloud-agent session ID
 */
/**
 * Response from creating a kilo CLI session.
 */
export type KiloCliSession = {
  id: string;
  title?: string;
};

/**
 * Create a new kilo CLI session via the server API.
 * This creates a session in the running kilo server that can be used
 * for sending prompts and tracking conversation history.
 *
 * NOTE: This must be called from within the execution session since the kilo server
 * runs on 127.0.0.1 inside the sandbox container.
 *
 * @param session - The execution session to execute the request from
 * @param port - The kilo server port
 * @returns The created session with its ID
 */
export async function createKiloCliSession(
  session: ExecutionSession,
  port: number
): Promise<KiloCliSession> {
  const url = `http://127.0.0.1:${port}/session`;

  logger.withFields({ port }).debug('Creating kilo CLI session');

  // Execute curl from within the session since the server runs on localhost inside the container
  // -f: Fail silently on HTTP errors (exit code 22 for 4xx/5xx)
  // -s: Silent mode (no progress)
  // -S: Show errors when -s is used
  // --max-time: Timeout for the entire operation
  const result = await session.exec(
    `curl -f -s -S --max-time ${KILO_CLI_SESSION_CREATE_TIMEOUT_SECONDS} -X POST -H "Content-Type: application/json" -d "{}" "${url}"`
  );

  if (result.exitCode !== 0) {
    // Exit code 22 = HTTP error (4xx/5xx), 28 = timeout
    const exitCodeInfo =
      result.exitCode === 22
        ? 'HTTP error from server'
        : result.exitCode === 28
          ? 'Request timed out'
          : `exit code ${result.exitCode}`;
    throw new Error(
      `Failed to create kilo CLI session: ${exitCodeInfo} - ${result.stderr || result.stdout}`
    );
  }

  let kiloSession: KiloCliSession;
  try {
    kiloSession = JSON.parse(result.stdout) as KiloCliSession;
  } catch {
    throw new Error(`Failed to parse kilo CLI session response: ${result.stdout}`);
  }

  if (!kiloSession.id) {
    throw new Error(`Invalid kilo CLI session response - missing id: ${result.stdout}`);
  }

  logger.withFields({ port, kiloSessionId: kiloSession.id }).info('Created kilo CLI session');

  return kiloSession;
}

export async function stopKiloServer(sandbox: SandboxInstance, sessionId: string): Promise<void> {
  const existing = await findKiloServerForSession(sandbox, sessionId);

  if (!existing) {
    logger.withFields({ sessionId }).debug('No kilo server found to stop');
    return;
  }

  const { process: proc, port } = existing;

  logger.withFields({ sessionId, port, processId: proc.id }).info('Stopping kilo server');

  try {
    await proc.kill('SIGTERM');
    logger.withFields({ sessionId, port }).info('Kilo server stopped');
  } catch (error) {
    logger
      .withFields({
        sessionId,
        port,
        error: error instanceof Error ? error.message : String(error),
      })
      .warn('Error stopping kilo server');
  }
}
