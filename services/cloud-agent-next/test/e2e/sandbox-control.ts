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

/**
 * Immutable identity of an exclusively owned control-plane primary, captured
 * while it is still reachable. `unpauseOwnedPrimary` never rediscoveries the
 * runtime from Kilo: a paused container may reject `docker exec`, so it acts on
 * this exact captured identity only.
 */
export type OwnedPrimaryHandle = {
  containerId: string;
  name: string;
  kiloSessionId: string;
  image: string;
};

export type PauseOwnedPrimaryOptions = {
  /**
   * Runs as soon as exclusive ownership is proven and the immutable handle is
   * captured, BEFORE `docker pause` is issued. Callers must retain this handle
   * so a hung or uncertain pause can still be cleaned up in `finally`.
   */
  onCaptured?: (handle: OwnedPrimaryHandle) => void;
  /**
   * Runs after exclusive ownership is proven and before `docker pause`. Use it
   * to capture state that must be read while the container is still runnable
   * (for example the wrapper's last heartbeat send line).
   */
  beforePause?: (handle: OwnedPrimaryHandle) => Promise<void>;
  /** Docker executor override for tests. */
  executeDocker?: DockerCommandExecutor;
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

export type ControlPlaneKiloRoot = {
  id: string;
  directory: string;
  home: string;
  processId: number;
};

export type ControlPlaneKiloCompletion = {
  sessionId: string;
  messageId: string;
  assistantMessageId: string;
};

/**
 * Result of a workspace-file inspection. `unavailable` means the container was
 * already gone, so the file state could not be observed at all — callers must
 * not read that as "the file does not exist".
 */
export type ControlPlaneWorkspaceFile =
  | { unavailable: true; reason: string }
  | { unavailable?: false; exists: boolean; contents?: string; dirty: boolean; head: string };

export type ControlPlaneQuestionVisibility = {
  unscoped: { status: number; count: number; matchingQuestion: boolean };
  scoped: { status: number; count: number; matchingQuestion: boolean };
};

type ControlPlaneKiloOperation = {
  action:
    | 'discover'
    | 'inspect'
    | 'exists'
    | 'import'
    | 'prompt'
    | 'completion'
    | 'file'
    | 'stage-file'
    | 'questions'
    | 'exclusive';
  kiloSessionId: string;
  serverUrl?: string;
  directory?: string;
  home?: string;
  processId?: number;
  ownerKiloSessionId?: string;
  sourceKiloSessionId?: string;
  messageId?: string;
  gateTag?: string;
  model?: string;
  expectedText?: string;
  userMessageId?: string;
  filePath?: string;
  bytes?: number;
  /**
   * Additional worktree directories the harness itself created for this root
   * across prior incarnations. Exclusivity still rejects any directory or
   * listener outside this exact set.
   */
  allowedDirectories?: string[];
  questionId?: string;
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

function rootResult(root, serverUrl) {
  const matches = kiloListeners().filter(listener => sameListener(listener, request));
  if (matches.length !== 1 || serverUrl !== request.serverUrl || root.directory !== request.directory) {
    return { ok: false, reason: 'Kilo listener identity changed' };
  }
  return { ok: true, id: root.id, directory: root.directory, home: request.home, processId: request.processId };
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

  if (request.action === 'inspect') {
    const root = await getRoot(request.serverUrl, request.kiloSessionId);
    return root ? rootResult(root, request.serverUrl) : { ok: false, reason: 'Kilo root was not found' };
  }

  if (request.action === 'exists') {
    const root = await getRoot(request.serverUrl, request.kiloSessionId);
    return { ok: true, exists: root !== null && root.parentID === null };
  }

  if (request.action === 'import') {
    const source = await getRoot(request.serverUrl, request.sourceKiloSessionId);
    if (!source || source.parentID !== null) {
      return { ok: false, reason: 'source Kilo root was not found' };
    }
    if (await getRoot(request.serverUrl, request.kiloSessionId)) {
      return { ok: false, reason: 'new Kilo root already exists' };
    }
    // Production ensureSession imports under the live current project id, not a
    // hardcoded one. A non-2xx here is reported with its HTTP status only; the
    // response body is never dumped.
    const projectEndpoint = new URL('/project/current', request.serverUrl);
    projectEndpoint.searchParams.set('directory', source.directory);
    const projectResponse = await fetch(projectEndpoint, { signal: AbortSignal.timeout(5_000) });
    if (!projectResponse.ok) {
      return { ok: false, reason: 'Kilo project lookup returned HTTP ' + projectResponse.status };
    }
    const project = await projectResponse.json();
    const projectId =
      project && typeof project === 'object' && typeof project.id === 'string' && project.id.length > 0
        ? project.id
        : null;
    if (!projectId) {
      return {
        ok: false,
        reason: 'Kilo project lookup returned no project id (HTTP ' + projectResponse.status + ')',
      };
    }
    const now = Date.now();
    const endpoint = new URL('/kilocode/session-import/session', request.serverUrl);
    endpoint.searchParams.set('directory', source.directory);
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: AbortSignal.timeout(8_000),
      body: JSON.stringify({
        id: request.kiloSessionId,
        projectID: projectId,
        slug: request.kiloSessionId.slice(0, 24),
        directory: source.directory,
        title: 'Cloud Agent Gate 0',
        version: '7.6.2',
        timeCreated: now,
        timeUpdated: now,
      }),
    });
    if (!response.ok) {
      // Keep the failure diagnostic bounded: an HTTP status plus an optional
      // short diagnostic ref token. Never dump the response body.
      let ref: string | undefined;
      try {
        const body: unknown = await response.json();
        const record = body && typeof body === 'object' ? (body as Record<string, unknown>) : undefined;
        const data =
          record && record.data && typeof record.data === 'object'
            ? (record.data as Record<string, unknown>)
            : undefined;
        const candidate =
          typeof record?.ref === 'string' ? record.ref : typeof data?.ref === 'string' ? data.ref : undefined;
        if (candidate !== undefined && /^[A-Za-z0-9_-]{1,64}$/.test(candidate)) ref = candidate;
      } catch {}
      return {
        ok: false,
        reason: 'Kilo session import returned HTTP ' + response.status + (ref ? ' ref=' + ref : ''),
      };
    }
    const root = await getRoot(request.serverUrl, request.kiloSessionId);
    if (!root || root.directory !== source.directory) {
      return { ok: false, reason: 'imported Kilo root did not preserve the source directory' };
    }
    return rootResult(root, request.serverUrl);
  }

  const root = await getRoot(request.serverUrl, request.kiloSessionId);
  if (!root || root.parentID !== null) {
    return { ok: false, reason: 'Kilo root was not found' };
  }

  if (request.action === 'questions') {
    const inspectQuestions = async scoped => {
      const endpoint = new URL('/question', request.serverUrl);
      if (scoped) endpoint.searchParams.set('directory', root.directory);
      const response = await fetch(endpoint, { signal: AbortSignal.timeout(5_000) });
      if (!response.ok) return { status: response.status, count: 0, matchingQuestion: false };
      const questions = await response.json();
      if (!Array.isArray(questions)) {
        return { status: response.status, count: 0, matchingQuestion: false };
      }
      return {
        status: response.status,
        count: questions.length,
        matchingQuestion: questions.some(
          question => question?.id === request.questionId && question.sessionID === root.id
        ),
      };
    };
    const [unscoped, scoped] = await Promise.all([inspectQuestions(false), inspectQuestions(true)]);
    return { ok: true, unscoped, scoped };
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

  if (request.action === 'stage-file') {
    if (
      typeof request.filePath !== 'string' ||
      path.isAbsolute(request.filePath) ||
      !Number.isSafeInteger(request.bytes) ||
      request.bytes < 0
    ) {
      return { ok: false, reason: 'workspace file path and byte count are required' };
    }
    const absolutePath = path.resolve(root.directory, request.filePath);
    if (!absolutePath.startsWith(root.directory + path.sep)) {
      return { ok: false, reason: 'workspace file path escaped the checkout' };
    }
    // Generate the bytes inside the container: the harness only sends the path
    // and count, so the large payload crosses Kilo -> wrapper -> client on the
    // read result instead of the (huge) tool-argument request path. Use short
    // lines so the read tool's per-line handling does not truncate the single
    // line; the file is still exactly request.bytes bytes.
    const lineWidth = 99;
    const line = 'x'.repeat(lineWidth) + '\n';
    const fullLines = Math.floor(request.bytes / (lineWidth + 1));
    const remainder = request.bytes - fullLines * (lineWidth + 1);
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.writeFileSync(absolutePath, line.repeat(fullLines) + 'x'.repeat(remainder));
    return { ok: true, byteCount: fs.statSync(absolutePath).size };
  }

  if (request.action === 'prompt') {
    const source = await getRoot(request.serverUrl, request.sourceKiloSessionId);
    if (!source || source.directory !== root.directory) {
      return { ok: false, reason: 'Kilo roots do not share one directory' };
    }
    const endpoint = new URL(
      '/session/' + encodeURIComponent(root.id) + '/prompt_async',
      request.serverUrl
    );
    endpoint.searchParams.set('directory', root.directory);
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: AbortSignal.timeout(8_000),
      body: JSON.stringify({
        messageID: request.messageId,
        agent: 'code',
        model: { providerID: 'kilo', modelID: request.model },
        parts: [{ type: 'text', text: '__fake__:gate:' + request.gateTag }],
      }),
    });
    return response.ok
      ? { ok: true, accepted: true, status: response.status }
      : { ok: false, reason: 'Kilo prompt returned HTTP ' + response.status };
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

async function runControlPlaneKiloOperation(
  containerId: string,
  operation: ControlPlaneKiloOperation,
  executeDocker: DockerCommandExecutor = executeDockerCommand
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

function requireControlPlaneKiloRoot(
  result: Record<string, unknown>,
  kiloSessionId: string
): ControlPlaneKiloRoot {
  if (
    result.id !== kiloSessionId ||
    typeof result.directory !== 'string' ||
    typeof result.home !== 'string' ||
    typeof result.processId !== 'number' ||
    !Number.isSafeInteger(result.processId) ||
    result.processId <= 0
  ) {
    throw new Error(`Kilo root ${kiloSessionId} returned invalid runtime identity`);
  }
  return {
    id: result.id,
    directory: result.directory,
    home: result.home,
    processId: result.processId,
  };
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
 * Prove exclusive ownership of `kiloSessionId`'s control-plane primary, then
 * freeze it with `docker pause`. Returns the captured identity that
 * `unpauseOwnedPrimary` must use; never unpause by re-discovering the Kilo
 * runtime, because a paused container may reject `docker exec`.
 *
 * The optional `beforePause` hook runs after the ownership proof and before the
 * freeze, so callers can capture live container state (wrapper heartbeat send
 * line) that is unavailable once the container is paused.
 */
export async function pauseOwnedPrimary(
  kiloSessionId: string,
  options: PauseOwnedPrimaryOptions = {}
): Promise<OwnedPrimaryHandle> {
  const executeDocker = options.executeDocker ?? executeDockerCommand;
  const runtime = await findControlPlaneKiloRuntime(kiloSessionId, executeDocker);
  if (!runtime) {
    throw new Error(`Cannot prove an exclusively owned control-plane primary for ${kiloSessionId}`);
  }
  if (runtime.container.isProxy || runtime.container.name.endsWith('-proxy')) {
    throw new Error('Refusing to pause a sandbox proxy container');
  }
  await assertExclusiveControlPlaneRuntime(runtime, kiloSessionId, executeDocker);
  const handle: OwnedPrimaryHandle = {
    containerId: runtime.container.id,
    name: runtime.container.name,
    kiloSessionId,
    image: runtime.container.image,
  };
  // Retain the identity before the freeze. A hung pause ack must not be able to
  // strand a frozen container that the caller cannot name.
  options.onCaptured?.(handle);
  await options.beforePause?.(handle);
  try {
    await executeDocker(['pause', handle.containerId]);
  } catch (error) {
    // A failed or timed-out pause ack must not leave a frozen container behind.
    let cleanupFailure: string | undefined;
    try {
      await unpauseOwnedPrimary(handle, executeDocker);
    } catch (cleanupError) {
      cleanupFailure = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
    }
    if (cleanupFailure !== undefined) {
      throw new Error(
        `docker pause ${handle.name} failed (${error instanceof Error ? error.message : String(error)}); identity cleanup also failed (${cleanupFailure}); container ${handle.containerId} may be frozen`
      );
    }
    throw error;
  }
  return handle;
}

/**
 * Unfreeze the exact container captured by `pauseOwnedPrimary`.
 *
 * Acts only on the captured identity, verified with Docker metadata rather than
 * a live Kilo runtime lookup. Idempotent: an already-unpaused or already-gone
 * container is a no-op, so callers can put this in `finally` without masking
 * the original failure.
 */
export async function unpauseOwnedPrimary(
  handle: OwnedPrimaryHandle,
  executeDocker: DockerCommandExecutor = executeDockerCommand
): Promise<void> {
  if (handle.name.endsWith('-proxy')) {
    throw new Error('Refusing to unpause a sandbox proxy container');
  }
  let stdout: string;
  try {
    ({ stdout } = await executeDocker([
      'inspect',
      '--format',
      '{{.Id}}\t{{.Name}}\t{{.State.Paused}}',
      handle.containerId,
    ]));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('No such container')) return;
    throw error;
  }
  const [id, rawName, paused] = stdout.trim().split('\t');
  if (!id || !id.startsWith(handle.containerId) || rawName?.replace(/^\//, '') !== handle.name) {
    throw new Error(`Refusing to unpause: container identity no longer matches ${handle.name}`);
  }
  if (paused === 'false') return;
  if (paused !== 'true') throw new Error(`Refusing to unpause ${handle.name}: unknown pause state`);
  await executeDocker(['unpause', handle.containerId]);
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

export async function waitForControlPlaneKiloRuntime(
  kiloSessionId: string,
  timeoutMs: number,
  onOwnedSandbox?: (sandbox: SandboxContainer) => void
): Promise<ControlPlaneKiloRuntime | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const runtime = await findControlPlaneKiloRuntime(
      kiloSessionId,
      executeDockerCommand,
      onOwnedSandbox
    );
    if (runtime) return runtime;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  return null;
}

export async function inspectControlPlaneKiloRoot(
  runtime: ControlPlaneKiloRuntime,
  kiloSessionId: string
): Promise<ControlPlaneKiloRoot> {
  const result = await runControlPlaneKiloOperation(runtime.container.id, {
    action: 'inspect',
    kiloSessionId,
    serverUrl: runtime.serverUrl,
    directory: runtime.directory,
    home: runtime.home,
    processId: runtime.processId,
    ownerKiloSessionId: runtime.kiloSessionId,
  });
  return requireControlPlaneKiloRoot(result, kiloSessionId);
}

export async function controlPlaneKiloRootExists(
  runtime: ControlPlaneKiloRuntime,
  kiloSessionId: string
): Promise<boolean> {
  const result = await runControlPlaneKiloOperation(runtime.container.id, {
    action: 'exists',
    kiloSessionId,
    serverUrl: runtime.serverUrl,
    directory: runtime.directory,
    home: runtime.home,
    processId: runtime.processId,
    ownerKiloSessionId: runtime.kiloSessionId,
  });
  if (typeof result.exists !== 'boolean') {
    throw new Error(`Kilo root ${kiloSessionId} returned invalid existence status`);
  }
  return result.exists;
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

/**
 * Stage a file of exactly `bytes` bytes (x-filled short lines) inside the owned
 * worktree so a fake `read` directive has a real payload to stream back. The
 * content is generated inside the container, so the large payload crosses
 * Kilo -> wrapper -> client on the read RESULT instead of the tool-argument
 * request that stalls.
 */
export async function stageControlPlaneWorkspaceFile(
  runtime: ControlPlaneKiloRuntime,
  input: { kiloSessionId: string; filePath: string; bytes: number },
  executeDocker: DockerCommandExecutor = executeDockerCommand
): Promise<{ byteCount: number }> {
  const result = await runControlPlaneKiloOperation(
    runtime.container.id,
    {
      action: 'stage-file',
      kiloSessionId: input.kiloSessionId,
      serverUrl: runtime.serverUrl,
      directory: runtime.directory,
      processId: runtime.processId,
      ownerKiloSessionId: runtime.kiloSessionId,
      filePath: input.filePath,
      bytes: input.bytes,
    },
    executeDocker
  );
  if (result.byteCount !== input.bytes) {
    throw new Error(
      `staged file ${input.filePath} reported ${String(result.byteCount)} bytes, expected ${input.bytes}`
    );
  }
  return { byteCount: input.bytes };
}

export async function inspectControlPlaneQuestions(
  runtime: ControlPlaneKiloRuntime,
  input: { kiloSessionId: string; questionId: string }
): Promise<ControlPlaneQuestionVisibility> {
  const result = await runControlPlaneKiloOperation(runtime.container.id, {
    action: 'questions',
    kiloSessionId: input.kiloSessionId,
    questionId: input.questionId,
    serverUrl: runtime.serverUrl,
    directory: runtime.directory,
    home: runtime.home,
    processId: runtime.processId,
    ownerKiloSessionId: runtime.kiloSessionId,
  });
  const { unscoped, scoped } = result;
  if (
    !isRecord(unscoped) ||
    !isRecord(scoped) ||
    typeof unscoped.status !== 'number' ||
    typeof unscoped.count !== 'number' ||
    typeof unscoped.matchingQuestion !== 'boolean' ||
    typeof scoped.status !== 'number' ||
    typeof scoped.count !== 'number' ||
    typeof scoped.matchingQuestion !== 'boolean'
  ) {
    throw new Error('Kilo question inspection returned invalid sanitized visibility');
  }
  return {
    unscoped: {
      status: unscoped.status,
      count: unscoped.count,
      matchingQuestion: unscoped.matchingQuestion,
    },
    scoped: {
      status: scoped.status,
      count: scoped.count,
      matchingQuestion: scoped.matchingQuestion,
    },
  };
}

export async function importControlPlaneKiloRoot(
  runtime: ControlPlaneKiloRuntime,
  kiloSessionId: string
): Promise<ControlPlaneKiloRoot> {
  const result = await runControlPlaneKiloOperation(runtime.container.id, {
    action: 'import',
    kiloSessionId,
    sourceKiloSessionId: runtime.kiloSessionId,
    serverUrl: runtime.serverUrl,
    directory: runtime.directory,
    home: runtime.home,
    processId: runtime.processId,
    ownerKiloSessionId: runtime.kiloSessionId,
  });
  return requireControlPlaneKiloRoot(result, kiloSessionId);
}

export async function promptControlPlaneKiloRoot(
  runtime: ControlPlaneKiloRuntime,
  input: { kiloSessionId: string; messageId: string; gateTag: string; model: string }
): Promise<void> {
  const result = await runControlPlaneKiloOperation(runtime.container.id, {
    action: 'prompt',
    kiloSessionId: input.kiloSessionId,
    sourceKiloSessionId: runtime.kiloSessionId,
    serverUrl: runtime.serverUrl,
    directory: runtime.directory,
    home: runtime.home,
    processId: runtime.processId,
    ownerKiloSessionId: runtime.kiloSessionId,
    messageId: input.messageId,
    gateTag: input.gateTag,
    model: input.model,
  });
  if (result.accepted !== true) {
    throw new Error(`Kilo root ${input.kiloSessionId} did not accept its prompt`);
  }
}

export async function waitForControlPlaneKiloCompletion(
  runtime: ControlPlaneKiloRuntime,
  input: { kiloSessionId: string; messageId: string; timeoutMs: number; expectedText?: string }
): Promise<ControlPlaneKiloCompletion> {
  const deadline = Date.now() + input.timeoutMs;
  while (Date.now() < deadline) {
    let result: Record<string, unknown>;
    try {
      result = await runControlPlaneKiloOperation(runtime.container.id, {
        action: 'completion',
        kiloSessionId: input.kiloSessionId,
        serverUrl: runtime.serverUrl,
        directory: runtime.directory,
        home: runtime.home,
        processId: runtime.processId,
        ownerKiloSessionId: runtime.kiloSessionId,
        messageId: input.messageId,
        ...(input.expectedText ? { expectedText: input.expectedText } : {}),
      });
    } catch (error) {
      // One slow in-container `/message` fetch surfaces as a `TimeoutError`
      // from the 5s `AbortSignal.timeout`. That is a transient poll failure,
      // not a terminal completion verdict, so keep polling until the deadline.
      // Every other failure (HTTP status, assistant error, identity mismatch,
      // gone container) stays terminal.
      if (error instanceof Error && error.message.includes('completion failed (TimeoutError)')) {
        await new Promise(resolve => setTimeout(resolve, 200));
        continue;
      }
      throw error;
    }
    if (result.found === true) {
      if (result.failed === true) {
        throw new Error(`Kilo root ${input.kiloSessionId} finished with an assistant error`);
      }
      if (result.completed === true && result.expectedText === true) {
        if (
          result.sessionId !== input.kiloSessionId ||
          result.messageId !== input.messageId ||
          typeof result.assistantMessageId !== 'string'
        ) {
          throw new Error(`Kilo root ${input.kiloSessionId} returned an invalid completion`);
        }
        return {
          sessionId: result.sessionId,
          messageId: result.messageId,
          assistantMessageId: result.assistantMessageId,
        };
      }
    }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error(`Kilo root ${input.kiloSessionId} did not complete within ${input.timeoutMs}ms`);
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
 * completion operation retains the existing assistant lookup used by
 * waitForControlPlaneKiloCompletion and additionally reports exact user-entry
 * and completed-assistant matches for this test-only oracle.
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
  timeoutMs: number
): Promise<SandboxContainer | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
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

/** Run a shell command inside a container and read its stdout; null when absent. */
async function readContainerFile(
  containerId: string,
  shellCommand: string
): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      'docker',
      ['exec', containerId, 'sh', '-c', shellCommand],
      { timeout: DOCKER_COMMAND_TIMEOUT_MS, killSignal: 'SIGKILL' }
    );
    return stdout || null;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('No such container') || msg.includes('is not running')) return null;
    throw err;
  }
}

/**
 * Read the wrapper log file inside a running sandbox container. Used for
 * smoke tests to assert "using fake kilo client" is present after boot.
 *
 * Returns null if the wrapper log isn't findable — the wrapper writes to
 * `/tmp/kilocode-wrapper-*.log`, so we glob for the newest file.
 */
export async function readWrapperLog(containerId: string): Promise<string | null> {
  return readContainerFile(
    containerId,
    'ls -t /tmp/kilocode-wrapper-*.log 2>/dev/null | head -n 1 | xargs -r cat'
  );
}

/**
 * Read the control wrapper log file inside a running sandbox container.
 *
 * The control wrapper (`kilocode-control-wrapper.js`) writes to the fixed
 * `/tmp/kilocode-control-wrapper.log` path (`src/sandbox-control/cloudflare-provider.ts`),
 * unlike the per-worktree agent wrapper's `/tmp/kilocode-wrapper-*.log`. It
 * carries the control-plane `control heartbeat` send lines.
 */
export async function readControlWrapperLog(containerId: string): Promise<string | null> {
  return readContainerFile(containerId, 'cat /tmp/kilocode-control-wrapper.log 2>/dev/null');
}

/**
 * Read the newest kilo CLI log file inside a running sandbox container.
 *
 * The wrapper writes CLI logs under `/home/${agentSessionId}/.local/share/kilo/log/*.log`
 * (see `services/cloud-agent-next/wrapper/src/server.ts:249`). This helper
 * avoids waiting on the 30s log-uploader cycle.
 */
export async function readKiloCliLog(containerId: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      'docker',
      [
        'exec',
        containerId,
        'sh',
        '-c',
        'ls -t /home/agent_*/.local/share/kilo/log/*.log 2>/dev/null | head -n 1 | xargs -r cat',
      ],
      { timeout: DOCKER_COMMAND_TIMEOUT_MS, killSignal: 'SIGKILL' }
    );
    return stdout || null;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('No such container') || msg.includes('is not running')) return null;
    throw err;
  }
}

/**
 * Tail the last `maxLines` lines of a (potentially large) log blob. Keeps
 * failure output readable in the harness.
 */
export function tailLines(log: string | null, maxLines = 200): string {
  if (!log) return '<empty>';
  const lines = log.split('\n');
  return lines.slice(Math.max(0, lines.length - maxLines)).join('\n');
}
