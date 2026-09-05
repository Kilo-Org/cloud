import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createKiloClient } from '@kilocode/sdk';
import { createKiloClient as createKiloEventClient } from '@kilocode/sdk/v2/client';
import { CONTROL_PLANE_SANDBOX_PERMISSION } from '../../../src/shared/control-plane-permission.js';
import type { ControlDiagnosticReporter } from '../../../src/shared/control-diagnostics.js';
import { safeSandboxRuntimeVersion } from '../../../src/shared/sandbox-status.js';
import {
  SANDBOX_CONTROL_CLEANUP_TIMEOUT_MS,
  type ControlErrorCode,
  type SessionAttachPayload,
  type SessionRequestIdentity,
} from '../../../src/shared/sandbox-control-protocol.js';
import { CONTROL_RUNTIME_RESERVED_ENV_VARS } from '../../../src/shared/runtime-environment.js';
import {
  createWrapperKiloClient,
  type KiloServerHandle,
  type WrapperKiloClient,
} from '../kilo-api.js';
import { withTimeoutAndAbort } from '../utils.js';
import { isKiloServerProcess } from '../tool-cgroup.js';
import { createOwnedProcessScope, type OwnedProcessScope } from './owned-processes.js';
import type { NativeOperationTarget, NativeRetirement } from './session-operation-cleanup.js';
import { retireWorktreeRuntime } from './worktree-runtime-cleanup.js';
import { forgetAttachedRoot, rememberAttachedRoot } from './session-directories.js';
import { withKiloRequestDeadline, type KiloEventFeedError } from './sandbox-control-runtime.js';
import { createWorktreeFeed, type WorktreeFeed } from './worktree-feed.js';

export type WorktreeKiloAuth = NonNullable<SessionAttachPayload['kilo']>;

type WorktreeKiloFailure = {
  directory: string;
  reason: KiloEventFeedError['reason'] | 'process_exited' | 'credential_refresh_failed';
  runtimeId: string;
  cleanup: 'confirmed' | 'unconfirmed';
};

export type WorktreeKiloRuntime = {
  readonly scopeId: string;
  readonly runtimeId: string;
  readonly directory: string;
  readonly env: Record<string, string>;
  readonly kiloClient: WrapperKiloClient;
  readonly signal: AbortSignal;
};

export type WorktreeKiloAttachment = {
  ready: Promise<WorktreeKiloRuntime>;
  signal: AbortSignal;
  cleanup?(deadlineAt: number): Promise<NativeRetirement>;
  commit(): void;
  release(): void;
};

export type WorktreeKiloRuntimes = {
  readonly kiloCliVersion?: string | null;
  attach(
    identity: SessionRequestIdentity,
    kilo: WorktreeKiloAuth,
    env?: Record<string, string>,
    canRefreshCredentials?: () => boolean,
    beforeMutation?: () => void,
    onCleanupTarget?: (cleanup: (deadlineAt: number) => Promise<NativeRetirement>) => void
  ): WorktreeKiloAttachment;
  detach(identity: SessionRequestIdentity): boolean;
  deleteDirectory(directory: string): Promise<void>;
  retireRuntime?(
    directory: string,
    deadlineAt: number,
    target?: NativeOperationTarget
  ): Promise<NativeRetirement>;
  verifyQuiescence?(
    directory: string,
    target: NativeOperationTarget,
    deadlineAt: number
  ): Promise<boolean>;
  getRetained?(directory: string): WorktreeKiloRuntime | undefined;
  get(directory: string): WorktreeKiloRuntime | undefined;
  prepareForNewWork?(directory: string): boolean;
  isHealthy(): boolean;
  shutdown(): void;
};

type WorktreeKiloEvent = {
  type: string;
  properties: Record<string, unknown>;
  directory?: string;
};

type ServerOptions = {
  directory: string;
  env: Record<string, string>;
  signal: AbortSignal;
  timeoutMs?: number;
  onProcessScope?: (scope: OwnedProcessScope) => void;
  claimCleanupDeadline?: (deadlineAt?: number) => number;
};

type WorktreeKiloServerHandle = Omit<KiloServerHandle, 'close'> & {
  close(deadlineAt?: number): void;
  stopped?: Promise<void>;
  exited?: Promise<void>;
  processes?: OwnedProcessScope;
};

