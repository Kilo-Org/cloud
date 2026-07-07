import fs from 'node:fs/promises';
import path from 'node:path';
import {
  type WrapperBootstrapAttachment,
  type WrapperPromptRequest,
  type WrapperPromptPart,
  type WrapperSessionReadyRequest,
} from '../../src/shared/wrapper-bootstrap.js';
import { buildCloudAgentRules } from '../../src/shared/cloud-agent-rules.js';
import {
  createSafeProcessDiagnostic,
  git,
  isTimeoutTermination,
  logToFile,
  runProcess,
  type ExecResult,
  type ProcessOptions,
  type ProcessOutputStream,
} from './utils.js';
import { restoreSession } from './restore-session.js';
import { WrapperBootstrapError, workspaceBootstrapError } from './bootstrap-error.js';

const LONG_COMMAND_INACTIVITY_TIMEOUT_MS = 120_000;
const LONG_COMMAND_HARD_TIMEOUT_MS = 300_000;
// Setup commands may legitimately stay silent for minutes (piped tools often
// buffer), unlike git commands which run with --progress, so they get a more
// lenient silence watchdog.
const SETUP_COMMAND_INACTIVITY_TIMEOUT_MS = 4 * 60_000;
const WORKSPACE_PREPARATION_TIMEOUT_MS = 8 * 60_000;
const WORKSPACE_CLEANUP_TIMEOUT_MS = 60_000;
const SHORT_GIT_COMMAND_TIMEOUT_MS = 120_000;
const PROGRESS_UPDATE_INTERVAL_MS = 5_000;
const GIT_BOOTSTRAP_MARKER = 'kilo-bootstrap-complete';
const MAX_ATTACHMENT_BYTES = 5_242_880;

export type BootstrapProgressStep =
  | 'disk_check'
  | 'workspace_setup'
  | 'cloning'
  | 'branch'
  | 'kilo_session'
  | 'setup_commands'
  | 'attachments'
  | 'kilo_server';

export type BootstrapProgress = (step: BootstrapProgressStep, message: string) => void;

export type WrapperBootstrapResult = {
  workspaceWasWarm: boolean;
};

type GitRunner = (args: string[], opts?: ProcessOptions) => Promise<ExecResult>;
type ProcessRunner = (
  command: string,
  args: string[],
  opts?: ProcessOptions
) => Promise<ExecResult>;

export type WrapperBootstrapDeps = {
  git?: GitRunner;
  runProcess?: ProcessRunner;
  restoreSession?: typeof restoreSession;
  workspacePreparationTimeoutMs?: number;
};

const GIT_FAILURE_PATTERNS = [
  { subtype: 'sandbox_storage_full', pattern: /no space left on device|disk quota exceeded/i },
  {
    subtype: 'git_authentication_failed',
    pattern: /authentication failed|could not read username|http 401|http 403/i,
  },
  {
    subtype: 'git_network_failed',
    pattern:
      /remote end hung up|connection (?:reset|timed out)|could not resolve host|failed to connect/i,
  },
  {
    subtype: 'git_pack_corrupt',
    pattern: /bad object|pack.*corrupt|invalid index-pack output|early eof/i,
  },
] as const;

function classifyGitFailure(result: ExecResult, operation: 'clone' | 'checkout') {
  if (isTimeoutTermination(result)) {
    return operation === 'clone' ? 'git_clone_timeout' : 'git_checkout_timeout';
  }
  const output = `${result.stderr}\n${result.stdout}`;
  if (
    operation === 'checkout' &&
    /would be overwritten|index\.lock.*exists|unable to create.*index\.lock/i.test(output)
  ) {
    return 'git_checkout_conflict';
  }
  return (
    GIT_FAILURE_PATTERNS.find(entry => entry.pattern.test(output))?.subtype ??
    'workspace_setup_unknown'
  );
}

function gitOperationError(
  result: ExecResult,
  operation: 'clone' | 'checkout'
): WrapperBootstrapError {
  const label = operation === 'clone' ? 'Repository clone' : 'Repository checkout';
  const subtype = classifyGitFailure(result, operation);
  const message = isTimeoutTermination(result) ? `${label} timed out` : `${label} failed`;
  return workspaceBootstrapError(subtype, message, createSafeProcessDiagnostic(result));
}

const GIT_PROGRESS_PATTERN =
  /\b(Receiving objects|Resolving deltas|Updating files|Checking out files|Compressing objects):\s+(\d+)%/g;

