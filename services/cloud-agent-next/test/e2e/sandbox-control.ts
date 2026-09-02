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

export type DockerCommandExecutor = (args: string[]) => Promise<{ stdout: string }>;

const executeDockerCommand: DockerCommandExecutor = async args => {
  const { stdout } = await execFileAsync('docker', args);
  return { stdout };
};

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
  processId: number;
  logPath?: string;
};

export type ControlPlaneKiloRoot = {
  id: string;
  directory: string;
  processId: number;
};

export type ControlPlaneKiloCompletion = {
  sessionId: string;
  messageId: string;
  assistantMessageId: string;
};

export type ControlPlaneWorkspaceFile = {
  exists: boolean;
  contents?: string;
  dirty: boolean;
  head: string;
};

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
    | 'questions'
    | 'exclusive';
  kiloSessionId: string;
  serverUrl?: string;
  directory?: string;
  processId?: number;
  ownerKiloSessionId?: string;
  sourceKiloSessionId?: string;
  messageId?: string;
  gateTag?: string;
  model?: string;
  expectedText?: string;
  filePath?: string;
  questionId?: string;
};

const CONTROL_PLANE_KILO_SCRIPT = String.raw`
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const request = JSON.parse(process.argv[1] ?? '{}');

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
      if (path.basename(fs.readlinkSync('/proc/' + processId + '/exe')) !== 'kilo') continue;
      const argv = fs.readFileSync('/proc/' + processId + '/cmdline', 'utf8').split('\0');
      if (path.basename(argv[0]) !== 'kilo' || argv[1] !== 'serve') continue;
      const cwd = fs.readlinkSync('/proc/' + processId + '/cwd');
      const directory = fs.realpathSync(cwd);
      if (!path.isAbsolute(cwd) || cwd !== directory) continue;
      if (!fs.existsSync(path.join(directory, '.kilo-bootstrap-complete'))) continue;
      listeners.push({ serverUrl, processId, directory });
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
  return { ok: true, id: root.id, directory: root.directory, processId: request.processId };
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
  if (listeners.length !== 1 || !(await getRoot(request.serverUrl, request.ownerKiloSessionId))) {
    return { ok: false, reason: 'Owned Kilo listener identity did not match' };
  }

  if (request.action === 'exclusive') {
    const parent = path.dirname(request.directory);
    const directories = fs.readdirSync(parent).filter(name => fs.statSync(path.join(parent, name)).isDirectory());
    const exclusive = path.basename(parent) === 'worktrees' &&
      directories.length === 1 && path.join(parent, directories[0]) === request.directory &&
      kiloListeners().every(listener => listener.directory === request.directory);
    return { ok: true, exclusive };
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
    const now = Date.now();
    const endpoint = new URL('/kilocode/session-import/session', request.serverUrl);
    endpoint.searchParams.set('directory', source.directory);
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: AbortSignal.timeout(8_000),
      body: JSON.stringify({
        id: request.kiloSessionId,
        projectID: 'global',
        slug: request.kiloSessionId.slice(0, 24),
        directory: source.directory,
        title: 'Cloud Agent Gate 0',
        version: '7.4.20',
        timeCreated: now,
        timeUpdated: now,
      }),
    });
    if (!response.ok) {
      return { ok: false, reason: 'Kilo session import returned HTTP ' + response.status };
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
    if (!assistant) return { ok: true, found: false };
    return {
      ok: true,
      found: true,
      sessionId: root.id,
      messageId: request.messageId,
      assistantMessageId: assistant.info.id,
      completed: typeof assistant.info.time?.completed === 'number',
      failed: assistant.info.error !== undefined,
      expectedText: assistantText(assistant).includes(expectedText),
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
`;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