type RuntimeEntry = {
  kilo: WorktreeKiloAuth;
  directory: string;
  env: Record<string, string>;
  abort: AbortController;
  roots: Set<RootAttachment>;
  runtime?: WorktreeKiloRuntime;
  kiloClient?: WrapperKiloClient;
  processAbort?: AbortController;
  processes?: OwnedProcessScope;
  processIssued?: boolean;
  runtimeId: string;
  pendingPtys: number;
  feed?: WorktreeFeed;
  starting?: Promise<WorktreeKiloRuntime>;
  stopped?: Promise<void>;
  retiring?: Promise<NativeRetirement>;
  retirementResult?: NativeRetirement;
  cleanupDeadlineAt?: number;
};

type RootAttachment = {
  identity: SessionRequestIdentity;
  entry: RuntimeEntry;
  abort: AbortController;
  attached: boolean;
  pending: Set<symbol>;
};

const KILO_STARTUP_TIMEOUT_MS = 30_000;
const BITBUCKET_METADATA_ENV_VARS = new Set([
  'KILO_BITBUCKET_WORKSPACE_SLUG',
  'KILO_BITBUCKET_REPOSITORY_SLUG',
  'KILO_BITBUCKET_WORKSPACE_UUID',
  'KILO_BITBUCKET_REPOSITORY_UUID',
]);
const INHERITED_GIT_CREDENTIALS = new Set([
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'GITLAB_TOKEN',
  'GITLAB_OAUTH_TOKEN',
  'BITBUCKET_TOKEN',
  'BITBUCKET_APP_PASSWORD',
]);

export class WorktreeKiloRuntimeError extends Error {
  constructor(
    readonly code: ControlErrorCode,
    message: string,
    readonly retryable: boolean
  ) {
    super(message);
    this.name = 'WorktreeKiloRuntimeError';
  }
}

export function buildWorktreeKiloEnvironment(
  directory: string,
  home: string,
  kilo: WorktreeKiloAuth,
  environment: Record<string, string> = {},
  inherited: NodeJS.ProcessEnv = process.env
): Record<string, string> {
  const env: Record<string, string> = {};
  const reserved = new Set<string>(CONTROL_RUNTIME_RESERVED_ENV_VARS);
  const isRuntimeOwned = (name: string): boolean =>
    reserved.has(name) ||
    name === 'HOME' ||
    name.startsWith('XDG_') ||
    name.startsWith('KILO') ||
    name.startsWith('OPENCODE');

  for (const [name, value] of Object.entries(inherited)) {
    if (value !== undefined && !isRuntimeOwned(name) && !INHERITED_GIT_CREDENTIALS.has(name)) {
      env[name] = value;
    }
  }
  for (const [name, value] of Object.entries(environment)) {
    if (!isRuntimeOwned(name) || BITBUCKET_METADATA_ENV_VARS.has(name)) env[name] = value;
  }

  const config = JSON.stringify({
    autoupdate: false,
    permission: CONTROL_PLANE_SANDBOX_PERMISSION,
    provider: {
      kilo: {
        options: {
          apiKey: kilo.token,
          kilocodeToken: kilo.token,
          ...(kilo.organizationId ? { kilocodeOrganizationId: kilo.organizationId } : {}),
          baseURL: kilo.targets.providerBaseUrl,
        },
      },
    },
  });

  return {
    ...env,
    PWD: directory,
    HOME: home,
    XDG_DATA_HOME: path.join(home, '.local', 'share'),
    XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_CACHE_HOME: path.join(home, '.cache'),
    XDG_STATE_HOME: path.join(home, '.local', 'state'),
    XDG_RUNTIME_DIR: path.join(home, '.run'),
    KILO_PLATFORM: 'cloud-agent',
    KILO_DISABLE_AUTOUPDATE: 'true',
    KILO_DEBUG_SESSION_INGEST: '1',
    KILOCODE_TOKEN: kilo.token,
    ...(kilo.organizationId ? { KILOCODE_ORGANIZATION_ID: kilo.organizationId } : {}),
    KILO_AUTH_CONTENT: JSON.stringify({ kilo: { type: 'api', key: kilo.token } }),
    KILOCODE_BACKEND_BASE_URL: kilo.targets.backendBaseUrl,
    KILO_API_URL: kilo.targets.backendBaseUrl,
    KILO_OPENROUTER_BASE: kilo.targets.providerBaseUrl,
    KILO_SESSION_INGEST_URL: kilo.targets.sessionIngestBaseUrl,
    KILO_CONFIG_CONTENT: config,
    OPENCODE_CONFIG_CONTENT: config,
  };
}

