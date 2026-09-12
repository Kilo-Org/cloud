import { redactSecrets } from './redact-output.js';
import { type ExecResult, type ProcessOptions, type ProcessOutputStream } from './utils.js';
import { workspaceBootstrapError } from './bootstrap-error.js';
import { gitFailureDetail, gitOperationError } from './git-errors.js';

const LONG_GIT_COMMAND_INACTIVITY_TIMEOUT_MS = 120_000;
const LONG_GIT_COMMAND_HARD_TIMEOUT_MS = 300_000;
const GIT_PROGRESS_PATTERN =
  /\b(Receiving objects|Resolving deltas|Updating files|Checking out files|Compressing objects):\s+(\d+)%/g;

const GITHUB_PULL_REF_PATTERN = /^refs\/pull\/\d+\/head$/;
const GITLAB_MR_REF_PATTERN = /^refs\/merge-requests\/\d+\/head$/;
const MISSING_REMOTE_REF_PATTERN =
  /(?:couldn['’]t|could not|cannot|can't|unable to) find remote ref|remote ref .*?(?:not found|does not exist)/i;

type GitRunner = (args: string[], opts?: ProcessOptions) => Promise<ExecResult>;

export type GitReviewRefOptions = {
  runGit: GitRunner;
  workspacePath: string;
  branchName: string;
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
  redact?: (text: string) => string;
};

function gitProgressReporter(
  onProgress: ((message: string) => void) | undefined,
  prefix: string
): (stream: ProcessOutputStream, output: string) => void {
  let bufferedOutput = '';
  let lastReportedProgress = '';
  let lastReportedAt = 0;

  return (_stream, output) => {
    bufferedOutput = (bufferedOutput + output).slice(-1_024);
    const latest = [...bufferedOutput.matchAll(GIT_PROGRESS_PATTERN)].at(-1);
    if (!latest) return;

    const progressText = `${latest[1]}: ${latest[2]}%`;
    if (progressText === lastReportedProgress) return;

    const now = Date.now();
    if (lastReportedAt !== 0 && now - lastReportedAt < 5_000) return;

    lastReportedProgress = progressText;
    lastReportedAt = now;
    onProgress?.(`${prefix} ${progressText}`);
  };
}

function longGitOptions(
  workspacePath: string,
  signal: AbortSignal | undefined,
  onProgress: ((message: string) => void) | undefined,
  prefix: string
): ProcessOptions {
  return {
    cwd: workspacePath,
    inactivityTimeoutMs: LONG_GIT_COMMAND_INACTIVITY_TIMEOUT_MS,
    hardTimeoutMs: LONG_GIT_COMMAND_HARD_TIMEOUT_MS,
    ...(signal ? { signal } : {}),
    onOutput: gitProgressReporter(onProgress, prefix),
  };
}

function isMissingRemoteRef(result: ExecResult): boolean {
  return MISSING_REMOTE_REF_PATTERN.test(result.stderr);
}

export function isSyntheticReviewRef(branchName: string): boolean {
  return GITHUB_PULL_REF_PATTERN.test(branchName) || GITLAB_MR_REF_PATTERN.test(branchName);
}

export async function checkoutSyntheticReviewRef(options: GitReviewRefOptions): Promise<void> {
  const redact = options.redact ?? redactSecrets;
  const fetchResult = await options.runGit(
    ['fetch', '--progress', 'origin', options.branchName],
    longGitOptions(
      options.workspacePath,
      options.signal,
      options.onProgress,
      'Fetching review branch...'
    )
  );
  if (fetchResult.exitCode !== 0) {
    if (isMissingRemoteRef(fetchResult)) {
      throw workspaceBootstrapError(
        'git_branch_missing',
        'Requested repository branch was not found',
        gitFailureDetail(fetchResult, redact),
        false
      );
    }
    throw gitOperationError(fetchResult, 'checkout', redact);
  }

  const checkoutResult = await options.runGit(
    ['checkout', '--progress', '-B', options.branchName, 'FETCH_HEAD'],
    longGitOptions(
      options.workspacePath,
      options.signal,
      options.onProgress,
      'Checking out review branch...'
    )
  );
  if (checkoutResult.exitCode !== 0) {
    throw gitOperationError(checkoutResult, 'checkout', redact);
  }
}
