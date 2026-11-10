import type { HistoryPageRequest } from './history-requests.js';
import { runSetupScript } from '../setup-script.js';
import {
  createRuntimeProfileMaterializer,
  RuntimeProfileMismatchError,
  withRuntimeProfileEnvironment,
} from './runtime-profile.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  CONTROL_PLANE_COMMAND_FAILURES_MAX,
  CONTROL_PLANE_PREPARATION_DETAIL_MAX_LENGTH,
  type AttachmentSpec,
  type ControlPlaneCommandFailure,
  type ControlPlanePreparationStep,
  type ControlPlaneRouteSpec,
  type ControlPlaneSessionCredentialsPayload,
  type ControlPlaneSetupCommandKind,
  type ControlPlaneWorkspaceOutcome,
  type ControlPlaneWrapperFrame,
  type WorkspaceConfig,
} from '../../../src/shared/control-plane-protocol.js';
import type { ControlPlaneTimers } from '../../../src/shared/control-plane-timers.js';
import type { ControlDiagnosticReporter } from '../../../src/shared/control-diagnostics.js';
import type { Harness } from './harness.js';
import {
  git,
  runProcess,
  withTimeoutAndAbort,
  type ExecResult,
  type ProcessOptions,
  type ProcessOutputStream,
  type ProcessSpawn,
} from '../utils.js';
import { WrapperBootstrapError, workspaceBootstrapError } from '../bootstrap-error.js';
import { formatGitResultFailure, gitOperationError, type GitRouteClass } from '../git-errors.js';
import {
  additionalHostCredentials,
  credentialFreeGitUrl,
  normalizeOriginCredential,
  writeGitCredentialRecords,
} from '../control/git-credentials.js';
import { checkoutSyntheticReviewRef, isSyntheticReviewRef } from '../git-review-ref.js';
import {
  buildWorktreeKiloEnvironment,
  type WorktreeKiloAuth,
} from '../control/worktree-runtime.js';
import { createSecretRedactor, redactSecrets } from '../redact-output.js';
import {
  KiloWorktreeCredentialClassMismatchError,
  KiloWorktreeMcpMismatchError,
} from './kilo-runtime.js';
import { configureWorkspaceGitAuthor, createGitProgressReporter } from '../session-bootstrap.js';
import type { RestoreRoots } from '../restore-roots.js';
import { reportRestoreIncomplete } from '../restore-incomplete.js';
import { restoreWorktreeRecovery } from './worktree-recovery.js';
import type { ControlWorkload } from '../control/workload-cgroup.js';
import { refreshAdoptedRepository } from './workspace-adoption.js';
import {
  classifyWorkspace,
  readWorkspaceStamp,
  writeWorkspaceStamp,
  type WorkspaceInspection,
  type WorkspaceStamp,
} from './workspace-stamp.js';
import {
  SETUP_COMMAND_HARD_TIMEOUT_MS,
  SETUP_COMMAND_INACTIVITY_TIMEOUT_MS,
  createRepositoryPreparation,
  managedGitHubPreparationGitArgs,
} from './repository-preparation.js';
import { createStepBudget, type StepBudget } from './step-budget.js';
import { defaultHomeRoots, routeHome, type HomeRoots } from './workspace-home.js';
import { workspaceConfigRuntimeKey } from '../../../src/shared/workspace-config.js';
import { restoreRootRecoveries } from './root-recovery.js';
import {
  hasEnvironmentRoots,
  prepareRoots,
  reconcileRoots,
  rootProgressDetail,
  routeRoots,
  type PrepareRoot,
  type RouteRoot,
} from './workspace-roots.js';

/** Spec §7: Kilo runtime start and Kilo session each get one retry. */
const STEP_RETRY_ATTEMPTS = 2;
/**
 * Release cleanup bounds. Aborting a released route's Kilo session tree is best
 * effort: it must terminate and never block the route release, so the walk is
 * capped by depth, node count and a shared deadline, with one retry per step.
 */
const RELEASE_CLEANUP_DEADLINE_MS = 10_000;

/**
 * A recorded base that is no longer an ancestor of `origin/<baseBranch>`.
 * A fresh create can be retried (the web router resolves a new SHA); a rebuilt
 * workspace keeps its recorded base, so retrying would loop on the same stale
 * SHA. Exported for the focused retryability test.
 */
export function stackedBaseMismatchError(
  baseBranch: string,
  stale: boolean
): WrapperBootstrapError {
  return workspaceBootstrapError(
    stale ? 'base_branch_stale' : 'base_branch_changed',
    stale
      ? `Base branch \`${baseBranch}\` no longer contains this workspace's recorded base; recreate the stacked workspace`
      : `Base branch \`${baseBranch}\` changed while the workspace was starting; try again`,
    undefined,
    !stale
  );
}

export type PrepareRuntimePort = {
  ensure(input: {
    key: string;
    directory: string;
    env: Record<string, string>;
    workload?: ControlWorkload;
  }): Promise<Harness>;
  installCredentials(
    key: string,
    env: Record<string, string>,
    cloudAgentMcp?: ControlPlaneSessionCredentialsPayload['cloudAgentMcp']
  ): Promise<void>;
  /** True when the runtime is gone or has spent its restart budget. */
  isUnavailable(key: string): boolean;
  /**
   * The runtime's client only while it is live; undefined during a restart, when
   * unavailable, or after shutdown. Never throws.
   */
  getLiveClient(key: string): Harness | undefined;
  remove(key: string): void;
  release(key: string): void;
};

export type PrepareDeps = {
  timers: ControlPlaneTimers;
  emit: (frame: ControlPlaneWrapperFrame) => void;
  /** Reads one page of a session's Cloud history over the control connection. */
  readHistoryPage?: (request: HistoryPageRequest) => Promise<unknown>;
  runtimes: PrepareRuntimePort;
  /** This wrapper's allocation; a workspace stamped by another one came from a snapshot. */
  allocationId: string;
  log?: (message: string) => void;
  onNativeDiagnostic?: ControlDiagnosticReporter;
  onPreparedRoute?: (spec: ControlPlaneRouteSpec) => void;
  runGit?: (args: string[], options?: ProcessOptions) => Promise<ExecResult>;
  runSetup?: (
    command: string,
    directory: string,
    env: Record<string, string>,
    onOutput?: (stream: ProcessOutputStream, output: string) => void,
    signal?: AbortSignal
  ) => Promise<ExecResult>;
  runSkillInstall?: typeof runProcess;
  /** Starts the default setup command, e.g. inside the setup cgroup. */
  spawnSetup?: ProcessSpawn;
  recoverWorktree?: typeof restoreWorktreeRecovery;
  configureGitAuthor?: typeof configureWorkspaceGitAuthor;
  mkdir?: (directory: string) => Promise<void>;
  hasGit?: (directory: string) => Promise<boolean>;
  readStamp?: (directory: string) => Promise<WorkspaceStamp | null>;
  writeStamp?: (directory: string, stamp: WorkspaceStamp) => Promise<void>;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  inheritedEnv?: NodeJS.ProcessEnv;
  homeRoots?: HomeRoots;
  /** Bounds release cleanup; defaults to `RELEASE_CLEANUP_DEADLINE_MS`. */
  releaseCleanupDeadlineMs?: number;
};

