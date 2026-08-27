import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createKiloClient } from '@kilocode/sdk';
import { CONTROL_PLANE_SANDBOX_PERMISSION } from '../../../src/shared/control-plane-permission.js';
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
import { startSandboxControlEventFeed } from './sandbox-control-runtime.js';

export type WorktreeKiloAuth = NonNullable<SessionAttachPayload['kilo']>;

export type WorktreeKiloRuntime = {
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
  attach(
    identity: SessionRequestIdentity,
    kilo: WorktreeKiloAuth,
    env?: Record<string, string>
  ): WorktreeKiloAttachment;
  detach(identity: SessionRequestIdentity): boolean;
  deleteDirectory(directory: string): Promise<void>;
  get(directory: string): WorktreeKiloRuntime | undefined;
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
  kilo: WorktreeKiloAuth;
  directory: string;
  env: Record<string, string>;
  abort: AbortController;
  roots: Set<RootAttachment>;
  runtime?: WorktreeKiloRuntime;
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
    left.token === right.token &&
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
  onUnexpectedClose: () => void;
}): WorktreeKiloRuntimes {
  const entries = new Map<string, RuntimeEntry>();
  const directoriesByScope = new Map<string, string>();
  const roots = new Map<string, RootAttachment>();
  const homesByDirectory = new Map<string, Set<string>>();
  const deletedDirectories = new Set<string>();
  let closed = false;

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

  function retire(entry: RuntimeEntry): Promise<void> {
    if (entry.retiring) return entry.retiring;
    entry.retiring = Promise.resolve(entry.starting)
      .catch(() => undefined)
      .then(() => entry.stopped)
      .then(() => {
        if (entries.get(entry.directory) === entry) entries.delete(entry.directory);
      });
    void entry.retiring.catch(() => {});
    if (
      entries.get(entry.directory) === entry &&
      directoriesByScope.get(entry.kilo.scopeId) === entry.directory
    ) {
      directoriesByScope.delete(entry.kilo.scopeId);
    }
    entry.abort.abort();
    return entry.retiring;
  }

  function removeRoot(root: RootAttachment): void {
    if (roots.get(root.identity.kiloSessionId) !== root) return;
    roots.delete(root.identity.kiloSessionId);
    root.entry.roots.delete(root);
    forgetAttachedRoot(root.identity.kiloSessionId, root.identity.directory);
    root.abort.abort();
    if (root.entry.roots.size === 0) void retire(root.entry);
  }

  async function start(
    entry: RuntimeEntry,
    retiring: Promise<void> | undefined
  ): Promise<WorktreeKiloRuntime> {
    const { abort } = entry;
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
      abort.signal.throwIfAborted();
      const client = createKiloClient({ baseUrl: server.url, directory: entry.directory });
      const runtime: WorktreeKiloRuntime = {
        scopeId: entry.kilo.scopeId,
        directory: entry.directory,
        env: entry.env,
        kiloClient: createWrapperKiloClient(client, server.url, entry.directory),
        signal: abort.signal,
      };
      entry.feed = await withTimeoutAndAbort(
        startSandboxControlEventFeed({
          signal: abort.signal,
          open: signal => client.global.event({ signal, sseMaxRetryAttempts: 1 }),
          consume: async stream => {
            for await (const event of unfilteredKiloEvents(stream)) {
              if (abort.signal.aborted) return;
              options.onEvent?.(runtime, event);
            }
          },
          onUnexpectedClose: () => {
            abort.abort();
            options.onUnexpectedClose();
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
      return runtime;
    } catch {
      abort.abort();
      closeServer();
      throw new WorktreeKiloRuntimeError('not_ready', 'Kilo worktree failed to start', true);
    } finally {
      entry.starting = undefined;
    }
  }

  return {
    attach(identity, kilo, environment) {
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
        throw new WorktreeKiloRuntimeError('not_ready', 'Kilo worktree is closed', true);
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
        };
        const homes = homesByDirectory.get(directory) ?? new Set<string>();
        homes.add(home);
        homesByDirectory.set(directory, homes);
        entries.set(directory, entry);
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
      const attempt = Symbol();
      attachedRoot.pending.add(attempt);
      const signal = AbortSignal.any([attachedRoot.abort.signal, entry.abort.signal]);
      const ready = entry.runtime
        ? Promise.resolve(entry.runtime)
        : (entry.starting ??= start(entry, previous?.retiring));
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
      const entry = entries.get(directory);
      for (const root of roots.values()) {
        if (root.identity.directory === directory) removeRoot(root);
      }
      if (entry) {
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
    get(directory) {
      const runtime = entries.get(directory)?.runtime;
      return !closed && runtime && !runtime.signal.aborted ? runtime : undefined;
    },
    isHealthy() {
      return (
        !closed &&
        [...entries.values()].every(
          entry =>
            entry.retiring !== undefined ||
            (!entry.abort.signal.aborted && (!entry.runtime || entry.feed?.isFresh() === true))
        )
      );
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