function gitProgressReporter(
  progress: BootstrapProgress | undefined,
  step: 'cloning' | 'branch',
  prefix: string
): (stream: ProcessOutputStream, output: string) => void {
  let bufferedOutput = '';
  let lastReportedProgress = '';
  let lastReportedAt = 0;

  return (_stream, output) => {
    bufferedOutput = (bufferedOutput + output).slice(-1_024);
    const matches = [...bufferedOutput.matchAll(GIT_PROGRESS_PATTERN)];
    const latest = matches.at(-1);
    if (!latest) return;

    const progressText = `${latest[1]}: ${latest[2]}%`;
    if (progressText === lastReportedProgress) return;

    const now = Date.now();
    if (lastReportedAt !== 0 && now - lastReportedAt < PROGRESS_UPDATE_INTERVAL_MS) return;

    lastReportedProgress = progressText;
    lastReportedAt = now;
    progress?.(step, `${prefix} ${progressText}`);
  };
}

function longGitOptions(
  progress: BootstrapProgress | undefined,
  step: 'cloning' | 'branch',
  progressPrefix: string,
  cwd?: string
): ProcessOptions {
  return {
    cwd,
    inactivityTimeoutMs: LONG_COMMAND_INACTIVITY_TIMEOUT_MS,
    hardTimeoutMs: LONG_COMMAND_HARD_TIMEOUT_MS,
    onOutput: gitProgressReporter(progress, step, progressPrefix),
  };
}

export class RestoredWorkspaceReconciliationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'RestoredWorkspaceReconciliationError';
  }
}

export function workspaceBootstrapErrorCode(
  error: unknown
): 'WORKSPACE_RECONCILIATION_FAILED' | 'WORKSPACE_SETUP_FAILED' {
  return error instanceof RestoredWorkspaceReconciliationError
    ? 'WORKSPACE_RECONCILIATION_FAILED'
    : 'WORKSPACE_SETUP_FAILED';
}

function authenticatedUrl(
  gitUrl: string,
  token: string | undefined,
  platform: 'github' | 'gitlab' | 'bitbucket' | undefined
): string {
  if (!token) return gitUrl;
  const url = new URL(gitUrl);
  url.username =
    platform === 'gitlab' ? 'oauth2' : platform === 'bitbucket' ? 'x-token-auth' : 'x-access-token';
  url.password = token;
  return url.toString();
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.stat(filePath);
    return true;
  } catch {
    return false;
  }
}

function gitBootstrapMarkerPath(workspacePath: string): string {
  return path.join(workspacePath, '.git', GIT_BOOTSTRAP_MARKER);
}

function sessionAuthFilePath(sessionHome: string): string {
  return path.join(sessionHome, '.local/share/kilo/auth.json');
}

// The marker is removed before re-bootstrapping and written only after restore
// and setup commands finish, so its presence is the sole evidence that a
// workspace completed bootstrap. Anything else (a bare .git, auth.json) can be
// left behind by an interrupted bootstrap and must be rebuilt.
async function isCompleteGitWorkspace(workspacePath: string): Promise<boolean> {
  return exists(gitBootstrapMarkerPath(workspacePath));
}

async function ensureWorkspaceDirectories(request: WrapperSessionReadyRequest): Promise<void> {
  await fs.mkdir(request.workspace.workspacePath, { recursive: true });
  await fs.mkdir(request.workspace.sessionHome, { recursive: true });
}

async function removePath(filePath: string, signal?: AbortSignal): Promise<void> {
  const result = await runProcess('rm', ['-rf', '--', filePath], {
    hardTimeoutMs: WORKSPACE_CLEANUP_TIMEOUT_MS,
    signal,
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `Failed to remove workspace path: ${filePath} (${createSafeProcessDiagnostic(result)})`
    );
  }
}

async function cleanupWorkspace(request: WrapperSessionReadyRequest): Promise<void> {
  await Promise.allSettled([
    removePath(request.workspace.workspacePath),
    removePath(request.workspace.sessionHome),
  ]);
}

