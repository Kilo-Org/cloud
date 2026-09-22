/**
 * Docker helpers for the lifecycle scenarios.
 *
 * Cloudflare's `wrangler dev` + @cloudflare/containers runtime launches sandbox
 * containers with synthesized names. The exact naming convention isn't pinned
 * by this repo, so we match on a stable substring (`Sandbox`) plus the worker
 * name (`cloud-agent-next-dev`) when present. Lifecycle tests snapshot the
 * current set before starting a session when they need to identify a newly
 * created sandbox. Scenarios that may overlap other sandbox creation use the
 * wrapper log filename to prove a container belongs to their Cloud Agent root.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Upper bound for any single Docker CLI call. `docker pause`/`unpause` on a
 * wedged daemon otherwise never resolves, which leaves the harness unable to
 * retain or clean up the frozen container's identity. A timed-out call is an
 * uncertain acknowledgement, not a no-op.
 */
export const DOCKER_COMMAND_TIMEOUT_MS = 30_000;

export type DockerCommandExecutor = (args: string[]) => Promise<{ stdout: string }>;

const executeDockerCommand: DockerCommandExecutor = async args => {
  const { stdout } = await execFileAsync('docker', args, {
    timeout: DOCKER_COMMAND_TIMEOUT_MS,
    killSignal: 'SIGKILL',
  });
  return { stdout };
};

/**
 * A control-plane Docker operation could not reach its container because the
 * container no longer exists or is not running. This is deliberately distinct
 * from "the container is running but ownership could not be proven": only a
 * gone container may be treated as a best-effort cleanup no-op, and only
 * "gone" produces this error.
 */
export class ControlPlaneContainerUnavailableError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = 'ControlPlaneContainerUnavailableError';
  }
}

const DOCKER_CONTAINER_GONE_MARKERS = ['No such container', 'is not running', 'No such object'];

/** True when a Docker CLI error means the named container is absent or stopped. */
export function isDockerContainerGoneError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return DOCKER_CONTAINER_GONE_MARKERS.some(marker => message.includes(marker));
}

export type SandboxContainer = {
  id: string;
  name: string;
  image: string;
  isProxy: boolean;
};

export type ControlPlaneKiloRuntime = {
  container: SandboxContainer;
  kiloSessionId: string;
  serverUrl: string;
  directory: string;
  home: string;
  processId: number;
  logPath?: string;
};

/**
 * Result of a workspace-file inspection. `unavailable` means the container was
 * already gone, so the file state could not be observed at all — callers must
 * not read that as "the file does not exist".
 */
export type ControlPlaneWorkspaceFile =
  | { unavailable: true; reason: string }
  | { unavailable?: false; exists: boolean; contents?: string; dirty: boolean; head: string };

type ControlPlaneKiloOperation = {
  action: 'discover' | 'completion' | 'file' | 'exclusive';
  kiloSessionId: string;
  serverUrl?: string;
  directory?: string;
  home?: string;
  processId?: number;
  ownerKiloSessionId?: string;
  messageId?: string;
  expectedText?: string;
  userMessageId?: string;
  filePath?: string;
  /**
   * Additional worktree directories the harness itself created for this root
   * across prior incarnations. Exclusivity still rejects any directory or
   * listener outside this exact set.
   */
  allowedDirectories?: string[];
};

type ExclusiveLayoutFs = {
  readdirSync: (directory: string) => string[];
  statSync: (filePath: string) => { isDirectory: () => boolean };
};

type ExclusiveLayoutPath = {
  dirname: (filePath: string) => string;
  basename: (filePath: string) => string;
  join: (...segments: string[]) => string;
};

export type ExclusiveLayoutInput = {
  directory: string;
  allowedDirectories?: string[];
  fs: ExclusiveLayoutFs;
  path: ExclusiveLayoutPath;
  listeners: ReadonlyArray<{ directory: string }>;
};

/**
 * Decide whether a control-plane Kilo root is the only worktree under its
 * parent. `sessions/<sessionId>` is the control-plane session workspace and
 * `worktrees/<worktreeId>` the worktree-sibling layout; both are legitimate.
 * The guard is the directory count plus the allowlist plus the listener set,
 * not the parent name: every sibling directory and every Kilo listener must be
 * the target directory or a harness-supplied `allowedDirectories` entry, so an
 * unknown directory or a foreign listener still refuses.
 *
 * One source of truth: the container `exclusive` operation embeds this function
 * with `toString()`, and the unit test calls it directly.
 */
export function computeExclusiveLayout(input: ExclusiveLayoutInput): {
  exclusive: boolean;
  directories: string[];
} {
  const { directory, allowedDirectories, fs, path, listeners } = input;
  const parent = path.dirname(directory);
  const allowed = new Set([
    directory,
    ...(Array.isArray(allowedDirectories) ? allowedDirectories : []),
  ]);
  const directories = fs
    .readdirSync(parent)
    .filter(name => fs.statSync(path.join(parent, name)).isDirectory())
    .map(name => path.join(parent, name));
  const sessionParent =
    path.basename(parent) === 'worktrees' || path.basename(parent) === 'sessions';
  return {
    exclusive:
      sessionParent &&
      directories.includes(directory) &&
      directories.every(candidate => allowed.has(candidate)) &&
      listeners.every(listener => allowed.has(listener.directory)),
    directories,
  };
}