type PreparedRoute = {
  key: string;
  spec: ControlPlaneRouteSpec;
  directory: string;
  home: string;
  kilo: WorktreeKiloAuth;
  env: Record<string, string>;
};

type PreparingRoute = {
  promise: Promise<void>;
  released: boolean;
  skillInstallController?: AbortController;
  /** `runtimeKey(spec)` captured before the first await, for last-route release. */
  runtimeKey: string;
  /** A credentials frame that arrived before the route was prepared. */
  pendingCredentials?: ControlPlaneSessionCredentialsPayload;
};

export type PreparationManager = {
  prepare(
    spec: ControlPlaneRouteSpec,
    credentials?: ControlPlaneSessionCredentialsPayload
  ): Promise<void>;
  /**
   * The configuration the route's runtime uses: the retained one while another
   * route holds the runtime key, otherwise `offered`, which becomes retained.
   */
  workspaceConfiguration(spec: AttachmentSpec, offered: WorkspaceConfig): WorkspaceConfig;
  release(sessionId: string): void;
  isPrepared(sessionId: string): boolean;
  /**
   * The prepared route's runtime identity, or null while the route is not yet
   * attached. Live native reads use it to reach the exact runtime and directory
   * the route was prepared for (spec §10).
   */
  preparedRoute(
    sessionId: string
  ): { runtimeKey: string; directory: string; roots: RouteRoot[] } | null;
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

/** Keep existing allocations on their original runtime and HOME identities. */
export function runtimeKey(spec: ControlPlaneRouteSpec): string {
  return workspaceConfigRuntimeKey(spec);
}

function isTimeoutMessage(step: ControlPlanePreparationStep, error: unknown): boolean {
  return error instanceof Error && error.message === `${step} timed out`;
}

type InflightCleanup = {
  promise: Promise<void>;
  controller: AbortController;
};

export function createPreparationManager(deps: PrepareDeps): PreparationManager {
  const timers = deps.timers.wrapper;
  const log = deps.log ?? ((): void => undefined);
  const inheritedEnv = deps.inheritedEnv ?? process.env;
  const profileMaterializer = createRuntimeProfileMaterializer();
  const workspaceConfigurations = new Map<string, WorkspaceConfig>();
  const workspaceMcpGrants = new Map<
    string,
    NonNullable<ControlPlaneSessionCredentialsPayload['cloudAgentMcp']>
  >();

  function workspaceMcpGrant(
    key: string,
    offered: ControlPlaneSessionCredentialsPayload['cloudAgentMcp']
  ): ControlPlaneSessionCredentialsPayload['cloudAgentMcp'] {
    const retained = workspaceMcpGrants.get(key);
    if (offered && (!retained || offered.expiresAt >= retained.expiresAt)) return offered;
    return retained;
  }

  function commitWorkspaceMcpGrant(
    key: string,
    grant: ControlPlaneSessionCredentialsPayload['cloudAgentMcp']
  ): void {
    if (!grant) return;
    const retained = workspaceMcpGrants.get(key);
    if (!retained || grant.expiresAt >= retained.expiresAt) workspaceMcpGrants.set(key, grant);
  }

  function newestMcpGrant(
    first: ControlPlaneSessionCredentialsPayload['cloudAgentMcp'],
    second: ControlPlaneSessionCredentialsPayload['cloudAgentMcp']
  ): ControlPlaneSessionCredentialsPayload['cloudAgentMcp'] {
    if (!first) return second;
    if (!second) return first;
    return second.expiresAt >= first.expiresAt ? second : first;
  }

  const runGit = deps.runGit ?? ((args, options) => git(args, options));
  const runSetup =
    deps.runSetup ??
    ((command, directory, env, onOutput, signal) =>
      runSetupScript(command, {
        cwd: directory,
        env,
        inheritEnv: false,
        ...(deps.spawnSetup ? { spawn: deps.spawnSetup } : {}),
        ...(signal ? { signal } : {}),
        inactivityTimeoutMs: SETUP_COMMAND_INACTIVITY_TIMEOUT_MS,
        hardTimeoutMs: SETUP_COMMAND_HARD_TIMEOUT_MS,
        ...(onOutput ? { onOutput } : {}),
      }));
  const configureGitAuthor = deps.configureGitAuthor ?? configureWorkspaceGitAuthor;
  const sleep = deps.sleep ?? defaultSleep;
  const homeRoots = deps.homeRoots ?? defaultHomeRoots();
  const prepared = new Map<string, PreparedRoute>();
  const preparing = new Map<string, PreparingRoute>();
  const releaseCleanups = new Map<string, InflightCleanup>();
  const releaseCleanupDeadlineMs = deps.releaseCleanupDeadlineMs ?? RELEASE_CLEANUP_DEADLINE_MS;
  // Spec §7: clone/checkout/setup mutate one shared worktree, so they must not
  // run concurrently for two sessions on the same directory. The lock is keyed
  // by directory, mirroring legacy `serializeWorkspacePreparation`.
  const workspacePreparations = new Map<string, Promise<void>>();

  const hasGit = deps.hasGit ?? defaultHasGit;
  const readStamp = deps.readStamp ?? readWorkspaceStamp;
  const writeStamp =
    deps.writeStamp ??
    (async (directory: string, stamp: WorkspaceStamp) =>
      writeWorkspaceStamp(directory, await hasGit(directory), stamp));
  const mkdir = deps.mkdir ?? (dir => fs.mkdir(dir, { recursive: true }).then(() => undefined));
  const repository = createRepositoryPreparation({ runGit, runSetup, sleep, mkdir, hasGit, log });
  const { runNetworkGit, headCommit } = repository;

  function emitProgress(
    sessionId: string,
    step: ControlPlanePreparationStep,
    detail?: string
  ): void {
    deps.emit({
      type: 'session.progress',
      sessionId,
      step,
      ...(detail === undefined
        ? {}
        : {
            detail:
              detail.length > CONTROL_PLANE_PREPARATION_DETAIL_MAX_LENGTH
                ? `${detail.slice(0, CONTROL_PLANE_PREPARATION_DETAIL_MAX_LENGTH - 1)}…`
                : detail,
          }),
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
      reason:
        error instanceof RuntimeProfileMismatchError
          ? 'invalid_configuration'
          : 'workspace_setup_failed',
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

  async function cloneWorkspace(
    root: PrepareRoot,
    env: Record<string, string>,
    redact: (text: string) => string,
    signal: AbortSignal,
    onCheckout: () => void
  ): Promise<void> {
    const { spec, directory } = root;
    await repository.cloneRepository({
      git: spec.git,
      sessionId: spec.sessionId,
      createdOnPlatform: spec.createdOnPlatform,
      branch: spec.branch,
      branchMode: spec.branchMode,
      directory,
      env,
      redact,
      signal,
      onProgress: detail =>
        emitProgress(
          spec.sessionId,
          'clone',
          rootProgressDetail(root, detail, 'Cloning repository')
        ),
    });
    if (!spec.git) return;
    onCheckout();
    await checkoutWorkspace(root, env, redact, signal, false);
  }

  /**
   * Spec §7 "Checkout, branch restore" (legacy apply-attach branch logic), then the
   * git author. Shared by a fresh clone and an adopted snapshot.
   */
  async function checkoutWorkspace(
    root: PrepareRoot,
    env: Record<string, string>,
    redact: (text: string) => string,
    signal: AbortSignal,
    restoring: boolean,
    startRef?: string
  ): Promise<void> {
    const { spec, directory } = root;
    emitProgress(
      spec.sessionId,
      'checkout',
      rootProgressDetail(root, undefined, 'Checking out branch')
    );
    const gitRoute: GitRouteClass = spec.git?.token ? 'managed' : 'direct';
    const runBranchGit = (args: string[], options?: ProcessOptions): Promise<ExecResult> =>
      runGit([...managedGitHubPreparationGitArgs(spec, args[0]), ...args], {
        ...options,
        cwd: directory,
        env,
        inheritEnv: false,
        signal,
      });
    // Spec §7 "Checkout, branch restore" (legacy apply-attach branch logic):
    // `-B <branch> origin/<branch>` breaks a working branch or a `session/*`
    // branch that has no upstream, so resolve the refs first.
    const branch = spec.branch ?? `session/${spec.kilo?.scopeId ?? spec.sessionId}`;
    if (isSyntheticReviewRef(branch) && spec.branchMode !== 'working') {
      await checkoutSyntheticReviewRef({
        runGit: (args, options) => {
          const gitConfigArgs = managedGitHubPreparationGitArgs(spec, args[0]);
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
      /**
       * Creates a stacked working branch from exactly the recorded base SHA.
       * `--no-track` is required: without it the new branch tracks
       * `origin/<baseBranch>` and the first auto-commit would push to the parent.
       */
      const stackedCheckoutTarget = async (): Promise<string> => {
        const baseBranch = spec.baseBranch as string;
        emitProgress(
          spec.sessionId,
          'checkout',
          rootProgressDetail(root, `Fetching base branch ${baseBranch}...`, 'Checking out branch')
        );
        const fetched = await runNetworkGit(
          [
            ...managedGitHubPreparationGitArgs(spec, 'fetch'),
            'fetch',
            '--no-tags',
            'origin',
            baseBranch,
          ],
          { cwd: directory, env, inheritEnv: false, signal },
          redact,
          signal
        );
        signal.throwIfAborted();
        if (fetched.exitCode !== 0) {
          const missing =
            /couldn't find remote ref|remote ref does not exist|could not find remote ref/i.test(
              `${fetched.stderr}\n${fetched.stdout}`
            );
          if (missing) {
            throw workspaceBootstrapError(
              'base_branch_missing',
              `Base branch \`${baseBranch}\` has not been pushed`,
              formatGitResultFailure(fetched, 'git fetch failed', redact),
              false
            );
          }
          throw gitOperationError(fetched, 'checkout', redact, gitRoute);
        }
        const baseRef = `refs/remotes/origin/${baseBranch}`;
        const exists = await runBranchGit(['show-ref', '--verify', '--quiet', baseRef]);
        signal.throwIfAborted();
        if (exists.exitCode !== 0) {
          if (exists.exitCode !== 1) {
            throw gitOperationError(exists, 'checkout', redact, gitRoute);
          }
          throw workspaceBootstrapError(
            'base_branch_missing',
            `Base branch \`${baseBranch}\` has not been pushed`,
            undefined,
            false
          );
        }
        if (spec.baseSha === undefined) return baseRef;
        const ancestor = await runBranchGit(['merge-base', '--is-ancestor', spec.baseSha, baseRef]);
        signal.throwIfAborted();
        if (ancestor.exitCode === 0) return spec.baseSha;
        if (ancestor.exitCode === 1) {
          // A rebuilt workspace keeps its recorded base; a retry cannot
          // re-resolve it, so a rewritten base is a terminal stale-base error.
          throw stackedBaseMismatchError(
            baseBranch,
            restoring || spec.worktreeRecovery !== undefined
          );
        }
        throw gitOperationError(ancestor, 'checkout', redact, gitRoute);
      };
      if (startRef) {
        // An adopted snapshot whose working branch was never pushed starts from
        // the remote default; a stacked workspace starts from its recorded base.
        const startsFromDefault = startRef === 'refs/remotes/origin/HEAD';
        checkoutArgs = [
          'checkout',
          ...(startsFromDefault ? ['--no-track'] : []),
          '-B',
          branch,
          startsFromDefault && spec.baseBranch !== undefined
            ? await stackedCheckoutTarget()
            : startRef,
        ];
      } else if (!spec.branch || spec.branchMode === 'working') {
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
          if (remoteBranch.exitCode === 0) {
            checkoutArgs = ['checkout', '-b', branch, '--track', `origin/${branch}`];
          } else if (spec.baseBranch !== undefined) {
            checkoutArgs = ['checkout', '-b', branch, '--no-track', await stackedCheckoutTarget()];
          } else {
            checkoutArgs = ['checkout', '-b', branch];
          }
        }
      }
      const checked = await runBranchGit(['checkout', '--progress', ...checkoutArgs.slice(1)], {
        onOutput: createGitProgressReporter(progressText =>
          emitProgress(
            spec.sessionId,
            'checkout',
            rootProgressDetail(
              root,
              `Checking out branch... ${progressText}`,
              'Checking out branch'
            )
          )
        ),
      });
      signal.throwIfAborted();
      if (checked.exitCode !== 0) throw gitOperationError(checked, 'checkout', redact, gitRoute);
    }
    // Seed the durable last-known own-branch ref so a later branch operation can
    // verify its force-push lease without assuming the remote matches HEAD.
    if (spec.git && !isSyntheticReviewRef(branch)) {
      const remoteRef = `refs/remotes/origin/${branch}`;
      const resolved = await runBranchGit([
        'rev-parse',
        '--verify',
        '--quiet',
        `${remoteRef}^{commit}`,
      ]);
      if (
        resolved.exitCode === 0 &&
        /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(resolved.stdout.trim())
      ) {
        const ancestor = await runBranchGit(['merge-base', '--is-ancestor', remoteRef, 'HEAD']);
        if (ancestor.exitCode === 0) {
          await runBranchGit([
            'update-ref',
            `refs/kilo/last-known-remote/${branch}`,
            resolved.stdout.trim(),
          ]);
        }
      }
    }
    await configureGitAuthor(
      directory,
      (args, options) => runGit(args, { ...options, cwd: directory, env, inheritEnv: false }),
      spec.git?.author,
      signal
    );
  }

  /**
   * Reconcile one root restored from a repository snapshot with this route:
   * refresh the repository, then the ordinary branch logic. A failure propagates
   * and fails the preparation; it never silently clears or clones over the snapshot.
   */
  async function adoptWorkspace(
    root: PrepareRoot,
    env: Record<string, string>,
    redact: (text: string) => string,
    setStep: (step: ControlPlanePreparationStep) => void,
    restoreBudget: StepBudget
  ): Promise<void> {
    const { spec, directory } = root;
    const git = spec.git;
    setStep('restore');
    if (!git) {
      throw workspaceBootstrapError(
        'workspace_setup_unknown',
        'A snapshot workspace requires a repository',
        undefined,
        false
      );
    }
    await restoreBudget.spend(remainingMs =>
      withinStep('restore', remainingMs, async signal => {
        emitProgress(
          spec.sessionId,
          'restore',
          rootProgressDetail(root, undefined, 'Updating repository')
        );
        const startRef = await refreshAdoptedRepository({
          remoteUrl: credentialFreeGitUrl(git.url),
          route: git.token ? 'managed' : 'direct',
          redact,
          branch: spec.branch,
          branchMode: spec.branchMode,
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
        signal.throwIfAborted();
        setStep('checkout');
        await checkoutWorkspace(root, env, redact, signal, true, startRef);
      })
    );
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

  /**
   * Bring the route's roots to a prepared workspace and report how. The
   * filesystem alone decides (spec: workspace stamp): a workspace whose every
   * root has a stamp from this allocation needs nothing, a root with one from
   * another allocation is a restored environment snapshot to adopt, and anything
   * else is cloned. An adopt failure fails the preparation; it never clears the
   * root to clone over the snapshot. Environment build commands run only in an
   * environment build, so every start skips them. Session setup and start
   * commands run once, at the route directory, after every root is in place;
   * their failures are reported non-fatally. A workspace tail snapshot restore
   * runs no commands at all. Repository stamps stay per root. Registered
   * workspace identity is stamped after runtime preparation succeeds.
   */
  async function prepareWorkspace(
    spec: ControlPlaneRouteSpec,
    roots: readonly PrepareRoot[],
    home: string,
    additionalGit: ReturnType<typeof additionalHostCredentials>,
    env: Record<string, string>,
    redact: (text: string) => string,
    setStep: (step: ControlPlanePreparationStep) => void,
    onReplacementWorkspace?: () => Promise<boolean>
  ): Promise<{
    outcome: ControlPlaneWorkspaceOutcome;
    deferredStamps: Array<{ directory: string; commit: string; workspacePrepared?: false }> | null;
    /** Non-fatal session setup/start failures, reported on `session.ready`. */
    commandFailures: ControlPlaneCommandFailure[];
  }> {
    const workspaceStartedAt = Date.now();
    let sessionInspection: WorkspaceInspection | undefined;
    let sessionStamp: WorkspaceStamp | null = null;
    if (spec.workspaceSnapshot !== undefined) {
      setStep('restore');
      const inspected = await inspectWorkspace(spec.directory);
      sessionInspection = inspected.inspection;
      sessionStamp = inspected.stamp;
      const sourceAllocationId = spec.workspaceSnapshot.sourceAllocationId;
      if (
        sessionStamp === null ||
        sessionStamp.workspaceId !== spec.workspaceSnapshot.workspaceId ||
        sessionStamp.directory !== spec.directory ||
        spec.workspaceSnapshot.directory !== spec.directory ||
        spec.kilo?.scopeId !== spec.workspaceSnapshot.workspaceId ||
        (sessionStamp.allocationId !== sourceAllocationId &&
          sessionStamp.allocationId !== deps.allocationId) ||
        (
          await Promise.all(
            roots.filter(root => root.spec.git !== undefined).map(root => hasGit(root.directory))
          )
        ).some(present => !present) ||
        !(await fs.stat(spec.directory).then(
          stat => stat.isDirectory(),
          () => false
        ))
      ) {
        throw new WrapperBootstrapError({
          code: 'WORKSPACE_SETUP_FAILED',
          message: 'Workspace snapshot provenance does not match the prepared workspace',
          retryable: false,
        });
      }
    }
    // Git authenticates through the pinned helper's per-session record, never
    // through `origin`. A reused workspace is refreshed here too, so a renewed
    // grant reaches the next `git push` without touching the remote.
    if (spec.git) {
      try {
        await writeGitCredentialRecords({
          home,
          credentials: [
            {
              url: credentialFreeGitUrl(spec.git.url),
              token: spec.git.token,
              platform: spec.git.platform,
            },
            ...additionalGit,
          ],
        });
      } catch {
        setStep('clone');
        throw new WrapperBootstrapError({
          code: 'WORKSPACE_SETUP_FAILED',
          message: 'Git credential setup failed',
          retryable: true,
        });
      }
    }
    // A workspace tail restores every root without checkout or environment adoption.
    // The workspace stamp binds the route directory; repository stamps remain per root.
    if (spec.workspaceSnapshot !== undefined) {
      log(
        `control-plane workspace inspect session=${spec.sessionId} inspection=${sessionInspection} elapsedMs=${Date.now() - workspaceStartedAt}`
      );
      if (sessionInspection === 'same' || sessionStamp?.allocationId === deps.allocationId)
        return { outcome: 'same', deferredStamps: null, commandFailures: [] };
      emitProgress(spec.sessionId, 'restore', 'Using workspace snapshot');
      await withinStep('restore', timers.restoreMs, async signal => {
        for (const root of roots) {
          if (!root.spec.git) continue;
          await configureGitAuthor(
            root.directory,
            (args, options) =>
              runGit(args, { ...options, cwd: root.directory, env, inheritEnv: false }),
            root.spec.git.author,
            signal
          );
        }
      });
      // A workspace snapshot restores files and no processes. Nothing setup or
      // start produced is running, and the agent can start what it needs, so no
      // command runs on this path.
      return {
        outcome: 'adopted',
        deferredStamps: [
          {
            directory: spec.directory,
            commit: await headCommit(spec.directory, env),
            ...(sessionStamp?.workspacePrepared === false ? { workspacePrepared: false } : {}),
          },
        ],
        commandFailures: [],
      };
    }
    const inspectStartedAt = Date.now();
    // One budget for all roots: the route attempt has one deadline, so a slow
    // second repository must not wait past it for its own full allowance.
    const restoreBudget = createStepBudget(timers.restoreMs);
    const cloneBudget = createStepBudget(timers.cloneMs);
    const reconciled = await reconcileRoots(roots, {
      inspect: async root => {
        const { inspection } = await inspectWorkspace(root.directory);
        return inspection;
      },
      adopt: root => adoptWorkspace(root, env, redact, setStep, restoreBudget),
      hasGit,
      clone: root => {
        setStep('clone');
        return cloneBudget.spend(remainingMs =>
          withinStep('clone', remainingMs, signal =>
            cloneWorkspace(root, env, redact, signal, () => setStep('checkout'))
          )
        );
      },
      log,
    });
    log(
      `control-plane workspace inspect session=${spec.sessionId} inspection=${reconciled.inspections.join(',')} elapsedMs=${Date.now() - inspectStartedAt}`
    );
    if (reconciled.kind === 'same')
      return { outcome: 'same', deferredStamps: null, commandFailures: [] };
    const { adopted, cloning } = reconciled;
    setStep('setup');
    const fromEnvironmentSnapshot = reconciled.inspections.every(
      inspection => inspection === 'foreign'
    );
    // The leading commands belong to the environment's build and run only there.
    // This applies to a fresh start too, not only an adopted snapshot.
    const skippedSetupCommands = spec.environmentSetupCommandCount ?? 0;
    const setupCommands = (spec.setupCommands ?? []).slice(skippedSetupCommands);
    const startCommands = spec.startCommands ?? [];
    log(
      `control-plane workspace setup session=${spec.sessionId} fromEnvironmentSnapshot=${fromEnvironmentSnapshot} environmentBuildCommands=${skippedSetupCommands} sessionSetupCommands=${setupCommands.length} startCommands=${startCommands.length}`
    );
    if (skippedSetupCommands > 0) {
      emitProgress(
        spec.sessionId,
        'setup',
        fromEnvironmentSnapshot
          ? 'Setup already ran in the environment snapshot'
          : 'Environment build commands run in the environment build'
      );
    }
    const commandFailures: ControlPlaneCommandFailure[] = [];
    await runPreparationCommands(
      spec,
      setupCommands,
      'session_setup',
      env,
      redact,
      commandFailures
    );
    await runPreparationCommands(spec, startCommands, 'start', env, redact, commandFailures);
    // The callback reports whether the recovery steps actually applied. A clone
    // with no `.git` yet, or a surviving workspace, never runs it.
    const recoveryApplied =
      cloning || adopted ? ((await onReplacementWorkspace?.()) ?? false) : false;
    const stamps: Array<{ directory: string; commit: string }> = [];
    for (const root of roots) {
      stamps.push({ directory: root.directory, commit: await headCommit(root.directory, env) });
    }
    // Recovery requested but not applied: defer the current-allocation stamp until
    // after the deferred import, so a crash in between cannot leave a stamp that
    // makes the next preparation look like a surviving workspace.
    if (spec.worktreeRecovery !== undefined && !recoveryApplied) {
      log(
        `control-plane workspace stamp deferred session=${spec.sessionId} elapsedMs=${Date.now() - workspaceStartedAt}`
      );
      return {
        outcome: adopted ? 'adopted' : 'cloned',
        deferredStamps: stamps,
        commandFailures: commandFailures.slice(0, CONTROL_PLANE_COMMAND_FAILURES_MAX),
      };
    }
    for (const stamp of stamps) {
      await writeStamp(stamp.directory, { allocationId: deps.allocationId, commit: stamp.commit });
    }
    log(
      `control-plane workspace prepared session=${spec.sessionId} outcome=${adopted ? 'adopted' : 'cloned'} elapsedMs=${Date.now() - workspaceStartedAt}`
    );
    return {
      outcome: adopted ? 'adopted' : 'cloned',
      deferredStamps: null,
      commandFailures: commandFailures.slice(0, CONTROL_PLANE_COMMAND_FAILURES_MAX),
    };
  }

  /**
   * Run one command list at the route directory. Session setup and start
   * commands are non-fatal: failures are collected for `session.ready` and the
   * next command still runs.
   */
  async function runPreparationCommands(
    spec: ControlPlaneRouteSpec,
    commands: readonly string[],
    kind: ControlPlaneSetupCommandKind,
    env: Record<string, string>,
    redact: (text: string) => string,
    failures: ControlPlaneCommandFailure[]
  ): Promise<void> {
    if (commands.length === 0) return;
    // The setup events create the kind-specific preparation phase; a generic
    // `setup` progress line would leave an empty phase before them.
    // The Session renders the setup events as per-command preparation steps.
    const reported = await repository.runSetupCommands({
      commands: [...commands],
      kind,
      directory: spec.directory,
      env,
      redact,
      signal: new AbortController().signal,
      continueOnFailure: true,
      onEvent: event =>
        deps.emit({ type: 'session.events', sessionId: spec.sessionId, events: [event] }),
      logContext: `sessionId=${spec.sessionId} kiloSessionId=${spec.kiloSessionId} attemptId=${spec.attemptId} kind=${kind}`,
    });
    failures.push(...reported);
  }

  async function resolveKiloSession(
    spec: ControlPlaneRouteSpec,
    directory: string,
    env: Record<string, string>,
    client: Harness,
    signal: AbortSignal,
    restoreFiles: boolean,
    restoreRoots: RestoreRoots | undefined
  ): Promise<void> {
    const readHistoryPage = deps.readHistoryPage;
    await client.open({
      sessionId: spec.kiloSessionId,
      ...(readHistoryPage
        ? {
            readHistoryPage: (cursor: string | undefined) =>
              readHistoryPage({
                sessionId: spec.sessionId,
                kiloSessionId: spec.kiloSessionId,
                cursor,
                signal,
              }),
          }
        : {}),
      directory,
      env,
      signal,
      restoreFiles,
      ...(restoreRoots === undefined ? {} : { roots: restoreRoots }),
      onRestore: () => emitProgress(spec.sessionId, 'kilo_session', 'Loading session history'),
    });
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
        // An MCP or credential-class drift against the shared runtime is permanent for this key;
        // retrying would drop the existing runtime and accept the changed configuration.
        if (
          !isCurrent() ||
          error instanceof KiloWorktreeMcpMismatchError ||
          error instanceof KiloWorktreeCredentialClassMismatchError
        ) {
          throw error;
        }
        lastError = error;
        // M1: a hung spawn leaves `ensure` returning the same pending promise,
        // so drop the runtime before the retry starts a fresh one.
        deps.runtimes.remove(key);
      }
    }
    throw lastError;
  }

  /**
   * Whether any route other than `excludeSessionId` still holds `key`. Counts
   * prepared routes and in-flight prepares that are not themselves released, so
   * a route releasing while a sibling prepare is still running is not the last.
   */
  function hasRoutesForKey(key: string, excludeSessionId: string): boolean {
    for (const [sessionId, route] of prepared) {
      if (sessionId !== excludeSessionId && route.key === key) return true;
    }
    for (const [sessionId, record] of preparing) {
      if (sessionId === excludeSessionId || record.released) continue;
      if (record.runtimeKey === key) return true;
    }
    return false;
  }

  /**
   * Whether `prepare` for `sessionId` reuses its current runtime and ignores a
   * newly offered configuration: an unreleased in-flight prepare, or a prepared
   * route whose runtime is still available.
   */
  function callerKeepsRuntime(sessionId: string, key: string): boolean {
    const record = preparing.get(sessionId);
    if (record && !record.released && record.runtimeKey === key) return true;
    const route = prepared.get(sessionId);
    return route?.key === key && !deps.runtimes.isUnavailable(key);
  }

  /**
   * Finish a route that left `prepared`, or never reached it. When it was the
   * last holder of its runtime key the process is released: the runtime's owned
   * process scope reaps the background processes it started, so walking a dying
   * client would only emit false unreaped-process diagnostics. When a sibling
   * still holds the key, the route's Kilo session tree is aborted instead.
   */
  function finishReleasedRoute(input: {
    key: string;
    sessionId: string;
    spec: ControlPlaneRouteSpec;
  }): void {
    if (!hasRoutesForKey(input.key, input.sessionId)) {
      deps.runtimes.release(input.key);
      profileMaterializer.release(routeHome(input.spec, homeRoots));
      workspaceConfigurations.delete(input.key);
      workspaceMcpGrants.delete(input.key);
      return;
    }
    // Resolve the CURRENT live client: a restart replaces the runtime on a new
    // port, and reading `.client` during a restart throws. When no client is
    // live the old process is gone, so its sessions are dead and cleanup is a
    // no-op rather than an error.
    const client = deps.runtimes.getLiveClient(input.key);
    if (!client) return;
    const entry: InflightCleanup = {
      controller: new AbortController(),
      promise: Promise.resolve(),
    };
    entry.promise = client
      .release({
        directory: input.spec.directory,
        sessionId: input.spec.kiloSessionId,
        deadlineMs: releaseCleanupDeadlineMs,
        signal: entry.controller.signal,
      })
      .then(result => {
        if (!result.ok) {
          log(
            `control-plane release cleanup incomplete session=${input.sessionId} sessions=${result.sessions} failures=${result.failures}`
          );
        }
        // Closed native record: counts only, never a handle or session body.
        deps.onNativeDiagnostic?.('session.task', {
          phase: result.ok ? 'finished' : 'failed',
          stage: 'process_cleanup',
          ok: result.ok,
          sessionCount: result.sessions,
          failureCount: result.failures,
          elapsedMs: result.elapsedMs,
          sessionId: input.sessionId,
        });
      })
      .catch(() => undefined);
    releaseCleanups.set(input.sessionId, entry);
    void entry.promise.finally(() => {
      if (releaseCleanups.get(input.sessionId) === entry) releaseCleanups.delete(input.sessionId);
    });
  }

  /**
   * Stop any release cleanup still walking `sessionId` before a re-prepare
   * resolves the same Kilo session. Bounded by the cleanup's own deadline.
   */
  async function settleReleaseCleanup(sessionId: string): Promise<void> {
    const entry = releaseCleanups.get(sessionId);
    if (!entry) return;
    entry.controller.abort();
    await entry.promise;
  }

  /**
   * The single finalizer for a preparing record: run it exactly when this owner
   * is the active record leaving `preparing` and its session never made it into
   * `prepared`.
   */
  function finalizePreparingOwner(owner: PreparingRoute, spec: ControlPlaneRouteSpec): void {
    if (preparing.get(spec.sessionId) !== owner) return;
    preparing.delete(spec.sessionId);
    if (prepared.has(spec.sessionId)) return;
    finishReleasedRoute({
      key: owner.runtimeKey,
      sessionId: spec.sessionId,
      spec,
    });
  }

  async function runPrepare(
    spec: ControlPlaneRouteSpec,
    credentials: ControlPlaneSessionCredentialsPayload | undefined,
    owner: PreparingRoute
  ): Promise<void> {
    const sessionId = spec.sessionId;
    let currentStep: ControlPlanePreparationStep = 'kilo_runtime';
    const kiloConfig = spec.kilo;
    // Spec §6: behind the runtime credential proxy the wrapper talks to the
    // Worker facade with the scope's runtime-proxy handle; otherwise it uses the
    // spec's alias and targets.
    const kiloToken = credentials?.proxy?.handle ?? credentials?.kilo.token ?? kiloConfig?.token;
    if (!kiloConfig || !kiloToken) {
      log(`control-plane prepare is missing the Kilo context session=${sessionId}`);
      emitFailure(sessionId, 'kilo_runtime', undefined);
      return;
    }
    const key = runtimeKey(spec);
    // The route directory is the Kilo cwd. The git roots are where repositories
    // are cloned; they are the directory itself only for a route with one root.
    const directory = spec.directory;
    const roots = prepareRoots(spec, credentials);
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
    const home = routeHome(spec, homeRoots);
    log(`control-plane prepare received session=${sessionId} directory=${directory}`);

    try {
      // Built inside the failure scope: an over-limit CLI config must surface as
      // `session.failed`, not reject the prepare promise (which the caller
      // swallows while the route waits out its timeout).
      const previousMcpGrant = workspaceMcpGrants.get(key);
      const cloudAgentMcp = workspaceMcpGrant(key, credentials?.cloudAgentMcp);
      const builtEnv = withRuntimeProfileEnvironment(
        buildWorktreeKiloEnvironment(
          directory,
          home,
          kiloAuth,
          spec.env ?? {},
          inheritedEnv,
          spec.mcp,
          { ...spec, ...(cloudAgentMcp === undefined ? {} : { cloudAgentMcp }) }
        ),
        spec
      );
      const redact = createSecretRedactor(
        inheritedEnv,
        [
          spec.env ?? {},
          {
            ...builtEnv,
            ...(credentials?.git?.token ? { GIT_TOKEN: credentials.git.token } : {}),
            ...(cloudAgentMcp ? { CLOUD_AGENT_MCP_TOKEN: cloudAgentMcp.token } : {}),
          },
        ],
        spec.secretEnvKeys ?? []
      );
      const needsWorkspace =
        spec.workspaceSnapshot !== undefined ||
        Boolean(spec.git) ||
        (spec.setupCommands?.length ?? 0) > 0 ||
        (spec.startCommands?.length ?? 0) > 0;
      // M3: clone/checkout/setup mutate a shared worktree. Serialize per
      // directory and inspect the stamp inside the lock, so a waiting session
      // sees the finished workspace and skips the work.
      let workspace: ControlPlaneWorkspaceOutcome | undefined;
      let workspaceCommandFailures: ControlPlaneCommandFailure[] = [];
      let replacementWorkspace = false;
      let localRecoveryApplied = false;
      let deferredRuntimeStarted = false;
      let runtimeWasReused = false;
      const recovery = spec.worktreeRecovery;
      // The roots whose saved changes are back. A root whose changes were not
      // restored keeps ingest restoration; one that was must not get older diffs.
      const recoveredRoots = new Set<string>();
      // Older ingest restoration must not overwrite newer local recovery. That is
      // proven for a replacement workspace whose recovery applied, and for a
      // surviving workspace this allocation already stamped (a wrapper restart
      // after the stamp but before import). An unstamped repository is a partial
      // preparation, not proof of recovery, so it keeps ingest restoration.
      // A continued session clones the source transcript but must not let
      // historical ingest files overwrite the pushed branch, which is the source
      // of truth. `spec.continuation` is the server-only marker for that case;
      // transcript import still runs for the message history.
      const restoreFilesFor = (): boolean =>
        spec.workspaceSnapshot === undefined &&
        spec.continuation !== true &&
        !(replacementWorkspace && localRecoveryApplied) &&
        !(recovery !== undefined && workspace === 'same');
      // One owner for runtime profile, runtime start and session resolution, shared
      // by the normal path after the lock and the deferred path inside it.
      const ensureRuntimeAndSession = async (restoreFiles: boolean): Promise<void> => {
        const installsSkills = spec.runtimeSkills?.some(skill => skill.source !== undefined);
        currentStep = installsSkills ? 'setup' : 'kilo_runtime';
        owner.skillInstallController = new AbortController();
        await profileMaterializer.materialize(home, spec, {
          run: (command, args, options) =>
            (deps.runSkillInstall ?? runProcess)(command, args, {
              ...options,
              spawn: deps.spawnSetup,
            }),
          signal: owner.skillInstallController.signal,
          onProgress: detail => {
            if (!owner.released) emitProgress(sessionId, 'setup', detail);
          },
        });
        if (owner.released) return;
        currentStep = 'kilo_runtime';
        emitProgress(sessionId, 'kilo_runtime');
        runtimeWasReused = !deps.runtimes.isUnavailable(key);
        const client = await withRuntimeStartRetry(
          key,
          () =>
            withinStep('kilo_runtime', timers.kiloRuntimeStartMs, () =>
              deps.runtimes.ensure({ key, directory, env: builtEnv })
            ),
          () => !owner.released
        );
        if (!runtimeWasReused) commitWorkspaceMcpGrant(key, cloudAgentMcp);
        if (owner.released) return;
        currentStep = 'kilo_session';
        emitProgress(sessionId, 'kilo_session');
        await settleReleaseCleanup(sessionId);
        await withOneRetry(
          () =>
            withinStep('kilo_session', timers.kiloSessionMs, signal =>
              resolveKiloSession(
                spec,
                directory,
                builtEnv,
                client,
                signal,
                restoreFiles,
                // A V2 route sends each restored diff to the root that contains it.
                hasEnvironmentRoots(roots)
                  ? {
                      directories: roots.map(root => root.directory),
                      recovered: [...recoveredRoots],
                    }
                  : undefined
              )
            ),
          () => !owner.released
        );
      };
      await withWorkspaceLock(directory, async () => {
        if (!needsWorkspace) {
          await mkdir(directory);
          return;
        }
        const preparedWorkspace = await prepareWorkspace(
          spec,
          roots,
          home,
          additionalHostCredentials(credentials?.gitCredentials),
          builtEnv,
          redact,
          step => {
            currentStep = step;
          },
          async () => {
            replacementWorkspace = true;
            if (!recovery || owner.released) return false;
            currentStep = 'restore';
            try {
              emitProgress(sessionId, 'restore', 'Restoring saved worktree changes');
              const diffs = await restoreRootRecoveries({
                cwd: directory,
                roots: routeRoots(spec),
                recovery,
                env: builtEnv,
                signal: AbortSignal.timeout(30_000),
                restore: deps.recoverWorktree ?? restoreWorktreeRecovery,
                onRoot: (rootDirectory, recovered) => {
                  if (recovered) recoveredRoots.add(rootDirectory);
                },
              });
              log(
                `local worktree recovery session=${sessionId} applied=${diffs.applied} skipped=${diffs.skipped} total=${diffs.total}`
              );
              localRecoveryApplied = recoveredRoots.size === roots.length;
              const incomplete = await reportRestoreIncomplete({
                diffs,
                identity: `kiloSessionId=${spec.kiloSessionId}`,
                log,
              });
              if (incomplete) emitProgress(sessionId, 'restore', incomplete.message);
              return localRecoveryApplied;
            } catch {
              log(`local worktree recovery session=${sessionId} failed; continuing`);
              emitProgress(
                sessionId,
                'restore',
                'Saved worktree changes could not be restored; continuing'
              );
              return false;
            }
          }
        );
        workspace = preparedWorkspace.outcome;
        workspaceCommandFailures = preparedWorkspace.commandFailures;
        if (spec.git) {
          for (const root of roots) {
            const origin = await normalizeOriginCredential({
              git: args => runGit(args, { cwd: root.directory, env: builtEnv, inheritEnv: false }),
              directory: root.directory,
            });
            if (origin === 'failed') {
              log(`control-plane Git origin normalization failed session=${sessionId}`);
            }
          }
        }
        if (preparedWorkspace.deferredStamps === null || owner.released) return;
        // Recovery import completes under the workspace lock before stamping.
        deferredRuntimeStarted = true;
        await ensureRuntimeAndSession(restoreFilesFor());
        if (!owner.released) {
          for (const stamp of preparedWorkspace.deferredStamps) {
            await writeStamp(stamp.directory, {
              allocationId: deps.allocationId,
              commit: stamp.commit,
              ...(stamp.workspacePrepared === false ? { workspacePrepared: false } : {}),
            });
          }
        }
      });
      if (owner.released) {
        return;
      }
      if (recovery && !replacementWorkspace) {
        log(`local worktree recovery session=${sessionId} skipped reason=surviving_workspace`);
      }
      if (!deferredRuntimeStarted) {
        await ensureRuntimeAndSession(restoreFilesFor());
      }
      if (owner.released) return;
      if (!needsWorkspace) {
        await withWorkspaceLock(directory, async () => {
          if (await readStamp(directory)) return;
          await writeStamp(directory, {
            allocationId: deps.allocationId,
            ...(spec.kilo?.scopeId.startsWith('worktree_')
              ? { workspaceId: spec.kilo.scopeId, directory }
              : {}),
            commit: '',
            workspacePrepared: false,
          });
        });
      }
      if (spec.kilo?.scopeId.startsWith('worktree_')) {
        await withWorkspaceLock(directory, async () => {
          const stamp = await readStamp(directory);
          await writeStamp(directory, {
            allocationId: deps.allocationId,
            commit: await headCommit(directory, builtEnv),
            workspaceId: spec.kilo?.scopeId,
            directory,
            ...(stamp?.workspacePrepared === false ? { workspacePrepared: false } : {}),
          });
        });
      }
      if (owner.released) return;
      prepared.set(sessionId, {
        key,
        spec,
        directory,
        home,
        kilo: kiloAuth,
        env: builtEnv,
      });
      // A credentials frame that arrived while this route was preparing is
      // applied before the route reports ready; a release during the apply
      // suppresses ready and leaves the already-released route torn down.
      const pending = owner.pendingCredentials;
      owner.pendingCredentials = undefined;
      const grantChanged = cloudAgentMcp !== previousMcpGrant;
      if (pending || (grantChanged && (runtimeWasReused || hasRoutesForKey(key, sessionId)))) {
        const installCredentials = pending ?? {
          ...credentials,
          sessionId,
          kilo: credentials?.kilo ?? { token: kiloToken },
          cloudAgentMcp: undefined,
        };
        const retainedGrant = workspaceMcpGrants.get(key);
        const prepareGrant = newestMcpGrant(cloudAgentMcp, pending?.cloudAgentMcp);
        const installGrant =
          retainedGrant === previousMcpGrant
            ? prepareGrant
            : newestMcpGrant(prepareGrant, retainedGrant);
        try {
          await applyCredentialsFor(installCredentials, installGrant);
        } catch (error) {
          log(
            `control-plane buffered credential apply failed session=${sessionId} error=${
              error instanceof Error ? error.message : String(error)
            }`
          );
        }
      }
      if (owner.released) return;
      deps.onPreparedRoute?.(spec);
      emitSessionReadyNative(sessionId);
      deps.emit({
        type: 'session.ready',
        sessionId,
        ...(workspace ? { workspace } : {}),
        ...(workspaceCommandFailures.length > 0
          ? { commandFailures: workspaceCommandFailures }
          : {}),
      });
      log(`control-plane prepare ready session=${sessionId} directory=${directory}`);
    } catch (error) {
      if (owner.released) return;
      log(
        `control-plane prepare failed session=${sessionId} step=${currentStep} error=${redactSecrets(
          error instanceof Error ? error.message : String(error),
          credentials?.cloudAgentMcp ? [credentials.cloudAgentMcp.token] : []
        )}${
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
    if (!route) {
      const preparation = preparing.get(credentials.sessionId);
      if (preparation && !preparation.released) preparation.pendingCredentials = credentials;
      return;
    }
    await applyCredentialsFor(credentials, workspaceMcpGrant(route.key, credentials.cloudAgentMcp));
  }

  async function applyCredentialsFor(
    credentials: ControlPlaneSessionCredentialsPayload,
    cloudAgentMcp: ControlPlaneSessionCredentialsPayload['cloudAgentMcp']
  ): Promise<void> {
    const route = prepared.get(credentials.sessionId);
    if (!route) {
      const preparation = preparing.get(credentials.sessionId);
      if (preparation && !preparation.released) preparation.pendingCredentials = credentials;
      return;
    }
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
        route.spec.mcp,
        { ...route.spec, ...(cloudAgentMcp === undefined ? {} : { cloudAgentMcp }) }
      ),
      route.spec
    );
    route.env = nextEnv;
    await deps.runtimes.installCredentials(route.key, nextEnv, cloudAgentMcp);
    commitWorkspaceMcpGrant(route.key, cloudAgentMcp);
    if (credentials.git?.token && route.spec.git) {
      // The helper re-reads the record on the next git command, so the agent's
      // push/fetch picks up the renewed token while `origin` stays credential-free.
      try {
        await writeGitCredentialRecords({
          home: route.home,
          credentials: [
            {
              url: credentialFreeGitUrl(route.spec.git.url),
              token: credentials.git.token,
              platform: credentials.git.platform ?? route.spec.git.platform,
            },
            ...additionalHostCredentials(credentials.gitCredentials),
          ],
        });
      } catch {
        log(`control-plane Git credential record refresh failed session=${credentials.sessionId}`);
      }
    }
  }

  return {
    workspaceConfiguration(spec, offered) {
      const key = workspaceConfigRuntimeKey(spec);
      const retained =
        callerKeepsRuntime(spec.sessionId, key) || hasRoutesForKey(key, spec.sessionId)
          ? workspaceConfigurations.get(key)
          : undefined;
      if (retained !== undefined) return retained;
      workspaceConfigurations.set(key, offered);
      return offered;
    },
    prepare: function prepare(spec, credentials) {
      const existing = preparing.get(spec.sessionId);
      if (existing && !existing.released) return existing.promise;
      if (existing) {
        const owner: PreparingRoute = {
          promise: Promise.resolve(),
          released: false,
          runtimeKey: runtimeKey(spec),
        };
        owner.promise = existing.promise
          .then(() => {
            if (owner.released) return;
            preparing.delete(spec.sessionId);
            // A frame buffered on this owner would be lost when the re-entrant
            // prepare creates a fresh owner for the same session.
            const pending = owner.pendingCredentials;
            const next = prepare(spec, credentials);
            if (pending) {
              const created = preparing.get(spec.sessionId);
              if (created) created.pendingCredentials = pending;
            }
            return next;
          })
          .finally(() => finalizePreparingOwner(owner, spec));
        preparing.set(spec.sessionId, owner);
        return owner.promise;
      }
      const owner: PreparingRoute = {
        promise: Promise.resolve(),
        released: false,
        runtimeKey: runtimeKey(spec),
      };
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
              deps.onPreparedRoute?.(route.spec);
              emitSessionReadyNative(spec.sessionId);
              deps.emit({ type: 'session.ready', sessionId: spec.sessionId, workspace: 'same' });
            }
          })().finally(() => finalizePreparingOwner(owner, spec));
          owner.promise = running;
          preparing.set(spec.sessionId, owner);
          return running;
        }
      }
      const running = runPrepare(spec, credentials, owner).finally(() =>
        finalizePreparingOwner(owner, spec)
      );
      owner.promise = running;
      preparing.set(spec.sessionId, owner);
      return running;
    },
    release(sessionId) {
      const preparation = preparing.get(sessionId);
      if (preparation) {
        preparation.released = true;
        preparation.skillInstallController?.abort();
      }
      const route = prepared.get(sessionId);
      if (!route) return;
      prepared.delete(sessionId);
      const owner = preparing.get(sessionId);
      if (owner) {
        // The in-flight prepare's finalizer owns the decision.
        return;
      }
      finishReleasedRoute({
        key: route.key,
        sessionId,
        spec: route.spec,
      });
    },
    isPrepared: sessionId => prepared.has(sessionId),
    preparedRoute: sessionId => {
      const route = prepared.get(sessionId);
      return route === undefined
        ? null
        : { runtimeKey: route.key, directory: route.directory, roots: routeRoots(route.spec) };
    },
    isPreparing: () => preparing.size > 0,
    preparingCount: () => preparing.size,
    sessionCount: () => prepared.size,
    installCredentials: installCredentialsFor,
  };
}
