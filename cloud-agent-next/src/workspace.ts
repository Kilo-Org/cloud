import type { SandboxInstance, ExecutionSession, SystemSandboxUsageEvent } from './types.js';
import { logger } from './logger.js';
import { withTimeout } from './utils/timeout.js';

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

const SESSION_HOME_ROOT = `/home`;
const KILOCODE_DIR = `.kilocode`;
const CLI_DIR = `${KILOCODE_DIR}/cli`;
const CLI_GLOBAL_TASKS_PATH = `${CLI_DIR}/global/tasks`;
const CLI_LOGS_PATH = `${CLI_DIR}/logs`;

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

export interface SessionPaths {
  workspacePath: string;
  sessionHome: string;
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
 * @param session - Execution session
 * @param workspacePath - Path to the session workspace (e.g., /workspace/org/user/sessions/sessionId)
 * @param sessionHome - Path to the session home (e.g., /home/sessionId)
 */
export async function cleanupWorkspace(
  session: ExecutionSession,
  workspacePath: string,
  sessionHome: string
): Promise<void> {
  logger.setTags({ workspacePath, sessionHome });
  logger.info('Cleaning up workspace directories');

  try {
    // Delete workspace directory
    const workspaceResult = await session.exec(`rm -rf '${workspacePath}'`);
    if (workspaceResult.exitCode !== 0) {
      logger
        .withFields({ stderr: workspaceResult.stderr })
        .warn('Failed to delete workspace directory');
    }

    // Delete session home directory
    const homeResult = await session.exec(`rm -rf '${sessionHome}'`);
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

export type GitAuthorConfig = {
  name: string;
  email: string;
};

export const LOW_DISK_THRESHOLD_MB = 2048; // 2GB

/**
 * Result of disk space check with structured fields.
 */
export type DiskSpaceResult = {
  availableMB: number;
  totalMB: number;
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
export async function checkDiskSpace(session: ExecutionSession): Promise<DiskSpaceResult> {
  // df -B1 gives output in bytes for clean numeric parsing (no M/G/K suffixes)
  // --output=avail,size gives available and total space
  // Always use "/" since all container paths share the same root filesystem
  const result = await session.exec('df -B1 --output=avail,size / | tail -1');

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
  session: ExecutionSession,
  sessionId?: string
): Promise<SystemSandboxUsageEvent> {
  const result = await checkDiskSpace(session);

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
  options?: { shallow?: boolean }
): Promise<void> {
  // Build URL with token if available (for private repos)
  // Use x-access-token format which works across most git providers
  let repoUrl = gitUrl;
  if (gitToken) {
    const url = new URL(gitUrl);
    url.username = 'x-access-token';
    url.password = gitToken;
    repoUrl = url.toString();
  }

  const sanitizedGitUrl = sanitizeGitUrlForLogging(gitUrl);
  const shallow = options?.shallow ?? false;
  logger.setTags({ gitUrl: sanitizedGitUrl, workspacePath, shallow });
  logger.info('Cloning generic git repository');

  try {
    // Git clone with 2-minute timeout to prevent indefinite hangs
    const CLONE_TIMEOUT_MS = 120_000; // 2 minutes
    const result = await withTimeout(
      session.gitCheckout(repoUrl, {
        targetDir: workspacePath,
        // Use depth: 1 for shallow clones (faster, less disk space)
        ...(shallow && { depth: 1 }),
      }),
      CLONE_TIMEOUT_MS,
      `Git clone timed out after ${CLONE_TIMEOUT_MS / 1000} seconds for ${sanitizedGitUrl}`
    );

    if (!result.success) {
      throw new Error(`gitCheckout failed with exit code ${result.exitCode ?? 'unknown'}`);
    }

    const authorName = gitAuthor?.name ?? 'Kilo Code Cloud';
    const authorEmail = gitAuthor?.email ?? 'agent@kilocode.ai';

    await session.exec(`cd ${workspacePath} && git config user.name "${authorName}"`);
    await session.exec(`cd ${workspacePath} && git config user.email "${authorEmail}"`);

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

/**
 * Update the git remote origin URL to include a new token.
 * This is needed when the git token changes and we need to push/pull.
 * Uses the same x-access-token format as cloneGitRepo() for consistency.
 *
 * @param session - Execution session
 * @param workspacePath - Path to the git repository
 * @param gitUrl - Full git URL (e.g., https://github.com/org/repo.git)
 * @param gitToken - New git token for authentication
 */
export async function updateGitRemoteToken(
  session: ExecutionSession,
  workspacePath: string,
  gitUrl: string,
  gitToken: string
): Promise<void> {
  // Build new URL with token embedded (same format as cloneGitRepo)
  const newUrl = new URL(gitUrl);
  newUrl.username = 'x-access-token';
  newUrl.password = gitToken;

  const sanitizedGitUrl = sanitizeGitUrlForLogging(gitUrl);
  logger.setTags({ workspacePath, gitUrl: sanitizedGitUrl });
  logger.info('Updating git remote URL with new token');

  const result = await session.exec(
    `cd '${workspacePath}' && git remote set-url origin '${newUrl.toString()}'`
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
  const result = await session.exec(`cd ${workspacePath} && git fetch origin`);
  if (result.exitCode !== 0) {
    logger.withFields({ stderr: result.stderr }).warn('Git fetch failed');
  }
}

async function branchExistsLocally(
  session: ExecutionSession,
  workspacePath: string,
  branchName: string
): Promise<boolean> {
  const result = await session.exec(
    `cd ${workspacePath} && git rev-parse --verify '${branchName}' 2>/dev/null`
  );
  return result.exitCode === 0;
}

async function branchExistsRemotely(
  session: ExecutionSession,
  workspacePath: string,
  branchName: string
): Promise<boolean> {
  const result = await session.exec(
    `cd ${workspacePath} && git rev-parse --verify 'origin/${branchName}' 2>/dev/null`
  );
  return result.exitCode === 0;
}

async function checkoutExistingBranch(
  session: ExecutionSession,
  workspacePath: string,
  branchName: string
): Promise<void> {
  const result = await session.exec(`cd ${workspacePath} && git checkout '${branchName}'`);
  if (result.exitCode !== 0) {
    throw new Error(`Failed to checkout branch ${branchName}: ${result.stderr || result.stdout}`);
  }
}

async function pullLatestChangesLenient(
  session: ExecutionSession,
  workspacePath: string,
  branchName: string
): Promise<void> {
  const result = await session.exec(`cd ${workspacePath} && git pull origin '${branchName}'`);
  if (result.exitCode !== 0) {
    // Session branches might have unpushed work or conflicts, just warn
    logger
      .withFields({ branchName, stderr: result.stderr })
      .warn('Could not pull branch, continuing with local version');
  }
}

async function createTrackingBranch(
  session: ExecutionSession,
  workspacePath: string,
  branchName: string
): Promise<void> {
  const result = await session.exec(
    `cd ${workspacePath} && git checkout -b '${branchName}' 'origin/${branchName}'`
  );
  if (result.exitCode !== 0) {
    throw new Error(
      `Failed to create tracking branch ${branchName}: ${result.stderr || result.stdout}`
    );
  }
}

async function createNewBranch(
  session: ExecutionSession,
  workspacePath: string,
  branchName: string
): Promise<void> {
  const result = await session.exec(`cd ${workspacePath} && git checkout -b '${branchName}'`);
  if (result.exitCode !== 0) {
    throw new Error(`Failed to create branch ${branchName}: ${result.stderr || result.stdout}`);
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
      throw new Error(
        `Branch "${branchName}" not found in repository. Please ensure the branch exists remotely.`
      );
    }
    await createNewBranch(session, workspacePath, branchName);
  }

  logger.debug('Successfully on branch');
  return branchName;
}