async function cloneRepository(
  request: WrapperSessionReadyRequest,
  runGit: GitRunner,
  progress: BootstrapProgress | undefined,
  signal: AbortSignal
): Promise<void> {
  const repo = request.repo;
  if (!repo) {
    throw new Error('Session metadata is missing a repository source');
  }

  const gitUrl = repo.kind === 'github' ? `https://github.com/${repo.repo}.git` : repo.url;
  const platform = repo.kind === 'git' ? repo.platform : 'github';
  const repoUrl = authenticatedUrl(gitUrl, repo.token, platform);
  const args = ['clone', '--progress'];
  if (repo.shallow) {
    args.push('--depth', '1');
  }
  args.push(repoUrl, request.workspace.workspacePath);

  await removePath(request.workspace.workspacePath, signal);
  await fs.mkdir(path.dirname(request.workspace.workspacePath), { recursive: true });

  const result = await runGit(args, longGitOptions(progress, 'cloning', 'Cloning repository...'));
  if (result.exitCode !== 0) {
    throw gitOperationError(result, 'clone');
  }

  const authorName =
    repo.kind === 'github' ? (repo.gitAuthor?.name ?? 'Kilo Code Cloud') : 'Kilo Code Cloud';
  const authorEmail =
    repo.kind === 'github' ? (repo.gitAuthor?.email ?? 'agent@kilocode.ai') : 'agent@kilocode.ai';
  const authorNameResult = await runGit(['config', 'user.name', authorName], {
    cwd: request.workspace.workspacePath,
    timeoutMs: SHORT_GIT_COMMAND_TIMEOUT_MS,
  });
  const authorEmailResult = await runGit(['config', 'user.email', authorEmail], {
    cwd: request.workspace.workspacePath,
    timeoutMs: SHORT_GIT_COMMAND_TIMEOUT_MS,
  });
  if (authorNameResult.exitCode !== 0 || authorEmailResult.exitCode !== 0) {
    throw new Error('Failed to configure git author identity');
  }
}

async function branchExists(
  runGit: GitRunner,
  workspacePath: string,
  branch: string,
  remote: boolean
): Promise<boolean> {
  const ref = remote ? `origin/${branch}` : branch;
  const result = await runGit(['rev-parse', '--verify', '--quiet', ref], {
    cwd: workspacePath,
    timeoutMs: SHORT_GIT_COMMAND_TIMEOUT_MS,
  });
  if (result.exitCode === 0) return true;
  if (result.exitCode !== 1 || result.terminationReason !== undefined) {
    throw gitOperationError(result, 'checkout');
  }
  return false;
}

const GITHUB_PULL_REF_PATTERN = /^refs\/pull\/\d+\/head$/;
const GITLAB_MR_REF_PATTERN = /^refs\/merge-requests\/\d+\/head$/;

function isSyntheticReviewRef(branchName: string): boolean {
  return GITHUB_PULL_REF_PATTERN.test(branchName) || GITLAB_MR_REF_PATTERN.test(branchName);
}

async function fetchSyntheticReviewRef(
  runGit: GitRunner,
  workspacePath: string,
  branchName: string,
  progress: BootstrapProgress | undefined
): Promise<void> {
  const fetchResult = await runGit(
    ['fetch', '--progress', 'origin', branchName],
    longGitOptions(progress, 'branch', 'Fetching review branch...', workspacePath)
  );
  if (fetchResult.exitCode !== 0) {
    throw gitOperationError(fetchResult, 'checkout');
  }

  const checkoutResult = await runGit(
    ['checkout', '--progress', '-B', branchName, 'FETCH_HEAD'],
    longGitOptions(progress, 'branch', 'Checking out review branch...', workspacePath)
  );
  if (checkoutResult.exitCode !== 0) {
    throw gitOperationError(checkoutResult, 'checkout');
  }
}

async function prepareBranch(
  request: WrapperSessionReadyRequest,
  runGit: GitRunner,
  progress: BootstrapProgress | undefined
): Promise<void> {
  const { workspacePath, branchName, strictBranch } = request.workspace;
  if (strictBranch && isSyntheticReviewRef(branchName)) {
    await fetchSyntheticReviewRef(runGit, workspacePath, branchName, progress);
    return;
  }

  const fetchResult = await runGit(
    ['fetch', '--progress', 'origin'],
    longGitOptions(progress, 'branch', 'Fetching repository...', workspacePath)
  );
  if (fetchResult.exitCode !== 0) {
    throw gitOperationError(fetchResult, 'checkout');
  }

  if (await branchExists(runGit, workspacePath, branchName, false)) {
    const result = await runGit(
      ['checkout', '--progress', branchName],
      longGitOptions(progress, 'branch', 'Checking out branch...', workspacePath)
    );
    if (result.exitCode !== 0) {
      throw gitOperationError(result, 'checkout');
    }
    return;
  }

  if (await branchExists(runGit, workspacePath, branchName, true)) {
    const result = await runGit(
      ['checkout', '--progress', '-B', branchName, `origin/${branchName}`],
      longGitOptions(progress, 'branch', 'Checking out branch...', workspacePath)
    );
    if (result.exitCode !== 0) {
      throw gitOperationError(result, 'checkout');
    }
    return;
  }

  if (strictBranch) {
    throw workspaceBootstrapError(
      'git_branch_missing',
      'Requested repository branch was not found',
      undefined,
      false
    );
  }

  const result = await runGit(
    ['checkout', '--progress', '-b', branchName],
    longGitOptions(progress, 'branch', 'Creating branch...', workspacePath)
  );
  if (result.exitCode !== 0) {
    throw gitOperationError(result, 'checkout');
  }
}

