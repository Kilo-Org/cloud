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
import type { ObservedWrapper, WrapperObservation } from '../agent-sandbox/protocol.js';
import { logger } from '../logger.js';
import { KILO_AGENT_SESSION_LABEL, KILO_WRAPPER_PORT_LABEL } from './devcontainer.js';
import { dockerSocketEnv, resolveDockerSocketPath } from './sandbox-runtime.js';
import { shellQuote } from './utils.js';

// Re-export Process type from sandbox for consumers
type Process = Awaited<ReturnType<SandboxInstance['listProcesses']>>[number];

/** Command markers identifying the logical session and leased physical wrapper. */
const KILO_WRAPPER_SESSION_FLAG = '--agent-session';
const KILO_WRAPPER_INSTANCE_FLAG = '--wrapper-instance-id';
const KILO_WRAPPER_INSTANCE_GENERATION_FLAG = '--wrapper-instance-generation';
const KILO_WRAPPER_INSTANCE_ENV = 'WRAPPER_INSTANCE_ID=';
const KILO_WRAPPER_INSTANCE_GENERATION_ENV = 'WRAPPER_INSTANCE_GENERATION=';

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
function extractFlagValueFromCommand(command: string, flag: string): string | null {
  const flagIndex = command.indexOf(flag);
  if (flagIndex === -1) return null;

  const afterFlag = command.slice(flagIndex + flag.length).trimStart();
  if (!afterFlag) return null;

  const quote = afterFlag[0];
  if (quote === "'" || quote === '"') {
    const closingQuoteIndex = afterFlag.indexOf(quote, 1);
    return closingQuoteIndex === -1 ? null : afterFlag.slice(1, closingQuoteIndex);
  }

  const endIdx = afterFlag.indexOf(' ');
  return endIdx === -1 ? afterFlag : afterFlag.slice(0, endIdx);
}

export function extractWrapperSessionIdFromCommand(command: string): string | null {
  return extractFlagValueFromCommand(command, KILO_WRAPPER_SESSION_FLAG);
}

export function extractWrapperInstanceIdFromCommand(command: string): string | null {
  return (
    extractFlagValueFromCommand(command, KILO_WRAPPER_INSTANCE_FLAG) ??
    extractFlagValueFromCommand(command, KILO_WRAPPER_INSTANCE_ENV)
  );
}

export function extractWrapperInstanceGenerationFromCommand(command: string): number | null {
  const value =
    extractFlagValueFromCommand(command, KILO_WRAPPER_INSTANCE_GENERATION_FLAG) ??
    extractFlagValueFromCommand(command, KILO_WRAPPER_INSTANCE_GENERATION_ENV);
  if (!value) return null;
  const generation = Number.parseInt(value, 10);
  return Number.isInteger(generation) && generation >= 0 ? generation : null;
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
  port?: number;
};