async function runControlPlaneKiloOperation(
  containerId: string,
  operation: ControlPlaneKiloOperation,
  executeDocker: DockerCommandExecutor = executeDockerCommand
): Promise<Record<string, unknown>> {
  const { stdout } = await executeDocker([
    'exec',
    containerId,
    'bun',
    '-e',
    CONTROL_PLANE_KILO_SCRIPT,
    JSON.stringify(operation),
  ]);
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
    typeof result.processId !== 'number' ||
    !Number.isSafeInteger(result.processId) ||
    result.processId <= 0
  ) {
    throw new Error(`Kilo root ${kiloSessionId} returned invalid runtime identity`);
  }
  return {
    id: result.id,
    directory: result.directory,
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
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('No such container') || message.includes('is not running')) continue;
      throw error;
    }
    if (result.matched !== true) continue;
    if (
      result.kiloSessionId !== kiloSessionId ||
      typeof result.serverUrl !== 'string' ||
      !/^http:\/\/(?:127\.0\.0\.1|\[::1\]):\d+$/.test(result.serverUrl) ||
      typeof result.directory !== 'string' ||
      !result.directory.startsWith('/') ||
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

export async function stopOwnedControlPlaneSandbox(
  sandbox: SandboxContainer,
  kiloSessionId: string,
  executeDocker: DockerCommandExecutor = executeDockerCommand
): Promise<void> {
  const runtime = await findControlPlaneKiloRuntime(kiloSessionId, executeDocker);
  if (!runtime || runtime.container.id !== sandbox.id || runtime.container.name !== sandbox.name) {
    throw new Error('Cannot prove the original sandbox still owns the requested root');
  }
  const result = await runControlPlaneKiloOperation(
    sandbox.id,
    {
      action: 'exclusive',
      kiloSessionId,
      ownerKiloSessionId: kiloSessionId,
      serverUrl: runtime.serverUrl,
      directory: runtime.directory,
      processId: runtime.processId,
    },
    executeDocker
  );
  if (result.exclusive !== true)
    throw new Error('Refusing cleanup of a sandbox with other worktrees');
  await killSandboxFamily(sandbox, executeDocker);
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
  input: { kiloSessionId: string; filePath: string }
): Promise<ControlPlaneWorkspaceFile> {
  const result = await runControlPlaneKiloOperation(runtime.container.id, {
    action: 'file',
    kiloSessionId: input.kiloSessionId,
    serverUrl: runtime.serverUrl,
    directory: runtime.directory,
    processId: runtime.processId,
    ownerKiloSessionId: runtime.kiloSessionId,
    filePath: input.filePath,
  });
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
    const result = await runControlPlaneKiloOperation(runtime.container.id, {
      action: 'completion',
      kiloSessionId: input.kiloSessionId,
      serverUrl: runtime.serverUrl,
      directory: runtime.directory,
      processId: runtime.processId,
      ownerKiloSessionId: runtime.kiloSessionId,
      messageId: input.messageId,
      ...(input.expectedText ? { expectedText: input.expectedText } : {}),
    });
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

/**
 * Kill a container by ID. Swallows "no such container" errors so callers can
 * be defensive without try/catch.
 */
export async function killContainer(
  idOrName: string,
  executeDocker: DockerCommandExecutor = executeDockerCommand
): Promise<void> {
  try {
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
  timeoutMs: number
): Promise<boolean> {
  const familyNames = sandboxFamilyNames(sandbox);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const containers = await listSandboxContainers();
    if (!containers.some(container => familyNames.has(container.name))) return true;
    await new Promise(r => setTimeout(r, 500));
  }
  return false;
}

/**
 * Read the wrapper log file inside a running sandbox container. Used for
 * smoke tests to assert "using fake kilo client" is present after boot.
 *
 * Returns null if the wrapper log isn't findable — the wrapper writes to
 * `/tmp/kilocode-wrapper-*.log`, so we glob for the newest file.
 */
export async function readWrapperLog(containerId: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('docker', [
      'exec',
      containerId,
      'sh',
      '-c',
      'ls -t /tmp/kilocode-wrapper-*.log 2>/dev/null | head -n 1 | xargs -r cat',
    ]);
    return stdout || null;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('No such container') || msg.includes('is not running')) return null;
    throw err;
  }
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
    const { stdout } = await execFileAsync('docker', [
      'exec',
      containerId,
      'sh',
      '-c',
      'ls -t /home/agent_*/.local/share/kilo/log/*.log 2>/dev/null | head -n 1 | xargs -r cat',
    ]);
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