async function sanitizeBitbucketCodeReviewRemote(
  request: WrapperSessionReadyRequest,
  runGit: GitRunner
): Promise<boolean> {
  const repo = request.repo;
  if (
    repo?.kind !== 'git' ||
    repo.platform !== 'bitbucket' ||
    request.materialized.env.KILO_PLATFORM !== 'code-review'
  ) {
    return false;
  }
  const canonicalUrl = new URL(repo.url);
  canonicalUrl.username = '';
  canonicalUrl.password = '';
  const result = await runGit(['remote', 'set-url', 'origin', canonicalUrl.toString()], {
    cwd: request.workspace.workspacePath,
    timeoutMs: SHORT_GIT_COMMAND_TIMEOUT_MS,
  });
  if (result.exitCode !== 0) {
    throw new Error('Failed to update git remote URL');
  }
  return true;
}

function repositoryUrls(request: WrapperSessionReadyRequest): {
  canonical: string;
  authenticated: string;
} | null {
  const repo = request.repo;
  if (!repo) return null;
  const canonical = repo.kind === 'github' ? `https://github.com/${repo.repo}.git` : repo.url;
  const platform = repo.kind === 'git' ? repo.platform : 'github';
  return {
    canonical,
    authenticated: authenticatedUrl(canonical, repo.token, platform),
  };
}

async function setOriginUrl(
  request: WrapperSessionReadyRequest,
  runGit: GitRunner,
  url: string
): Promise<void> {
  const result = await runGit(['remote', 'set-url', 'origin', url], {
    cwd: request.workspace.workspacePath,
    timeoutMs: SHORT_GIT_COMMAND_TIMEOUT_MS,
  });
  if (result.exitCode !== 0) {
    throw new Error('Failed to update git remote URL');
  }
}

async function refreshGitRemoteToken(
  request: WrapperSessionReadyRequest,
  runGit: GitRunner
): Promise<void> {
  const repo = request.repo;
  const urls = repositoryUrls(request);
  if (!repo?.refreshRemote || !repo.token || !urls) return;

  const result = await runGit(['remote', 'set-url', 'origin', urls.authenticated], {
    cwd: request.workspace.workspacePath,
    timeoutMs: SHORT_GIT_COMMAND_TIMEOUT_MS,
  });
  if (result.exitCode !== 0) {
    throw new Error('Failed to update git remote URL');
  }
  if (repo.kind === 'github' && repo.gitAuthor) {
    const nameResult = await runGit(['config', 'user.name', repo.gitAuthor.name], {
      cwd: request.workspace.workspacePath,
      timeoutMs: SHORT_GIT_COMMAND_TIMEOUT_MS,
    });
    const emailResult = await runGit(['config', 'user.email', repo.gitAuthor.email], {
      cwd: request.workspace.workspacePath,
      timeoutMs: SHORT_GIT_COMMAND_TIMEOUT_MS,
    });
    if (nameResult.exitCode !== 0 || emailResult.exitCode !== 0) {
      throw new Error('Failed to configure git author identity');
    }
  }
}

async function writeSessionAuthFile(request: WrapperSessionReadyRequest): Promise<void> {
  const authFilePath = sessionAuthFilePath(request.workspace.sessionHome);
  await fs.mkdir(path.dirname(authFilePath), { recursive: true });
  await fs.writeFile(
    authFilePath,
    JSON.stringify({ kilo: { type: 'api', key: request.session.workerAuthToken } }, null, 2)
  );
}

async function writeCloudAgentRules(request: WrapperSessionReadyRequest): Promise<void> {
  const rulesDir = path.join(request.workspace.sessionHome, '.kilocode/rules');
  await fs.mkdir(rulesDir, { recursive: true });
  await fs.writeFile(
    path.join(rulesDir, 'cloud-agent.md'),
    buildCloudAgentRules(request.agentSessionId)
  );
}