const CONTROL_PLANE_KILO_SCRIPT = String.raw`
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const request = JSON.parse(process.argv[1] ?? '{}');

// __EXCLUSIVE_LAYOUT__

const KILO_SERVER_BASENAMES = new Set(['kilo', '.kilo']);

/**
 * Rosetta re-execs the CLI as: node --no-opt -r /proc/.reset <kilo> serve, so
 * /proc/<pid>/exe resolves to the Rosetta loader and the Kilo entrypoint may
 * not be argv[0]. Match a Kilo-named argv element with serve immediately
 * after it, scanning all argv. getRoot remains the authoritative ownership
 * proof: the socket must have a single owner and the session must report this
 * exact directory.
 */
function isKiloServeArgv(argv) {
  return argv.some(
    (arg, index) =>
      KILO_SERVER_BASENAMES.has(path.basename(arg)) && argv[index + 1] === 'serve'
  );
}

function kiloListeners() {
  const sockets = new Map();
  for (const table of ['/proc/net/tcp', '/proc/net/tcp6']) {
    let rows;
    try {
      rows = fs.readFileSync(table, 'utf8').split('\n').slice(1);
    } catch {
      continue;
    }
    for (const row of rows) {
      const fields = row.trim().split(/\s+/);
      const [address, hexPort] = fields[1]?.split(':') ?? [];
      const host = address === '0100007F' || address === '0000000000000000FFFF00000100007F'
        ? '127.0.0.1'
        : address === '00000000000000000000000001000000' ? '[::1]' : null;
      const port = parseInt(hexPort ?? '', 16);
      if (fields[3] !== '0A' || !host || !Number.isInteger(port) || port < 1 || port > 65535 || !fields[9]) continue;
      sockets.set(fields[9], { serverUrl: 'http://' + host + ':' + port, owners: new Set() });
    }
  }
  for (const pid of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(pid)) continue;
    let descriptors;
    try {
      descriptors = fs.readdirSync('/proc/' + pid + '/fd');
    } catch {
      continue;
    }
    for (const fd of descriptors) {
      try {
        const inode = fs.readlinkSync('/proc/' + pid + '/fd/' + fd).match(/^socket:\[(\d+)\]$/)?.[1];
        sockets.get(inode)?.owners.add(Number(pid));
      } catch {
        continue;
      }
    }
  }
  const listeners = [];
  for (const { serverUrl, owners } of sockets.values()) {
    if (owners.size !== 1) continue;
    const [processId] = owners;
    try {
      const argv = fs.readFileSync('/proc/' + processId + '/cmdline', 'utf8').split('\0');
      if (!isKiloServeArgv(argv)) continue;
      const cwd = fs.readlinkSync('/proc/' + processId + '/cwd');
      const directory = fs.realpathSync(cwd);
      if (!path.isAbsolute(cwd) || cwd !== directory) continue;
      const environment = fs.readFileSync('/proc/' + processId + '/environ', 'utf8');
      const home = environment.split('\0').find(value => value.startsWith('HOME='))?.slice(5);
      if (!home || !path.isAbsolute(home) || fs.realpathSync(home) !== home) continue;
      listeners.push({ serverUrl, processId, directory, home });
    } catch {
      continue;
    }
  }
  return listeners;
}

function sameListener(left, right) {
  return left.serverUrl === right.serverUrl && left.processId === right.processId && left.directory === right.directory;
}

async function getRoot(serverUrl, kiloSessionId, directory = request.directory) {
  const endpoint = new URL('/session/' + encodeURIComponent(kiloSessionId), serverUrl);
  endpoint.searchParams.set('directory', directory);
  const response = await fetch(endpoint, { signal: AbortSignal.timeout(3_000), redirect: 'error' });
  if (!response.ok) return null;
  const root = await response.json();
  if (
    typeof root !== 'object' ||
    root === null ||
    root.id !== kiloSessionId ||
    root.directory !== directory ||
    (root.parentID !== undefined && root.parentID !== null) ||
    fs.realpathSync(root.directory) !== directory
  ) {
    return null;
  }
  return { id: root.id, directory: root.directory, parentID: null };
}

async function run() {
  if (request.action === 'discover') {
    const matches = [];
    for (const listener of kiloListeners()) {
      let root;
      try {
        root = await getRoot(listener.serverUrl, request.kiloSessionId, listener.directory);
      } catch {
        continue;
      }
      if (!root) continue;
      const current = kiloListeners().filter(candidate => sameListener(candidate, listener));
      if (current.length !== 1) continue;
      matches.push({ ...listener, kiloSessionId: root.id });
    }
    if (matches.length > 1) return { ok: false, reason: 'Ambiguous Kilo root listener ownership' };
    const match = matches[0];
    if (!match) return { ok: true, matched: false };
    let logPath;
    try {
      for (const name of fs.readdirSync('/tmp')) {
        if (!/^kilocode-control-wrapper(?:-[^/]+)?\.log$/.test(name)) continue;
        const candidate = path.join('/tmp', name);
        const lines = fs.readFileSync(candidate, 'utf8').split('\n');
        if (
          lines.some(line => line.endsWith('session.attach ready directory=' + match.directory)) &&
          lines.some(line => line.split(/\s+/).includes('expectedKiloSessionId=' + request.kiloSessionId))
        ) {
          logPath = candidate;
          break;
        }
      }
    } catch {}
    return { ok: true, matched: true, ...match, ...(logPath ? { logPath } : {}) };
  }

  const listeners = kiloListeners().filter(listener => sameListener(listener, request));
  if (
    listeners.length !== 1 ||
    listeners[0].home !== request.home ||
    !(await getRoot(request.serverUrl, request.ownerKiloSessionId))
  ) {
    return { ok: false, reason: 'Owned Kilo listener identity did not match' };
  }

  if (request.action === 'exclusive') {
    const verdict = computeExclusiveLayout({
      directory: request.directory,
      allowedDirectories: request.allowedDirectories,
      fs,
      path,
      listeners: kiloListeners(),
    });
    return { ok: true, exclusive: verdict.exclusive, directories: verdict.directories };
  }

  const root = await getRoot(request.serverUrl, request.kiloSessionId);
  if (!root || root.parentID !== null) {
    return { ok: false, reason: 'Kilo root was not found' };
  }

  if (request.action === 'file') {
    if (typeof request.filePath !== 'string' || path.isAbsolute(request.filePath)) {
      return { ok: false, reason: 'workspace file path must be relative' };
    }
    const absolutePath = path.resolve(root.directory, request.filePath);
    if (!absolutePath.startsWith(root.directory + path.sep)) {
      return { ok: false, reason: 'workspace file path escaped the checkout' };
    }
    const head = execFileSync('git', ['-C', root.directory, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
    }).trim();
    const status = execFileSync(
      'git',
      ['-C', root.directory, 'status', '--porcelain', '--', request.filePath],
      { encoding: 'utf8' }
    );
    return {
      ok: true,
      exists: fs.existsSync(absolutePath),
      contents: fs.existsSync(absolutePath) ? fs.readFileSync(absolutePath, 'utf8') : undefined,
      dirty: status.trim().length > 0,
      head,
    };
  }

  if (request.action === 'completion') {
    const endpoint = new URL(
      '/session/' + encodeURIComponent(root.id) + '/message',
      request.serverUrl
    );
    endpoint.searchParams.set('directory', root.directory);
    const response = await fetch(endpoint, { signal: AbortSignal.timeout(5_000) });
    if (!response.ok) {
      return { ok: false, reason: 'Kilo messages returned HTTP ' + response.status };
    }
    const entries = await response.json();
    if (!Array.isArray(entries)) {
      return { ok: false, reason: 'Kilo messages response was not an array' };
    }
    const assistants = entries.filter(entry =>
      entry?.info?.role === 'assistant' &&
      entry.info.sessionID === root.id &&
      entry.info.parentID === request.messageId
    );
    const expectedText = request.expectedText ?? 'done';
    const assistantText = entry => Array.isArray(entry.parts)
      ? entry.parts
          .filter(part => part?.type === 'text' && typeof part.text === 'string')
          .map(part => part.text)
          .join('')
      : '';
    const assistant = assistants.find(entry => assistantText(entry).includes(expectedText)) ?? assistants.at(-1);
    if (!assistant)
      return { ok: true, found: false, userEntryFound: false, assistantEntryFound: false };
    const userEntry = entries.find(
      entry =>
        entry?.info?.role === 'user' &&
        entry.info.id === (request.userMessageId ?? request.messageId) &&
        entry.info.sessionID === request.kiloSessionId
    );
    const assistantEntryFound =
      assistant.info.sessionID === request.kiloSessionId &&
      assistant.info.parentID === request.messageId &&
      typeof assistant.info.time?.completed === 'number' &&
      assistantText(assistant).includes(expectedText);
    return {
      ok: true,
      found: true,
      sessionId: root.id,
      messageId: request.messageId,
      assistantMessageId: assistant.info.id,
      completed: typeof assistant.info.time?.completed === 'number',
      failed: assistant.info.error !== undefined,
      expectedText: assistantText(assistant).includes(expectedText),
      userEntryFound: userEntry !== undefined,
      assistantEntryFound,
    };
  }

  return { ok: false, reason: 'unsupported Kilo operation' };
}

run()
  .then(result => process.stdout.write(JSON.stringify(result)))
  .catch(error =>
    process.stdout.write(
      JSON.stringify({
        ok: false,
        reason:
          request.action + ' failed (' + (error instanceof Error ? error.name : 'unknown') + ')',
      })
    )
  );
`.replace('// __EXCLUSIVE_LAYOUT__', computeExclusiveLayout.toString());

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Read-only control-plane probes may be retried once:
 * - a transient fetch `TimeoutError` under Docker contention is not a terminal
 *   verdict;
 * - a `Owned Kilo listener identity did not match` for a read-only probe means
 *   the native runtime rotated (idle stop/wake, credential refresh) after the
 *   harness captured its `{serverUrl, processId}`. Re-discovering the same root
 *   in the same container and retrying with the fresh identity observes the
 *   same session+directory, so it cannot mask a real ownership divergence.
 *
 * `exclusive` is retried on a transient timeout but never re-anchored: its
 * callers already discover a fresh runtime before the destructive proof.
 */
