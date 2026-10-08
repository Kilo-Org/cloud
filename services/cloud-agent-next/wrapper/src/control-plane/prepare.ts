import { materializeRuntimeProfile, withRuntimeProfileEnvironment } from './runtime-profile.js';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  CONTROL_PLANE_SETUP_EVENTS,
  type ControlPlanePreparationStep,
  type ControlPlaneRouteSpec,
  type ControlPlaneSessionCredentialsPayload,
  type ControlPlaneSetupEvent,
  type ControlPlaneWorkspaceOutcome,
  type ControlPlaneWrapperFrame,
} from '../../../src/shared/control-plane-protocol.js';
import type { ControlPlaneTimers } from '../../../src/shared/control-plane-timers.js';
import type { ControlDiagnosticReporter } from '../../../src/shared/control-diagnostics.js';
import { parseControlPlaneCredential } from '../../../src/shared/control-plane-credential.js';
import type { WorkspaceFailureSubtype } from '../../../src/shared/wrapper-bootstrap.js';
import type { WrapperKiloClient } from '../kilo-api.js';
import {
  git,
  runProcess,
  withTimeoutAndAbort,
  type ExecResult,
  type ProcessOptions,
  type ProcessOutputStream,
  type ProcessSpawn,
} from '../utils.js';
import { WrapperBootstrapError } from '../bootstrap-error.js';
import {
  cleanTerminalOutput,
  formatGitResultFailure,
  gitOperationError,
  type GitRouteClass,
} from '../git-errors.js';
import { authenticatedGitUrl } from '../control/git-url.js';
import { checkoutSyntheticReviewRef, isSyntheticReviewRef } from '../git-review-ref.js';
import {
  buildWorktreeKiloEnvironment,
  type WorktreeKiloAuth,
} from '../control/worktree-runtime.js';
import { createOutputRedactor, createSecretRedactor } from '../redact-output.js';
import { KiloWorktreeMcpMismatchError } from './kilo-runtime.js';
import { configureWorkspaceGitAuthor, createGitProgressReporter } from '../session-bootstrap.js';
import { restoreSession, seedSessionIngestRegistration } from '../restore-session.js';
import { reportRestoreIncomplete } from '../restore-incomplete.js';
import type { ControlWorkload } from '../control/workload-cgroup.js';
import {
  emptyWorkspaceDirectory,
  refreshAdoptedRepository,
  removeStaleHomes,
  stripGitCredentials,
  truncateWrapperLog,
} from './workspace-adoption.js';
import type { WorkspaceCapture } from './workspace-capture.js';
import {
  classifyWorkspace,
  planStamp,
  snapshotAction,
  readWorkspaceStamp,
  writeWorkspaceStamp,
  type WorkspaceInspection,
  type WorkspaceStamp,
} from './workspace-stamp.js';

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

/**
 * Spec §7: eligible managed GitHub HTTPS preparation clone/fetch opts into the
 * two invocation-scoped native Git options together. `proactiveAuth=basic`
 * makes the first request carry the existing URL-bound control alias so
 * contained resolution, repository-authorized redemption and the bounded
 * Retry-After handler run instead of an anonymous first request;
 * `followRedirects=false` fails every redirect (including a same-origin one)
 * rather than letting Git reattach the alias to a redirected request. Never one
 * option without the other, and never on an ineligible command.
 */
const MANAGED_GITHUB_PREPARATION_GIT_CONFIG = [
  '-c',
  'http.https://github.com/.proactiveAuth=basic',
  '-c',
  'http.https://github.com/.followRedirects=false',
] as const;

/**
 * The single eligibility decision for the two invocation-scoped options. Both
 * options or neither: the command must be preparation clone/fetch, the platform
 * must be managed GitHub, the token must parse as a `github` control alias, and
 * the URL must be the direct HTTPS default-port github.com URL. Callers judge
 * `spec.git.url`, never the password parsed back out of the authenticated URL.
 */
