import type { SandboxInstance, ExecutionSession, SystemSandboxUsageEvent } from './types.js';
import type { ExecResult, ExecOptions } from '@cloudflare/sandbox';
import { logger } from './logger.js';
import { findWrapperForSessionInProcesses } from './kilo/wrapper-manager.js';
import {
  DISK_CHECK_TIMEOUT_MS,
  FAST_SANDBOX_COMMAND_TIMEOUT_MS,
  GIT_CLONE_TIMEOUT_MS,
  GIT_COMMAND_TIMEOUT_MS,
  logSandboxOperationTimeout,
  timedExec,
  withSandboxOperationTimeoutLog,
} from './sandbox-timeout-logging.js';
import { withTimeout } from '@kilocode/worker-utils';

/**
 * Minimal interface for running shell commands.
 * Both SandboxInstance and ExecutionSession satisfy this,
 * letting us run disk checks before a session exists.
 */
export type CommandExecutor = {
  exec(command: string, options?: ExecOptions): Promise<ExecResult>;
};

/**
 * Sanitize a string for use in filesystem paths by replacing forbidden characters with dashes.
 * This handles user IDs that may contain characters like `/` or `:` (e.g., `oauth/google:1234`).
 */
export function sanitizeIdForPath(value: string): string {
  return value.replace(/[/:]/g, '-');
}

// Sanitize a git URL by removing any credentials (username/password) from it.
function sanitizeGitUrlForLogging(gitUrl: string): string {
  try {
    const url = new URL(gitUrl);
    // Remove username and password if present
    url.username = '';
    url.password = '';
    return url.toString();
  } catch {
    // If URL parsing fails, return as-is (shouldn't happen with validated URLs)
    return gitUrl;
  }
}

// Mask authentication tokens in git output to prevent leaking secrets in logs/errors.
// Handles patterns like `oauth2:TOKEN@`, `x-access-token:TOKEN@`, and `x-token-auth:TOKEN@`.
function sanitizeGitOutput(output: string): string {
  return output.replace(/(oauth2|x-access-token|x-token-auth):([^@]+)@/gi, '$1:***@');
}

const SESSION_HOME_ROOT = `/home`;
const KILOCODE_DIR = `.kilocode`;
const CLI_DIR = `${KILOCODE_DIR}/cli`;
const CLI_GLOBAL_TASKS_PATH = `${CLI_DIR}/global/tasks`;
const CLI_LOGS_PATH = `${CLI_DIR}/logs`;

// Re-export timeout constants so existing imports from workspace.ts keep working.
export {
  DISK_CHECK_TIMEOUT_MS,
  FAST_SANDBOX_COMMAND_TIMEOUT_MS,
  GIT_CLONE_TIMEOUT_MS,
  GIT_COMMAND_TIMEOUT_MS,
} from './sandbox-timeout-logging.js';

export function getBaseWorkspacePath(
  kilocodeOrganizationId: string | undefined,
  userId: string
): string {
  const safeUserId = sanitizeIdForPath(userId);
  // Personal accounts (no orgId) get simpler path without orgId segment
  if (!kilocodeOrganizationId) {
    return `/workspace/${safeUserId}`;
  }
  // Org accounts maintain orgId/userId structure
  return `/workspace/${kilocodeOrganizationId}/${safeUserId}`;
}

export function getSessionWorkspacePath(
  kilocodeOrganizationId: string | undefined,
  userId: string,
  sessionId: string
): string {
  return `${getBaseWorkspacePath(kilocodeOrganizationId, userId)}/sessions/${sessionId}`;
}

export function getSessionHomePath(sessionId: string): string {
  return `${SESSION_HOME_ROOT}/${sessionId}`;
}

export function getKilocodeCliDir(sessionHome: string): string {
  return `${sessionHome}/${CLI_DIR}`;
}

export function getKilocodeLogsDir(sessionHome: string): string {
  return `${sessionHome}/${CLI_LOGS_PATH}`;
}

export function getKilocodeLogFilePath(sessionHome: string): string {
  return `${getKilocodeLogsDir(sessionHome)}/cli.txt`;
}

export function getWrapperLogFilePath(executionId: string): string {
  return `/tmp/kilocode-wrapper-${executionId}.log`;
}

