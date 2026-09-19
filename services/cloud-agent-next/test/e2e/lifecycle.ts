/**
 * Local Docker support shared by the capability adapters and the aggregate
 * smoke run. The lifecycle *scenarios* now live in the shared registry
 * (`scenarios-shared*.ts`); this module retains only the control-plane sandbox
 * discovery/ownership/stop helpers that no public surface can express.
 *
 * Nothing here may be imported by a shared scenario module: the ownership
 * probes read Docker directly, so they stay behind `capabilities-local.ts`.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ApiVersion, DriverConfig, StreamEvent } from './client.js';
import type { ScenarioEnvironment } from './scenario-capabilities.js';
import {
  findControlPlaneKiloRuntime,
  killSandboxFamily,
  listSandboxContainers,
  listSandboxesForAgentSession,
  stopOwnedControlPlaneSandbox,
  waitForSandboxFamilyGone,
  type DockerCommandExecutor,
  type SandboxContainer,
} from './sandbox-control.js';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

export type ConversationScenario = string; // e.g. "echo:hi", "slow:5:200", "hang"

export type LifecycleResult = {
  name: string;
  conversation: string;
  ok: boolean;
  /** Set only by the shared-scenario gate for a declared-but-absent capability. */
  unsupported?: boolean;
  message: string;
  events: StreamEvent[];
  durationMs: number;
};

export type LifecycleArgs = {
  config: DriverConfig;
  conversation: ConversationScenario;
  /**
   * Which tRPC API surface to exercise. Defaults to the current unified
   * `start` / `send` procedures. Pass `'legacy'` to drive the
   * `prepareSession` + `initiateFromKilocodeSessionV2` + `sendMessageV2`
   * surface the web UI still uses.
   */
  api?: ApiVersion;
  /** Overall per-scenario timeout, resolved from the shared definition's default. */
  timeoutMs?: number;
  /**
   * Injected profile capabilities for a shared scenario. Runners always set
   * this; a shared scenario invoked without it fails loudly in
   * `runSharedScenario` instead of silently dropping its assertions.
   */
  env?: ScenarioEnvironment;
};

/**
 * Presence probe for a control-plane primary. Root presence is NOT exclusive
 * ownership: the wrapper restore paths no longer emit `session.attach ready
 * directory=`, so discovery now goes through the live Kilo root. Callers that
 * need exclusivity (kill, pause) must use the `exclusive` operation instead.
 */
async function sandboxOwnsSession(
  containerId: string,
  sessionId: string,
  kiloSessionId?: string
): Promise<boolean> {
  if (sessionId.startsWith('workspace_') && kiloSessionId !== undefined) {
    const runtime = await findControlPlaneKiloRuntime(kiloSessionId).catch(() => null);
    return runtime?.container.id === containerId;
  }
  const probe = `
    const fs = require('node:fs');
    const sessionId = process.argv.at(-1);
    if (!sessionId.startsWith('workspace_')) {
      const logs = fs.readdirSync('/tmp').filter(name => /^kilocode-wrapper-agent_.+\\.log$/.test(name));
      process.exit(logs.length > 0 && logs.every(name =>
        name.startsWith('kilocode-wrapper-' + sessionId + '-')
      ) ? 0 : 1);
    }
    const log = fs.readFileSync('/tmp/kilocode-control-wrapper.log', 'utf8');
    const directories = [...log.matchAll(/session\\.attach ready directory=([^\\n]+)/g)];
    process.exit(directories.length > 0 && directories.every(match =>
      match[1].trim().split('/').at(-1) === sessionId
    ) ? 0 : 1);
  `;
  try {
    await execFileAsync('docker', ['exec', containerId, 'bun', '-e', probe, sessionId], {
      timeout: 5_000,
    });
    return true;
  } catch {
    return false;
  }
}

async function findOwnedSandboxes(
  sessionId: string,
  kiloSessionId: string | undefined,
  knownIds: Set<string>
) {
  const candidates = sessionId.startsWith('workspace_')
    ? await listSandboxContainers()
    : await listSandboxesForAgentSession(sessionId);
  const matches: SandboxContainer[] = [];
  for (const container of candidates) {
    if (container.isProxy || knownIds.has(container.id)) continue;
    if (await sandboxOwnsSession(container.id, sessionId, kiloSessionId)) matches.push(container);
  }
  return matches;
}