function managedGitHubPreparationGitArgs(spec: ControlPlaneRouteSpec, command: string): string[] {
  if (command !== 'clone' && command !== 'fetch') return [];
  const git = spec.git;
  if (!git || git.platform !== 'github') return [];
  if (!git.token || parseControlPlaneCredential(git.token)?.purpose !== 'github') return [];
  let url: URL;
  try {
    url = new URL(git.url);
  } catch {
    return [];
  }
  // WHATWG `URL.port` is '' for both `https://github.com/...` and an explicit
  // `:443`, so explicit 443 is eligible and only a non-empty port is excluded.
  if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.port !== '') return [];
  return [...MANAGED_GITHUB_PREPARATION_GIT_CONFIG];
}

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
  /** This wrapper's allocation; a workspace stamped by another one came from a snapshot. */
  allocationId: string;
  /** Asks the Sandbox DO to snapshot the container; absent disables capture. */
  capture?: Pick<WorkspaceCapture, 'request'>;
  log?: (message: string) => void;
  onNativeDiagnostic?: ControlDiagnosticReporter;
  runGit?: (args: string[], options?: ProcessOptions) => Promise<ExecResult>;
  runSetup?: (
    command: string,
    directory: string,
    env: Record<string, string>,
    onOutput?: (stream: ProcessOutputStream, output: string) => void,
    signal?: AbortSignal
  ) => Promise<ExecResult>;
  /** Starts the default setup command, e.g. inside the setup cgroup. */
  spawnSetup?: ProcessSpawn;
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
  readStamp?: (directory: string) => Promise<WorkspaceStamp | null>;
  writeStamp?: (directory: string, stamp: WorkspaceStamp) => Promise<void>;
  emptyDirectory?: (directory: string) => Promise<void>;
  /** Removes the homes a restored snapshot carries, keeping this route's own. */
  clearStaleHomes?: (homeRoot: string, keep: string) => Promise<void>;
  truncateLog?: () => Promise<void>;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  now?: () => number;
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
  /** In-flight prepares, for the native status line. */
  preparingCount(): number;
  /** Prepared sessions, for the native status line. */
  sessionCount(): number;
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
        ...(deps.spawnSetup ? { spawn: deps.spawnSetup } : {}),
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
  const now = deps.now ?? Date.now;
  const homeRoot = deps.homeRoot ?? path.join(os.tmpdir(), 'kilo-worktrees');
  const prepared = new Map<string, PreparedRoute>();
  const preparing = new Map<string, { promise: Promise<void>; released: boolean }>();
  // Spec §7: clone/checkout/setup mutate one shared worktree, so they must not
  // run concurrently for two sessions on the same directory. The lock is keyed
  // by directory, mirroring legacy `serializeWorkspacePreparation`.
  const workspacePreparations = new Map<string, Promise<void>>();

  const hasGit = deps.hasGit ?? defaultHasGit;
  const readStamp =
    deps.readStamp ??
    (async (directory: string) => readWorkspaceStamp(directory, await hasGit(directory)));
  const writeStamp =
    deps.writeStamp ??
    (async (directory: string, stamp: WorkspaceStamp) =>
      writeWorkspaceStamp(directory, await hasGit(directory), stamp));
  const emptyDirectory = deps.emptyDirectory ?? emptyWorkspaceDirectory;
  const clearStaleHomes = deps.clearStaleHomes ?? removeStaleHomes;
  const truncateLog = deps.truncateLog ?? (() => truncateWrapperLog(inheritedEnv.WRAPPER_LOG_PATH));
  const mkdir = deps.mkdir ?? (dir => fs.mkdir(dir, { recursive: true }).then(() => undefined));

  function emitProgress(
    sessionId: string,
    step: ControlPlanePreparationStep,
    detail?: string
  ): void {
    deps.emit({
      type: 'session.progress',
      sessionId,
      step,
      ...(detail === undefined ? {} : { detail }),
    });
  }

  function emitSessionReadyNative(sessionId: string): void {
    // Closed native record; the directory stays in the file log.
    deps.onNativeDiagnostic?.('wrapper.lifecycle', {
      phase: 'session_ready',
      sessionId,
    });
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
    // Closed native record; the free-text error and git failure stay in the file log.
    deps.onNativeDiagnostic?.('wrapper.lifecycle', {
      phase: 'prepare_failed',
      preparationStep: step,
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

  /** Runs a git command that talks to the remote; a network failure retries with backoff. */
  async function runNetworkGit(
    args: string[],
    options: ProcessOptions,
    redact: (text: string) => string,
    signal: AbortSignal
  ): Promise<ExecResult> {
    let last: ExecResult | undefined;
    for (let attempt = 1; attempt <= CLONE_RETRY_ATTEMPTS; attempt += 1) {
      signal.throwIfAborted();
      last = await runGit(args, options);
      if (last.exitCode === 0) return last;
      const failure = gitOperationError(last, 'clone', redact);
      if (!isNetworkFailure(failure.subtype) || attempt === CLONE_RETRY_ATTEMPTS) return last;
      await sleep(CLONE_RETRY_BACKOFF_MS[attempt - 1] ?? 0, signal);
    }
    return last as ExecResult;
  }

  async function cloneRepository(
    spec: ControlPlaneRouteSpec,
    directory: string,
    env: Record<string, string>,
    redact: (text: string) => string,
    signal: AbortSignal
  ): Promise<void> {
    emitProgress(spec.sessionId, 'clone');
    await mkdir(directory);
    if (!spec.git || (await hasGit(directory))) return;
    // Diagnostic route class only: a managed credential was injected into the
    // clone URL, otherwise the plain (direct) URL is used. Never log the URL.
    const gitRoute: GitRouteClass = spec.git.token ? 'managed' : 'direct';
    if (!(await hasGit(directory))) {
      const cloneUrl = authenticatedGitUrl(spec.git.url, spec.git.token, spec.git.platform);
      const gitConfigArgs = managedGitHubPreparationGitArgs(spec, 'clone');
      let lastError: WrapperBootstrapError | undefined;
      for (let attempt = 1; attempt <= CLONE_RETRY_ATTEMPTS; attempt += 1) {
        signal.throwIfAborted();
        if (attempt > 1) {
          emitProgress(
            spec.sessionId,
            'clone',
            `Retrying clone (attempt ${attempt} of ${CLONE_RETRY_ATTEMPTS})`
          );
        }
        const cloned = await runGit(
          [...gitConfigArgs, 'clone', '--progress', cloneUrl, directory],
          {
            env,
            inheritEnv: false,
            signal,
            onOutput: createGitProgressReporter(progressText =>
              emitProgress(spec.sessionId, 'clone', `Cloning repository... ${progressText}`)
            ),
          }
        );
        if (cloned.exitCode === 0) {
          lastError = undefined;
          break;
        }
        lastError = gitOperationError(cloned, 'clone', redact, gitRoute);
        if (!isNetworkFailure(lastError.subtype) || attempt === CLONE_RETRY_ATTEMPTS) break;
        await sleep(CLONE_RETRY_BACKOFF_MS[attempt - 1] ?? 0, signal);
      }
      if (lastError) throw lastError;
    }
  }

  async function cloneWorkspace(
    spec: ControlPlaneRouteSpec,
    directory: string,
    env: Record<string, string>,
    redact: (text: string) => string,
    signal: AbortSignal,
    onCheckout: () => void
  ): Promise<void> {
    await cloneRepository(spec, directory, env, redact, signal);
    if (!spec.git) return;
    onCheckout();
    await checkoutWorkspace(spec, directory, env, redact, signal);
  }

  /**
   * Spec §7 "Checkout, branch restore" (legacy apply-attach branch logic), then the
   * git author. Shared by a fresh clone and an adopted snapshot.
   */
  async function checkoutWorkspace(
    spec: ControlPlaneRouteSpec,
    directory: string,
    env: Record<string, string>,
    redact: (text: string) => string,
    signal: AbortSignal
  ): Promise<void> {
    emitProgress(spec.sessionId, 'checkout');
    const gitRoute: GitRouteClass = spec.git?.token ? 'managed' : 'direct';
    const runBranchGit = (args: string[], options?: ProcessOptions): Promise<ExecResult> =>
      runGit(args, { ...options, cwd: directory, env, inheritEnv: false, signal });
    // Spec §7 "Checkout, branch restore" (legacy apply-attach branch logic):
    // `-B <branch> origin/<branch>` breaks a working branch or a `session/*`
    // branch that has no upstream, so resolve the refs first.
    const branch = spec.branch ?? `session/${spec.kilo?.scopeId ?? spec.sessionId}`;
    if (isSyntheticReviewRef(branch) && spec.branchMode !== 'working') {
      await checkoutSyntheticReviewRef({
        runGit: (args, options) => {
          const gitConfigArgs =
            args[0] === 'fetch' ? managedGitHubPreparationGitArgs(spec, 'fetch') : [];
          return runGit([...gitConfigArgs, ...args], {
            ...options,
            cwd: directory,
            env,
            inheritEnv: false,
            signal,
          });
        },
        workspacePath: directory,
        branchName: branch,
        signal,
        redact,
        route: gitRoute,
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
          const lookup = gitOperationError(existingBranch, 'checkout', redact, gitRoute);
          throw new WrapperBootstrapError({
            code: 'WORKSPACE_SETUP_FAILED',
            subtype: lookup.subtype,
            ...(lookup.gitFailure === undefined ? {} : { gitFailure: lookup.gitFailure }),
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
            const lookup = gitOperationError(remoteBranch, 'checkout', redact, gitRoute);
            throw new WrapperBootstrapError({
              code: 'WORKSPACE_SETUP_FAILED',
              subtype: lookup.subtype,
              ...(lookup.gitFailure === undefined ? {} : { gitFailure: lookup.gitFailure }),
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
      const checked = await runBranchGit(['checkout', '--progress', ...checkoutArgs.slice(1)], {
        onOutput: createGitProgressReporter(progressText =>
          emitProgress(spec.sessionId, 'checkout', `Checking out branch... ${progressText}`)
        ),
      });
      signal.throwIfAborted();
      if (checked.exitCode !== 0) throw gitOperationError(checked, 'checkout', redact, gitRoute);
    }
    await configureGitAuthor(
      directory,
      (args, options) => runGit(args, { ...options, cwd: directory, env, inheritEnv: false }),
      spec.git?.author,
      signal
    );
  }

  /**
   * Reconcile a workspace restored from a repository snapshot with this route:
   * refresh the repository, then the ordinary branch logic. Returns false, leaving
   * the caller to clone, on any failure; an adopt never fails the preparation.
   */
  async function adoptWorkspace(
    spec: ControlPlaneRouteSpec,
    directory: string,
    env: Record<string, string>,
    redact: (text: string) => string,
    setStep: (step: ControlPlanePreparationStep) => void
  ): Promise<boolean> {
    const git = spec.git;
    if (!git) return false;
    setStep('restore');
    try {
      await withinStep('restore', timers.restoreMs, async signal => {
        emitProgress(spec.sessionId, 'restore');
        await refreshAdoptedRepository({
          remoteUrl: authenticatedGitUrl(git.url, git.token, git.platform),
          redact,
          git: (args, options) =>
            options?.network
              ? runNetworkGit(
                  args,
                  { cwd: directory, env, inheritEnv: false, signal },
                  redact,
                  signal
                )
              : runGit(args, { cwd: directory, env, inheritEnv: false, signal }),
        });
        setStep('checkout');
        await checkoutWorkspace(spec, directory, env, redact, signal);
      });
      return true;
    } catch (error) {
      log(
        `control-plane adopt failed, cloning session=${spec.sessionId} error=${
          error instanceof Error ? redact(error.message) : 'unknown'
        }`
      );
      return false;
    }
  }

  async function inspectWorkspace(
    directory: string
  ): Promise<{ inspection: WorkspaceInspection; stamp: WorkspaceStamp | null }> {
    const stamp = await readStamp(directory);
    const inspection = classifyWorkspace({
      hasGit: await hasGit(directory),
      stamp,
      allocationId: deps.allocationId,
    });
    return { inspection, stamp };
  }

  async function headCommit(directory: string, env: Record<string, string>): Promise<string> {
    const result = await runGit(['rev-parse', 'HEAD'], {
      cwd: directory,
      env,
      inheritEnv: false,
    });
    return result.exitCode === 0 ? result.stdout.trim() : '';
  }

  /**
   * Save the prepared workspace as a repository snapshot. `origin` is bare while the
   * Sandbox DO snapshots the container, and gets this route's credential back
   * whatever happens; a failed capture is logged and preparation continues.
   */
  async function captureWorkspace(
    spec: ControlPlaneRouteSpec,
    directory: string,
    env: Record<string, string>,
    commit: string
  ): Promise<void> {
    const git = spec.git;
    const capture = deps.capture;
    if (!git || !capture) return;
    emitProgress(spec.sessionId, 'snapshot');
    await truncateLog().catch(() => undefined);
    const runWorkspaceGit = (args: string[]): Promise<ExecResult> =>
      runGit(args, { cwd: directory, env, inheritEnv: false });
    try {
      const bare = await stripGitCredentials({
        git: runWorkspaceGit,
        directory,
        bareUrl: git.url,
      });
      if (!bare) {
        log(`control-plane capture skipped, origin not bare session=${spec.sessionId}`);
        return;
      }
      const saved = await capture.request(spec.sessionId, commit, timers.captureMs);
      log(`control-plane capture ${saved ? 'saved' : 'not saved'} session=${spec.sessionId}`);
    } catch (error) {
      log(
        `control-plane capture failed session=${spec.sessionId} error=${
          error instanceof Error ? error.message : 'unknown'
        }`
      );
    } finally {
      await restoreOriginCredential(spec, runWorkspaceGit);
    }
  }

  async function restoreOriginCredential(
    spec: ControlPlaneRouteSpec,
    run: (args: string[]) => Promise<ExecResult>
  ): Promise<void> {
    const git = spec.git;
    if (!git) return;
    const url = authenticatedGitUrl(git.url, git.token, git.platform);
    for (let attempt = 1; attempt <= STEP_RETRY_ATTEMPTS; attempt += 1) {
      const result = await run(['remote', 'set-url', 'origin', url]);
      if (result.exitCode === 0) return;
    }
    throw new WrapperBootstrapError({
      code: 'WORKSPACE_SETUP_FAILED',
      message: 'Failed to restore the repository credential after a snapshot',
      retryable: true,
    });
  }

  /**
   * Bring the route's directory to a prepared workspace and report how. The
   * filesystem alone decides (spec: workspace stamp): a stamp from this allocation
   * needs nothing, one from another allocation is a restored snapshot to adopt,
   * and anything else is cloned. Setup always runs after a clone or an adopt. A
   * clone is captured as a new snapshot; an adopted snapshot only once it is old,
   * so the refresh builds on it instead of starting from scratch, until the
   * generation cap sends it back to a clone.
   */
  async function prepareWorkspace(
    spec: ControlPlaneRouteSpec,
    directory: string,
    env: Record<string, string>,
    redact: (text: string) => string,
    home: string,
    setStep: (step: ControlPlanePreparationStep) => void
  ): Promise<ControlPlaneWorkspaceOutcome> {
    const workspaceStartedAt = Date.now();
    const inspectStartedAt = Date.now();
    const { inspection, stamp: previous } = await inspectWorkspace(directory);
    log(
      `control-plane workspace inspect session=${spec.sessionId} inspection=${inspection} elapsedMs=${Date.now() - inspectStartedAt}`
    );
    if (inspection === 'same') return 'same';
    let adopted = false;
    if (inspection === 'foreign') {
      const clearStartedAt = Date.now();
      await clearStaleHomes(homeRoot, home).catch(() => undefined);
      log(
        `control-plane workspace stale homes cleared session=${spec.sessionId} elapsedMs=${Date.now() - clearStartedAt}`
      );
      // A snapshot at the generation cap that is due again is not adopted: it is
      // rebuilt from a clone, so the layers stacked on it do not accumulate.
      const rebuild = previous !== null && snapshotAction(previous, now()) === 'rebuild';
      const adoptStartedAt = Date.now();
      adopted = !rebuild && (await adoptWorkspace(spec, directory, env, redact, setStep));
      log(
        `control-plane workspace adopt done session=${spec.sessionId} adopted=${adopted} rebuild=${rebuild} elapsedMs=${Date.now() - adoptStartedAt}`
      );
      if (!adopted) await emptyDirectory(directory);
    }
    // A clone happens only when there is no repository yet; a partly prepared
    // workspace is reused, as before.
    const cloning = !adopted && Boolean(spec.git) && !(await hasGit(directory));
    if (!adopted) {
      setStep('clone');
      await withinStep('clone', timers.cloneMs, signal =>
        cloneWorkspace(spec, directory, env, redact, signal, () => setStep('checkout'))
      );
    }
    setStep('setup');
    await runSetupCommands(spec, directory, env, redact, new AbortController().signal);
    const commit = await headCommit(directory, env);
    // The stamp goes down before the snapshot, so a container restored from it
    // sees another allocation's stamp and adopts rather than trusting the files.
    const plan = planStamp({ cloning, adopted, previous, now: now() });
    await writeStamp(directory, { allocationId: deps.allocationId, commit, ...plan.lineage });
    if (plan.capture && spec.capture === true) {
      setStep('snapshot');
      await captureWorkspace(spec, directory, env, commit);
    }
    log(
      `control-plane workspace prepared session=${spec.sessionId} outcome=${adopted ? 'adopted' : 'cloned'} elapsedMs=${Date.now() - workspaceStartedAt}`
    );
    return adopted ? 'adopted' : 'cloned';
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
    // Spec §9: a setup failure must show the command output, so each command's
    // start, output and end go on the wire, not only to the wrapper log. The
    // Session renders them as per-command preparation steps.
    const emitSetupEvent = (event: ControlPlaneSetupEvent): void => {
      deps.emit({
        type: 'session.events',
        sessionId: spec.sessionId,
        events: [event],
      });
    };
    for (const [index, command] of commands.entries()) {
      signal.throwIfAborted();
      const commandNumber = index + 1;
      emitSetupEvent({
        type: CONTROL_PLANE_SETUP_EVENTS.started,
        properties: { command: commandNumber, commandCount: commands.length },
      });
      const output = createOutputRedactor(
        text => redact(cleanTerminalOutput(text)),
        text => {
          if (signal.aborted) return;
          const cleaned = text.trim();
          if (!cleaned) return;
          log(`control-plane setup command ${commandNumber} produced output`);
          emitSetupEvent({
            type: CONTROL_PLANE_SETUP_EVENTS.output,
            properties: {
              command: commandNumber,
              output: `${cleaned.slice(0, SETUP_OUTPUT_EVENT_LIMIT - 1)}\n`,
            },
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
        const message = `Setup command ${commandNumber} ${timedOut ? 'timed out' : 'failed'}`;
        emitSetupEvent({
          type: CONTROL_PLANE_SETUP_EVENTS.finished,
          properties: { command: commandNumber, exitCode: result.exitCode, safeError: message },
        });
        throw new WrapperBootstrapError({
          code: 'WORKSPACE_SETUP_FAILED',
          subtype: timedOut ? 'setup_command_timeout' : 'setup_command_failed',
          message,
          retryable: true,
        });
      }
      emitSetupEvent({
        type: CONTROL_PLANE_SETUP_EVENTS.finished,
        properties: { command: commandNumber, exitCode: 0 },
      });
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
    emitProgress(spec.sessionId, 'kilo_session', 'Loading session history');
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
    log(`control-plane prepare received session=${sessionId} directory=${directory}`);

    try {
      // Built inside the failure scope: an over-limit CLI config must surface as
      // `session.failed`, not reject the prepare promise (which the caller
      // swallows while the route waits out its timeout).
      const env = withRuntimeProfileEnvironment(
        buildWorktreeKiloEnvironment(
          directory,
          home,
          kiloAuth,
          spec.env ?? {},
          inheritedEnv,
          spec.mcp
        ),
        spec
      );
      const redact = createSecretRedactor(
        inheritedEnv,
        [
          spec.env ?? {},
          {
            ...env,
            ...(credentials?.git?.token ? { GIT_TOKEN: credentials.git.token } : {}),
          },
        ],
        spec.secretEnvKeys ?? []
      );
      const needsWorkspace = Boolean(spec.git) || (spec.setupCommands?.length ?? 0) > 0;
      // M3: clone/checkout/setup mutate a shared worktree. Serialize per
      // directory and inspect the stamp inside the lock, so a waiting session
      // sees the finished workspace and skips the work.
      let workspace: ControlPlaneWorkspaceOutcome | undefined;
      await withWorkspaceLock(directory, async () => {
        if (!needsWorkspace) return;
        workspace = await prepareWorkspace(spec, directory, env, redact, home, step => {
          currentStep = step;
        });
      });
      if (owner.released) return;
      currentStep = 'kilo_runtime';
      emitProgress(sessionId, 'kilo_runtime');
      if (spec.runtimeIsolation === 'per-session') await materializeRuntimeProfile(home, spec);
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
      emitSessionReadyNative(sessionId);
      deps.emit({ type: 'session.ready', sessionId, ...(workspace ? { workspace } : {}) });
      log(`control-plane prepare ready session=${sessionId} directory=${directory}`);
    } catch (error) {
      if (owner.released) {
        if (spec.runtimeIsolation === 'per-session') deps.runtimes.release(key);
        return;
      }
      log(
        `control-plane prepare failed session=${sessionId} step=${currentStep} error=${
          error instanceof Error ? error.message : String(error)
        }${
          error instanceof WrapperBootstrapError && error.gitFailure ? ` ${error.gitFailure}` : ''
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
    const nextEnv = withRuntimeProfileEnvironment(
      buildWorktreeKiloEnvironment(
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
      ),
      route.spec
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
              emitSessionReadyNative(spec.sessionId);
              deps.emit({ type: 'session.ready', sessionId: spec.sessionId, workspace: 'same' });
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
    preparingCount: () => preparing.size,
    sessionCount: () => prepared.size,
    installCredentials: installCredentialsFor,
  };
}
