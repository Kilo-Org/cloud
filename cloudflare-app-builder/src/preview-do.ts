import { DurableObject } from 'cloudflare:workers';
import { stripVTControlCharacters } from 'node:util';
import type { ProcessStatus } from '@cloudflare/sandbox';
import { getSandbox, parseSSEStream, type ExecEvent } from '@cloudflare/sandbox';

import {
  type Env,
  type PreviewState,
  type PreviewPersistedState,
  type GitHubSourceConfig,
  type GetTokenForRepoResult,
  DEFAULT_SANDBOX_PORT,
} from './types';
import { logger, withLogTags, formatError } from './utils/logger';
import { signGitToken } from './utils/jwt';
import { createDBProvisioner, DBProvisionResult } from './db-provisioner';

/** Process ID prefix for dev server - combined with appId for unique identification */
const DEV_SERVER_PROCESS_PREFIX = 'bun-dev-';

export class PreviewDO extends DurableObject<Env> {
  private persistedState: PreviewPersistedState;
  /** Guard to prevent re-entry of _executeBuild while a build is in progress */
  private isBuildInProgress = false;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);

    // Initialize default persisted state - explicitly uninitialized
    this.persistedState = {
      appId: null,
      lastError: null,
      dbCredentials: null,
      githubSource: null,
    };

    // Restore persisted state from storage if available
    void this.ctx.blockConcurrencyWhile(async () => {
      const stored = await this.ctx.storage.get<PreviewPersistedState>('state');
      if (stored) {
        this.persistedState = stored;
      }
    });
  }

  private async savePersistedState(): Promise<void> {
    await this.ctx.storage.put('state', this.persistedState);
  }

  /**
   * Get the process ID prefix for the dev server
   * Format: bun-dev-{appId}-
   */
  private getDevServerProcessIdPrefix(): string | null {
    if (!this.persistedState.appId) {
      return null;
    }
    return `${DEV_SERVER_PROCESS_PREFIX}${this.persistedState.appId}-`;
  }

  /**
   * Generate a new process ID with a random suffix
   * Format: bun-dev-{appId}-{randomSuffix}
   */
  private generateProcessId(): string | null {
    const prefix = this.getDevServerProcessIdPrefix();
    if (!prefix) {
      return null;
    }
    const randomSuffix = Math.random().toString(36).substring(2, 10);
    return `${prefix}${randomSuffix}`;
  }

  /**
   * Get the active dev server process from the sandbox by finding a process
   * with the correct prefix that is not completed/failed/killed
   * Returns null if no active process is found
   */
  private async getDevProcess(sandbox: ReturnType<typeof getSandbox>) {
    const prefix = this.getDevServerProcessIdPrefix();
    if (!prefix) {
      return null;
    }

    try {
      const processes = await sandbox.listProcesses();
      const activeStatuses: ProcessStatus[] = ['starting', 'running'];
      const activeProcess = processes.find(
        p => p.id.startsWith(prefix) && activeStatuses.includes(p.status)
      );
      return activeProcess ?? null;
    } catch (error) {
      logger.debug('Could not list processes', {
        prefix,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      return null;
    }
  }

  /**
   * Set an error message in persisted state
   */
  private async setError(error: string): Promise<void> {
    this.persistedState.lastError = error;
    await this.savePersistedState();
  }

  /**
   * Clear the error state (called before starting a new build)
   */
  private async clearErrorState(): Promise<void> {
    if (this.persistedState.lastError) {
      this.persistedState.lastError = null;
      await this.savePersistedState();
    }
  }

  /**
   * Get sandbox state using process-based detection
   * Finds active process by prefix using listProcesses
   */
  private async getSandboxState(): Promise<PreviewState> {
    // No appId = uninitialized
    if (!this.persistedState.appId) {
      return 'uninitialized';
    }

    const sandbox = getSandbox(this.env.SANDBOX, this.persistedState.appId);

    // Try to find the dev server process
    const process = await this.getDevProcess(sandbox);

    if (process) {
      const status = await process.getStatus();
      logger.debug('Process status', {
        processId: process.id,
        status,
      });

      switch (status) {
        case 'failed':
        case 'killed':
        case 'error':
          try {
            const logs = await process.getLogs();
            const errorMessage = `Process ${status}: ${logs.stderr.slice(-500) || 'Unknown error'}`;
            await this.setError(errorMessage);
          } catch {
            await this.setError(`Process ${status}`);
          }
          return 'error';

        case 'completed':
          return 'idle';

        case 'starting':
        case 'running':
          try {
            const portOpen = await this.isPortOpen(sandbox);
            return portOpen ? 'running' : 'building';
          } catch {
            // If port check fails, assume building
            return 'building';
          }

        default: {
          const _exhaustive: never = status;
          throw new Error(`Unhandled status: ${_exhaustive as string}`);
        }
      }
    }

    // No process found - check for orphan process (something running on port)
    try {
      const portOpen = await this.isPortOpen(sandbox);
      if (portOpen) {
        // There's something running but we can't access by processId
        logger.warn('Orphan process detected on port');
        return 'running';
      }
    } catch (error) {
      // Port check failed - sandbox likely doesn't exist, return idle
      logger.debug('Port check failed, sandbox may not exist', {
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }

    return 'idle';
  }

  /**
   * Construct the git repository URL for cloning.
   *
   * For migrated projects (githubSource is set), fetches a fresh GitHub token
   * from git-token-service and returns a GitHub URL.
   *
   * For non-migrated projects, generates a short-lived JWT token with read-only
   * access for the internal App Builder git server.
   */
  private async getRepoUrl(repoId: string): Promise<string> {
    // Check if project is migrated to GitHub
    if (this.persistedState.githubSource) {
      const { githubRepo, userId, orgId } = this.persistedState.githubSource;

      // Get fresh token from git-token-service
      const result: GetTokenForRepoResult = await this.env.GIT_TOKEN_SERVICE.getTokenForRepo({
        githubRepo,
        userId,
        orgId,
      });

      if (!result.success) {
        throw new Error(`Failed to get GitHub token: ${result.reason}`);
      }

      const url = new URL(`https://github.com/${githubRepo}.git`);
      url.username = 'x-access-token';
      url.password = result.token;
      return url.toString();
    }

    // Internal App Builder repository (not migrated)
    const authToken = signGitToken(repoId, 'ro', this.env.GIT_JWT_SECRET);
    const hostname = this.env.BUILDER_HOSTNAME;
    const baseUrl = `https://x-access-token:${authToken}@${hostname}`;
    return `${baseUrl}/apps/${repoId}.git`;
  }

  /**
   * Run a command in the sandbox with streaming output
   */
  private async runScript(sandbox: ReturnType<typeof getSandbox>, command: string): Promise<void> {
    const stream = await sandbox.execStream(command);

    for await (const event of parseSSEStream<ExecEvent>(stream)) {
      const data = stripVTControlCharacters(event.data || '').trim();

      // Log output for debugging (verbose, use debug level)
      if (data) {
        logger.debug('Sandbox output', { data });
      }

      if (event.type === 'error') {
        throw new Error(event.error || 'Command failed');
      }

      if (event.type === 'complete' && event.exitCode !== 0) {
        throw new Error(`Command failed with exit code ${event.exitCode}`);
      }
    }
  }

  /**
   * Check if the default port is listening using ss (socket statistics)
   */
  private async isPortOpen(sandbox: ReturnType<typeof getSandbox>): Promise<boolean> {
    // Use ss to check if something is listening on the port
    const portCheck = await sandbox.exec(`ss -tln | grep -q ':${DEFAULT_SANDBOX_PORT} '`);

    // If grep found a match (exit code 0), the port is listening
    const isOpen = portCheck.exitCode === 0;

    return isOpen;
  }

  // ============================================
  // RPC Methods (Public API)
  // ============================================

  async initWithAppId(appId: string): Promise<void> {
    return withLogTags({ source: 'PreviewDO', tags: { appId } }, async () => {
      logger.info('Initializing PreviewDO');
      this.persistedState.appId = appId;
      this.persistedState.lastError = null;
      await this.savePersistedState();
    });
  }

  async setDbCredentials(url: string, token: string): Promise<void> {
    return withLogTags(
      { source: 'PreviewDO', tags: { appId: this.persistedState.appId ?? undefined } },
      async () => {
        logger.info('Setting DB credentials');
        this.persistedState.dbCredentials = { url, token };
        await this.savePersistedState();
      }
    );
  }

  /**
   * Set GitHub source configuration for migrated projects.
   *
   * After calling this, the preview will clone from GitHub instead of the
   * internal App Builder git server. A fresh GitHub token is fetched on
   * every clone/fetch operation via git-token-service.
   *
   * This also destroys the existing sandbox to ensure a clean state when
   * switching from internal repo to GitHub. The next build will clone
   * fresh from GitHub.
   *
   * @param config - GitHub repository and user context for token lookup
   */
  async setGitHubSource(config: GitHubSourceConfig): Promise<void> {
    return withLogTags(
      { source: 'PreviewDO', tags: { appId: this.persistedState.appId ?? undefined } },
      async () => {
        logger.info('Setting GitHub source', {
          githubRepo: config.githubRepo,
          hasOrgId: !!config.orgId,
        });
        this.persistedState.githubSource = config;
        await this.savePersistedState();

        // Destroy the sandbox to ensure a clean state when switching sources.
        // The next build will clone fresh from GitHub.
        await this.destroy();
        logger.info('Sandbox destroyed after setting GitHub source');
      }
    );
  }

  async getStatus(): Promise<{ state: PreviewState; error: string | null }> {
    return withLogTags(
      { source: 'PreviewDO', tags: { appId: this.persistedState.appId ?? undefined } },
      async () => {
        const state = await this.getSandboxState();
        return {
          state,
          error: this.persistedState.lastError,
        };
      }
    );
  }

  /**
   * Trigger a build (fire-and-forget)
   *
   * This method returns immediately after queuing the build.
   */
  async triggerBuild(): Promise<void> {
    return withLogTags(
      { source: 'PreviewDO', tags: { appId: this.persistedState.appId ?? undefined } },
      async () => {
        if (!this.persistedState.appId) {
          throw new Error('App ID not set');
        }
        logger.info('Triggering build');
        this.ctx.waitUntil(this._executeBuild());
      }
    );
  }

  private async _executeBuild(): Promise<void> {
    return withLogTags(
      { source: 'PreviewDO', tags: { appId: this.persistedState.appId ?? undefined } },
      async () => {
        if (this.isBuildInProgress) {
          logger.warn('_executeBuild called while build already in progress');
          return;
        }

        this.isBuildInProgress = true;
        const appId = this.persistedState.appId;
        try {
          logger.info('Build started');

          if (!appId) {
            throw new Error('App ID not set');
          }

          // Clear any previous error state
          await this.clearErrorState();

          const sandbox = getSandbox(this.env.SANDBOX, appId);

          // Check if repository already exists
          const checkResult = await sandbox.exec('test -d /workspace/.git');
          const repoExists = checkResult.exitCode === 0;

          if (repoExists) {
            logger.debug('Repository exists, pulling latest changes');

            // The origin URL contains an ephemeral GitHub token from the previous clone/fetch; refresh it
            if (this.persistedState.githubSource) {
              const repoUrl = await this.getRepoUrl(appId);
              await sandbox.exec(`cd /workspace && git remote set-url origin '${repoUrl}'`);
            }

            const pullResult = await sandbox.exec(
              'cd /workspace && git fetch origin && git reset --hard origin/HEAD'
            );
            if (!pullResult.success) {
              throw new Error('Failed to pull new changes');
            }
            logger.debug('Successfully pulled latest changes');
          } else {
            const repoUrl = await this.getRepoUrl(appId);
            logger.debug('Cloning repository for the first time');
            const checkoutResult = await sandbox.gitCheckout(repoUrl, {
              targetDir: '/workspace',
            });
            if (!checkoutResult.success) {
              throw new Error('Failed to clone repo');
            }
            logger.debug('Successfully cloned repository');
          }

          await this.runScript(sandbox, 'cd /workspace && bun install --frozen-lockfile');
          logger.debug('Dependencies installed');

          const dbProvisioner = createDBProvisioner({
            env: this.env,
            getCredentials: () => this.persistedState.dbCredentials,
            setCredentials: async creds => {
              this.persistedState.dbCredentials = creds;
              await this.savePersistedState();
            },
          });
          const dbResult = await dbProvisioner.provisionIfNeeded(sandbox, appId);

          // Check if there's already a process running
          const activeProcess = await this.getDevProcess(sandbox);
          logger.debug('Checking if dev server is already running', {
            hasActiveProcess: !!activeProcess,
          });
          if (activeProcess?.status === 'running' || activeProcess?.status === 'starting') {
            // If DB was just provisioned, we need to restart the dev server to pick up DB constants
            if (dbResult === DBProvisionResult.PROVISIONED) {
              logger.info('DB provisioned, restarting dev server to pick up DB constants');
              // Use pkill -f to kill the dev server process instead of destroying the whole sandbox
              // This preserves the sandbox state while allowing us to restart with new env vars
              // Match 'bun run dev' which is the actual command running in the process list
              const pkillResult = await sandbox.exec(`pkill -f 'bun run dev'`);
              // Exit codes: 0 = matched and killed, 1 = no match, 2+ = error
              if (pkillResult.exitCode === 0) {
                logger.debug('Successfully killed dev server process with pkill');
              } else if (pkillResult.exitCode === 1) {
                logger.debug('No matching processes found for pkill');
              } else {
                logger.warn('pkill command failed', {
                  exitCode: pkillResult.exitCode,
                  stderr: pkillResult.stderr,
                });
              }
              // Continue to start a new dev server process below
            } else {
              return;
            }
          }

          // Generate a new process ID with random suffix
          const processId = this.generateProcessId();
          if (!processId) {
            throw new Error('Failed to generate dev server process ID');
          }

          // Build environment variables for dev server
          const env: Record<string, string> = { PORT: String(DEFAULT_SANDBOX_PORT) };
          if (this.persistedState.dbCredentials) {
            env.DB_URL = this.persistedState.dbCredentials.url;
            env.DB_TOKEN = this.persistedState.dbCredentials.token;
          }

          await sandbox.startProcess('bun run dev', {
            processId,
            env,
            cwd: '/workspace',
          });

          logger.info('Dev server started', { processId });
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Unknown error occurred';
          this.persistedState.lastError = message;
          await this.savePersistedState();

          logger.error('Build execution failed', formatError(error));
          throw error;
        } finally {
          this.isBuildInProgress = false;
        }
      }
    );
  }

  /**
   * Stream build logs from the dev server process
   * Returns a ReadableStream that emits SSE log events
   */
  async streamBuildLogs(): Promise<ReadableStream | null> {
    return withLogTags(
      { source: 'PreviewDO', tags: { appId: this.persistedState.appId ?? undefined } },
      async () => {
        if (!this.persistedState.appId) {
          return null;
        }

        try {
          const sandbox = getSandbox(this.env.SANDBOX, this.persistedState.appId);

          // Find the active dev server process
          const process = await this.getDevProcess(sandbox);
          if (!process) {
            return null;
          }

          const logStream = (await sandbox.streamProcessLogs(process.id)) as ReadableStream;
          return logStream;
        } catch (error) {
          logger.error('Failed to stream build logs', formatError(error));
          return null;
        }
      }
    );
  }

  /**
   * Destroy the sandbox container
   */
  async destroy(): Promise<void> {
    return withLogTags(
      { source: 'PreviewDO', tags: { appId: this.persistedState.appId ?? undefined } },
      async () => {
        logger.info('Destroying sandbox');
        if (!this.persistedState.appId) {
          return;
        }
        try {
          const sandbox = getSandbox(this.env.SANDBOX, this.persistedState.appId);
          await sandbox.destroy();
        } catch (error) {
          // Log but don't fail if sandbox cleanup fails
          logger.error('Failed to destroy sandbox', formatError(error));
        }
      }
    );
  }

  /**
   * Delete all preview data including sandbox
   * Called when deleting a project to clean up all resources
   */
  async deleteAll(): Promise<void> {
    return withLogTags(
      { source: 'PreviewDO', tags: { appId: this.persistedState.appId ?? undefined } },
      async () => {
        logger.info('Deleting all preview data');

        // First destroy the sandbox container if it exists
        await this.destroy();

        // Clear all persisted state
        await this.ctx.storage.deleteAll();

        // Reset in-memory state
        this.persistedState = {
          appId: null,
          lastError: null,
          dbCredentials: null,
          githubSource: null,
        };

        logger.info('Preview deleted successfully');
      }
    );
  }
}
