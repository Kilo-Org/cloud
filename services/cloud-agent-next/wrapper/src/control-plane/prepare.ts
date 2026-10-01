import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type {
  ControlPlanePreparationStep,
  ControlPlaneRouteSpec,
  ControlPlaneSessionCredentialsPayload,
  ControlPlaneWrapperFrame,
} from '../../../src/shared/control-plane-protocol.js';
import type { ControlPlaneTimers } from '../../../src/shared/control-plane-timers.js';
import type { WorkspaceFailureSubtype } from '../../../src/shared/wrapper-bootstrap.js';
import type { WrapperKiloClient } from '../kilo-api.js';
import {
  git,
  runProcess,
  withTimeoutAndAbort,
  type ExecResult,
  type ProcessOptions,
  type ProcessOutputStream,
} from '../utils.js';
import { WrapperBootstrapError } from '../bootstrap-error.js';
import { formatGitResultFailure, gitOperationError } from '../git-errors.js';
import { authenticatedGitUrl } from '../control/git-url.js';
import { checkoutSyntheticReviewRef, isSyntheticReviewRef } from '../git-review-ref.js';
import {
  buildWorktreeKiloEnvironment,
  type WorktreeKiloAuth,
} from '../control/worktree-runtime.js';
import { createOutputRedactor, createSecretRedactor } from '../redact-output.js';
import { stripAnsi } from '../event-parser.js';
import { KiloWorktreeMcpMismatchError } from './kilo-runtime.js';
import { configureWorkspaceGitAuthor } from '../session-bootstrap.js';
import { restoreSession, seedSessionIngestRegistration } from '../restore-session.js';
import { reportRestoreIncomplete } from '../restore-incomplete.js';
import type { ControlWorkload } from '../control/workload-cgroup.js';

const BOOTSTRAP_MARKER = 'kilo-bootstrap-complete';
/** Spec §7 "Setup commands": current per-command limits. */
const SETUP_COMMAND_INACTIVITY_TIMEOUT_MS = 5 * 60_000;
const SETUP_COMMAND_HARD_TIMEOUT_MS = 8 * 60_000;
/** Spec §7 "Clone or fetch": network errors get 3 attempts with backoff. */
const CLONE_RETRY_ATTEMPTS = 3;
const CLONE_RETRY_BACKOFF_MS = [1_000, 2_000];
/** Spec §7: Kilo runtime start and Kilo session each get one retry. */
const STEP_RETRY_ATTEMPTS = 2;
/** Upper bound on one setup-output event so a chatty command cannot flood the wire. */
const SETUP_OUTPUT_EVENT_LIMIT = 8_192;

export type PrepareRuntimePort = {
  ensure(input: {
    key: string;
    directory: string;
    env: Record<string, string>;
    workload?: ControlWorkload;
  }): Promise<WrapperKiloClient>;
  installCredentials(key: string, env: Record<string, string>): Promise<void>;
  /** True when the runtime is gone or has spent its restart budget. */
  isUnavailable(key: string): boolean;
  remove(key: string): void;
  release(key: string): void;
};

export type PrepareDeps = {
  timers: ControlPlaneTimers;
  emit: (frame: ControlPlaneWrapperFrame) => void;
  runtimes: PrepareRuntimePort;
  log?: (message: string) => void;
  runGit?: (args: string[], options?: ProcessOptions) => Promise<ExecResult>;
  runSetup?: (
    command: string,
    directory: string,
    env: Record<string, string>,
    onOutput?: (stream: ProcessOutputStream, output: string) => void,
    signal?: AbortSignal
  ) => Promise<ExecResult>;
  restore?: typeof restoreSession;
  seedRegistration?: typeof seedSessionIngestRegistration;
  configureGitAuthor?: typeof configureWorkspaceGitAuthor;
  sessionExists?: (
    client: WrapperKiloClient,
    kiloSessionId: string,
    directory: string,
    signal: AbortSignal
  ) => Promise<boolean>;
  mkdir?: (directory: string) => Promise<void>;
  hasGit?: (directory: string) => Promise<boolean>;
  hasBootstrapMarker?: (directory: string) => Promise<boolean>;
  writeBootstrapMarker?: (directory: string) => Promise<void>;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  inheritedEnv?: NodeJS.ProcessEnv;
  homeRoot?: string;
};

