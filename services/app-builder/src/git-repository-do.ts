/**
 * Git Repository Agent
 * Stores git repositories in SQLite and provides export functionality
 * Uses RPC for communication with workers
 */

import { DurableObject } from 'cloudflare:workers';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import type { DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite';
import { migrate } from 'drizzle-orm/durable-sqlite/migrator';
import migrations from '../drizzle/migrations';
import git from '@ashishkumar472/cf-git';
import http from '@ashishkumar472/cf-git/http/web';
import { sanitizeGitUrl } from './utils/git-url';
import { SqliteFS } from './git/fs-adapter';
import { MemFS } from './git/memfs';
import { logger, withLogTags, formatError } from './utils/logger';
import type { Env, GitObject, RepositoryStats } from './types';

export class GitRepositoryDO extends DurableObject<Env> {
  private db: DrizzleSqliteDODatabase;
  private fs: SqliteFS | null = null;
  private _initialized = false;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.db = drizzle(ctx.storage, { logger: false });
    void ctx.blockConcurrencyWhile(async () => {
      migrate(this.db, migrations);
    });
  }

  private async initializeFS(): Promise<void> {
    if (this.fs) return;

    logger.debug('Initializing SqliteFS', { id: this.ctx.id.toString() });

    try {
      this.fs = new SqliteFS(this.db);
      this.fs.init();
    } catch (error) {
      this.fs = null;
      logger.error('Failed to initialize SqliteFS', formatError(error));
      throw error;
    }

    // Check if .git directory exists
    try {
      await this.fs.stat('.git');
      this._initialized = true;
      logger.debug('Repository already initialized');
    } catch (_err) {
      // .git doesn't exist, repo not initialized yet
      this._initialized = false;
      logger.debug('Repository not yet initialized');
    }
  }

  async isInitialized(): Promise<boolean> {
    return withLogTags(
      { source: 'GitRepositoryDO', tags: { appId: this.ctx.id.name } },
      async () => {
        await this.initializeFS();
        return this._initialized;
      }
    );
  }

  async initialize(): Promise<void> {
    return withLogTags(
      { source: 'GitRepositoryDO', tags: { appId: this.ctx.id.name } },
      async () => {
        if (!this.fs) {
          await this.initializeFS();
        }

        if (this._initialized) {
          logger.debug('Repository already initialized');
          return;
        }

        logger.debug('Initializing new git repository');

        if (!this.fs) {
          throw new Error('Filesystem not initialized');
        }

        await git.init({ fs: this.fs, dir: '/', defaultBranch: 'main' });
        this._initialized = true;

        logger.debug('Git repository initialized successfully');
      }
    );
  }

  /**
   * Files are expected to have base64-encoded content to safely handle binary data through RPC
   */
  async createInitialCommit(files: Record<string, string>): Promise<void> {
    return withLogTags(
      { source: 'GitRepositoryDO', tags: { appId: this.ctx.id.name } },
      async () => {
        await this.initialize();

        if (!this.fs) {
          throw new Error('Filesystem not initialized');
        }

        logger.debug('Creating initial commit', { fileCount: Object.keys(files).length });

        // Write files (decode base64 to binary)
        for (const [path, base64Content] of Object.entries(files)) {
          const bytes = Buffer.from(base64Content, 'base64');
          await this.fs.writeFile(path, bytes);
          await git.add({ fs: this.fs, dir: '/', filepath: path });
        }

        await git.commit({
          fs: this.fs,
          dir: '/',
          message: 'Initial commit',
          author: {
            name: 'Kilo Code Cloud',
            email: 'agent@kilocode.ai',
          },
        });

        logger.debug('Initial commit created');
      }
    );
  }

  /**
   * Returns objects with base64-encoded data for serialization
   */
  async exportGitObjects(): Promise<GitObject[]> {
    return withLogTags(
      { source: 'GitRepositoryDO', tags: { appId: this.ctx.id.name } },
      async () => {
        if (!this.fs) {
          await this.initializeFS();
        }

        if (!this._initialized || !this.fs) {
          return [];
        }

        const objects = this.fs.exportGitObjects();

        return objects.map(obj => ({
          path: obj.path,
          data: Buffer.from(obj.data).toString('base64'),
        }));
      }
    );
  }

  /**
   * Writes all objects to the filesystem, replacing existing ones
   */
  async importGitObjects(objects: GitObject[]): Promise<void> {
    return withLogTags(
      { source: 'GitRepositoryDO', tags: { appId: this.ctx.id.name } },
      async () => {
        if (!this.fs) {
          await this.initializeFS();
        }

        if (!this.fs) {
          throw new Error('Filesystem not initialized');
        }

        if (!this._initialized) {
          await this.initialize();
        }

        logger.debug('Importing git objects', { count: objects.length });

        for (const obj of objects) {
          const bytes = Buffer.from(obj.data, 'base64');
          await this.fs.writeFile(obj.path, bytes);
        }

        logger.debug('Git objects imported successfully');
      }
    );
  }

  async getLatestCommit(): Promise<string | null> {
    return withLogTags(
      { source: 'GitRepositoryDO', tags: { appId: this.ctx.id.name } },
      async () => {
        if (!this.fs) {
          await this.initializeFS();
        }

        if (!this._initialized || !this.fs) {
          return null;
        }

        try {
          const commitHash = await git.resolveRef({ fs: this.fs, dir: '/', ref: 'HEAD' });
          return commitHash;
        } catch (err) {
          logger.error('Failed to get latest commit', formatError(err));
          return null;
        }
      }
    );
  }

  async getStats(): Promise<RepositoryStats> {
    return withLogTags(
      { source: 'GitRepositoryDO', tags: { appId: this.ctx.id.name } },
      async () => {
        if (!this.fs) {
          await this.initializeFS();
        }

        if (!this.fs) {
          return { totalObjects: 0, totalBytes: 0, largestObject: null, initialized: false };
        }

        const stats = this.fs.getStorageStats();
        return { ...stats, initialized: this._initialized };
      }
    );
  }

  // Legacy auth token verification (for transition period, read-only)
  // Only used to support existing repositories with stored tokens
  // New repositories should use JWT authentication instead
  async verifyAuthToken(token: string): Promise<boolean> {
    return withLogTags(
      { source: 'GitRepositoryDO', tags: { appId: this.ctx.id.name } },
      async () => {
        const storedToken = await this.ctx.storage.get<string>('auth_token');

        if (!storedToken || storedToken.trim().length === 0) {
          return false;
        }

        return storedToken === token;
      }
    );
  }

  /**
   * Called when deleting a project to clean up storage
   */
  async deleteAll(): Promise<void> {
    return withLogTags(
      { source: 'GitRepositoryDO', tags: { appId: this.ctx.id.name } },
      async () => {
        logger.info('Deleting all repository data');

        // deleteAll() clears all storage including SQLite tables
        await this.ctx.storage.deleteAll();

        this._initialized = false;
        this.fs = null;

        logger.info('Repository deleted successfully');
      }
    );
  }

  /**
   * Schedule self-deletion after a delay.
   * Used after GitHub migration to clean up the internal git repo
   * while keeping a grace period for rollback.
   */
  async scheduleDelete(delayMs: number): Promise<void> {
    return withLogTags(
      { source: 'GitRepositoryDO', tags: { appId: this.ctx.id.name } },
      async () => {
        try {
          const deleteAt = Date.now() + delayMs;
          await this.ctx.storage.setAlarm(deleteAt);
          logger.info('Scheduled self-deletion', {
            deleteAt: new Date(deleteAt).toISOString(),
          });
        } catch (error) {
          logger.error('Failed to schedule self-deletion', formatError(error));
          throw error;
        }
      }
    );
  }

  async alarm(): Promise<void> {
    return withLogTags(
      { source: 'GitRepositoryDO', tags: { appId: this.ctx.id.name } },
      async () => {
        logger.info('Alarm fired: deleting repository data');
        await this.ctx.storage.deleteAll();
        this._initialized = false;
        this.fs = null;
        logger.info('Repository self-deleted');
      }
    );
  }

  /**
   * Push repository to a remote URL.
   * Used for GitHub migration - pushes all branches to the remote.
   */
  async pushToRemote(
    remoteUrl: string,
    authToken: string
  ): Promise<{ success: boolean; error?: string }> {
    return withLogTags(
      { source: 'GitRepositoryDO', tags: { appId: this.ctx.id.name } },
      async () => {
        try {
          if (!this.fs) {
            await this.initializeFS();
          }

          if (!this._initialized || !this.fs) {
            return { success: false, error: 'Repository not initialized' };
          }

          logger.info('Pushing repository to remote', {
            id: this.ctx.id.toString(),
            remoteUrl: sanitizeGitUrl(remoteUrl),
          });

          const gitObjs = this.fs.exportGitObjects();

          if (gitObjs.length === 0) {
            return { success: false, error: 'No git objects to push' };
          }

          // Build in-memory FS for isomorphic-git push operation
          const memFs = new MemFS();
          await git.init({ fs: memFs, dir: '/', defaultBranch: 'main' });

          for (const obj of gitObjs) {
            await memFs.writeFile(obj.path, obj.data);
          }

          let branches: string[] = [];
          try {
            branches = await git.listBranches({ fs: memFs, dir: '/' });
          } catch {
            branches = ['main'];
          }

          logger.info('Pushing branches to remote', { branches });

          let mainPushed = false;
          const failedBranches: string[] = [];

          for (const branch of branches) {
            try {
              await git.push({
                fs: memFs,
                http,
                dir: '/',
                url: remoteUrl,
                ref: branch,
                remoteRef: branch,
                onAuth: () => ({ username: 'x-access-token', password: authToken }),
                force: false,
              });

              logger.info('Successfully pushed branch', { branch });
              if (branch === 'main') {
                mainPushed = true;
              }
            } catch (branchError) {
              logger.warn('Failed to push branch', {
                branch,
                ...formatError(branchError),
              });
              failedBranches.push(branch);
            }
          }

          if (!mainPushed) {
            const errorMessage = failedBranches.includes('main')
              ? 'Failed to push main branch'
              : 'Main branch not found in repository';
            logger.error('Push failed: main branch not pushed', { failedBranches });
            return { success: false, error: errorMessage };
          }

          logger.info('Repository push completed successfully', {
            failedBranches: failedBranches.length > 0 ? failedBranches : undefined,
          });
          return { success: true };
        } catch (error) {
          logger.error('Failed to push repository to remote', formatError(error));
          const errorMessage = error instanceof Error ? error.message : String(error);
          return { success: false, error: errorMessage };
        }
      }
    );
  }
}