export async function waitForOwnedSandbox(
  sessionId: string,
  kiloSessionId: string,
  knownIds: Set<string>,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<SandboxContainer | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    // Docker discovery is not abortable mid-exec, so the signal is honoured
    // between polls rather than during one.
    if (signal?.aborted) return null;
    const matches = await findOwnedSandboxes(sessionId, kiloSessionId, knownIds);
    if (matches.length > 1) {
      throw new Error(`Multiple containers match ${sessionId}; refusing ambiguous ownership`);
    }
    if (matches[0]) return matches[0];
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  return null;
}

/**
 * Single-shot owned-container discovery for the current session, used by the
 * `sessionSandbox.currentContainer` capability. Unlike `waitForOwnedSandbox` it
 * excludes nothing, because it observes a container that is expected to already
 * exist; it still refuses ambiguous ownership.
 */
export async function currentOwnedSandbox(
  sessionId: string,
  kiloSessionId: string
): Promise<SandboxContainer | null> {
  const matches = await findOwnedSandboxes(sessionId, kiloSessionId, new Set());
  if (matches.length > 1) {
    throw new Error(`Multiple containers match ${sessionId}; refusing ambiguous ownership`);
  }
  return matches[0] ?? null;
}

export type StopOwnedSandboxFamilyOptions = {
  executeDocker?: DockerCommandExecutor;
  familyGoneTimeoutMs?: number;
  /**
   * Worktree directories the scenario created for this root's prior
   * incarnations, captured while each was exclusively owned. Passing them lets
   * cleanup stop a live replacement whose parent also holds the retired
   * worktree, without weakening the exclusive-ownership proof.
   */
  allowedDirectories?: readonly string[];
};

export async function stopOwnedSandboxFamily(
  sandbox: SandboxContainer,
  sessionId: string,
  kiloSessionId?: string,
  options: StopOwnedSandboxFamilyOptions = {}
) {
  const { executeDocker, allowedDirectories = [] } = options;
  const familyGoneTimeoutMs = options.familyGoneTimeoutMs ?? 30_000;
  const current = (await listSandboxContainers(executeDocker)).find(
    container => container.name === sandbox.name
  );
  if (current && current.id !== sandbox.id)
    throw new Error(`Container identity changed for ${sandbox.name}`);
  let killed: string[];
  if (current && sessionId.startsWith('workspace_') && kiloSessionId !== undefined) {
    // Root presence is not exclusive ownership; the control-plane stop proves
    // the `exclusive` operation before it kills. The proof can fail merely
    // because the runtime was retired or replaced while the container was
    // winding down, so re-check the family before treating that as failure.
    try {
      killed = await stopOwnedControlPlaneSandbox(
        sandbox,
        kiloSessionId,
        executeDocker,
        allowedDirectories
      );
    } catch (error) {
      if (!(await waitForSandboxFamilyGone(sandbox, familyGoneTimeoutMs, executeDocker)))
        throw error;
      return [];
    }
  } else {
    if (current) {
      const owned = await sandboxOwnsSession(current.id, sessionId, kiloSessionId);
      if (!owned) throw new Error(`Cannot prove exclusive ownership of ${sandbox.name}`);
    }
    killed = await killSandboxFamily(sandbox, executeDocker);
  }
  if (!(await waitForSandboxFamilyGone(sandbox, familyGoneTimeoutMs, executeDocker))) {
    throw new Error(`Owned sandbox family ${sandbox.name} is still running after cleanup`);
  }
  return killed;
}

/** Only tear down sandboxes whose exclusive session ownership can be proven. */
export async function stopOwnedSessionSandboxes(sessionId: string): Promise<void> {
  for (const sandbox of await findOwnedSandboxes(sessionId, undefined, new Set())) {
    await stopOwnedSandboxFamily(sandbox, sessionId);
  }
}

/** Snapshot of live sandbox container ids, used to detect a new container. */
export async function snapshotSandboxIds(): Promise<Set<string>> {
  const containers = await listSandboxContainers();
  return new Set(containers.map(container => container.id));
}
