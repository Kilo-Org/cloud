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
import {
  getDevContainerOverridePath,
  KILO_AGENT_SESSION_LABEL,
  KILO_WRAPPER_PORT_LABEL,
} from './devcontainer.js';
import { dockerSocketEnv, resolveDockerSocketPath } from './sandbox-runtime.js';
import { shellQuote } from './utils.js';

// Re-export Process type from sandbox for consumers
type Process = Awaited<ReturnType<SandboxInstance['listProcesses']>>[number];

/** Command-line marker to identify which session owns a wrapper */
const KILO_WRAPPER_SESSION_FLAG = '--agent-session';

/**
 * Information about a running wrapper.
 *
 * `kind` distinguishes between the two locations a wrapper can run:
 *   - `'process'` — directly on the outer sandbox; killable via `pkill -f`.
 *   - `'container'` — inside a dev container; killable via `docker kill <id>`
 *     where `<id>` is `process.id` (the docker container ID).
 */
export type WrapperInfo = {
  port: number;
  process: Process;
  kind: 'process' | 'container';
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
          return { port, process: proc, kind: 'process' };
        }
      }
    }
  }

  return null;
}

/**
 * Find an existing wrapper for the given session.
 *
 * Checks two places, in order:
 *   1. `sandbox.listProcesses()` — wrapper running directly on the outer
 *      sandbox (the non-devcontainer flow).
 *   2. `docker ps --filter label=kilo.agentSession=<id>` — wrapper running
 *      inside a dev container, with its port published to the outer loopback.
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
  const fromProcesses = findWrapperForSessionInProcesses(processes, sessionId);
  if (fromProcesses) return fromProcesses;

  return findWrapperContainerForSession(sandbox, sessionId);
}

// ---------------------------------------------------------------------------
// Docker-label discovery (devcontainer flow)
// ---------------------------------------------------------------------------

/**
 * `docker ps --format` rows for wrapper containers tagged with
 * `kilo.agentSession=<id>`. The published port we want is buried in the
 * `Ports` column (`0.0.0.0:5xxx->5xxx/tcp` or `127.0.0.1:5xxx->5xxx/tcp`).
 */
type LabeledWrapperRow = {
  containerId: string;
  agentSessionId: string;
  port: number;
};

/** Minimal exec surface — both `SandboxInstance` and `ExecutionSession` satisfy this. */
type DockerExecutor = {
  exec(
    command: string,
    options?: { env?: Record<string, string>; timeout?: number }
  ): Promise<{ exitCode: number; stdout?: string; stderr?: string }>;
};

/**
 * Extract the published wrapper port from a `docker ps` `Ports` field.
 * Tolerates either `0.0.0.0:PORT->PORT/tcp` or `127.0.0.1:PORT->PORT/tcp`,
 * and ignores any non-tcp / IPv6 mappings the runtime might emit.
 */
export function extractPublishedWrapperPort(portsField: string): number | null {
  // Iterate every "ip:port->port/tcp" mapping; take the first valid one.
  const re = /(?:0\.0\.0\.0|127\.0\.0\.1):(\d+)->\d+\/tcp/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(portsField)) !== null) {
    const port = parseInt(match[1], 10);
    if (!Number.isNaN(port) && port > 0 && port < 65536) {
      return port;
    }
  }
  return null;
}

/**
 * List all wrapper containers in the outer sandbox (one per active dev container).
 *
 * Uses `\\t` as a column separator so the `Ports` field — which can contain
 * spaces and arrows — survives intact. Each label key/value pair is emitted as
 * `Labels=k1=v1,k2=v2` so we can pull `kilo.agentSession` and the wrapper port.
 */