export async function startWorktreeKiloServer(
  options: ServerOptions
): Promise<WorktreeKiloServerHandle & { stopped: Promise<void> }> {
  options.signal.throwIfAborted();
  const processes = createOwnedProcessScope();
  options.onProcessScope?.(processes);
  const proc = processes.spawn('kilo', ['serve', '--hostname=127.0.0.1', '--port=0'], {
    cwd: options.directory,
    env: options.env,
  });
  proc.stderr.resume();
  const stopped = new Promise<void>(resolve => {
    proc.once('close', () => resolve());
  });
  const exited = new Promise<void>(resolve => {
    proc.once('exit', () => resolve());
    proc.once('error', () => {
      if (proc.pid === undefined) resolve();
    });
  });
  let cleanupDeadlineAt: number | undefined;
  const claimCleanupDeadline = (requested?: number): number => {
    const owned = options.claimCleanupDeadline?.(requested) ?? requested;
    cleanupDeadlineAt ??= owned ?? Date.now() + SANDBOX_CONTROL_CLEANUP_TIMEOUT_MS;
    cleanupDeadlineAt = Math.min(cleanupDeadlineAt, owned ?? cleanupDeadlineAt);
    return cleanupDeadlineAt;
  };
  let closed = false;
  const closeAt = (deadlineAt?: number): void => {
    if (closed) return;
    closed = true;
    options.signal.removeEventListener('abort', close);
    if (deadlineAt === undefined) {
      if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGTERM');
      return;
    }
    void processes.stop(claimCleanupDeadline(deadlineAt));
  };
  const close = (): void => closeAt();
  options.signal.addEventListener('abort', close, { once: true });

  try {
    const url = await new Promise<string>((resolve, reject) => {
      let output = '';
      const timeout = setTimeout(
        () => fail('Kilo server startup timed out'),
        options.timeoutMs ?? KILO_STARTUP_TIMEOUT_MS
      );
      const cleanup = (): void => {
        clearTimeout(timeout);
        options.signal.removeEventListener('abort', onAbort);
        proc.stdout.removeListener('data', onOutput);
        proc.removeListener('exit', onExit);
      };
      const fail = (message: string): void => {
        cleanup();
        reject(new Error(message));
      };
      const onAbort = (): void => fail('Kilo server startup aborted');
      const onExit = (): void => fail('Kilo server exited before startup');
      const onOutput = (chunk: Buffer): void => {
        output = (output + chunk.toString()).slice(-65_536);
        const match = /^kilo server listening on (http:\/\/127\.0\.0\.1:\d+)\r?\n/m.exec(output);
        if (!match?.[1]) return;
        cleanup();
        resolve(match[1]);
      };
      proc.stdout.on('data', onOutput);
      proc.once('exit', onExit);
      proc.on('error', () => fail('Kilo server failed to start'));
      options.signal.addEventListener('abort', onAbort, { once: true });
      if (options.signal.aborted) onAbort();
    });
    proc.stdout.resume();
    proc.once('exit', close);
    await processes.captureBaseline(isKiloServerProcess);
    options.signal.throwIfAborted();
    return { url, close: closeAt, stopped, exited, processes };
  } catch {
    const deadlineAt = claimCleanupDeadline();
    const cleanup = processes.stop(deadlineAt);
    closeAt(deadlineAt);
    await withTimeoutAndAbort(cleanup, {
      timeoutMs: Math.max(1, deadlineAt - Date.now()),
      timeoutMessage: 'Kilo startup cleanup expired',
      abortMessage: 'Kilo startup cleanup cancelled',
    }).catch(() => false);
    throw new Error('Kilo server failed to start');
  }
}