function isSafeSkillFilePath(relativePath: string): boolean {
  if (relativePath.length === 0 || relativePath.length > 200) return false;
  if (relativePath.startsWith('/')) return false;
  if (relativePath.includes('..')) return false;
  if (relativePath.includes('\\') || relativePath.includes('\0')) return false;
  if (relativePath.toLowerCase() === 'skill.md') return false;
  return /^[a-zA-Z0-9._\-/]+$/.test(relativePath);
}

async function writeRuntimeSkills(request: WrapperSessionReadyRequest): Promise<void> {
  const skills = request.materialized.runtimeSkills;
  if (!skills?.length) return;

  const baseDir = path.join(request.workspace.sessionHome, '.kilocode/skills');
  await fs.mkdir(baseDir, { recursive: true });

  for (const skill of skills) {
    const skillDir = path.join(baseDir, skill.name);
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(path.join(skillDir, 'SKILL.md'), skill.rawMarkdown);
    for (const [relativePath, content] of Object.entries(skill.files ?? {})) {
      if (!isSafeSkillFilePath(relativePath)) continue;
      const targetPath = path.join(skillDir, relativePath);
      await fs.mkdir(path.dirname(targetPath), { recursive: true });
      await fs.writeFile(targetPath, content);
    }
  }
}

async function bootstrapEmptyKiloSession(
  request: WrapperSessionReadyRequest,
  restore: typeof restoreSession
): Promise<void> {
  const now = Date.now();
  const minimalSessionJson = JSON.stringify({
    info: {
      id: request.kiloSessionId,
      slug: '',
      projectID: '',
      directory: '',
      title: 'New session - ' + new Date(now).toISOString(),
      version: '2',
      time: { created: now, updated: now },
    },
    messages: [],
  });
  const importFilePath = `/tmp/kilo-empty-session-${request.kiloSessionId}.json`;
  logToFile(
    `bootstrap empty kilo session writing kiloSessionId=${request.kiloSessionId} importFilePath=${importFilePath} workspacePath=${request.workspace.workspacePath} sessionHome=${request.workspace.sessionHome} jsonChars=${minimalSessionJson.length}`
  );
  await fs.writeFile(importFilePath, minimalSessionJson);
  const result = await restore(
    request.kiloSessionId,
    request.workspace.workspacePath,
    importFilePath
  );
  if (!result.ok) {
    logToFile(
      `bootstrap empty kilo session failed kiloSessionId=${request.kiloSessionId} step=${result.step} code=${result.code ?? '(none)'} subtype=${result.subtype ?? '(none)'}`
    );
    throw workspaceBootstrapError(
      result.subtype ?? 'workspace_setup_unknown',
      result.subtype === 'kilo_import_timeout'
        ? 'Session import timed out'
        : 'Session import failed',
      result.detail
    );
  }
  logToFile(
    `bootstrap empty kilo session ready kiloSessionId=${request.kiloSessionId} diffsApplied=${result.diffs.applied} diffsSkipped=${result.diffs.skipped} diffsTotal=${result.diffs.total}`
  );
}

async function restoreOrBootstrapKiloSession(
  request: WrapperSessionReadyRequest,
  restore: typeof restoreSession
): Promise<void> {
  if (request.workspace.preferSnapshot) {
    logToFile(
      `bootstrap snapshot restore starting kiloSessionId=${request.kiloSessionId} workspacePath=${request.workspace.workspacePath}`
    );
    const result = await restore(request.kiloSessionId, request.workspace.workspacePath);
    if (result.ok) {
      logToFile(
        `bootstrap snapshot restore ready kiloSessionId=${request.kiloSessionId} downloaded=${result.downloaded} diffsApplied=${result.diffs.applied} diffsSkipped=${result.diffs.skipped} diffsTotal=${result.diffs.total}`
      );
      return;
    }
    logToFile(
      `bootstrap snapshot restore failed kiloSessionId=${request.kiloSessionId} step=${result.step} code=${result.code ?? '(none)'} subtype=${result.subtype ?? '(none)'}`
    );
    if (result.code !== 404) {
      throw workspaceBootstrapError(
        result.subtype ?? 'workspace_setup_unknown',
        result.subtype === 'kilo_import_timeout'
          ? 'Session import timed out'
          : 'Session restore failed',
        result.detail
      );
    }
    logToFile(
      `bootstrap snapshot missing; falling back to empty import kiloSessionId=${request.kiloSessionId}`
    );
  } else {
    logToFile(`bootstrap fresh session using empty import kiloSessionId=${request.kiloSessionId}`);
  }
  await bootstrapEmptyKiloSession(request, restore);
}