export async function listWrapperContainers(
  executor: DockerExecutor,
  options?: { dockerEnv?: Record<string, string> }
): Promise<LabeledWrapperRow[]> {
  const cmd = `docker ps --filter label=${KILO_AGENT_SESSION_LABEL} --format '{{.ID}}\\t{{.Ports}}\\t{{.Labels}}'`;
  let result: { exitCode: number; stdout?: string; stderr?: string } | undefined;
  try {
    const dockerEnv =
      options?.dockerEnv ?? dockerSocketEnv(await resolveDockerSocketPath(executor));
    result = await executor.exec(cmd, { env: dockerEnv });
  } catch (error) {
    logger
      .withFields({ error: error instanceof Error ? error.message : String(error) })
      .debug('docker ps for wrapper containers failed');
    return [];
  }
  // Defensive: a missing/undefined response (or non-zero exit) means docker
  // isn't reachable on this image — fall through and let process-list lookup
  // (or absence of wrapper) drive the decision.
  if (!result || result.exitCode !== 0) return [];

  const rows: LabeledWrapperRow[] = [];
  for (const line of (result.stdout ?? '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const [containerId, ports, labels] = trimmed.split('\t');
    if (!containerId || !labels) continue;
    const agentSessionId = extractLabelValue(labels, KILO_AGENT_SESSION_LABEL);
    if (!agentSessionId) continue;
    const port =
      extractPublishedWrapperPortFromLabel(labels) ?? extractPublishedWrapperPort(ports ?? '');
    if (port === null) continue;
    rows.push({ containerId, agentSessionId, port });
  }
  return rows;
}

function extractLabelValue(labelsField: string, labelKey: string): string | null {
  // labelsField looks like "k1=v1,k2=v2,kilo.agentSession=<id>". Split on
  // commas (a label value can't contain a comma), then look for the key.
  for (const kv of labelsField.split(',')) {
    const idx = kv.indexOf('=');
    if (idx === -1) continue;
    const key = kv.slice(0, idx).trim();
    if (key !== labelKey) continue;
    const value = kv.slice(idx + 1).trim();
    return value || null;
  }
  return null;
}

function extractPublishedWrapperPortFromLabel(labelsField: string): number | null {
  const value = extractLabelValue(labelsField, KILO_WRAPPER_PORT_LABEL);
  if (!value) return null;
  const port = parseInt(value, 10);
  return !Number.isNaN(port) && port > 0 && port < 65536 ? port : null;
}

/**
 * Find a wrapper container by `kilo.agentSession` label. Returns null if no
 * matching container is running. The returned `process` field is synthesised
 * from the docker row so existing callers can keep using a single `WrapperInfo`
 * shape — `id` is the container ID, `command` carries the agent-session marker
 * for diagnostics.
 */
export async function findWrapperContainerForSession(
  executor: DockerExecutor,
  sessionId: string
): Promise<WrapperInfo | null> {
  const containers = await listWrapperContainers(executor);
  const match = containers.find(c => c.agentSessionId === sessionId);
  if (!match) return null;

  // Synthesise a Process-shaped record so existing call sites that read
  // `proc.id` / `proc.command` still work.
  const synthetic: Process = {
    id: match.containerId,
    command: `[devcontainer] ${getWrapperSessionMarker(sessionId)} WRAPPER_PORT=${match.port}`,
    status: 'running',
    // The Process type may have additional optional fields (start time, etc.);
    // we don't have those values for a docker container, so leave them off.
  } as Process;

  logger
    .withFields({ sessionId, port: match.port, containerId: match.containerId })
    .debug('Found existing wrapper container for session');

  return { port: match.port, process: synthetic, kind: 'container' };
}

/**
 * Convenience helper for stale-workspace cleanup: returns true when an
 * agent-session marker is present *anywhere* — outer process list or
 * docker-label-tagged container.
 */
export function isWrapperLiveInProcessesOrContainers(
  processes: Process[],
  containers: LabeledWrapperRow[],
  sessionId: string
): boolean {
  if (findWrapperForSessionInProcesses(processes, sessionId)) return true;
  return containers.some(c => c.agentSessionId === sessionId);
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
export async function stopWrapper(
  sandbox: SandboxInstance,
  sessionId: string,
  options?: { devcontainer?: { workspacePath: string; configPath?: string } }
): Promise<void> {
  const existing = await findWrapperForSession(sandbox, sessionId);
  if (!existing) {
    logger.withFields({ sessionId }).debug('No wrapper found to stop');
    return;
  }
  const { process: proc, port, kind } = existing;
  logger.withFields({ sessionId, port, processId: proc.id, kind }).info('Stopping wrapper');
  try {
    if (kind === 'container') {
      const sessionMarker = getWrapperSessionMarker(sessionId);
      const dockerEnv = dockerSocketEnv(await resolveDockerSocketPath(sandbox));
      if (options?.devcontainer) {
        // The wrapper is inside a dev container — outer pkill can't see it.
        // Prefer killing just the wrapper process so follow-up executions keep
        // using the same devcontainer instead of falling back to the outer image.
        // `--config` is required so the CLI keeps applying our remoteUser/
        // remoteEnv overrides; the path is reconstructed from sessionId
        // since the override is written deterministically in
        // `bringUpDevContainer`.
        await sandbox.exec(
          [
            'devcontainer exec',
            `--workspace-folder ${shellQuote(options.devcontainer.workspacePath)}`,
            `--config ${shellQuote(
              getDevContainerOverridePath(
                sessionId,
                options.devcontainer.workspacePath,
                options.devcontainer.configPath
              )
            )}`,
            `--id-label ${shellQuote(`${KILO_AGENT_SESSION_LABEL}=${sessionId}`)}`,
            '--',
            'sh -c',
            shellQuote(`pkill -f -- ${shellQuote(sessionMarker)}`),
          ].join(' '),
          { env: dockerEnv }
        );
      } else {
        // No devcontainer metadata is available (e.g. older sessions). Kill the
        // container as a last-resort cleanup rather than leaving it leaked.
        await sandbox.exec(`docker kill ${shellQuote(proc.id)}`, { env: dockerEnv });
      }
    } else {
      const sessionMarker = getWrapperSessionMarker(sessionId);
      await sandbox.exec(`pkill -f -- ${shellQuote(sessionMarker)}`);
    }
    logger.withFields({ sessionId, port, kind }).info('Wrapper stopped');
  } catch (error) {
    logger
      .withFields({
        sessionId,
        port,
        kind,
        error: error instanceof Error ? error.message : String(error),
      })
      .warn('Error stopping wrapper');
  }
}