const RETRYABLE_PROBE_ACTIONS: ReadonlySet<ControlPlaneKiloOperation['action']> = new Set([
  'discover',
  'completion',
  'file',
  'exclusive',
]);

const REANCHORABLE_PROBE_ACTIONS: ReadonlySet<ControlPlaneKiloOperation['action']> = new Set([
  'completion',
  'file',
]);

const PROBE_RETRY_DELAY_MS = 250;
const PROBE_MAX_ATTEMPTS = 2;

function isTransientProbeTimeout(error: unknown): boolean {
  return error instanceof Error && error.message.includes('failed (TimeoutError)');
}

function isStaleListenerIdentity(error: unknown): boolean {
  return (
    error instanceof Error && error.message.includes('Owned Kilo listener identity did not match')
  );
}

/**
 * Re-discover the operation's root and return an operation bound to the current
 * listener identity, or null when the container itself changed (the caller's
 * sandbox handle is stale and discovery, not a probe retry, is required).
 */
async function reanchorControlPlaneKiloOperation(
  containerId: string,
  operation: ControlPlaneKiloOperation,
  executeDocker: DockerCommandExecutor
): Promise<ControlPlaneKiloOperation | null> {
  const rootKiloSessionId = operation.ownerKiloSessionId ?? operation.kiloSessionId;
  const fresh = await findControlPlaneKiloRuntime(rootKiloSessionId, executeDocker).catch(
    () => null
  );
  if (!fresh || fresh.container.id !== containerId) return null;
  // A changed worktree directory is a divergent owner, not a rotated listener.
  if (fresh.directory !== operation.directory) return null;
  if (
    fresh.serverUrl === operation.serverUrl &&
    fresh.processId === operation.processId &&
    fresh.home === operation.home
  ) {
    return null;
  }
  return {
    ...operation,
    serverUrl: fresh.serverUrl,
    processId: fresh.processId,
    directory: fresh.directory,
    home: fresh.home,
  };
}

