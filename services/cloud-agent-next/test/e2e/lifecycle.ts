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

/**
 * A refused ownership proof is only re-checked this long for a sandbox that is
 * winding down on its own; the fault scenarios' 30 s default would stall every
 * scenario whose sandbox is not exclusive.
 */
const RECLAIM_FAMILY_GONE_TIMEOUT_MS = 5_000;
const RECLAIM_DOCKER_ATTEMPTS = 3;
const RECLAIM_DOCKER_RETRY_MS = 1_000;

export type ReclaimSession = { sessionId: string; kiloSessionId?: string };

export type SandboxReclaimReport = {
  /** Sandbox containers this call stopped. */
  stopped: string[];
  /** Why a session's sandbox was left alone. */
  failures: string[];
};

type LocatedSandbox = { container: SandboxContainer; directory: string | undefined };

/** The one primary sandbox a session provably owns, or `null` when none is running. */
async function locateOwnedSandbox(
  session: ReclaimSession,
  executeDocker: DockerCommandExecutor | undefined
): Promise<LocatedSandbox | null> {
  const { sessionId, kiloSessionId } = session;
  if (sessionId.startsWith('workspace_')) {
    if (kiloSessionId === undefined) {
      throw new Error(`no Kilo session id was recorded for ${sessionId}; ownership is unprovable`);
    }
    const runtime = await findControlPlaneKiloRuntime(kiloSessionId, executeDocker);
    return runtime ? { container: runtime.container, directory: runtime.directory } : null;
  }
  const matches = await listSandboxesForAgentSession(sessionId, executeDocker);
  if (matches.length > 1) {
    throw new Error(`multiple containers match ${sessionId}; refusing ambiguous ownership`);
  }
  return matches[0] ? { container: matches[0], directory: undefined } : null;
}

/**
 * Run a docker-scanning step again when a raw `docker` command failed. The scans
 * touch every sandbox, and a sibling scenario's reclaim can kill a container
 * mid-scan; that fails without a "gone" marker, and the next attempt sees the
 * container absent. Our own refusals (unprovable or shared ownership) are
 * deterministic and are thrown at once.
 */
async function retryTransientDocker<T>(step: () => Promise<T>, retryMs: number): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await step();
    } catch (error) {
      const transient = error instanceof Error && error.message.includes('Command failed: docker');
      if (!transient || attempt >= RECLAIM_DOCKER_ATTEMPTS) throw error;
      await new Promise(resolve => setTimeout(resolve, retryMs));
    }
  }
}

/**
 * Stop the sandbox families (primary and `-proxy`) that `sessions` provably own.
 * Each local session has its own `ses-…` sandbox (`PER_SESSION_SANDBOX_ORG_IDS`
 * is `*` in the dev config), and its proxy is named after it, so once the
 * gate has deleted the sessions nothing can address that sandbox again. One
 * sandbox is stopped once even when several sessions share it (a worktree's
 * chats); the sessions' own worktrees are the only extra directories the
 * exclusivity proof accepts. A sandbox whose ownership cannot be proven is left
 * running and reported, never killed. Never throws.
 */
export async function reclaimOwnedSandboxes(
  sessions: readonly ReclaimSession[],
  deps: {
    executeDocker?: DockerCommandExecutor;
    familyGoneTimeoutMs?: number;
    retryMs?: number;
  } = {}
): Promise<SandboxReclaimReport> {
  const { executeDocker } = deps;
  const retryMs = deps.retryMs ?? RECLAIM_DOCKER_RETRY_MS;
  const failures: string[] = [];
  const groups = new Map<
    string,
    { container: SandboxContainer; sessions: ReclaimSession[]; directories: string[] }
  >();
  for (const session of sessions) {
    try {
      const located = await retryTransientDocker(
        () => locateOwnedSandbox(session, executeDocker),
        retryMs
      );
      if (!located) continue;
      const group = groups.get(located.container.id) ?? {
        container: located.container,
        sessions: [],
        directories: [],
      };
      group.sessions.push(session);
      if (located.directory !== undefined) group.directories.push(located.directory);
      groups.set(located.container.id, group);
    } catch (error) {
      failures.push(`${session.sessionId}: ${errorText(error)}`);
    }
  }

  const stopped: string[] = [];
  for (const group of groups.values()) {
    const [owner] = group.sessions;
    if (!owner) continue;
    try {
      const killed = await retryTransientDocker(
        () =>
          stopOwnedSandboxFamily(group.container, owner.sessionId, owner.kiloSessionId, {
            ...(executeDocker ? { executeDocker } : {}),
            familyGoneTimeoutMs: deps.familyGoneTimeoutMs ?? RECLAIM_FAMILY_GONE_TIMEOUT_MS,
            allowedDirectories: group.directories,
          }),
        retryMs
      );
      if (killed.length > 0) stopped.push(group.container.name);
    } catch (error) {
      failures.push(`${group.container.name}: ${errorText(error)}`);
    }
  }

  return { stopped, failures };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Snapshot of live sandbox container ids, used to detect a new container. */
export async function snapshotSandboxIds(): Promise<Set<string>> {
  const containers = await listSandboxContainers();
  return new Set(containers.map(container => container.id));
}