export type WrapperContainerInspection =
  | { status: 'ok'; containers: LabeledWrapperRow[] }
  | { status: 'inspection-failed'; error: string };

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
export async function inspectWrapperContainers(
  executor: DockerExecutor,
  options?: { dockerEnv?: Record<string, string> }
): Promise<WrapperContainerInspection> {
  const cmd = `docker ps --filter label=${KILO_AGENT_SESSION_LABEL} --format '{{.ID}}\\t{{.Ports}}\\t{{.Labels}}'`;
  let result: { exitCode: number; stdout?: string; stderr?: string };
  try {
    const dockerEnv =
      options?.dockerEnv ?? dockerSocketEnv(await resolveDockerSocketPath(executor));
    result = await executor.exec(cmd, { env: dockerEnv });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.withFields({ error: message }).debug('docker ps for wrapper containers failed');
    return { status: 'inspection-failed', error: message };
  }
  if (result.exitCode !== 0) {
    return {
      status: 'inspection-failed',
      error: result.stderr?.trim() || `docker ps exited with code ${result.exitCode}`,
    };
  }

  const containers: LabeledWrapperRow[] = [];
  for (const line of (result.stdout ?? '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const [containerId, ports, labels] = trimmed.split('\t');
    if (!containerId || !labels) continue;
    const agentSessionId = extractLabelValue(labels, KILO_AGENT_SESSION_LABEL);
    if (!agentSessionId) continue;
    const port =
      extractPublishedWrapperPortFromLabel(labels) ?? extractPublishedWrapperPort(ports ?? '');
    containers.push({
      containerId,
      agentSessionId,
      ...(port === null ? {} : { port }),
    });
  }
  return { status: 'ok', containers };
}

export async function listWrapperContainers(
  executor: DockerExecutor,
  options?: { dockerEnv?: Record<string, string> }
): Promise<LabeledWrapperRow[]> {
  const inspection = await inspectWrapperContainers(executor, options);
  return inspection.status === 'ok' ? inspection.containers : [];
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
export async function discoverSessionWrappers(
  sandbox: SandboxInstance,
  sessionId: string,
  options?: { dockerEnv?: Record<string, string>; inspectContainers?: boolean }
): Promise<WrapperObservation> {
  let processes: Process[];
  try {
    processes = await sandbox.listProcesses();
  } catch (error) {
    return {
      status: 'inspection-failed',
      error: error instanceof Error ? error.message : String(error),
    };
  }

  const observed: ObservedWrapper[] = [];
  const marker = `${KILO_WRAPPER_SESSION_FLAG} ${sessionId}`;
  for (const proc of processes) {
    if (proc.command.includes('devcontainer exec')) continue;
    if (!proc.command.includes(marker) || !proc.command.includes('kilocode-wrapper')) continue;
    if (proc.status !== 'running' && proc.status !== 'starting') continue;
    const port = extractWrapperPortFromCommand(proc.command) ?? undefined;
    const instanceId = extractWrapperInstanceIdFromCommand(proc.command) ?? undefined;
    const instanceGeneration =
      extractWrapperInstanceGenerationFromCommand(proc.command) ?? undefined;
    observed.push({
      representation: 'process',
      id: proc.id,
      ...(port !== undefined ? { port } : {}),
      ...(instanceId ? { instanceId } : {}),
      ...(instanceGeneration !== undefined ? { instanceGeneration } : {}),
    });
  }

  if (options?.inspectContainers === false) {
    return observed.length === 0 ? { status: 'absent' } : { status: 'present', observed };
  }

  const containerInspection = await inspectWrapperContainers(sandbox, options);
  if (containerInspection.status === 'inspection-failed') return containerInspection;
  for (const container of containerInspection.containers) {
    if (container.agentSessionId !== sessionId) continue;
    let result: { exitCode: number; stdout?: string; stderr?: string };
    let dockerEnv: Record<string, string>;
    try {
      dockerEnv = options?.dockerEnv ?? dockerSocketEnv(await resolveDockerSocketPath(sandbox));
      result = await sandbox.exec(
        `docker exec ${shellQuote(container.containerId)} sh -c ${shellQuote('ps -eo pid=,args=')}`,
        { env: dockerEnv }
      );
    } catch (error) {
      return {
        status: 'inspection-failed',
        error: error instanceof Error ? error.message : String(error),
      };
    }
    if (result.exitCode !== 0) {
      return {
        status: 'inspection-failed',
        error: result.stderr?.trim() || `docker exec exited with code ${result.exitCode}`,
      };
    }
    for (const row of (result.stdout ?? '').split('\n')) {
      const parsedRow = row.match(/^\s*(\d+)\s+(.*)$/);
      const pid = parsedRow?.[1];
      const command = parsedRow?.[2] ?? row;
      if (!command.includes(marker) || !command.includes('kilocode-wrapper')) continue;

      let identitySource = command;
      if (pid) {
        let environmentResult: { exitCode: number; stdout?: string; stderr?: string };
        try {
          environmentResult = await sandbox.exec(
            `docker exec ${shellQuote(container.containerId)} sh -c ${shellQuote(
              `tr '\\000' ' ' < /proc/${pid}/environ`
            )}`,
            { env: dockerEnv }
          );
        } catch (error) {
          return {
            status: 'inspection-failed',
            error: error instanceof Error ? error.message : String(error),
          };
        }
        if (environmentResult.exitCode !== 0) {
          return {
            status: 'inspection-failed',
            error:
              environmentResult.stderr?.trim() ||
              `docker exec environment inspection exited with code ${environmentResult.exitCode}`,
          };
        }
        identitySource = `${environmentResult.stdout ?? ''} ${command}`;
      }
      const port = extractWrapperPortFromCommand(command) ?? container.port;
      const instanceId = extractWrapperInstanceIdFromCommand(identitySource) ?? undefined;
      const instanceGeneration =
        extractWrapperInstanceGenerationFromCommand(identitySource) ?? undefined;
      observed.push({
        representation: 'container',
        id: container.containerId,
        ...(port !== undefined ? { port } : {}),
        ...(instanceId ? { instanceId } : {}),
        ...(instanceGeneration !== undefined ? { instanceGeneration } : {}),
      });
    }
  }
  return observed.length === 0 ? { status: 'absent' } : { status: 'present', observed };
}

export async function findWrapperContainerForSession(
  executor: DockerExecutor,
  sessionId: string
): Promise<WrapperInfo | null> {
  const containers = await listWrapperContainers(executor);
  const match = containers.find(c => c.agentSessionId === sessionId && c.port !== undefined);
  if (!match || match.port === undefined) return null;

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
  const marker = `${KILO_WRAPPER_SESSION_FLAG} ${sessionId}`;
  const hasDirectWrapper = processes.some(
    process =>
      process.command.includes(marker) &&
      process.command.includes('kilocode-wrapper') &&
      (process.status === 'running' || process.status === 'starting')
  );
  if (hasDirectWrapper) return true;
  return containers.some(c => c.agentSessionId === sessionId);
}

/**
 * Get the session marker environment variable for a wrapper command.
 */
export function getWrapperSessionMarker(sessionId: string): string {
  return `${KILO_WRAPPER_SESSION_FLAG} ${sessionId}`;
}

export async function stopObservedWrappers(
  sandbox: SandboxInstance,
  sessionId: string,
  observed: ObservedWrapper[],
  options?: { force?: boolean; devcontainer?: { workspacePath: string; configPath?: string } }
): Promise<void> {
  const dockerRows = observed.filter(wrapper => wrapper.representation === 'container');
  const processRows = observed.filter(wrapper => wrapper.representation === 'process');
  const sessionMarker = getWrapperSessionMarker(sessionId);
  if (processRows.length > 0) {
    await sandbox.exec(
      `${options?.force ? 'pkill -9' : 'pkill'} -f -- ${shellQuote(sessionMarker)}`
    );
  }
  if (dockerRows.length > 0) {
    const dockerEnv = dockerSocketEnv(await resolveDockerSocketPath(sandbox));
    for (const wrapper of dockerRows) {
      const pkill = options?.force ? 'pkill -9' : 'pkill';
      await sandbox.exec(
        `docker exec ${shellQuote(wrapper.id)} sh -c ${shellQuote(
          `${pkill} -f -- ${shellQuote(sessionMarker)}`
        )}`,
        { env: dockerEnv }
      );
    }
  }
}