export function getKilocodeTasksDir(sessionHome: string): string {
  return `${sessionHome}/${CLI_GLOBAL_TASKS_PATH}`;
}

export function getKilocodeGlobalDir(sessionHome: string): string {
  return `${getKilocodeCliDir(sessionHome)}/global`;
}

export type SessionPaths = {
  workspacePath: string;
  sessionHome: string;
};

/**
 * Check disk space and clean up stale workspaces if low, using the sandbox
 * directly so it can run before any session or workspace directory exists.
 * Errors are caught and logged — never rethrown — so cleanup failure never blocks setup.
 */
export async function checkDiskAndCleanBeforeSetup(
  sandbox: SandboxInstance,
  orgId: string | undefined,
  userId: string,
  sessionId: string
): Promise<void> {
  try {
    const diskSpace = await checkDiskSpace(sandbox);
    if (diskSpace.isLow) {
      logger.info('Low disk space detected before workspace setup, cleaning stale workspaces');
      await cleanupStaleWorkspaces(sandbox, getBaseWorkspacePath(orgId, userId), sessionId);
    }
  } catch (error) {
    // Log and continue — a failed disk check should not block workspace setup.
    // The worst case is that mkdir fails (which it would have anyway without cleanup).
    logger
      .withFields({ error: error instanceof Error ? error.message : String(error) })
      .warn('Pre-setup disk check failed, continuing with workspace setup');
  }
}

