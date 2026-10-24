import {
  CONTROL_PLANE_SETUP_EVENTS,
  type ControlPlaneRouteSpec,
  type ControlPlaneSetupEvent,
} from '../../../src/shared/control-plane-protocol.js';
import { parseControlPlaneCredential } from '../../../src/shared/control-plane-credential.js';
import type { WorkspaceFailureSubtype } from '../../../src/shared/wrapper-bootstrap.js';
import { WrapperBootstrapError } from '../bootstrap-error.js';
import { cleanTerminalOutput, gitOperationError, type GitRouteClass } from '../git-errors.js';
import { authenticatedGitUrl } from '../control/git-url.js';
import { createOutputRedactor } from '../redact-output.js';
import { isSyntheticReviewRef } from '../git-review-ref.js';
import { isBloblessReviewCloneEligible, createGitProgressReporter } from '../session-bootstrap.js';
import type { ExecResult, ProcessOptions, ProcessOutputStream } from '../utils.js';

/**
 * Repository preparation shared by session preparation (`prepare.ts`) and the
 * environment builder: clone with bounded network retries, setup commands with
 * redacted, bounded output, and the commit a workspace ended at. Session
 * concerns (routes, stamps, adoption, Kilo) stay with the session caller; build
 * concerns (default-branch pinning, credential cleanup, capture) stay with the
 * builder.
 */

/** Spec §7 "Setup commands": current per-command limits. */
export const SETUP_COMMAND_INACTIVITY_TIMEOUT_MS = 5 * 60_000;
export const SETUP_COMMAND_HARD_TIMEOUT_MS = 8 * 60_000;
/** Spec §7 "Clone or fetch": network errors get 3 attempts with backoff. */
const CLONE_RETRY_ATTEMPTS = 3;
const CLONE_RETRY_BACKOFF_MS = [1_000, 2_000];
/** Upper bound on one setup-output event so a chatty command cannot flood the wire. */
export const SETUP_OUTPUT_EVENT_LIMIT = 8_192;

export type RepositoryGit = NonNullable<ControlPlaneRouteSpec['git']>;

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
 * the route's git source, never the password parsed back out of the
 * authenticated URL.
 */