async function runControlPlaneKiloOperation(
  containerId: string,
  operation: ControlPlaneKiloOperation,
  executeDocker: DockerCommandExecutor = executeDockerCommand
): Promise<Record<string, unknown>> {
  const maxAttempts = RETRYABLE_PROBE_ACTIONS.has(operation.action) ? PROBE_MAX_ATTEMPTS : 1;
  let current = operation;
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await runControlPlaneKiloOperationOnce(containerId, current, executeDocker);
    } catch (error) {
      if (attempt >= maxAttempts) throw error;
      if (REANCHORABLE_PROBE_ACTIONS.has(operation.action) && isStaleListenerIdentity(error)) {
        const reanchored = await reanchorControlPlaneKiloOperation(
          containerId,
          current,
          executeDocker
        );
        if (reanchored) {
          current = reanchored;
          continue;
        }
      }
      if (!isTransientProbeTimeout(error)) throw error;
      await new Promise(resolve => setTimeout(resolve, PROBE_RETRY_DELAY_MS));
    }
  }
}

async function runControlPlaneKiloOperationOnce(
  containerId: string,
  operation: ControlPlaneKiloOperation,
  executeDocker: DockerCommandExecutor
): Promise<Record<string, unknown>> {
  let stdout: string;
  try {
    ({ stdout } = await executeDocker([
      'exec',
      containerId,
      'bun',
      '-e',
      CONTROL_PLANE_KILO_SCRIPT,
      JSON.stringify(operation),
    ]));
  } catch (error) {
    // Surface a gone container as a readable, typed error instead of the
    // opaque `Command failed: docker exec ...` from the CLI.
    if (isDockerContainerGoneError(error)) {
      throw new ControlPlaneContainerUnavailableError(
        `Kilo ${operation.action} could not reach ${containerId}: the container is gone`
      );
    }
    // A marker-less mid-exec death must be classified against the exact
    // container at this operation boundary. A running container keeps the
    // original throw; only a confirmed-absent one becomes typed-gone.
    const unavailable = await unavailableIfContainerGone(
      containerId,
      error,
      executeDocker,
      `Kilo ${operation.action} could not reach ${containerId}: the container is gone`
    );
    if (unavailable) throw unavailable;
    throw error;
  }
  const result: unknown = JSON.parse(stdout.trim());
  if (!isRecord(result)) {
    throw new Error(`Kilo ${operation.action} returned an invalid result`);
  }
  if (result.ok !== true) {
    const reason = typeof result.reason === 'string' ? result.reason : 'unknown failure';
    throw new Error(`Kilo ${operation.action} failed: ${reason}`);
  }
  return result;
}

