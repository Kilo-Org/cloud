/**
 * Wrapper Manager
 *
 * Manages the lifecycle of wrapper instances within sandboxes.
 * Each cloud-agent session gets its own wrapper, identified by a
 * command marker (--agent-session {sessionId}) embedded in the process command.
 *
 * This is similar to server-manager.ts but for the wrapper process.
 */

import type { SandboxInstance } from '../types.js';
import { logger } from '../logger.js';

// Re-export Process type from sandbox for consumers
type Process = Awaited<ReturnType<SandboxInstance['listProcesses']>>[number];

/** Command-line marker to identify which session owns a wrapper */
const KILO_WRAPPER_SESSION_FLAG = '--agent-session';

/**
 * Information about a running wrapper.
 */
export type WrapperInfo = {
  port: number;
  process: Process;
};

/**
 * Extract port number from a wrapper command string.
 * Parses "WRAPPER_PORT=XXXX" from the command.
 *
 * @param command - The full command string
 * @returns The port number, or null if not found
 */
export function extractWrapperPortFromCommand(command: string): number | null {
  // Match WRAPPER_PORT= followed by digits
  const match = command.match(/WRAPPER_PORT=(\d+)/);
  if (match && match[1]) {
    const port = parseInt(match[1], 10);
    if (!isNaN(port) && port > 0 && port < 65536) {
      return port;
    }
  }
  return null;
}

/**
 * Extract session ID from a wrapper command string.
 * Parses "--agent-session XXX" from the command.
 *
 * @param command - The full command string
 * @returns The session ID, or null if not found
 */
export function extractWrapperSessionIdFromCommand(command: string): string | null {
  const flagIndex = command.indexOf(KILO_WRAPPER_SESSION_FLAG);
  if (flagIndex === -1) return null;

  const afterFlag = command.slice(flagIndex + KILO_WRAPPER_SESSION_FLAG.length).trimStart();
  if (!afterFlag) return null;

  const endIdx = afterFlag.indexOf(' ');
  if (endIdx === -1) {
    return afterFlag;
  }
  return afterFlag.slice(0, endIdx);
}

/**
 * Find a wrapper for the given session in a pre-fetched process list.
 * Useful when the caller already has the process list (e.g. to avoid
 * repeated listProcesses() calls in a loop).
 */
export function findWrapperForSessionInProcesses(
  processes: Process[],
  sessionId: string
): WrapperInfo | null {
  const marker = `${KILO_WRAPPER_SESSION_FLAG} ${sessionId}`;

  for (const proc of processes) {
    if (proc.command.includes(marker) && proc.command.includes('kilocode-wrapper')) {
      const status = proc.status;
      if (status === 'running' || status === 'starting') {
        const port = extractWrapperPortFromCommand(proc.command);
        if (port !== null) {
          logger
            .withFields({ sessionId, port, processId: proc.id, status })
            .debug('Found existing wrapper for session');
          return { port, process: proc };
        }
      }
    }
  }

  return null;
}

/**
 * Find an existing wrapper for the given session.
 * Scans listProcesses() for a command containing "--agent-session {sessionId}".
 *
 * @param sandbox - The sandbox instance to search in
 * @param sessionId - The cloud-agent session ID to find
 * @returns Wrapper info if found, null otherwise
 */
export async function findWrapperForSession(
  sandbox: SandboxInstance,
  sessionId: string
): Promise<WrapperInfo | null> {
  const processes = await sandbox.listProcesses();
  return findWrapperForSessionInProcesses(processes, sessionId);
}

/**
 * Get the session marker environment variable for a wrapper command.
 */
export function getWrapperSessionMarker(sessionId: string): string {
  return `${KILO_WRAPPER_SESSION_FLAG} ${sessionId}`;
}

/**
 * Stop a running wrapper for the given session.
 * Finds the wrapper process and sends SIGTERM.
 *
 * @param sandbox - The sandbox instance to search in
 * @param sessionId - The cloud-agent session ID
 */
export async function stopWrapper(sandbox: SandboxInstance, sessionId: string): Promise<void> {
  const existing = await findWrapperForSession(sandbox, sessionId);
  if (!existing) {
    logger.withFields({ sessionId }).debug('No wrapper found to stop');
    return;
  }
  const { process: proc, port } = existing;
  logger.withFields({ sessionId, port, processId: proc.id }).info('Stopping wrapper');
  const sessionMarker = getWrapperSessionMarker(sessionId);
  try {
    await sandbox.exec(`pkill -f -- '${sessionMarker}'`);
    logger.withFields({ sessionId, port }).info('Wrapper stopped');
  } catch (error) {
    logger
      .withFields({
        sessionId,
        port,
        error: error instanceof Error ? error.message : String(error),
      })
      .warn('Error stopping wrapper');
  }
}