type PreparedRoute = {
  key: string;
  spec: ControlPlaneRouteSpec;
  directory: string;
  home: string;
  kilo: WorktreeKiloAuth;
  env: Record<string, string>;
};

export type PreparationManager = {
  prepare(
    spec: ControlPlaneRouteSpec,
    credentials?: ControlPlaneSessionCredentialsPayload
  ): Promise<void>;
  release(sessionId: string): void;
  isPrepared(sessionId: string): boolean;
  isPreparing(): boolean;
  installCredentials(credentials: ControlPlaneSessionCredentialsPayload): Promise<void>;
};

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const done = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });
}

async function defaultHasGit(directory: string): Promise<boolean> {
  try {
    await fs.access(path.join(directory, '.git', 'HEAD'));
    return true;
  } catch {
    return false;
  }
}

function markerPath(directory: string, hasGit: boolean): string {
  return hasGit
    ? path.join(directory, '.git', BOOTSTRAP_MARKER)
    : `${path.resolve(directory)}.${BOOTSTRAP_MARKER}`;
}

async function defaultSessionExists(
  client: WrapperKiloClient,
  kiloSessionId: string,
  directory: string,
  signal: AbortSignal
): Promise<boolean> {
  const url = new URL(`/session/${encodeURIComponent(kiloSessionId)}`, client.serverUrl);
  url.searchParams.set('directory', directory);
  const response = await fetch(url, { signal });
  if (response.status === 404) return false;
  if (!response.ok) throw new Error('Kilo session probe failed');
  const data: unknown = await response.json();
  if (typeof data !== 'object' || data === null || !('id' in data) || data.id !== kiloSessionId) {
    throw new Error('Kilo session probe returned an invalid session');
  }
  return true;
}

export function runtimeKey(spec: ControlPlaneRouteSpec): string {
  return spec.runtimeIsolation === 'per-session' ? spec.sessionId : spec.directory;
}

/**
 * Spec §7: a per-session runtime gets its own HOME keyed by the session (legacy
 * `worktree-runtime.ts` hashes the runtime key under per-session isolation);
 * a shared runtime keys HOME by the worktree scope so every session sees one.
 */
function homeKey(spec: ControlPlaneRouteSpec): string {
  return spec.runtimeIsolation === 'per-session'
    ? spec.sessionId
    : (spec.kilo?.scopeId ?? spec.sessionId);
}

function homeFor(key: string, directory: string, homeRoot: string): string {
  const id = createHash('sha256').update(key).update('\0').update(directory).digest('hex');
  return path.join(homeRoot, id);
}

function isNetworkFailure(subtype: WorkspaceFailureSubtype | undefined): boolean {
  return subtype === 'git_network_failed' || subtype === 'git_rate_limited';
}

function isTimeoutMessage(step: ControlPlanePreparationStep, error: unknown): boolean {
  return error instanceof Error && error.message === `${step} timed out`;
}