function sameAuth(left: WorktreeKiloAuth, right: WorktreeKiloAuth): boolean {
  return (
    left.scopeId === right.scopeId &&
    (left.containmentEnabled !== false) === (right.containmentEnabled !== false) &&
    (left.containmentEnabled === false || left.token === right.token) &&
    left.organizationId === right.organizationId &&
    left.targets.backendBaseUrl === right.targets.backendBaseUrl &&
    left.targets.providerBaseUrl === right.targets.providerBaseUrl &&
    left.targets.sessionIngestBaseUrl === right.targets.sessionIngestBaseUrl
  );
}

export function createWorktreeKiloRuntimes(options: {
  homeRoot?: string;
  inheritedEnv?: NodeJS.ProcessEnv;
  startServer?: (options: ServerOptions) => Promise<WorktreeKiloServerHandle>;
  onEvent?: (runtime: WorktreeKiloRuntime, event: WorktreeKiloEvent) => void;
  onDiagnostic?: ControlDiagnosticReporter;
  onUnexpectedClose: (failure: WorktreeKiloFailure) => void;
}): WorktreeKiloRuntimes {
  const entries = new Map<string, RuntimeEntry>();
  const directoriesByScope = new Map<string, string>();
  const failedDirectories = new Set<string>();
  const roots = new Map<string, RootAttachment>();
  const homesByDirectory = new Map<string, Set<string>>();
  const deletedDirectories = new Set<string>();
  let observedVersion: string | null | undefined;
  let closed = false;

  function recordVersion(value: unknown): void {
    const version = safeSandboxRuntimeVersion(value);
    observedVersion = observedVersion === undefined || observedVersion === version ? version : null;
  }

  function findRoot(identity: SessionRequestIdentity): RootAttachment | undefined {
    for (const root of roots.values()) {
      if (
        root.identity.kiloSessionId !== identity.kiloSessionId &&
        root.identity.sessionId !== identity.sessionId
      ) {
        continue;
      }
      if (
        root.identity.sessionId !== identity.sessionId ||
        root.identity.kiloSessionId !== identity.kiloSessionId ||
        root.identity.directory !== identity.directory
      ) {
        throw new WorktreeKiloRuntimeError('unauthorized', 'Session identity mismatch', false);
      }
      return root;
    }
    return undefined;
  }

  function cleanupDeadline(entry: RuntimeEntry, requested?: number): number {
    entry.cleanupDeadlineAt ??= requested ?? Date.now() + SANDBOX_CONTROL_CLEANUP_TIMEOUT_MS;
    entry.cleanupDeadlineAt = Math.min(
      entry.cleanupDeadlineAt,
      requested ?? entry.cleanupDeadlineAt
    );
    return entry.cleanupDeadlineAt;
  }

  function unregisterRoot(root: RootAttachment): void {
    root.entry.roots.delete(root);
    root.attached = false;
    root.pending.clear();
    if (roots.get(root.identity.kiloSessionId) === root) {
      roots.delete(root.identity.kiloSessionId);
      forgetAttachedRoot(root.identity.kiloSessionId, root.identity.directory);
    }
  }

  function retire(
    entry: RuntimeEntry,
    requested?: number,
    target?: NativeOperationTarget
  ): Promise<NativeRetirement> {
    return retireWorktreeRuntime(entry, requested, target, {
      cleanupDeadline,
      unregisterRoot,
      removeEntry: retiring => {
        if (entries.get(retiring.directory) === retiring) {
          entries.delete(retiring.directory);
          if (directoriesByScope.get(retiring.kilo.scopeId) === retiring.directory)
            directoriesByScope.delete(retiring.kilo.scopeId);
        }
      },
    });
  }

  function removeRoot(root: RootAttachment): void {
    if (roots.get(root.identity.kiloSessionId) !== root) return;
    unregisterRoot(root);
    root.abort.abort();
    if (root.entry.roots.size === 0) void retire(root.entry);
  }

  function failRuntime(entry: RuntimeEntry, reason: WorktreeKiloFailure['reason']): void {
    if (entry.abort.signal.aborted) return;
    const deadlineAt = cleanupDeadline(entry);
    const runtimeId = entry.runtimeId;
    void retire(entry, deadlineAt).then(result => {
      if (result === 'unconfirmed') failedDirectories.add(entry.directory);
      options.onUnexpectedClose({
        directory: entry.directory,
        reason,
        runtimeId,
        cleanup: result === 'unconfirmed' ? 'unconfirmed' : 'confirmed',
      });
    });
  }

  async function start(
    entry: RuntimeEntry,
    retiring: Promise<NativeRetirement> | undefined,
    beforeMutation?: () => void
  ): Promise<WorktreeKiloRuntime> {
    const abort = new AbortController();
    entry.feed?.close();
    entry.feed = undefined;
    entry.processes = undefined;
    entry.processIssued = false;
    entry.stopped = undefined;
    entry.processAbort = abort;
    const stopProcess = () => {
      void entry.processes?.stop(cleanupDeadline(entry));
      abort.abort();
    };
    entry.abort.signal.addEventListener('abort', stopProcess, { once: true });
    abort.signal.addEventListener(
      'abort',
      () => entry.abort.signal.removeEventListener('abort', stopProcess),
      { once: true }
    );
    if (entry.abort.signal.aborted) abort.abort();
    let server: WorktreeKiloServerHandle | undefined;
    let serverClosed = false;
    const closeServer = (): void => {
      if (!server || serverClosed) return;
      serverClosed = true;
      const deadlineAt = cleanupDeadline(entry);
      void server.processes?.stop(deadlineAt);
      server.close(deadlineAt);
    };
    abort.signal.addEventListener('abort', closeServer, { once: true });
    try {
      if (retiring && (await retiring) !== 'retired')
        throw new Error('Predecessor native runtime is not contained');
      abort.signal.throwIfAborted();
      beforeMutation?.();
      const authDirectory = path.join(entry.env.XDG_DATA_HOME, 'kilo');
      await fs.mkdir(authDirectory, { recursive: true, mode: 0o700 });
      await fs.mkdir(entry.env.XDG_RUNTIME_DIR, { recursive: true, mode: 0o700 });
      await fs.mkdir(entry.directory, { recursive: true });
      await fs.writeFile(path.join(authDirectory, 'auth.json'), entry.env.KILO_AUTH_CONTENT, {
        mode: 0o600,
      });
      abort.signal.throwIfAborted();
      server = await (options.startServer ?? startWorktreeKiloServer)({
        directory: entry.directory,
        env: entry.env,
        signal: abort.signal,
        onProcessScope: processes => {
          entry.processes = processes;
          entry.processIssued = true;
          if (entry.cleanupDeadlineAt !== undefined) void processes.stop(entry.cleanupDeadlineAt);
        },
        claimCleanupDeadline: deadlineAt =>
          entry.processAbort === abort ? cleanupDeadline(entry, deadlineAt) : (deadlineAt ?? 0),
      });
      entry.processes = server.processes ?? entry.processes;
      entry.processIssued = true;
      entry.stopped = server.stopped;
      void (server.exited ?? server.stopped)?.then(() => {
        if (!abort.signal.aborted) failRuntime(entry, 'process_exited');
      });
      abort.signal.throwIfAborted();
      const client = createKiloClient({ baseUrl: server.url, directory: entry.directory });
      const kiloClient = createWrapperKiloClient(client, server.url, entry.directory);
      const runtimeKiloClient: WrapperKiloClient = {
        ...kiloClient,
        async createPty(options) {
          if (entry.starting) {
            throw new WorktreeKiloRuntimeError(
              'session_busy',
              'Worktree credentials are refreshing',
              true
            );
          }
          entry.pendingPtys += 1;
          try {
            return await kiloClient.createPty(options);
          } finally {
            entry.pendingPtys -= 1;
          }
        },
      };
      entry.kiloClient = runtimeKiloClient;
      const runtime: WorktreeKiloRuntime = entry.runtime ?? {
        scopeId: entry.kilo.scopeId,
        get runtimeId() {
          return entry.runtimeId;
        },
        directory: entry.directory,
        get env() {
          return entry.env;
        },
        get kiloClient() {
          if (!entry.kiloClient)
            throw new WorktreeKiloRuntimeError('not_ready', 'Kilo worktree is not ready', true);
          return entry.kiloClient;
        },
        signal: entry.abort.signal,
      };
      const feed = createWorktreeFeed({
        source: {
          scopeId: entry.kilo.scopeId,
          runtimeId: entry.runtimeId,
          directory: entry.directory,
          kiloClient: runtimeKiloClient,
          signal: abort.signal,
        },
        isCurrent: (runtimeId, client) =>
          entries.get(entry.directory) === entry &&
          entry.runtimeId === runtimeId &&
          entry.kiloClient === client &&
          entry.processAbort === abort,
        onEvent: event => options.onEvent?.(runtime, event),
        onFailure: reason => failRuntime(entry, reason),
        onDiagnostic: options.onDiagnostic,
      });
      entry.feed = feed;
      await withTimeoutAndAbort(feed.open(), {
        timeoutMs: KILO_STARTUP_TIMEOUT_MS,
        timeoutMessage: 'Kilo event feed startup timed out',
        signal: abort.signal,
        abortMessage: 'Kilo worktree closed',
      });
      abort.signal.throwIfAborted();
      entry.runtime = runtime;
      const eventClient = createKiloEventClient({
        baseUrl: server.url,
        directory: entry.directory,
      });
      void withKiloRequestDeadline(
        signal => eventClient.global.health({ signal }),
        abort.signal
      ).then(
        health => {
          if (closed || abort.signal.aborted || entry.processAbort !== abort) return;
          recordVersion(health.data?.healthy === true ? health.data.version : null);
        },
        () => {
          if (!closed && !abort.signal.aborted && entry.processAbort === abort) {
            recordVersion(null);
          }
        }
      );
      return runtime;
    } catch {
      if (!server) entry.processIssued = false;
      if (entry.runtime) failRuntime(entry, 'credential_refresh_failed');
      else void retire(entry);
      closeServer();
      throw new WorktreeKiloRuntimeError('not_ready', 'Kilo worktree failed to start', true);
    } finally {
      entry.starting = undefined;
    }
  }

  async function refreshCredentials(
    entry: RuntimeEntry,
    kilo: WorktreeKiloAuth,
    env: Record<string, string>,
    canRefreshCredentials: () => boolean,
    beforeMutation?: () => void,
    onDestructiveRefresh?: () => void
  ): Promise<WorktreeKiloRuntime> {
    const retry = () =>
      new WorktreeKiloRuntimeError(
        'session_busy',
        'Worktree credentials require an idle runtime',
        true
      );
    const client = entry.kiloClient;
    if (!client || !entry.processAbort || !entry.stopped) {
      throw new WorktreeKiloRuntimeError('not_ready', 'Worktree cannot refresh credentials', true);
    }
    if (entry.pendingPtys > 0 || !canRefreshCredentials()) throw retry();
    try {
      const idle = await withKiloRequestDeadline(async signal => {
        const statuses = await client.getSessionStatuses(entry.directory, signal);
        if (Object.values(statuses).some(status => status.type !== 'idle')) return false;
        const url = new URL('/pty', client.serverUrl);
        url.searchParams.set('directory', entry.directory);
        const response = await fetch(url, { signal });
        if (!response.ok) throw new Error('Worktree PTY probe failed');
        const ptys: unknown = await response.json();
        if (!Array.isArray(ptys)) throw new Error('Worktree PTY probe failed');
        return ptys.length === 0;
      }, entry.abort.signal);
      if (!idle || entry.pendingPtys > 0 || !canRefreshCredentials()) throw retry();
    } catch (error) {
      if (error instanceof WorktreeKiloRuntimeError) throw error;
      throw new WorktreeKiloRuntimeError('not_ready', 'Worktree idle probe failed', true);
    }
    const deadlineAt = cleanupDeadline(entry);
    onDestructiveRefresh?.();
    const stopped =
      entry.processes?.stop(deadlineAt) ?? Promise.resolve(entry.processIssued !== true);
    entry.processAbort.abort();
    try {
      await withTimeoutAndAbort(entry.stopped, {
        signal: entry.abort.signal,
        timeoutMs: Math.max(1, deadlineAt - Date.now()),
        timeoutMessage: 'Kilo worktree credential refresh timed out',
        abortMessage: 'Kilo worktree credential refresh cancelled',
      });
      if (!(await stopped) || Date.now() >= deadlineAt) {
        throw new Error('Original native execution is not contained');
      }
      entry.kilo = { ...kilo, targets: { ...kilo.targets } };
      entry.env = env;
      entry.cleanupDeadlineAt = undefined;
      entry.kiloClient = undefined;
      entry.runtimeId = crypto.randomUUID();
      return await start(entry, undefined, beforeMutation);
    } catch {
      failRuntime(entry, 'credential_refresh_failed');
      throw new WorktreeKiloRuntimeError(
        'runtime_unhealthy',
        'Kilo worktree credential refresh failed',
        true
      );
    }
  }

  return {
    get kiloCliVersion() {
      return observedVersion ?? null;
    },
    attach(identity, kilo, environment, canRefreshCredentials, beforeMutation, onCleanupTarget) {
      if (closed) {
        throw new WorktreeKiloRuntimeError('not_ready', 'Kilo worktrees are closed', false);
      }
      const { directory } = identity;
      if (!path.isAbsolute(directory) || path.resolve(directory) !== directory) {
        throw new WorktreeKiloRuntimeError('protocol_error', 'Invalid worktree directory', false);
      }
      if (deletedDirectories.has(directory)) {
        throw new WorktreeKiloRuntimeError('not_ready', 'Kilo worktree is deleted', false);
      }
      let root = findRoot(identity);
      const scopeDirectory = directoriesByScope.get(kilo.scopeId);
      const previous = entries.get(directory);
      let entry = previous?.retiring ? undefined : previous;
      let cleanupRequired = false;
      if (
        (scopeDirectory && scopeDirectory !== directory) ||
        (entry && !sameAuth(entry.kilo, kilo))
      ) {
        throw new WorktreeKiloRuntimeError(
          'unauthorized',
          'Kilo worktree auth context mismatch',
          false
        );
      }
      if (entry?.abort.signal.aborted) {
        throw new WorktreeKiloRuntimeError('runtime_unhealthy', 'Kilo worktree is closed', true);
      }
      if (entry?.runtime && entry.starting) {
        throw new WorktreeKiloRuntimeError(
          'session_busy',
          'Worktree credentials are refreshing',
          true
        );
      }
      if (entry && kilo.containmentEnabled === false) {
        const env = buildWorktreeKiloEnvironment(
          directory,
          entry.env.HOME,
          kilo,
          environment,
          options.inheritedEnv
        );
        const currentEnv = entry.env;
        const changed = Object.keys({ ...currentEnv, ...env }).some(
          key => currentEnv[key] !== env[key]
        );
        if (changed) {
          if (
            !entry.runtime ||
            entry.starting ||
            !canRefreshCredentials ||
            !canRefreshCredentials() ||
            [...entry.roots].some(current => current.pending.size > 0)
          ) {
            throw new WorktreeKiloRuntimeError(
              'session_busy',
              'Worktree credentials require an idle runtime',
              true
            );
          }
          const refreshing = entry;
          entry.starting = Promise.resolve()
            .then(() =>
              refreshCredentials(
                refreshing,
                kilo,
                env,
                canRefreshCredentials,
                beforeMutation,
                () => {
                  cleanupRequired = true;
                }
              )
            )
            .finally(() => {
              refreshing.starting = undefined;
            });
        }
      }
      if (!entry) {
        const homeId = createHash('sha256')
          .update(kilo.scopeId)
          .update('\0')
          .update(directory)
          .digest('hex');
        const home = path.join(
          options.homeRoot ?? path.join(os.tmpdir(), 'kilo-worktrees'),
          homeId
        );
        entry = {
          kilo: { ...kilo, targets: { ...kilo.targets } },
          directory,
          env: buildWorktreeKiloEnvironment(
            directory,
            home,
            kilo,
            environment,
            options.inheritedEnv
          ),
          abort: new AbortController(),
          roots: new Set(),
          runtimeId: crypto.randomUUID(),
          pendingPtys: 0,
        };
        const homes = homesByDirectory.get(directory) ?? new Set<string>();
        homes.add(home);
        homesByDirectory.set(directory, homes);
        entries.set(directory, entry);
        cleanupRequired = true;
        failedDirectories.delete(directory);
        directoriesByScope.set(kilo.scopeId, directory);
      }
      if (!root) {
        root = {
          identity: { ...identity },
          entry,
          abort: new AbortController(),
          attached: false,
          pending: new Set(),
        };
        roots.set(identity.kiloSessionId, root);
        entry.roots.add(root);
        rememberAttachedRoot(identity.kiloSessionId, directory);
      }
      const attachedRoot = root;
      const cleanupTarget = Object.freeze({ runtimeId: entry.runtimeId });
      onCleanupTarget?.(deadlineAt =>
        cleanupRequired ? retire(entry, deadlineAt, cleanupTarget) : Promise.resolve('stale')
      );
      const attempt = Symbol();
      attachedRoot.pending.add(attempt);
      const signal = AbortSignal.any([attachedRoot.abort.signal, entry.abort.signal]);
      const ready =
        entry.starting ??
        (entry.runtime
          ? Promise.resolve(entry.runtime)
          : (entry.starting = start(entry, previous?.retiring, beforeMutation)));
      return {
        ready,
        signal,
        cleanup(deadlineAt) {
          return cleanupRequired
            ? retire(entry, deadlineAt, cleanupTarget)
            : Promise.resolve('stale');
        },
        commit() {
          signal.throwIfAborted();
          if (!attachedRoot.pending.delete(attempt)) return;
          attachedRoot.attached = true;
        },
        release() {
          if (!attachedRoot.pending.delete(attempt)) return;
          if (!attachedRoot.attached && attachedRoot.pending.size === 0) removeRoot(attachedRoot);
        },
      };
    },
    detach(identity) {
      const root = findRoot(identity);
      if (!root) return false;
      removeRoot(root);
      return true;
    },
    async deleteDirectory(directory) {
      deletedDirectories.add(directory);
      const entry = entries.get(directory);
      for (const root of roots.values()) {
        if (root.identity.directory === directory) removeRoot(root);
      }
      if (entry) {
        const quiescent = await withTimeoutAndAbort(retire(entry), {
          timeoutMs: KILO_STARTUP_TIMEOUT_MS,
          timeoutMessage: 'Kilo worktree retirement timed out',
          abortMessage: 'Kilo worktree retirement cancelled',
        });
        if (quiescent !== 'retired') throw new Error('Native worktree cleanup is unconfirmed');
      }
      for (const home of homesByDirectory.get(directory) ?? []) {
        await fs.rm(home, { recursive: true, force: true });
      }
      homesByDirectory.delete(directory);
    },
    async retireRuntime(directory, deadlineAt, target) {
      const entry = entries.get(directory);
      if (!entry) return 'stale';
      return retire(entry, deadlineAt, target);
    },
    async verifyQuiescence(directory, target, deadlineAt) {
      const entry = entries.get(directory);
      if (
        !entry ||
        entry.runtimeId !== target.runtimeId ||
        entry.kiloClient !== target.client ||
        Date.now() >= deadlineAt
      )
        return false;
      const verified = await (entry.processes?.verify(true, deadlineAt) ?? Promise.resolve(false));
      return (
        verified &&
        Date.now() < deadlineAt &&
        entries.get(directory) === entry &&
        entry.runtimeId === target.runtimeId &&
        entry.kiloClient === target.client &&
        !entry.abort.signal.aborted
      );
    },
    getRetained(directory) {
      return entries.get(directory)?.runtime;
    },
    get(directory) {
      const entry = entries.get(directory);
      const runtime = entry?.starting ? undefined : entry?.runtime;
      return !closed && runtime && !runtime.signal.aborted ? runtime : undefined;
    },
    prepareForNewWork(directory) {
      const entry = entries.get(directory);
      return (
        !entry ||
        (!entry.abort.signal.aborted &&
          (entry.runtime === undefined || entry.feed?.prepareForNewWork() === true))
      );
    },
    isHealthy() {
      const healthy = [...entries.values()].some(
        entry =>
          entry.retiring === undefined &&
          !entry.abort.signal.aborted &&
          (entry.starting !== undefined || !entry.runtime || !entry.runtime.signal.aborted)
      );
      return !closed && failedDirectories.size === 0 && (entries.size === 0 || healthy);
    },
    shutdown() {
      if (closed) return;
      closed = true;
      for (const root of roots.values()) removeRoot(root);
      for (const entry of entries.values()) void retire(entry);
      directoriesByScope.clear();
    },
  };
}
