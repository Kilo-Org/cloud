/**
 * Wrapper Manager
 *
 * Manages the lifecycle of wrapper instances within sandboxes.
 * Each cloud-agent session gets its own wrapper, identified by a
 * command marker (--agent-session {sessionId}) embedded in the process command.
 *
 * This is similar to server-manager.ts but for the wrapper process,
 * using the 5xxx port range instead of 4xxx.
 */

import type { SandboxInstance } from '../types.js';
import { logger } from '../logger.js';

// Re-export Process type from sandbox for consumers
type Process = Awaited<ReturnType<SandboxInstance['listProcesses']>>[number];

/** Starting port for wrappers (5xxx range) */
const WRAPPER_START_PORT = 5000;

/** Port range size for session-based port allocation */
const WRAPPER_PORT_RANGE = 1000;

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
 * Find all ports currently in use by wrapper processes.
 * Used to avoid port collisions when starting a new wrapper.
 *
 * @param sandbox - The sandbox instance to search in
 * @returns Set of ports currently in use
 */
export async function findUsedWrapperPorts(sandbox: SandboxInstance): Promise<Set<number>> {
  const processes = await sandbox.listProcesses();
  const usedPorts = new Set<number>();

  for (const proc of processes) {
    if (proc.command.includes('kilocode-wrapper')) {
      const status = proc.status;
      if (status === 'running' || status === 'starting') {
        const port = extractWrapperPortFromCommand(proc.command);
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
 * @returns A port number in the range [WRAPPER_START_PORT, WRAPPER_START_PORT + WRAPPER_PORT_RANGE)
 */
export function deriveWrapperPortFromSessionId(sessionId: string): number {
  // Simple hash: sum of char codes modulo port range
  // Use a different multiplier than kilo server to spread ports differently
  let hash = 0;
  for (let i = 0; i < sessionId.length; i++) {
    hash = (hash * 37 + sessionId.charCodeAt(i)) >>> 0; // unsigned 32-bit
  }
  return WRAPPER_START_PORT + (hash % WRAPPER_PORT_RANGE);
}

/**
 * Find an available port for a wrapper, starting from the session-derived preferred port.
 * Falls back to scanning if the preferred port is in use.
 *
 * @param sandbox - The sandbox instance to check
 * @param sessionId - The session ID to derive the preferred port from
 * @returns First available port
 */
export async function findAvailableWrapperPort(
  sandbox: SandboxInstance,
  sessionId: string
): Promise<number> {
  const usedPorts = await findUsedWrapperPorts(sandbox);
  const preferredPort = deriveWrapperPortFromSessionId(sessionId);

  // Try preferred port first
  if (!usedPorts.has(preferredPort)) {
    return preferredPort;
  }

  // Fall back to scanning from preferred port
  for (let offset = 1; offset < WRAPPER_PORT_RANGE; offset++) {
    const port =
      WRAPPER_START_PORT + ((preferredPort - WRAPPER_START_PORT + offset) % WRAPPER_PORT_RANGE);
    if (!usedPorts.has(port)) {
      return port;
    }
  }

  // If all ports in range are used, scan beyond
  for (let port = WRAPPER_START_PORT + WRAPPER_PORT_RANGE; port < 65535; port++) {
    if (!usedPorts.has(port)) {
      return port;
    }
  }

  // Extremely unlikely to reach here
  throw new Error('No available ports for wrapper');
}

/**
 * Get the session marker environment variable for a wrapper command.
 */
export function getWrapperSessionMarker(sessionId: string): string {
  return `${KILO_WRAPPER_SESSION_FLAG} ${sessionId}`;
}