export async function setupWorkspace(
  sandbox: SandboxInstance,
  userId: string,
  kilocodeOrganizationId: string | undefined,
  sessionId: string
): Promise<SessionPaths> {
  const sessionWorkspacePath = getSessionWorkspacePath(kilocodeOrganizationId, userId, sessionId);
  const sessionHome = getSessionHomePath(sessionId);

  try {
    await sandbox.mkdir(sessionWorkspacePath, { recursive: true });
  } catch (error) {
    throw new Error(
      `Failed to create workspace directory: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  try {
    await sandbox.mkdir(sessionHome, { recursive: true });
  } catch (error) {
    throw new Error(
      `Failed to prepare session home: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  return {
    workspacePath: sessionWorkspacePath,
    sessionHome,
  };
}

/**
 * Clean up workspace directories for a session.
 * Removes both the workspace directory and session home directory.
 *
 * @param executor - Anything that can run shell commands (sandbox or session)
 * @param workspacePath - Path to the session workspace (e.g., /workspace/org/user/sessions/sessionId)
 * @param sessionHome - Path to the session home (e.g., /home/sessionId)
 */
export async function cleanupWorkspace(
  executor: CommandExecutor,
  workspacePath: string,
  sessionHome: string
): Promise<void> {
  logger.setTags({ workspacePath, sessionHome });
  logger.info('Cleaning up workspace directories');

  try {
    // Delete workspace directory
    const workspaceResult = await timedExec(
      executor,
      `rm -rf '${workspacePath}'`,
      'workspace.cleanup.workspace'
    );
    if (workspaceResult.exitCode !== 0) {
      logger
        .withFields({ stderr: workspaceResult.stderr })
        .warn('Failed to delete workspace directory');
    }

    // Delete session home directory
    const homeResult = await timedExec(
      executor,
      `rm -rf '${sessionHome}'`,
      'workspace.cleanup.home'
    );
    if (homeResult.exitCode !== 0) {
      logger
        .withFields({ stderr: homeResult.stderr })
        .warn('Failed to delete session home directory');
    }

    logger.info('Workspace cleanup completed');
  } catch (error) {
    logger
      .withFields({ error: error instanceof Error ? error.message : String(error) })
      .warn('Workspace cleanup encountered an error');
    // Don't throw - cleanup failures shouldn't block session termination
  }
}

/**
 * Clean up workspace directories for sessions that no longer have a running wrapper.
 * Called when disk space is low to reclaim space from abandoned sessions.
 * Errors are caught and logged — never rethrown — so cleanup failure never blocks setup.
 */
export async function cleanupStaleWorkspaces(
  sandbox: SandboxInstance,
  baseWorkspacePath: string,
  currentSessionId: string
): Promise<void> {
  logger
    .withFields({ baseWorkspacePath, currentSessionId })
    .info('Starting stale workspace cleanup');

  let sessionDirs: string[];
  try {
    const lsResult = await timedExec(
      sandbox,
      `ls -1 '${baseWorkspacePath}/sessions/'`,
      'workspace.cleanupStale.listSessions'
    );
    if (lsResult.exitCode !== 0 || !lsResult.stdout) {
      logger
        .withFields({ stderr: lsResult.stderr })
        .info('No sessions directory or listing failed, skipping cleanup');
      return;
    }
    sessionDirs = lsResult.stdout
      .trim()
      .split('\n')
      .map(d => d.trim())
      .filter(d => /^agent_[\w-]+$/.test(d));
  } catch (error) {
    logger
      .withFields({ error: error instanceof Error ? error.message : String(error) })
      .warn('Failed to list sessions directory, skipping cleanup');
    return;
  }

  logger.withFields({ found: sessionDirs.length }).info('Found session directories');

  // Fetch the process list once so we don't call listProcesses() per session
  let processes: Awaited<ReturnType<SandboxInstance['listProcesses']>>;
  try {
    processes = await sandbox.listProcesses();
  } catch (error) {
    logger
      .withFields({ error: error instanceof Error ? error.message : String(error) })
      .warn('Failed to list processes, skipping cleanup');
    return;
  }

  // Get current epoch once so we can age-check directories without re-shelling per candidate
  const nowSeconds = Math.floor(Date.now() / 1000);

  let cleaned = 0;
  let skipped = 0;

  for (const candidateSessionId of sessionDirs) {
    if (candidateSessionId === currentSessionId) {
      skipped++;
      continue;
    }

    try {
      // Skip directories younger than STALE_DIR_MIN_AGE_SECONDS to avoid deleting
      // sessions that are mid-setup (cloning, running setup commands, etc.) and
      // haven't started their wrapper process yet.
      // If we can't determine age (stat fails or unparseable), also skip — unknown
      // age is treated as potentially recent to avoid destroying active work.
      const workspacePath = `${baseWorkspacePath}/sessions/${candidateSessionId}`;
      const statResult = await timedExec(
        sandbox,
        `stat -c %Y '${workspacePath}'`,
        'workspace.cleanupStale.statSession'
      );
      if (statResult.exitCode !== 0 || !statResult.stdout) {
        logger
          .withFields({ candidateSessionId })
          .info('Skipping session: could not determine directory age');
        skipped++;
        continue;
      }
      const mtimeSeconds = Number.parseInt(statResult.stdout.trim(), 10);
      if (!Number.isFinite(mtimeSeconds)) {
        logger
          .withFields({ candidateSessionId })
          .info('Skipping session: could not parse directory mtime');
        skipped++;
        continue;
      }
      const ageSeconds = nowSeconds - mtimeSeconds;
      if (ageSeconds < STALE_DIR_MIN_AGE_SECONDS) {
        logger
          .withFields({ candidateSessionId, ageSeconds })
          .info('Skipping session: directory too recent');
        skipped++;
        continue;
      }

      const wrapperInfo = findWrapperForSessionInProcesses(processes, candidateSessionId);
      if (wrapperInfo !== null) {
        logger.withFields({ candidateSessionId }).info('Skipping session: wrapper is running');
        skipped++;
        continue;
      }

      const sessionHome = getSessionHomePath(candidateSessionId);
      logger
        .withFields({ candidateSessionId, workspacePath, sessionHome })
        .info('Removing stale session directories');

      await cleanupWorkspace(sandbox, workspacePath, sessionHome);
      cleaned++;
    } catch (error) {
      logger
        .withFields({
          candidateSessionId,
          error: error instanceof Error ? error.message : String(error),
        })
        .warn('Error while cleaning up stale session, continuing');
    }
  }

  logger.withFields({ cleaned, skipped }).info('Stale workspace cleanup complete');
}

export type GitAuthorConfig = {
  name: string;
  email: string;
};

export const LOW_DISK_THRESHOLD_MB = 2048; // 2GB
export const STALE_DIR_MIN_AGE_SECONDS = 1200; // 20 minutes — protect sessions mid-setup

/**
 * Result of disk space check with structured fields.
 */
export type DiskSpaceResult = {
  availableMB: number;
  totalMB: number;
  isLow: boolean;
};

/**
 * Check available disk space and total disk space for the container.
 * Uses `df` command on the root filesystem which is available in the sandbox environment.
 * Always checks `/` since all paths in the container share the same filesystem.
 *
 * @param session - Execution session to run the check
 * @returns Structured disk space result
 * @throws Error if disk check fails (command error, parse error, or exception)
 */
export async function checkDiskSpace(executor: CommandExecutor): Promise<DiskSpaceResult> {
  // df -B1 gives output in bytes for clean numeric parsing (no M/G/K suffixes)
  // --output=avail,size gives available and total space
  // Always use "/" since all container paths share the same root filesystem
  const result = await timedExec(
    executor,
    'df -B1 --output=avail,size / | tail -1',
    'workspace.checkDiskSpace',
    { timeoutMs: DISK_CHECK_TIMEOUT_MS }
  );

  if (result.exitCode !== 0) {
    logger
      .withFields({ exitCode: result.exitCode, stderr: result.stderr })
      .warn('Disk check: df command failed');
    throw new Error('Disk check failed');
  }

  // Output is like "123456789  5000000000" (pure numbers in bytes)
  const output = result.stdout.trim();
  const match = output.match(/^(\d+)\s+(\d+)$/);

  if (!match) {
    logger.withFields({ output }).warn('Disk check: unexpected df output format');
    throw new Error('Disk check failed');
  }

  const availableBytes = parseInt(match[1], 10);
  const totalBytes = parseInt(match[2], 10);
  const availableMB = Math.floor(availableBytes / (1024 * 1024));
  const totalMB = Math.floor(totalBytes / (1024 * 1024));
  const isLow = availableMB < LOW_DISK_THRESHOLD_MB;

  if (isLow) {
    logger
      .withFields({
        availableMB,
        totalMB,
        thresholdMB: LOW_DISK_THRESHOLD_MB,
      })
      .warn('Low disk space detected');
  }

  return {
    availableMB,
    totalMB,
    isLow,
  };
}

/**
 * Create a sandbox-usage event from disk space check.
 * Runs disk space check and returns a ready-to-emit event.
 *
 * @param session - Execution session to run the check
 * @param sessionId - Optional session ID to include in the event
 * @returns SystemSandboxUsageEvent ready for emission
 * @throws Error if disk check fails
 */
export async function createSandboxUsageEvent(
  executor: CommandExecutor,
  sessionId?: string
): Promise<SystemSandboxUsageEvent> {
  const result = await checkDiskSpace(executor);

  return {
    streamEventType: 'sandbox-usage',
    availableMB: result.availableMB,
    totalMB: result.totalMB,
    isLow: result.availableMB < LOW_DISK_THRESHOLD_MB,
    timestamp: new Date().toISOString(),
    sessionId,
  };
}

export async function cloneGitHubRepo(
  session: ExecutionSession,
  workspacePath: string,
  githubRepo: string,
  githubToken?: string,
  env?: { GITHUB_APP_SLUG?: string; GITHUB_APP_BOT_USER_ID?: string },
  options?: { shallow?: boolean }
): Promise<void> {
  // Convert GitHub repo format (org/repo) to full HTTPS URL and delegate to cloneGitRepo
  const gitUrl = `https://github.com/${githubRepo}.git`;

  // Build git author config from GitHub App environment variables
  let gitAuthor: GitAuthorConfig | undefined;
  if (env?.GITHUB_APP_SLUG && env?.GITHUB_APP_BOT_USER_ID) {
    gitAuthor = {
      name: `${env.GITHUB_APP_SLUG}[bot]`,
      email: `${env.GITHUB_APP_BOT_USER_ID}+${env.GITHUB_APP_SLUG}[bot]@users.noreply.github.com`,
    };
  }

  await cloneGitRepo(session, workspacePath, gitUrl, githubToken, gitAuthor, options);
}

export async function cloneGitRepo(
  session: ExecutionSession,
  workspacePath: string,
  gitUrl: string,
  gitToken?: string,
  gitAuthor?: GitAuthorConfig,
  options?: { shallow?: boolean; platform?: 'github' | 'gitlab' }
): Promise<void> {
  // Build URL with token if available (for private repos)
  // GitLab OAuth tokens require username 'oauth2'; all other providers use 'x-access-token'
  let repoUrl = gitUrl;
  if (gitToken) {
    const url = new URL(gitUrl);
    url.username = options?.platform === 'gitlab' ? 'oauth2' : 'x-access-token';
    url.password = gitToken;
    repoUrl = url.toString();
  }

  const sanitizedGitUrl = sanitizeGitUrlForLogging(gitUrl);
  const shallow = options?.shallow ?? false;
  logger.setTags({ gitUrl: sanitizedGitUrl, workspacePath, shallow });
  logger.info('Cloning generic git repository');

  try {
    // SDK clone timeout terminates the subprocess; the outer timeout bounds the request.
    const result = await withTimeout(
      withSandboxOperationTimeoutLog(
        session.gitCheckout(repoUrl, {
          targetDir: workspacePath,
          cloneTimeoutMs: GIT_CLONE_TIMEOUT_MS,
          // Use depth: 1 for shallow clones (faster, less disk space)
          ...(shallow && { depth: 1 }),
        }),
        {
          operation: 'git.clone',
          timeoutMs: GIT_CLONE_TIMEOUT_MS,
          timeoutLayer: 'sdk',
        }
      ),
      GIT_CLONE_TIMEOUT_MS + FAST_SANDBOX_COMMAND_TIMEOUT_MS,
      `Git clone request timed out after ${(GIT_CLONE_TIMEOUT_MS + FAST_SANDBOX_COMMAND_TIMEOUT_MS) / 1000} seconds for ${sanitizedGitUrl}`,
      () =>
        logSandboxOperationTimeout({
          operation: 'git.clone',
          timeoutMs: GIT_CLONE_TIMEOUT_MS + FAST_SANDBOX_COMMAND_TIMEOUT_MS,
          timeoutLayer: 'outer',
        })
    );

    if (!result.success) {
      throw new Error(`gitCheckout failed with exit code ${result.exitCode ?? 'unknown'}`);
    }

    const authorName = gitAuthor?.name ?? 'Kilo Code Cloud';
    const authorEmail = gitAuthor?.email ?? 'agent@kilocode.ai';

    await timedExec(
      session,
      `cd ${workspacePath} && git config user.name "${authorName}"`,
      'git.config.userName'
    );
    await timedExec(
      session,
      `cd ${workspacePath} && git config user.email "${authorEmail}"`,
      'git.config.userEmail'
    );

    logger.info('Successfully cloned generic git repository');
  } catch (err) {
    // Log actual error for debugging
    logger.error('Git clone failed', {
      error: err instanceof Error ? err.message : String(err),
      gitUrl: sanitizedGitUrl,
    });
    // Throw generic error to avoid leaking token in response
    throw new Error(`Failed to clone repository from ${sanitizedGitUrl}`);
  }
}

export type RestoreWorkspaceOptions = {
  githubRepo?: string;
  githubToken?: string;
  gitUrl?: string;
  gitToken?: string;
  gitAuthorEnv?: { GITHUB_APP_SLUG?: string; GITHUB_APP_BOT_USER_ID?: string };
  lastSeenBranch?: string;
  platform?: 'github' | 'gitlab';
};

export async function restoreWorkspace(
  session: ExecutionSession,
  workspacePath: string,
  branchName: string,
  options: RestoreWorkspaceOptions
): Promise<void> {
  if (options.gitUrl) {
    await cloneGitRepo(session, workspacePath, options.gitUrl, options.gitToken, undefined, {
      platform: options.platform,
    });
  } else if (options.githubRepo) {
    await cloneGitHubRepo(
      session,
      workspacePath,
      options.githubRepo,
      options.githubToken,
      options.gitAuthorEnv
    );
  } else {
    throw new Error('No repository source provided for workspace restore');
  }

  const targetBranchName = options.lastSeenBranch ?? branchName;
  await manageBranch(session, workspacePath, targetBranchName, false);
}

/**
 * Update the git remote origin URL to include a new token.
 * This is needed when the git token changes and we need to push/pull.
 *
 * @param session - Execution session
 * @param workspacePath - Path to the git repository
 * @param gitUrl - Full git URL (e.g., https://github.com/org/repo.git)
 * @param gitToken - New git token for authentication
 * @param platform - Git platform; GitLab requires 'oauth2' as the username
 */
export async function updateGitRemoteToken(
  session: ExecutionSession,
  workspacePath: string,
  gitUrl: string,
  gitToken: string,
  platform?: 'github' | 'gitlab'
): Promise<void> {
  // Build new URL with token embedded (GitLab uses 'oauth2', others use 'x-access-token')
  const newUrl = new URL(gitUrl);
  newUrl.username = platform === 'gitlab' ? 'oauth2' : 'x-access-token';
  newUrl.password = gitToken;

  const sanitizedGitUrl = sanitizeGitUrlForLogging(gitUrl);
  logger.setTags({ workspacePath, gitUrl: sanitizedGitUrl });
  logger.info('Updating git remote URL with new token');

  const result = await timedExec(
    session,
    `cd '${workspacePath}' && git remote set-url origin '${newUrl.toString()}'`,
    'git.updateRemoteToken'
  );

  if (result.exitCode !== 0) {
    // Log actual error for debugging (sanitized via structured logging)
    logger.error('Git remote update failed', {
      exitCode: result.exitCode,
    });
    // Throw generic error to avoid leaking token in response
    throw new Error(`Failed to update git remote URL`);
  }

  logger.info('Successfully updated git remote URL');
}

async function gitFetch(session: ExecutionSession, workspacePath: string): Promise<void> {
  const result = await timedExec(session, `cd ${workspacePath} && git fetch origin`, 'git.fetch', {
    timeoutMs: GIT_COMMAND_TIMEOUT_MS,
  });
  if (result.exitCode !== 0) {
    logger.withFields({ stderr: sanitizeGitOutput(result.stderr) }).warn('Git fetch failed');
  }
}

async function branchExistsLocally(
  session: ExecutionSession,
  workspacePath: string,
  branchName: string
): Promise<boolean> {
  const result = await timedExec(
    session,
    `cd ${workspacePath} && git rev-parse --verify '${branchName}' 2>/dev/null`,
    'git.branchExistsLocal'
  );
  return result.exitCode === 0;
}

async function branchExistsRemotely(
  session: ExecutionSession,
  workspacePath: string,
  branchName: string
): Promise<boolean> {
  const result = await timedExec(
    session,
    `cd ${workspacePath} && git rev-parse --verify 'origin/${branchName}' 2>/dev/null`,
    'git.branchExistsRemote'
  );
  return result.exitCode === 0;
}

async function checkoutExistingBranch(
  session: ExecutionSession,
  workspacePath: string,
  branchName: string
): Promise<void> {
  const result = await timedExec(
    session,
    `cd ${workspacePath} && git checkout '${branchName}'`,
    'git.checkoutExistingBranch'
  );
  if (result.exitCode !== 0) {
    throw new Error(
      `Failed to checkout branch ${branchName}: ${sanitizeGitOutput(result.stderr || result.stdout)}`
    );
  }
}

async function pullLatestChangesLenient(
  session: ExecutionSession,
  workspacePath: string,
  branchName: string
): Promise<void> {
  const result = await timedExec(
    session,
    `cd ${workspacePath} && git pull origin '${branchName}'`,
    'git.pullLatestChanges',
    { timeoutMs: GIT_COMMAND_TIMEOUT_MS }
  );
  if (result.exitCode !== 0) {
    // Session branches might have unpushed work or conflicts, just warn
    logger
      .withFields({ branchName, stderr: sanitizeGitOutput(result.stderr) })
      .warn('Could not pull branch, continuing with local version');
  }
}

async function createTrackingBranch(
  session: ExecutionSession,
  workspacePath: string,
  branchName: string
): Promise<void> {
  const result = await timedExec(
    session,
    `cd ${workspacePath} && git checkout -b '${branchName}' 'origin/${branchName}'`,
    'git.createTrackingBranch'
  );
  if (result.exitCode !== 0) {
    throw new Error(
      `Failed to create tracking branch ${branchName}: ${sanitizeGitOutput(result.stderr || result.stdout)}`
    );
  }
}

async function createNewBranch(
  session: ExecutionSession,
  workspacePath: string,
  branchName: string
): Promise<void> {
  const result = await timedExec(
    session,
    `cd ${workspacePath} && git checkout -b '${branchName}'`,
    'git.createNewBranch'
  );
  if (result.exitCode !== 0) {
    throw new Error(
      `Failed to create branch ${branchName}: ${sanitizeGitOutput(result.stderr || result.stdout)}`
    );
  }
}

const GITHUB_PULL_REF_PATTERN = /^refs\/pull\/\d+\/head$/;
const GITLAB_MR_REF_PATTERN = /^refs\/merge-requests\/\d+\/head$/;

async function fetchPullRefAndCheckout(
  session: ExecutionSession,
  workspacePath: string,
  pullRef: string
): Promise<void> {
  if (!GITHUB_PULL_REF_PATTERN.test(pullRef) && !GITLAB_MR_REF_PATTERN.test(pullRef)) {
    throw new Error(`Invalid pull ref format: ${pullRef}`);
  }

  const fetchResult = await timedExec(
    session,
    `cd ${workspacePath} && git fetch origin '${pullRef}'`,
    'git.fetchPullRef',
    { timeoutMs: GIT_COMMAND_TIMEOUT_MS }
  );
  if (fetchResult.exitCode !== 0) {
    throw new Error(
      `Failed to fetch pull ref ${pullRef}: ${sanitizeGitOutput(fetchResult.stderr || fetchResult.stdout)}`
    );
  }

  const checkoutResult = await timedExec(
    session,
    `cd ${workspacePath} && git checkout -B '${pullRef}' FETCH_HEAD`,
    'git.checkoutPullRef'
  );
  if (checkoutResult.exitCode !== 0) {
    throw new Error(
      `Failed to checkout pull ref ${pullRef}: ${sanitizeGitOutput(checkoutResult.stderr || checkoutResult.stdout)}`
    );
  }
}

/**
 * Manage branch checkout/creation.
 *
 * This function handles both upstream and session branches with different strategies:
 *
 * Upstream branches (isUpstreamBranch=true):
 * - MUST exist remotely (error if not found)
 * - Fetch + checkout (creates tracking branch if needed) *
 * Session branches (isUpstreamBranch=false):
 * - Try remote first, create fresh if not found
 * - Checkout + lenient pull to sync with remote
 * - Allows for unpushed work or force-pushes
 *
 * @param session - Execution session
 * @param workspacePath - Path to the git repository
 * @param branchName - Name of the branch to check out/create
 * @param isUpstreamBranch - Whether this is an upstream branch (must exist remotely)
 */
export async function manageBranch(
  session: ExecutionSession,
  workspacePath: string,
  branchName: string,
  isUpstreamBranch: boolean = false
): Promise<string> {
  logger.setTags({ branchName, workspacePath });
  logger.withTags({ isUpstream: isUpstreamBranch }).info('Managing branch');

  // Fetch latest refs from remote
  await gitFetch(session, workspacePath);

  // Check branch existence in parallel
  const [existsLocally, existsRemotely] = await Promise.all([
    branchExistsLocally(session, workspacePath, branchName),
    branchExistsRemotely(session, workspacePath, branchName),
  ]);

  logger.withTags({ existsLocally, existsRemotely }).debug('Branch status');

  // Four explicit cases
  if (existsLocally && existsRemotely) {
    // Case 1: Exists in both places - checkout and sync
    await checkoutExistingBranch(session, workspacePath, branchName);

    // Only pull for session branches, not upstream
    if (!isUpstreamBranch) {
      await pullLatestChangesLenient(session, workspacePath, branchName);
    }
    // For upstream: fetch already happened, checkout is done, leave as-is
  } else if (existsLocally && !existsRemotely) {
    // Case 2: Only exists locally - just checkout
    await checkoutExistingBranch(session, workspacePath, branchName);
  } else if (!existsLocally && existsRemotely) {
    // Case 3: Only exists remotely - create tracking branch
    await createTrackingBranch(session, workspacePath, branchName);
  } else {
    // Case 4: Doesn't exist anywhere
    if (isUpstreamBranch) {
      if (GITHUB_PULL_REF_PATTERN.test(branchName) || GITLAB_MR_REF_PATTERN.test(branchName)) {
        await fetchPullRefAndCheckout(session, workspacePath, branchName);
        logger.withTags({ pullRef: branchName }).info('Checked out pull/merge-request ref');
        logger.debug('Successfully on branch');
        return branchName;
      }

      throw new Error(
        `Branch "${branchName}" not found in repository. Please ensure the branch exists remotely.`
      );
    }
    await createNewBranch(session, workspacePath, branchName);
  }

  logger.debug('Successfully on branch');
  return branchName;
}