export async function findControlPlaneKiloRuntime(
  kiloSessionId: string,
  executeDocker: DockerCommandExecutor = executeDockerCommand,
  onOwnedSandbox?: (sandbox: SandboxContainer) => void
): Promise<ControlPlaneKiloRuntime | null> {
  const containers = await listSandboxContainers(executeDocker);
  const matches: ControlPlaneKiloRuntime[] = [];
  for (const container of containers) {
    if (container.isProxy) continue;
    let result: Record<string, unknown>;
    try {
      result = await runControlPlaneKiloOperation(
        container.id,
        { action: 'discover', kiloSessionId },
        executeDocker
      );
    } catch (error) {
      // Discovery can fail because the container died mid-exec without a
      // recognised gone marker. Treat that as gone only when the exact
      // container is confirmed absent; otherwise preserve the failure.
      const unavailable = await unavailableIfContainerGone(
        container.id,
        error,
        executeDocker,
        `Kilo discover could not reach ${container.id}: the container is gone`
      );
      if (unavailable) continue;
      throw error;
    }
    if (result.matched !== true) continue;
    if (
      result.kiloSessionId !== kiloSessionId ||
      typeof result.serverUrl !== 'string' ||
      !/^http:\/\/(?:127\.0\.0\.1|\[::1\]):\d+$/.test(result.serverUrl) ||
      typeof result.directory !== 'string' ||
      !result.directory.startsWith('/') ||
      typeof result.home !== 'string' ||
      !result.home.startsWith('/') ||
      typeof result.processId !== 'number' ||
      !Number.isSafeInteger(result.processId) ||
      result.processId <= 0 ||
      (result.logPath !== undefined && typeof result.logPath !== 'string')
    ) {
      throw new Error(`Kilo root ${kiloSessionId} returned invalid control-wrapper discovery`);
    }
    matches.push({
      container,
      kiloSessionId,
      serverUrl: result.serverUrl,
      directory: result.directory,
      home: result.home,
      processId: result.processId,
      ...(typeof result.logPath === 'string' ? { logPath: result.logPath } : {}),
    });
  }
  if (matches.length > 1) throw new Error('Ambiguous Kilo root container ownership');
  const runtime = matches[0];
  if (!runtime) return null;
  onOwnedSandbox?.(runtime.container);
  return runtime;
}

/**
 * Prove the control-plane primary for `kiloSessionId` is the only worktree
 * under its Kilo root. `findControlPlaneKiloRuntime` proves a root is PRESENT;
 * exclusivity is the additional `exclusive` operation, which requires the
 * root's parent to hold only this worktree plus any harness-supplied
 * `allowedDirectories`, and every Kilo listener to belong to one of those.
 * `allowedDirectories` are the directories the scenario itself created for the
 * same root across prior incarnations (captured while each was exclusively
 * owned); unknown directories and foreign listeners still refuse. Presence
 * alone must never authorize a destructive or freezing action.
 */