export function createPreparationManager(deps: PrepareDeps): PreparationManager {
  const timers = deps.timers.wrapper;
  const log = deps.log ?? ((): void => undefined);
  const inheritedEnv = deps.inheritedEnv ?? process.env;
  const runGit = deps.runGit ?? ((args, options) => git(args, options));
  const runSetup =
    deps.runSetup ??
    ((command, directory, env, onOutput, signal) =>
      runProcess('sh', ['-c', command], {
        cwd: directory,
        env,
        inheritEnv: false,
        ...(signal ? { signal } : {}),
        inactivityTimeoutMs: SETUP_COMMAND_INACTIVITY_TIMEOUT_MS,
        hardTimeoutMs: SETUP_COMMAND_HARD_TIMEOUT_MS,
        ...(onOutput ? { onOutput } : {}),
      }));
  const restore = deps.restore ?? restoreSession;
  const seedRegistration = deps.seedRegistration ?? seedSessionIngestRegistration;
  const configureGitAuthor = deps.configureGitAuthor ?? configureWorkspaceGitAuthor;
  const sessionExists = deps.sessionExists ?? defaultSessionExists;
  const sleep = deps.sleep ?? defaultSleep;
  const homeRoot = deps.homeRoot ?? path.join(os.tmpdir(), 'kilo-worktrees');
  const prepared = new Map<string, PreparedRoute>();
  const preparing = new Map<string, { promise: Promise<void>; released: boolean }>();
  // Spec §7: clone/checkout/setup mutate one shared worktree, so they must not
  // run concurrently for two sessions on the same directory. The lock is keyed
  // by directory, mirroring legacy `serializeWorkspacePreparation`.
  const workspacePreparations = new Map<string, Promise<void>>();

  const hasGit = deps.hasGit ?? defaultHasGit;
  const hasBootstrapMarker =
    deps.hasBootstrapMarker ??
    (async (directory: string) => {
      try {
        await fs.access(markerPath(directory, await hasGit(directory)));
        return true;
      } catch {
        return false;
      }
    });
  const writeBootstrapMarker =
    deps.writeBootstrapMarker ??
    (async (directory: string) => {
      await fs.writeFile(markerPath(directory, await hasGit(directory)), 'ready\n');
    });
  const mkdir = deps.mkdir ?? (dir => fs.mkdir(dir, { recursive: true }).then(() => undefined));

  function emitProgress(sessionId: string, step: ControlPlanePreparationStep): void {
    deps.emit({ type: 'session.progress', sessionId, step });
  }

  function emitFailure(sessionId: string, step: ControlPlanePreparationStep, error: unknown): void {
    const subtype = error instanceof WrapperBootstrapError ? error.subtype : undefined;
    deps.emit({
      type: 'session.failed',
      sessionId,
      reason: 'workspace_setup_failed',
      step,
      ...(subtype === undefined ? {} : { subtype }),
    });
  }

  async function withinStep<T>(
    step: ControlPlanePreparationStep,
    timeoutMs: number,
    operation: (signal: AbortSignal) => Promise<T>
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error(`${step} timed out`)), timeoutMs);
    try {
      return await withTimeoutAndAbort(operation(controller.signal), {
        timeoutMs,
        timeoutMessage: `${step} timed out`,
        abortMessage: `${step} aborted`,
      });
    } catch (error) {
      if (error instanceof WrapperBootstrapError) throw error;
      if (isTimeoutMessage(step, error)) {
        throw new WrapperBootstrapError({
          code: 'WORKSPACE_SETUP_FAILED',
          ...(step === 'clone'
            ? { subtype: 'git_clone_timeout' as const }
            : step === 'kilo_session'
              ? { subtype: 'kilo_import_timeout' as const }
              : {}),
          message: error instanceof Error ? error.message : `${step} timed out`,
          retryable: true,
        });
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Runs `prepare` after every earlier preparation of the same directory. */
  async function withWorkspaceLock<T>(directory: string, prepare: () => Promise<T>): Promise<T> {
    const previous = workspacePreparations.get(directory) ?? Promise.resolve();
    const run = previous.then(prepare, prepare);
    const tracked = run.then(
      () => undefined,
      () => undefined
    );
    workspacePreparations.set(directory, tracked);
    try {
      return await run;
    } finally {
      if (workspacePreparations.get(directory) === tracked) workspacePreparations.delete(directory);
    }
  }

  async function withOneRetry<T>(
    operation: () => Promise<T>,
    isCurrent: () => boolean
  ): Promise<T> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= STEP_RETRY_ATTEMPTS; attempt += 1) {
      try {
        return await operation();
      } catch (error) {
        if (!isCurrent()) throw error;
        lastError = error;
      }
    }
    throw lastError;
  }

  async function cloneWorkspace(
    spec: ControlPlaneRouteSpec,
    directory: string,
    env: Record<string, string>,
    redact: (text: string) => string,
    signal: AbortSignal,
    onCheckout: () => void
  ): Promise<void> {
    emitProgress(spec.sessionId, 'clone');
    await mkdir(directory);
    if (!spec.git) return;
    if (!(await hasGit(directory))) {
      const cloneUrl = authenticatedGitUrl(spec.git.url, spec.git.token, spec.git.platform);
      let lastError: WrapperBootstrapError | undefined;
      for (let attempt = 1; attempt <= CLONE_RETRY_ATTEMPTS; attempt += 1) {
        signal.throwIfAborted();
        const cloned = await runGit(['clone', cloneUrl, directory], {
          env,
          inheritEnv: false,
          signal,
        });
        if (cloned.exitCode === 0) {
          lastError = undefined;
          break;
        }
        lastError = gitOperationError(cloned, 'clone', redact);
        if (!isNetworkFailure(lastError.subtype) || attempt === CLONE_RETRY_ATTEMPTS) break;
        await sleep(CLONE_RETRY_BACKOFF_MS[attempt - 1] ?? 0, signal);
      }
      if (lastError) throw lastError;
    }
    onCheckout();
    emitProgress(spec.sessionId, 'checkout');
    const runBranchGit = (args: string[]): Promise<ExecResult> =>
      runGit(args, { cwd: directory, env, inheritEnv: false, signal });
    // Spec §7 "Checkout, branch restore" (legacy apply-attach branch logic):
    // `-B <branch> origin/<branch>` breaks a working branch or a `session/*`
    // branch that has no upstream, so resolve the refs first.
    const branch = spec.branch ?? `session/${spec.kilo?.scopeId ?? spec.sessionId}`;
    if (isSyntheticReviewRef(branch) && spec.branchMode !== 'working') {
      await checkoutSyntheticReviewRef({
        runGit: (args, options) =>
          runGit(args, { ...options, cwd: directory, env, inheritEnv: false, signal }),
        workspacePath: directory,
        branchName: branch,
        signal,
        redact,
      });
    } else {
      let checkoutArgs = ['checkout', '-B', branch, `origin/${branch}`];
      if (!spec.branch || spec.branchMode === 'working') {
        const existingBranch = await runBranchGit([
          'show-ref',
          '--verify',
          '--quiet',
          `refs/heads/${branch}`,
        ]);
        signal.throwIfAborted();
        if (existingBranch.exitCode !== 0 && existingBranch.exitCode !== 1) {
          throw new WrapperBootstrapError({
            code: 'WORKSPACE_SETUP_FAILED',
            subtype: gitOperationError(existingBranch, 'checkout', redact).subtype,
            message: formatGitResultFailure(existingBranch, 'git branch lookup failed', redact),
            retryable: true,
          });
        }
        checkoutArgs = ['checkout', branch];
        if (existingBranch.exitCode === 1) {
          const remoteBranch = await runBranchGit([
            'show-ref',
            '--verify',
            '--quiet',
            `refs/remotes/origin/${branch}`,
          ]);
          signal.throwIfAborted();
          if (remoteBranch.exitCode !== 0 && remoteBranch.exitCode !== 1) {
            throw new WrapperBootstrapError({
              code: 'WORKSPACE_SETUP_FAILED',
              subtype: gitOperationError(remoteBranch, 'checkout', redact).subtype,
              message: formatGitResultFailure(remoteBranch, 'git branch lookup failed', redact),
              retryable: true,
            });
          }
          checkoutArgs = [
            'checkout',
            '-b',
            branch,
            ...(remoteBranch.exitCode === 0 ? ['--track', `origin/${branch}`] : []),
          ];
        }
      }
      const checked = await runBranchGit(checkoutArgs);
      signal.throwIfAborted();
      if (checked.exitCode !== 0) throw gitOperationError(checked, 'checkout', redact);
    }
    await configureGitAuthor(
      directory,
      (args, options) => runGit(args, { ...options, cwd: directory, env, inheritEnv: false }),
      spec.git.author,
      signal
    );
  }

  async function runSetupCommands(
    spec: ControlPlaneRouteSpec,
    directory: string,
    env: Record<string, string>,
    redact: (text: string) => string,
    signal: AbortSignal
  ): Promise<void> {
    const commands = spec.setupCommands ?? [];
    if (commands.length === 0) return;
    emitProgress(spec.sessionId, 'setup');
    for (const [index, command] of commands.entries()) {
      signal.throwIfAborted();
      const output = createOutputRedactor(
        text => redact(stripAnsi(text)),
        text => {
          if (signal.aborted) return;
          const cleaned = text.trim();
          if (!cleaned) return;
          log(`control-plane setup command ${index + 1} produced output`);
          // Spec §9: a setup failure must show the command output, so surface it
          // on the wire rather than only in the wrapper log. B8/the Session owns
          // rendering `session.setup.output`.
          deps.emit({
            type: 'session.events',
            sessionId: spec.sessionId,
            events: [
              {
                type: 'session.setup.output',
                properties: {
                  command: index + 1,
                  output: cleaned.slice(0, SETUP_OUTPUT_EVENT_LIMIT),
                },
              },
            ],
          });
        }
      );
      const startedAt = Date.now();
      const result = await runSetup(command, directory, env, output.onOutput, signal);
      output.flush();
      if (result.exitCode !== 0) {
        const timedOut = result.terminationReason !== undefined;
        log(
          `control-plane setup command failed sessionId=${spec.sessionId} kiloSessionId=${spec.kiloSessionId} attemptId=${spec.attemptId} index=${index + 1} count=${commands.length} exitCode=${result.exitCode} terminationReason=${result.terminationReason ?? 'nonzero'} elapsedMs=${Date.now() - startedAt} inactivityTimeoutMs=${SETUP_COMMAND_INACTIVITY_TIMEOUT_MS} hardTimeoutMs=${SETUP_COMMAND_HARD_TIMEOUT_MS}`
        );
        throw new WrapperBootstrapError({
          code: 'WORKSPACE_SETUP_FAILED',
          subtype: timedOut ? 'setup_command_timeout' : 'setup_command_failed',
          message: `Setup command ${index + 1} ${timedOut ? 'timed out' : 'failed'}`,
          retryable: true,
        });
      }
    }
  }

  async function resolveKiloSession(
    spec: ControlPlaneRouteSpec,
    directory: string,
    env: Record<string, string>,
    client: WrapperKiloClient,
    signal: AbortSignal
  ): Promise<void> {
    await seedRegistration(spec.kiloSessionId, env, signal);
    if (await sessionExists(client, spec.kiloSessionId, directory, signal)) return;
    const restored = await restore(spec.kiloSessionId, directory, undefined, { env, signal });
    if (restored.ok) {
      if (restored.diffs.skipped > 0) {
        await reportRestoreIncomplete({
          diffs: restored.diffs,
          identity: `kiloSessionId=${spec.kiloSessionId}`,
          log,
        }).catch(() => undefined);
      }
      return;
    }
    if (restored.code !== 404 && !restored.emptySnapshot) {
      throw new WrapperBootstrapError({
        code: 'WORKSPACE_SETUP_FAILED',
        subtype: restored.subtype ?? 'kilo_import_failed',
        message: restored.error,
        retryable: true,
      });
    }
    await client.ensureSession(spec.kiloSessionId, directory, signal);
  }

  async function withRuntimeStartRetry<T>(
    key: string,
    operation: () => Promise<T>,
    isCurrent: () => boolean
  ): Promise<T> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= STEP_RETRY_ATTEMPTS; attempt += 1) {
      try {
        return await operation();
      } catch (error) {
        // A per-session MCP drift is permanent for this key; retrying would drop
        // the existing runtime and accept the changed servers.
        if (!isCurrent() || error instanceof KiloWorktreeMcpMismatchError) throw error;
        lastError = error;
        // M1: a hung spawn leaves `ensure` returning the same pending promise,
        // so drop the runtime before the retry starts a fresh one.
        deps.runtimes.remove(key);
      }
    }
    throw lastError;
  }

  async function runPrepare(
    spec: ControlPlaneRouteSpec,
    credentials: ControlPlaneSessionCredentialsPayload | undefined,
    owner: { released: boolean }
  ): Promise<void> {
    const sessionId = spec.sessionId;
    let currentStep: ControlPlanePreparationStep = 'kilo_runtime';
    const kiloConfig = spec.kilo;
    // Spec §6: behind the runtime credential proxy the wrapper talks to the
    // Worker facade with the per-session handle; otherwise it uses the spec's
    // alias and targets.
    const kiloToken = credentials?.proxy?.handle ?? credentials?.kilo.token ?? kiloConfig?.token;
    if (!kiloConfig || !kiloToken) {
      log(`control-plane prepare is missing the Kilo context session=${sessionId}`);
      emitFailure(sessionId, 'kilo_runtime', undefined);
      return;
    }
    const key = runtimeKey(spec);
    const directory = spec.directory;
    const kiloAuth: WorktreeKiloAuth = {
      scopeId: kiloConfig.scopeId,
      token: kiloToken,
      ...(kiloConfig.containmentEnabled === undefined
        ? {}
        : { containmentEnabled: kiloConfig.containmentEnabled }),
      ...(kiloConfig.organizationId === undefined
        ? {}
        : { organizationId: kiloConfig.organizationId }),
      targets: credentials?.proxy?.targets ?? kiloConfig.targets,
    };
    const home = homeFor(homeKey(spec), directory, homeRoot);

    try {
      // Built inside the failure scope: an over-limit CLI config must surface as
      // `session.failed`, not reject the prepare promise (which the caller
      // swallows while the route waits out its timeout).
      const env = buildWorktreeKiloEnvironment(
        directory,
        home,
        kiloAuth,
        spec.env ?? {},
        inheritedEnv,
        spec.mcp
      );
      const redact = createSecretRedactor(inheritedEnv, spec.env ?? {}, {
        ...env,
        ...(credentials?.git?.token ? { GIT_TOKEN: credentials.git.token } : {}),
      });
      const needsWorkspace = Boolean(spec.git) || (spec.setupCommands?.length ?? 0) > 0;
      // M3: clone/checkout/setup mutate a shared worktree. Serialize per
      // directory and re-check the marker so a waiting session skips the work.
      await withWorkspaceLock(directory, async () => {
        if (!needsWorkspace || (await hasBootstrapMarker(directory))) return;
        currentStep = 'clone';
        await withinStep('clone', timers.cloneMs, signal =>
          cloneWorkspace(spec, directory, env, redact, signal, () => {
            currentStep = 'checkout';
          })
        );
        currentStep = 'setup';
        await runSetupCommands(spec, directory, env, redact, new AbortController().signal);
        await writeBootstrapMarker(directory);
      });
      if (owner.released) return;
      currentStep = 'kilo_runtime';
      emitProgress(sessionId, 'kilo_runtime');
      const client = await withRuntimeStartRetry(
        key,
        () =>
          withinStep('kilo_runtime', timers.kiloRuntimeStartMs, () =>
            deps.runtimes.ensure({ key, directory, env })
          ),
        () => !owner.released
      );
      if (owner.released) {
        if (spec.runtimeIsolation === 'per-session') deps.runtimes.release(key);
        return;
      }
      currentStep = 'kilo_session';
      emitProgress(sessionId, 'kilo_session');
      await withOneRetry(
        () =>
          withinStep('kilo_session', timers.kiloSessionMs, signal =>
            resolveKiloSession(spec, directory, env, client, signal)
          ),
        () => !owner.released
      );
      if (owner.released) {
        if (spec.runtimeIsolation === 'per-session') deps.runtimes.release(key);
        return;
      }
      prepared.set(sessionId, { key, spec, directory, home, kilo: kiloAuth, env });
      deps.emit({ type: 'session.ready', sessionId });
      log(`control-plane prepare ready session=${sessionId} directory=${directory}`);
    } catch (error) {
      if (owner.released) {
        if (spec.runtimeIsolation === 'per-session') deps.runtimes.release(key);
        return;
      }
      log(
        `control-plane prepare failed session=${sessionId} step=${currentStep} error=${
          error instanceof Error ? error.message : String(error)
        }`
      );
      emitFailure(sessionId, currentStep, error);
    }
  }

  async function installCredentialsFor(
    credentials: ControlPlaneSessionCredentialsPayload
  ): Promise<void> {
    const route = prepared.get(credentials.sessionId);
    if (!route) return;
    const nextEnv = buildWorktreeKiloEnvironment(
      route.directory,
      route.home,
      {
        ...route.kilo,
        token: credentials.proxy?.handle ?? credentials.kilo.token,
        targets: credentials.proxy?.targets ?? route.kilo.targets,
      },
      route.spec.env ?? {},
      inheritedEnv,
      route.spec.mcp
    );
    route.env = nextEnv;
    await deps.runtimes.installCredentials(route.key, nextEnv);
    if (credentials.git?.token && route.spec.git) {
      const url = authenticatedGitUrl(
        route.spec.git.url,
        credentials.git.token,
        credentials.git.platform ?? route.spec.git.platform
      );
      const result = await runGit(['remote', 'set-url', 'origin', url], {
        cwd: route.directory,
        env: route.env,
        inheritEnv: false,
      });
      if (result.exitCode !== 0) {
        log(`control-plane Git credential refresh failed session=${credentials.sessionId}`);
      }
    }
  }

  return {
    prepare: function prepare(spec, credentials) {
      const existing = preparing.get(spec.sessionId);
      if (existing && !existing.released) return existing.promise;
      if (existing) {
        const owner = { promise: Promise.resolve(), released: false };
        owner.promise = existing.promise
          .then(() => {
            if (owner.released) return;
            preparing.delete(spec.sessionId);
            return prepare(spec, credentials);
          })
          .finally(() => {
            if (preparing.get(spec.sessionId) === owner) preparing.delete(spec.sessionId);
          });
        preparing.set(spec.sessionId, owner);
        return owner.promise;
      }
      const owner = { promise: Promise.resolve(), released: false };
      const route = prepared.get(spec.sessionId);
      if (route) {
        // M2: a failed route (spent restart budget / dead runtime) must start
        // fresh (spec §7), not short-circuit to `ready`.
        if (deps.runtimes.isUnavailable(route.key)) {
          prepared.delete(spec.sessionId);
        } else {
          const running = (async () => {
            if (credentials) {
              try {
                await installCredentialsFor(credentials);
              } catch (error) {
                log(
                  `control-plane credential refresh on re-prepare failed session=${spec.sessionId} error=${
                    error instanceof Error ? error.message : String(error)
                  }`
                );
              }
            }
            if (!owner.released) {
              deps.emit({ type: 'session.ready', sessionId: spec.sessionId });
            }
          })().finally(() => {
            if (preparing.get(spec.sessionId) === owner) preparing.delete(spec.sessionId);
          });
          owner.promise = running;
          preparing.set(spec.sessionId, owner);
          return running;
        }
      }
      const running = runPrepare(spec, credentials, owner).finally(() => {
        if (preparing.get(spec.sessionId) === owner) preparing.delete(spec.sessionId);
      });
      owner.promise = running;
      preparing.set(spec.sessionId, owner);
      return running;
    },
    release(sessionId) {
      const preparation = preparing.get(sessionId);
      if (preparation) preparation.released = true;
      const route = prepared.get(sessionId);
      if (!route) return;
      prepared.delete(sessionId);
      if (route.spec.runtimeIsolation === 'per-session') deps.runtimes.release(route.key);
    },
    isPrepared: sessionId => prepared.has(sessionId),
    isPreparing: () => preparing.size > 0,
    installCredentials: installCredentialsFor,
  };
}