export function managedGitHubPreparationGitArgs(
  git: RepositoryGit | undefined,
  command: string
): string[] {
  if (command !== 'clone' && command !== 'fetch') return [];
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

function isNetworkFailure(subtype: WorkspaceFailureSubtype | undefined): boolean {
  return subtype === 'git_network_failed' || subtype === 'git_rate_limited';
}

export type RunSetupCommand = (
  command: string,
  directory: string,
  env: Record<string, string>,
  onOutput?: (stream: ProcessOutputStream, output: string) => void,
  signal?: AbortSignal
) => Promise<ExecResult>;

export type RepositoryPreparationDeps = {
  runGit: (args: string[], options?: ProcessOptions) => Promise<ExecResult>;
  runSetup: RunSetupCommand;
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  mkdir: (directory: string) => Promise<void>;
  hasGit: (directory: string) => Promise<boolean>;
  log: (message: string) => void;
};

export type CloneInput = {
  sessionId?: string;
  createdOnPlatform?: string;
  branch?: string;
  branchMode?: ControlPlaneRouteSpec['branchMode'];
  git: RepositoryGit | undefined;
  directory: string;
  env: Record<string, string>;
  redact: (text: string) => string;
  signal: AbortSignal;
  /** A display line for the clone step; `undefined` marks the step start. */
  onProgress: (detail?: string) => void;
};

export type SetupCommandsInput = {
  commands: readonly string[];
  directory: string;
  env: Record<string, string>;
  redact: (text: string) => string;
  signal: AbortSignal;
  /** Receives each command's start, redacted output and end. */
  onEvent: (event: ControlPlaneSetupEvent) => void;
  /** Safe identifiers appended to the failure log line; never values. */
  logContext: string;
};

export type RepositoryPreparation = {
  runNetworkGit: (
    args: string[],
    options: ProcessOptions,
    redact: (text: string) => string,
    signal: AbortSignal
  ) => Promise<ExecResult>;
  cloneRepository: (input: CloneInput) => Promise<void>;
  runSetupCommands: (input: SetupCommandsInput) => Promise<void>;
  headCommit: (directory: string, env: Record<string, string>) => Promise<string>;
};

export function createRepositoryPreparation(
  deps: RepositoryPreparationDeps
): RepositoryPreparation {
  const { runGit, runSetup, sleep, mkdir, hasGit, log } = deps;

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

  async function cloneRepository(input: CloneInput): Promise<void> {
    const { directory, env, redact, signal, onProgress } = input;
    const spec = input;
    onProgress();
    await mkdir(directory);
    if (!spec.git || (await hasGit(directory))) return;
    // Diagnostic route class only: a managed credential was injected into the
    // clone URL, otherwise the plain (direct) URL is used. Never log the URL.
    const gitRoute: GitRouteClass = spec.git.token ? 'managed' : 'direct';
    if (!(await hasGit(directory))) {
      const cloneUrl = authenticatedGitUrl(spec.git.url, spec.git.token, spec.git.platform);
      const gitConfigArgs = managedGitHubPreparationGitArgs(spec.git, 'clone');
      const useBlobless = isBloblessReviewCloneEligible(
        spec.createdOnPlatform,
        spec.git.platform,
        spec.git.token
      );
      const noCheckout =
        spec.createdOnPlatform === 'code-review' &&
        spec.branch !== undefined &&
        isSyntheticReviewRef(spec.branch) &&
        spec.branchMode !== 'working';
      const startedAt = Date.now();
      let cloneAttempts = 0;
      let filterRejected = false;
      const runClone = async (): Promise<ExecResult> => {
        signal.throwIfAborted();
        cloneAttempts += 1;
        const cloned = await runGit(
          [
            ...gitConfigArgs,
            'clone',
            '--progress',
            ...(useBlobless && !filterRejected ? ['--filter=blob:none'] : []),
            ...(noCheckout ? ['--no-checkout'] : []),
            cloneUrl,
            directory,
          ],
          {
            env,
            inheritEnv: false,
            signal,
            onOutput: createGitProgressReporter(progressText =>
              onProgress(`Cloning repository... ${progressText}`)
            ),
          }
        );
        signal.throwIfAborted();
        return cloned;
      };
      let lastError: WrapperBootstrapError | undefined;
      for (let attempt = 1; attempt <= CLONE_RETRY_ATTEMPTS; attempt += 1) {
        signal.throwIfAborted();
        if (attempt > 1) {
          onProgress(`Retrying clone (attempt ${attempt} of ${CLONE_RETRY_ATTEMPTS})`);
        }
        let cloned = await runClone();
        if (
          useBlobless &&
          !filterRejected &&
          cloned.exitCode !== 0 &&
          !cloned.terminationReason &&
          /(?:filter(?:ing)?[^\r\n]*(?:not supported|not recognized|rejected)|(?:does not support|unsupported|invalid)[^\r\n]*filter)/i.test(
            `${cloned.stderr}\n${cloned.stdout}`
          )
        ) {
          filterRejected = true;
          log(
            `control-plane blobless clone rejected; retrying full clone session=${spec.sessionId}`
          );
          cloned = await runClone();
        }
        if (cloned.exitCode === 0) {
          lastError = undefined;
          break;
        }
        lastError = gitOperationError(cloned, 'clone', redact, gitRoute);
        if (!isNetworkFailure(lastError.subtype) || attempt === CLONE_RETRY_ATTEMPTS) break;
        await sleep(CLONE_RETRY_BACKOFF_MS[attempt - 1] ?? 0, signal);
      }
      if (lastError) throw lastError;
      let filterHonored = false;
      if (useBlobless && !filterRejected) {
        const promisor = await runGit(['config', '--get', 'remote.origin.promisor'], {
          cwd: directory,
          env,
          inheritEnv: false,
          signal,
        });
        filterHonored = promisor.exitCode === 0 && promisor.stdout.trim() === 'true';
      }
      const mode = filterRejected ? 'blobless_fallback' : filterHonored ? 'blobless' : 'full';
      log(
        `control-plane clone complete session=${spec.sessionId} mode=${mode} attempts=${cloneAttempts} durationMs=${Date.now() - startedAt}`
      );
    }
  }

  async function runSetupCommands(input: SetupCommandsInput): Promise<void> {
    const { commands, directory, env, redact, signal, onEvent, logContext } = input;
    // Spec §9: a setup failure must show the command output, so each command's
    // start, output and end are reported, not only written to the wrapper log.
    for (const [index, command] of commands.entries()) {
      signal.throwIfAborted();
      const commandNumber = index + 1;
      onEvent({
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
          onEvent({
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
          `control-plane setup command failed ${logContext} index=${index + 1} count=${commands.length} exitCode=${result.exitCode} terminationReason=${result.terminationReason ?? 'nonzero'} elapsedMs=${Date.now() - startedAt} inactivityTimeoutMs=${SETUP_COMMAND_INACTIVITY_TIMEOUT_MS} hardTimeoutMs=${SETUP_COMMAND_HARD_TIMEOUT_MS}`
        );
        const message = `Setup command ${commandNumber} ${timedOut ? 'timed out' : 'failed'}`;
        onEvent({
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
      onEvent({
        type: CONTROL_PLANE_SETUP_EVENTS.finished,
        properties: { command: commandNumber, exitCode: 0 },
      });
    }
  }

  async function headCommit(directory: string, env: Record<string, string>): Promise<string> {
    const result = await runGit(['rev-parse', 'HEAD'], {
      cwd: directory,
      env,
      inheritEnv: false,
    });
    return result.exitCode === 0 ? result.stdout.trim() : '';
  }

  return { runNetworkGit, cloneRepository, runSetupCommands, headCommit };
}