async function assertExclusiveControlPlaneRuntime(
  runtime: ControlPlaneKiloRuntime,
  kiloSessionId: string,
  executeDocker: DockerCommandExecutor,
  allowedDirectories: readonly string[] = []
): Promise<void> {
  let result: Record<string, unknown>;
  try {
    result = await runControlPlaneKiloOperation(
      runtime.container.id,
      {
        action: 'exclusive',
        kiloSessionId,
        ownerKiloSessionId: kiloSessionId,
        serverUrl: runtime.serverUrl,
        directory: runtime.directory,
        home: runtime.home,
        processId: runtime.processId,
        allowedDirectories: [...allowedDirectories],
      },
      executeDocker
    );
  } catch (error) {
    // A failure can be the container dying mid-exec without a recognised gone
    // marker. Classify it against the exact container: absent is a best-effort
    // no-op, but a running container must keep a hard ownership-proof failure.
    const unavailable = await unavailableIfContainerGone(
      runtime.container.id,
      error,
      executeDocker,
      `Kilo exclusive could not reach ${runtime.container.id}: the container is gone`
    );
    if (unavailable) throw unavailable;
    throw new Error(
      `Cannot prove exclusive ownership of ${runtime.container.id}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
  if (result.exclusive !== true) {
    const directories = Array.isArray(result.directories)
      ? result.directories.join(',')
      : 'unknown';
    throw new Error(
      `Refusing cleanup of a sandbox with other worktrees: directories=${directories}; allowed=${[runtime.directory, ...allowedDirectories].join(',')}`
    );
  }
}

export async function stopOwnedControlPlaneSandbox(
  sandbox: SandboxContainer,
  kiloSessionId: string,
  executeDocker: DockerCommandExecutor = executeDockerCommand,
  allowedDirectories: readonly string[] = []
): Promise<string[]> {
  if (!(await isSandboxContainerRunning(sandbox.id, executeDocker))) {
    // The named container is absent or not running: there is nothing left to
    // stop. After a scenario kills or the wrapper retires the runtime this is
    // the expected state, so cleanup records a no-op instead of failing.
    console.warn(
      `stop-owned-sandbox(${kiloSessionId}): ${sandbox.name} is already gone; no stop issued`
    );
    return [];
  }
  const runtime = await findControlPlaneKiloRuntime(kiloSessionId, executeDocker);
  if (!runtime || runtime.container.id !== sandbox.id || runtime.container.name !== sandbox.name) {
    // The runtime proof vanished mid-flight. If the container is gone too, the
    // stop is already moot; a still-running container with no provable owner
    // must keep failing closed.
    if (!(await isSandboxContainerRunning(sandbox.id, executeDocker))) {
      console.warn(
        `stop-owned-sandbox(${kiloSessionId}): ${sandbox.name} vanished before ownership proof; no stop issued`
      );
      return [];
    }
    throw new Error('Cannot prove the original sandbox still owns the requested root');
  }
  try {
    await assertExclusiveControlPlaneRuntime(
      runtime,
      kiloSessionId,
      executeDocker,
      allowedDirectories
    );
  } catch (error) {
    if (error instanceof ControlPlaneContainerUnavailableError) {
      console.warn(
        `stop-owned-sandbox(${kiloSessionId}): ${sandbox.name} vanished during exclusive proof; no stop issued`
      );
      return [];
    }
    throw error;
  }
  return killSandboxFamily(sandbox, executeDocker);
}

/**
 * Identity of one in-container Kilo server process, captured while the runtime
 * was discoverable. `feed-stale-recovery` freezes ONLY this process so the
 * control wrapper and the container stay alive and the inbound `/global/event`
 * subscriber goes silent without an error.
 */
export type KiloServerProcessHandle = {
  containerId: string;
  processId: number;
};

/**
 * Send a signal to the exact Kilo server process captured earlier. Never
 * rediscover the process: a STOPPED Kilo server cannot answer a discovery
 * request, so the captured identity is the only safe handle for `CONT`.
 *
 * A `docker exec` that cannot reach the container or the process throws, so a
 * caller that must not leak a stopped process has to run `CONT` in `finally`
 * and record the outcome.
 */
export async function signalKiloServerProcess(
  handle: KiloServerProcessHandle,
  signal: 'STOP' | 'CONT',
  executeDocker: DockerCommandExecutor = executeDockerCommand
): Promise<void> {
  await executeDocker(['exec', handle.containerId, 'kill', `-${signal}`, String(handle.processId)]);
}

/**
 * The control wrapper is launched as
 * `bun run /usr/local/bin/kilocode-control-wrapper.js`
 * (`src/sandbox-control/cloudflare-provider.ts`). Its basename differs from the
 * per-worktree agent wrapper (`kilocode-wrapper.js`), so requiring both a Bun
 * argv element and the exact control-wrapper basename selects the control
 * wrapper's Bun process and never the Kilo server (`kilo serve`).
 */
const CONTROL_WRAPPER_PROCESS_SCRIPT = String.raw`
import fs from 'node:fs';
import path from 'node:path';

const CONTROL_WRAPPER_BASENAME = 'kilocode-control-wrapper.js';

function isControlWrapperArgv(argv) {
  return (
    argv.some(arg => path.basename(arg) === 'bun') &&
    argv.some(arg => path.basename(arg) === CONTROL_WRAPPER_BASENAME)
  );
}

const pids = [];
for (const pid of fs.readdirSync('/proc')) {
  if (!/^\d+$/.test(pid)) continue;
  let argv;
  try {
    argv = fs.readFileSync('/proc/' + pid + '/cmdline', 'utf8').split('\0');
  } catch {
    continue;
  }
  if (isControlWrapperArgv(argv)) pids.push(Number(pid));
}
process.stdout.write(JSON.stringify({ pids }));
`;

/**
 * Capture the control-wrapper Bun process for one container in a single
 * `docker exec`. The captured identity is the only safe handle for `STOP`/`CONT`:
 * a frozen process cannot answer a discovery request. Exactly one match is
 * required; zero or several matches is an ambiguous identity and throws.
 */
export async function captureControlWrapperProcess(
  containerId: string,
  executeDocker: DockerCommandExecutor = executeDockerCommand
): Promise<KiloServerProcessHandle> {
  const { stdout } = await executeDocker([
    'exec',
    containerId,
    'bun',
    '-e',
    CONTROL_WRAPPER_PROCESS_SCRIPT,
  ]);
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.trim());
  } catch {
    throw new Error(`control-wrapper capture for ${containerId} returned unreadable output`);
  }
  const pids =
    isRecord(parsed) && Array.isArray(parsed.pids)
      ? parsed.pids.filter(
          (pid): pid is number => typeof pid === 'number' && Number.isSafeInteger(pid) && pid > 0
        )
      : [];
  const [processId] = pids;
  if (pids.length !== 1 || processId === undefined) {
    throw new Error(
      `control-wrapper capture for ${containerId} expected exactly one process, found ${pids.length}`
    );
  }
  return { containerId, processId };
}

export async function inspectControlPlaneWorkspaceFile(
  runtime: ControlPlaneKiloRuntime,
  input: { kiloSessionId: string; filePath: string },
  executeDocker: DockerCommandExecutor = executeDockerCommand
): Promise<ControlPlaneWorkspaceFile> {
  let result: Record<string, unknown>;
  try {
    result = await runControlPlaneKiloOperation(
      runtime.container.id,
      {
        action: 'file',
        kiloSessionId: input.kiloSessionId,
        serverUrl: runtime.serverUrl,
        directory: runtime.directory,
        home: runtime.home,
        processId: runtime.processId,
        ownerKiloSessionId: runtime.kiloSessionId,
        filePath: input.filePath,
      },
      executeDocker
    );
  } catch (error) {
    // A mid-exec death can surface without a gone marker. Only report the file
    // as unavailable once the exact container is confirmed absent.
    const unavailable = await unavailableIfContainerGone(
      runtime.container.id,
      error,
      executeDocker,
      `Kilo file could not reach ${runtime.container.id}: the container is gone`
    );
    if (unavailable) return { unavailable: true, reason: unavailable.reason };
    throw error;
  }
  if (
    typeof result.exists !== 'boolean' ||
    typeof result.dirty !== 'boolean' ||
    typeof result.head !== 'string' ||
    (result.exists && typeof result.contents !== 'string')
  ) {
    throw new Error(`Kilo root ${input.kiloSessionId} returned invalid workspace file state`);
  }
  return {
    exists: result.exists,
    ...(typeof result.contents === 'string' ? { contents: result.contents } : {}),
    dirty: result.dirty,
    head: result.head,
  };
}

export type ControlPlaneHistoryInspection =
  | { unavailable: true; reason: string }
  | {
      unavailable?: false;
      ok: boolean;
      found: boolean;
      userEntryFound: boolean;
      assistantEntryFound: boolean;
    };

/**
 * Inspect both sides of a completed user turn in the live Kilo history. The
 * `completion` operation looks up the assistant entry by the parent user
 * message and additionally reports exact user-entry and completed-assistant
 * matches for this test-only oracle.
 */
export async function inspectControlPlaneHistory(
  runtime: ControlPlaneKiloRuntime,
  input: { kiloSessionId: string; userMessageId: string; assistantMarker: string },
  executeDocker: DockerCommandExecutor = executeDockerCommand
): Promise<ControlPlaneHistoryInspection> {
  let result: Record<string, unknown>;
  try {
    result = await runControlPlaneKiloOperation(
      runtime.container.id,
      {
        action: 'completion',
        kiloSessionId: input.kiloSessionId,
        serverUrl: runtime.serverUrl,
        directory: runtime.directory,
        processId: runtime.processId,
        ownerKiloSessionId: runtime.kiloSessionId,
        messageId: input.userMessageId,
        userMessageId: input.userMessageId,
        expectedText: input.assistantMarker,
      },
      executeDocker
    );
  } catch (error) {
    // A mid-exec death can surface without a gone marker. Only report the
    // history as unavailable once the exact container is confirmed absent.
    const unavailable = await unavailableIfContainerGone(
      runtime.container.id,
      error,
      executeDocker,
      `Kilo completion could not reach ${runtime.container.id}: the container is gone`
    );
    if (unavailable) return { unavailable: true, reason: unavailable.reason };
    throw error;
  }
  if (
    typeof result.found !== 'boolean' ||
    typeof result.userEntryFound !== 'boolean' ||
    typeof result.assistantEntryFound !== 'boolean'
  ) {
    throw new Error('Kilo history inspection returned invalid entry matches');
  }
  return {
    ok: result.ok === true,
    found: result.found,
    userEntryFound: result.userEntryFound,
    assistantEntryFound: result.assistantEntryFound,
  };
}

/**
 * List running sandbox containers. Returns proxy containers separately so
 * callers can kill them together with their primary.
 */
export async function listSandboxContainers(
  executeDocker: DockerCommandExecutor = executeDockerCommand
): Promise<SandboxContainer[]> {
  const { stdout } = await executeDocker(['ps', '--format', '{{.ID}}\t{{.Names}}\t{{.Image}}']);
  const result: SandboxContainer[] = [];
  for (const line of stdout.trim().split('\n')) {
    if (!line) continue;
    const [id, name, image] = line.split('\t');
    if (!id || !name || !image) continue;
    // Match sandbox DO container names. cloudflare/containers uses a naming
    // scheme that includes the DO class name; we match on `Sandbox` (covers
    // both `Sandbox` and `SandboxSmall`) plus the dev worker prefix when
    // present. Relaxed match keeps the harness robust to wrangler version
    // changes.
    const isSandbox =
      (name.includes('cloud-agent-next-dev') || name.includes('cloud-agent-next')) &&
      (name.includes('Sandbox') || image.includes('cloudflare/sandbox'));
    if (!isSandbox) continue;
    result.push({ id, name, image, isProxy: name.endsWith('-proxy') });
  }
  return result;
}

/** True when this exact container id is currently present and running. */
async function isSandboxContainerRunning(
  containerId: string,
  executeDocker: DockerCommandExecutor = executeDockerCommand
): Promise<boolean> {
  const containers = await listSandboxContainers(executeDocker);
  return containers.some(container => container.id === containerId);
}

/**
 * Classify a failed control-plane operation against the exact container it
 * targeted. Returns an unavailable error only when the container is confirmed
 * absent or stopped. A container that is running again returns `undefined`, so
 * the caller keeps a hard failure: a running container must never be treated as
 * an already-gone cleanup target.
 */
async function unavailableIfContainerGone(
  containerId: string,
  error: unknown,
  executeDocker: DockerCommandExecutor,
  fallbackReason: string
): Promise<ControlPlaneContainerUnavailableError | undefined> {
  if (await isSandboxContainerRunning(containerId, executeDocker)) return undefined;
  if (error instanceof ControlPlaneContainerUnavailableError) return error;
  return new ControlPlaneContainerUnavailableError(fallbackReason);
}

/**
 * Kill a container by ID. Swallows "no such container" errors so callers can
 * be defensive without try/catch.
 */
export async function killContainer(
  idOrName: string,
  executeDocker: DockerCommandExecutor = executeDockerCommand
): Promise<void> {
  try {
    // Fault injection must leave the container present-but-stopped: the DO
    // distinguishes an observed stop from an absent container, and removing it
    // mid-scenario changes that. Leaked stopped records are instead dropped at
    // scenario end by the campaign runner and by an explicit cleanup, so this
    // stays a kill.
    await executeDocker(['kill', idOrName]);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('No such container') || msg.includes('is not running')) return;
    throw err;
  }
}

/** Block until a primary sandbox appears that was not present in `knownIds`. */
export async function waitForNewSandboxPresent(
  knownIds: Set<string>,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<SandboxContainer | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    // Docker listing is not abortable mid-exec; honour the signal between polls.
    if (signal?.aborted) return null;
    const containers = await listSandboxContainers();
    const primary = containers.find(c => !c.isProxy && !knownIds.has(c.id));
    if (primary) return primary;
    await new Promise(r => setTimeout(r, 500));
  }
  return null;
}

async function sandboxHasWrapperLogForAgentSession(
  containerId: string,
  agentSessionId: string,
  executeDocker: DockerCommandExecutor
): Promise<boolean> {
  try {
    await executeDocker([
      'exec',
      containerId,
      'sh',
      '-c',
      'for log in /tmp/kilocode-wrapper-"$1"-*.log; do test -e "$log" && exit 0; done; exit 1',
      'sandbox-wrapper-log-match',
      agentSessionId,
    ]);
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('No such container') || msg.includes('is not running')) return false;
    if (typeof err === 'object' && err !== null && 'code' in err && err.code === 1) return false;
    throw err;
  }
}

/** Return primary sandboxes proven to belong to `agentSessionId` by wrapper log filename. */
export async function listSandboxesForAgentSession(
  agentSessionId: string,
  executeDocker: DockerCommandExecutor = executeDockerCommand
): Promise<SandboxContainer[]> {
  const containers = await listSandboxContainers(executeDocker);
  const matches: SandboxContainer[] = [];
  for (const container of containers) {
    if (container.isProxy) continue;
    if (await sandboxHasWrapperLogForAgentSession(container.id, agentSessionId, executeDocker)) {
      matches.push(container);
    }
  }
  return matches;
}

/**
 * Block until a running primary sandbox proves it belongs to `agentSessionId`.
 * Unmatched containers are never returned, even when they appeared recently.
 */
export async function waitForSandboxForAgentSession(
  agentSessionId: string,
  timeoutMs: number
): Promise<SandboxContainer | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const [sandbox] = await listSandboxesForAgentSession(agentSessionId);
    if (sandbox) return sandbox;
    await new Promise(r => setTimeout(r, 500));
  }
  return null;
}

export function sandboxFamilyKey(sandbox: SandboxContainer): string {
  return sandbox.isProxy ? sandbox.name.replace(/-proxy$/, '') : sandbox.name;
}

function sandboxFamilyNames(sandbox: SandboxContainer): Set<string> {
  const primaryName = sandbox.isProxy ? sandbox.name.replace(/-proxy$/, '') : sandbox.name;
  return new Set([primaryName, `${primaryName}-proxy`]);
}

/** Kill one sandbox container plus its proxy sibling when present. */
export async function killSandboxFamily(
  sandbox: SandboxContainer,
  executeDocker: DockerCommandExecutor = executeDockerCommand
): Promise<string[]> {
  const familyNames = sandboxFamilyNames(sandbox);
  const containers = await listSandboxContainers(executeDocker);
  if (
    containers.some(container => container.name === sandbox.name && container.id !== sandbox.id)
  ) {
    throw new Error('Refusing cleanup after sandbox container identity changed');
  }
  const killed: string[] = [];
  for (const container of containers) {
    if (!familyNames.has(container.name)) continue;
    await killContainer(container.id, executeDocker);
    killed.push(container.name);
  }
  return killed;
}

/** Block until a sandbox container and its proxy sibling are gone. */
export async function waitForSandboxFamilyGone(
  sandbox: SandboxContainer,
  timeoutMs: number,
  executeDocker: DockerCommandExecutor = executeDockerCommand
): Promise<boolean> {
  const familyNames = sandboxFamilyNames(sandbox);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const containers = await listSandboxContainers(executeDocker);
    if (!containers.some(container => familyNames.has(container.name))) return true;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  return false;
}

/**
 * True when the owned primary container is absent. Proxy sidecars are ignored:
 * the cold-resume absence predicate only requires the primary sandbox to be
 * gone, and a `-proxy` sibling may outlive it.
 */
export function isSandboxPrimaryGone(containers: SandboxContainer[], primaryId: string): boolean {
  return !containers.some(container => container.id === primaryId);
}

/**
 * Block until the owned primary sandbox is gone. Unlike
 * `waitForSandboxFamilyGone`, a lingering `-proxy` sidecar does not keep the
 * primary alive.
 */
export async function waitForSandboxPrimaryGone(
  sandbox: SandboxContainer,
  timeoutMs: number,
  executeDocker: DockerCommandExecutor = executeDockerCommand
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const containers = await listSandboxContainers(executeDocker);
    if (isSandboxPrimaryGone(containers, sandbox.id)) return true;
    await new Promise(r => setTimeout(r, 500));
  }
  return false;
}
