import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createKiloClient } from '@kilocode/sdk';
import { createKiloClient as createKiloEventClient } from '@kilocode/sdk/v2/client';
import { CONTROL_PLANE_SANDBOX_PERMISSION } from '../../../src/shared/control-plane-permission.js';
import {
  emitControlDiagnostic,
  type ControlDiagnosticReporter,
} from '../../../src/shared/control-diagnostics.js';
import { safeSandboxRuntimeVersion } from '../../../src/shared/sandbox-status.js';
import type {
  ControlErrorCode,
  SessionAttachPayload,
  SessionRequestIdentity,
} from '../../../src/shared/sandbox-control-protocol.js';
import { CONTROL_RUNTIME_RESERVED_ENV_VARS } from '../../../src/shared/runtime-environment.js';
import {
  createWrapperKiloClient,
  type KiloServerHandle,
  type WrapperKiloClient,
} from '../kilo-api.js';
import { withTimeoutAndAbort } from '../utils.js';
import { unfilteredKiloEvents } from './feed.js';
import { forgetAttachedRoot, rememberAttachedRoot } from './session-directories.js';
import {
  KiloEventFeedError,
  startSandboxControlEventFeed,
  withKiloRequestDeadline,
} from './sandbox-control-runtime.js';

export type WorktreeKiloAuth = NonNullable<SessionAttachPayload['kilo']>;

type WorktreeKiloFailure = {
  directory: string;
  reason: KiloEventFeedError['reason'] | 'process_exited' | 'credential_refresh_failed';
};

export type WorktreeKiloRuntime = {
  readonly identity: SessionRequestIdentity;
  readonly scopeId: string;
  readonly directory: string;
  readonly env: Record<string, string>;
  readonly kiloClient: WrapperKiloClient;
  readonly signal: AbortSignal;
};

export type WorktreeKiloAttachment = {
  ready: Promise<WorktreeKiloRuntime>;
  signal: AbortSignal;
  commit(): void;
  release(): void;
};

export type WorktreeKiloRuntimes = {
  readonly kiloCliVersion?: string | null;
  attach(
    identity: SessionRequestIdentity,
    kilo: WorktreeKiloAuth,
    env?: Record<string, string>,
    canRefreshCredentials?: () => boolean
  ): WorktreeKiloAttachment;
  detach(identity: SessionRequestIdentity): boolean;
  deleteDirectory(directory: string): Promise<void>;
  get(identity: SessionRequestIdentity): WorktreeKiloRuntime | undefined;
  getAll(directory: string): WorktreeKiloRuntime[];
  isCurrent(runtime: WorktreeKiloRuntime): boolean;
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
};

type WorktreeKiloServerHandle = KiloServerHandle & { stopped?: Promise<void> };