async function reconcileRestoredWorkspace(
  request: WrapperSessionReadyRequest,
  runGit: GitRunner,
  progress: BootstrapProgress | undefined
): Promise<void> {
  const { workspacePath, branchName, upstreamBranch, strictBranch } = request.workspace;
  if (strictBranch && isSyntheticReviewRef(branchName)) {
    await fetchSyntheticReviewRef(runGit, workspacePath, branchName, progress);
    return;
  }

  let sourceBranch: string;
  if (upstreamBranch) {
    sourceBranch = upstreamBranch;
  } else if (strictBranch) {
    sourceBranch = branchName;
  } else {
    const defaultBranchResult = await runGit(
      ['ls-remote', '--symref', 'origin', 'HEAD'],
      longGitOptions(progress, 'branch', 'Resolving default branch...', workspacePath)
    );
    const defaultBranchMatch = defaultBranchResult.stdout.match(/^ref: refs\/heads\/(.+)\s+HEAD$/m);
    if (defaultBranchResult.exitCode !== 0 || !defaultBranchMatch?.[1]) {
      throw new Error('Failed to resolve authoritative remote default branch');
    }
    sourceBranch = defaultBranchMatch[1];
  }

  const fetchResult = await runGit(
    ['fetch', 'origin', sourceBranch],
    longGitOptions(progress, 'branch', 'Fetching authoritative state...', workspacePath)
  );
  if (fetchResult.exitCode !== 0) {
    throw new Error('Failed to fetch authoritative remote state');
  }

  const checkoutResult = await runGit(
    ['checkout', '-B', branchName, 'FETCH_HEAD'],
    longGitOptions(progress, 'branch', 'Checking out session branch...', workspacePath)
  );
  if (checkoutResult.exitCode !== 0) {
    throw new Error(`Failed to create session branch ${branchName} from origin/${sourceBranch}`);
  }
}

async function runSetupCommands(
  request: WrapperSessionReadyRequest,
  run: ProcessRunner,
  failFast: boolean,
  progress: BootstrapProgress | undefined
): Promise<void> {
  const setupCommands = request.materialized.setupCommands ?? [];
  logToFile(
    `bootstrap setup commands starting kiloSessionId=${request.kiloSessionId} count=${setupCommands.length} failFast=${failFast} workspacePath=${request.workspace.workspacePath}`
  );
  for (const [index, command] of setupCommands.entries()) {
    let lastProgressAt = 0;
    const startedAt = Date.now();
    const result = await run('sh', ['-lc', command], {
      cwd: request.workspace.workspacePath,
      inactivityTimeoutMs: SETUP_COMMAND_INACTIVITY_TIMEOUT_MS,
      hardTimeoutMs: LONG_COMMAND_HARD_TIMEOUT_MS,
      onOutput: () => {
        const now = Date.now();
        if (lastProgressAt !== 0 && now - lastProgressAt < PROGRESS_UPDATE_INTERVAL_MS) return;
        lastProgressAt = now;
        progress?.(
          'setup_commands',
          `Setup command ${index + 1} of ${setupCommands.length} is still running...`
        );
      },
    });
    logToFile(
      `bootstrap setup command finished kiloSessionId=${request.kiloSessionId} index=${index + 1} count=${setupCommands.length} elapsedMs=${Date.now() - startedAt} exitCode=${result.exitCode} terminationReason=${result.terminationReason ?? '(none)'}`
    );
    if (result.exitCode !== 0 && failFast) {
      const timedOut = isTimeoutTermination(result);
      throw workspaceBootstrapError(
        timedOut ? 'setup_command_timeout' : 'setup_command_failed',
        `Setup command ${index + 1} ${timedOut ? 'timed out' : 'failed'}`,
        createSafeProcessDiagnostic(result)
      );
    }
  }
  logToFile(
    `bootstrap setup commands finished kiloSessionId=${request.kiloSessionId} count=${setupCommands.length}`
  );
}

async function downloadAttachment(
  attachment: WrapperBootstrapAttachment,
  fetchImpl: typeof fetch,
  writeResponse: (filePath: string, response: Response) => Promise<number>
): Promise<WrapperPromptPart> {
  await fs.mkdir(path.dirname(attachment.localPath), { recursive: true });
  const response = await fetchImpl(attachment.signedUrl, {
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) {
    throw new Error(`Attachment download failed: ${attachment.filename}`);
  }
  const contentLength = response.headers.get('content-length');
  if (contentLength && Number(contentLength) > MAX_ATTACHMENT_BYTES) {
    throw new Error(`Attachment too large: ${attachment.filename}`);
  }
  await writeResponse(attachment.localPath, response);
  return {
    type: 'file',
    mime: attachment.mime,
    url: `file://${attachment.localPath}`,
    filename: attachment.filename,
  };
}

export async function materializePromptAttachments(
  prompt: WrapperPromptRequest,
  deps: {
    fetch?: typeof fetch;
    writeResponse?: (filePath: string, response: Response) => Promise<number>;
  } = {}
): Promise<WrapperPromptRequest> {
  if (!prompt.message.attachments?.length) return prompt;
  const fetchImpl = deps.fetch ?? fetch;
  const writeResponse =
    deps.writeResponse ?? ((filePath: string, response: Response) => Bun.write(filePath, response));
  const fileParts: WrapperPromptPart[] = [];
  for (const attachment of prompt.message.attachments) {
    fileParts.push(await downloadAttachment(attachment, fetchImpl, writeResponse));
  }
  return {
    ...prompt,
    message: {
      ...prompt.message,
      parts: [
        ...(prompt.message.parts ?? [{ type: 'text', text: prompt.message.prompt ?? '' }]),
        ...fileParts,
      ],
      prompt: undefined,
      attachments: undefined,
    },
  };
}

async function prepareWrapperBootstrapWorkspaceWithinDeadline(
  request: WrapperSessionReadyRequest,
  progress: BootstrapProgress | undefined,
  deps: WrapperBootstrapDeps,
  signal: AbortSignal
): Promise<WrapperBootstrapResult> {
  const runGit = deps.git ?? git;
  const run = deps.runProcess ?? runProcess;
  const restore = deps.restoreSession ?? restoreSession;

  Object.assign(process.env, request.materialized.env);

  let workspaceWasWarm = false;
  let workspaceNeedsBootstrap = true;
  const restoredFromBackup = request.workspace.restoredFromBackup === true;

  try {
    workspaceWasWarm = await isCompleteGitWorkspace(request.workspace.workspacePath);
    workspaceNeedsBootstrap =
      restoredFromBackup || !workspaceWasWarm || !request.workspace.preferSnapshot;
    logToFile(
      `bootstrap workspace plan kiloSessionId=${request.kiloSessionId} preferSnapshot=${request.workspace.preferSnapshot} workspaceWasWarm=${workspaceWasWarm} workspaceNeedsBootstrap=${workspaceNeedsBootstrap} workspacePath=${request.workspace.workspacePath} sessionHome=${request.workspace.sessionHome} home=${process.env.HOME ?? '(unset)'} homeMatchesSessionHome=${process.env.HOME === request.workspace.sessionHome} repoKind=${request.repo?.kind ?? '(none)'} setupCommandCount=${request.materialized.setupCommands?.length ?? 0} runtimeSkillCount=${request.materialized.runtimeSkills?.length ?? 0}`
    );
    if (!workspaceWasWarm) {
      progress?.('workspace_setup', 'Setting up workspace...');
    }

    await ensureWorkspaceDirectories(request);
    signal.throwIfAborted();

    if (workspaceNeedsBootstrap) {
      await fs.rm(gitBootstrapMarkerPath(request.workspace.workspacePath), { force: true });
    }

    await writeCloudAgentRules(request);

    if (workspaceWasWarm) {
      logToFile(
        `bootstrap warm workspace refreshing remote kiloSessionId=${request.kiloSessionId}`
      );
      if (workspaceNeedsBootstrap || !(await sanitizeBitbucketCodeReviewRemote(request, runGit))) {
        await refreshGitRemoteToken(request, runGit);
      }
      logToFile(`bootstrap warm workspace remote ready kiloSessionId=${request.kiloSessionId}`);
    } else {
      progress?.('cloning', 'Cloning repository...');
      logToFile(
        `bootstrap cold workspace cloning repository kiloSessionId=${request.kiloSessionId}`
      );
      await cloneRepository(request, runGit, progress, signal);
      logToFile(`bootstrap cold workspace clone ready kiloSessionId=${request.kiloSessionId}`);
    }

    if (workspaceNeedsBootstrap) {
      progress?.('branch', 'Setting up branch...');
      logToFile(
        `bootstrap branch preparation starting kiloSessionId=${request.kiloSessionId} branchName=${request.workspace.branchName} strictBranch=${request.workspace.strictBranch ?? false}`
      );
      if (restoredFromBackup) {
        try {
          const urls = repositoryUrls(request);
          if (urls) await setOriginUrl(request, runGit, urls.authenticated);
          await reconcileRestoredWorkspace(request, runGit, progress);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          throw new RestoredWorkspaceReconciliationError(message, { cause: error });
        }
      } else {
        await prepareBranch(request, runGit, progress);
      }
      logToFile(
        `bootstrap branch preparation ready kiloSessionId=${request.kiloSessionId} branchName=${request.workspace.branchName}`
      );
      await sanitizeBitbucketCodeReviewRemote(request, runGit);

      await writeSessionAuthFile(request);
      await writeRuntimeSkills(request);

      progress?.(
        'kilo_session',
        request.workspace.preferSnapshot ? 'Restoring session...' : 'Importing session...'
      );
      await restoreOrBootstrapKiloSession(request, restore);

      if (request.materialized.setupCommands?.length) {
        progress?.('setup_commands', 'Running setup commands...');
        await runSetupCommands(request, run, !request.workspace.preferSnapshot, progress);
      }

      signal.throwIfAborted();
      await fs.writeFile(gitBootstrapMarkerPath(request.workspace.workspacePath), 'ready\n');
    }

    signal.throwIfAborted();
    logToFile(
      `bootstrap workspace ready kiloSessionId=${request.kiloSessionId} workspaceWasWarm=${workspaceWasWarm} workspaceNeedsBootstrap=${workspaceNeedsBootstrap}`
    );
    progress?.('kilo_server', 'Starting Kilo...');
    return { workspaceWasWarm };
  } catch (error) {
    if (error instanceof RestoredWorkspaceReconciliationError) {
      if (workspaceNeedsBootstrap) {
        await cleanupWorkspace(request);
      }
      throw error;
    }
    const bootstrapError =
      error instanceof WrapperBootstrapError
        ? error
        : workspaceBootstrapError('workspace_setup_unknown', 'Workspace setup failed');
    logToFile(
      `bootstrap workspace failed kiloSessionId=${request.kiloSessionId} workspaceWasWarm=${workspaceWasWarm} workspaceNeedsBootstrap=${workspaceNeedsBootstrap} willCleanup=${workspaceNeedsBootstrap} code=${bootstrapError.code} subtype=${bootstrapError.subtype ?? '(none)'}`
    );
    if (workspaceNeedsBootstrap) {
      await cleanupWorkspace(request);
      logToFile(`bootstrap workspace cleanup finished kiloSessionId=${request.kiloSessionId}`);
    }
    throw bootstrapError;
  }
}

function withWorkspaceSignal(
  options: ProcessOptions | undefined,
  workspaceSignal: AbortSignal
): ProcessOptions {
  const signal = options?.signal
    ? AbortSignal.any([options.signal, workspaceSignal])
    : workspaceSignal;
  return { ...options, signal };
}

export async function prepareWrapperBootstrapWorkspace(
  request: WrapperSessionReadyRequest,
  progress?: BootstrapProgress,
  deps: WrapperBootstrapDeps = {},
  externalSignal?: AbortSignal
): Promise<WrapperBootstrapResult> {
  const workspacePreparationTimeoutMs =
    deps.workspacePreparationTimeoutMs ?? WORKSPACE_PREPARATION_TIMEOUT_MS;
  const timeoutError = workspaceBootstrapError(
    'workspace_setup_unknown',
    `Workspace preparation timed out after ${workspacePreparationTimeoutMs / 1000}s`
  );
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(timeoutError), workspacePreparationTimeoutMs);
  const workspaceSignal = externalSignal
    ? AbortSignal.any([controller.signal, externalSignal])
    : controller.signal;
  const runGit = deps.git ?? git;
  const run = deps.runProcess ?? runProcess;
  const restore = deps.restoreSession ?? restoreSession;

  try {
    return await prepareWrapperBootstrapWorkspaceWithinDeadline(
      request,
      progress,
      {
        ...deps,
        git: (args, options) => runGit(args, withWorkspaceSignal(options, workspaceSignal)),
        runProcess: (command, args, options) =>
          run(command, args, withWorkspaceSignal(options, workspaceSignal)),
        restoreSession: (kiloSessionId, workspacePath, filePath, options) =>
          restore(kiloSessionId, workspacePath, filePath, {
            ...options,
            signal: options?.signal
              ? AbortSignal.any([options.signal, workspaceSignal])
              : workspaceSignal,
          }),
      },
      workspaceSignal
    );
  } catch (error) {
    if (workspaceSignal.reason === timeoutError) throw timeoutError;
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