type RuntimeEntry = {
  identity: SessionRequestIdentity;
  kilo: WorktreeKiloAuth;
  directory: string;
  env: Record<string, string>;
  abort: AbortController;
  roots: Set<RootAttachment>;
  runtime?: WorktreeKiloRuntime;
  kiloClient?: WrapperKiloClient;
  processAbort?: AbortController;
  pendingPtys: number;
  feed?: Awaited<ReturnType<typeof startSandboxControlEventFeed>>;
  starting?: Promise<WorktreeKiloRuntime>;
  stopped?: Promise<void>;
  retiring?: Promise<void>;
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
  const proc = spawn('kilo', ['serve', '--hostname=127.0.0.1', '--port=0'], {
    cwd: options.directory,
    env: options.env,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const stopped = new Promise<void>(resolve => {
    proc.once('close', () => resolve());
  });
  let closed = false;
  const close = (): void => {
    if (closed) return;
    closed = true;
    options.signal.removeEventListener('abort', close);
    if (proc.exitCode === null && proc.signalCode === null) proc.kill();
  };
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
    return { url, close, stopped };
  } catch {
    close();
    await stopped;
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
  const roots = new Map<string, RootAttachment>();
  const homesByDirectory = new Map<string, Set<string>>();
  const deletedDirectories = new Set<string>();
  let observedVersion: string | null | undefined;
  let closed = false;

  function recordVersion(value: unknown): void {
    const version = safeSandboxRuntimeVersion(value);
    observedVersion = observedVersion === undefined || observedVersion === version ? version : null;
  }

  const identityKey = (identity: SessionRequestIdentity): string =>
    `${identity.sessionId}\0${identity.kiloSessionId}\0${identity.directory}`;

  function findRoot(identity: SessionRequestIdentity): RootAttachment | undefined {
    return roots.get(identityKey(identity));
  }

  function retire(entry: RuntimeEntry): Promise<void> {
    if (entry.retiring) return entry.retiring;
    entry.retiring = Promise.resolve(entry.starting)
      .catch(() => undefined)
      .then(() => entry.stopped)
      .then(() => {
        const key = identityKey(entry.identity);
        if (entries.get(key) === entry) entries.delete(key);
      });
    void entry.retiring.catch(() => {});
    entry.abort.abort();
    return entry.retiring;
  }

  function removeRoot(root: RootAttachment): void {
    if (roots.get(identityKey(root.identity)) !== root) return;
    roots.delete(identityKey(root.identity));
    root.entry.roots.delete(root);
    forgetAttachedRoot(root.identity.kiloSessionId, root.identity.directory);
    root.abort.abort();
    if (root.entry.roots.size === 0) void retire(root.entry);
  }

  function failRuntime(entry: RuntimeEntry, reason: WorktreeKiloFailure['reason']): void {
    if (entry.abort.signal.aborted) return;
    entry.abort.abort();
    options.onUnexpectedClose({ directory: entry.directory, reason });
  }

  async function start(
    entry: RuntimeEntry,
    retiring: Promise<void> | undefined
  ): Promise<WorktreeKiloRuntime> {
    const abort = new AbortController();
    entry.processAbort = abort;
    const stopProcess = () => abort.abort();
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
      server.close();
    };
    abort.signal.addEventListener('abort', closeServer, { once: true });
    try {
      if (retiring) await retiring;
      abort.signal.throwIfAborted();
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
      });
      entry.stopped = server.stopped;
      void server.stopped?.then(() => {
        if (!abort.signal.aborted) failRuntime(entry, 'process_exited');
      });
      abort.signal.throwIfAborted();
      const client = createKiloClient({ baseUrl: server.url, directory: entry.directory });
      const kiloClient = createWrapperKiloClient(client, server.url, entry.directory);
      entry.kiloClient = {
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
      const runtime: WorktreeKiloRuntime = entry.runtime ?? {
        identity: { ...entry.identity },
        scopeId: entry.kilo.scopeId,
        directory: entry.directory,
        get env() {
          return entry.env;
        },
        get kiloClient() {
          if (!entry.kiloClient) {
            throw new WorktreeKiloRuntimeError('not_ready', 'Kilo worktree is not ready', true);
          }
          return entry.kiloClient;
        },
        signal: entry.abort.signal,
      };
      const eventClient = createKiloEventClient({
        baseUrl: server.url,
        directory: entry.directory,
      });
      entry.feed = await withTimeoutAndAbort(
        startSandboxControlEventFeed({
          signal: abort.signal,
          onDiagnostic: (event, fields) =>
            emitControlDiagnostic(options.onDiagnostic, event, {
              ...fields,
              scopeId: entry.kilo.scopeId,
            }),
          open: signal =>
            eventClient.global.event({
              signal,
              sseMaxRetryAttempts: 1,
              onSseError: () => {
                if (!signal.aborted) {
                  throw new KiloEventFeedError('feed_failed', 'Kilo global event feed failed');
                }
              },
            }),
          consume: async stream => {
            for await (const event of unfilteredKiloEvents(stream)) {
              if (abort.signal.aborted) return;
              options.onEvent?.(runtime, event);
            }
          },
          onUnexpectedClose: error => {
            if (abort.signal.aborted) return;
            failRuntime(entry, error instanceof KiloEventFeedError ? error.reason : 'feed_failed');
          },
        }),
        {
          timeoutMs: KILO_STARTUP_TIMEOUT_MS,
          timeoutMessage: 'Kilo event feed startup timed out',
          signal: abort.signal,
          abortMessage: 'Kilo worktree closed',
        }
      );
      abort.signal.throwIfAborted();
      entry.runtime = runtime;
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
      if (entry.runtime) failRuntime(entry, 'credential_refresh_failed');
      else entry.abort.abort();
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
    canRefreshCredentials: () => boolean
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
    entry.processAbort.abort();
    try {
      await withTimeoutAndAbort(entry.stopped, {
        signal: entry.abort.signal,
        timeoutMs: KILO_STARTUP_TIMEOUT_MS,
        timeoutMessage: 'Kilo worktree credential refresh timed out',
        abortMessage: 'Kilo worktree credential refresh cancelled',
      });
      entry.kilo = { ...kilo, targets: { ...kilo.targets } };
      entry.env = env;
      return await start(entry, undefined);
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
    attach(identity, kilo, environment, canRefreshCredentials) {
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
      const key = identityKey(identity);
      const previous = entries.get(key);
      let entry = previous?.retiring ? undefined : previous;
      if (entry && !sameAuth(entry.kilo, kilo) && kilo.containmentEnabled !== false) {
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
            .then(() => refreshCredentials(refreshing, kilo, env, canRefreshCredentials))
            .finally(() => {
              refreshing.starting = undefined;
            });
        }
      }
      if (!entry) {
        const homeId = createHash('sha256')
          .update(key)
          .update('\0')
          .update(directory)
          .digest('hex');
        const home = path.join(
          options.homeRoot ?? path.join(os.tmpdir(), 'kilo-worktrees'),
          homeId
        );
        entry = {
          identity: { ...identity },
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
          pendingPtys: 0,
        };
        const homes = homesByDirectory.get(directory) ?? new Set<string>();
        homes.add(home);
        homesByDirectory.set(directory, homes);
        entries.set(key, entry);
      }
      if (!root) {
        root = {
          identity: { ...identity },
          entry,
          abort: new AbortController(),
          attached: false,
          pending: new Set(),
        };
        roots.set(key, root);
        entry.roots.add(root);
        rememberAttachedRoot(identity.kiloSessionId, directory);
      }
      const attachedRoot = root;
      const attempt = Symbol();
      attachedRoot.pending.add(attempt);
      const signal = AbortSignal.any([attachedRoot.abort.signal, entry.abort.signal]);
      const ready =
        entry.starting ??
        (entry.runtime
          ? Promise.resolve(entry.runtime)
          : (entry.starting = start(entry, previous?.retiring)));
      return {
        ready,
        signal,
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
      for (const root of roots.values()) {
        if (root.identity.directory === directory) removeRoot(root);
      }
      const directoryEntries = [...entries.values()].filter(entry => entry.directory === directory);
      for (const entry of directoryEntries) {
        await withTimeoutAndAbort(retire(entry), {
          timeoutMs: KILO_STARTUP_TIMEOUT_MS,
          timeoutMessage: 'Kilo worktree retirement timed out',
          abortMessage: 'Kilo worktree retirement cancelled',
        });
      }
      for (const home of homesByDirectory.get(directory) ?? []) {
        await fs.rm(home, { recursive: true, force: true });
      }
      homesByDirectory.delete(directory);
    },
    get(identity) {
      const entry = entries.get(identityKey(identity));
      const runtime = entry?.starting ? undefined : entry?.runtime;
      return !closed && runtime && !runtime.signal.aborted && entry?.feed?.isFresh()
        ? runtime
        : undefined;
    },
    getAll(directory) {
      return [...entries.values()]
        .flatMap(entry => {
          const runtime = entry.starting ? undefined : entry.runtime;
          return !closed && runtime && !runtime.signal.aborted && entry.feed?.isFresh()
            ? [runtime]
            : [];
        })
        .filter(runtime => runtime.directory === directory);
    },
    isCurrent(runtime) {
      return (
        !closed &&
        entries.get(identityKey(runtime.identity))?.runtime === runtime &&
        !runtime.signal.aborted
      );
    },
    isHealthy() {
      return (
        !closed &&
        [...entries.values()].every(
          entry =>
            entry.retiring !== undefined ||
            (!entry.abort.signal.aborted &&
              (entry.starting !== undefined || !entry.runtime || entry.feed?.isFresh() === true))
        )
      );
    },
    shutdown() {
      if (closed) return;
      closed = true;
      for (const root of roots.values()) removeRoot(root);
      for (const entry of entries.values()) void retire(entry);
    },
  };
}
