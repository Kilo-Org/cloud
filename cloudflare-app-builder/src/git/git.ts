/**
 * Git version control for Durable Objects using isomorphic-git
 */

import git from '@ashishkumar472/cf-git';
import { SqliteFS } from './fs-adapter';
import * as Diff from 'diff';
import type {
  CommitInfo,
  FileDiff,
  GitShowResult,
  SqlExecutor,
  TreeEntry,
  TreeResult,
  BlobResult,
} from '../types';

/**
 * Represents a file snapshot with path and contents
 */
interface FileSnapshot {
  filePath: string;
  fileContents: string;
}

export class GitVersionControl {
  private onFilesChangedCallback?: () => void;
  public fs: SqliteFS;
  private author: { name: string; email: string };

  private get gitConfig() {
    return { fs: this.fs, dir: '/' } as const;
  }

  constructor(sql: SqlExecutor, author?: { name: string; email: string }) {
    this.fs = new SqliteFS(sql);
    this.author = author || { name: 'Vibesdk', email: 'vibesdk-bot@cloudflare.com' };

    // Initialize SQLite table synchronously
    this.fs.init();
  }

  setOnFilesChangedCallback(callback: () => void): void {
    this.onFilesChangedCallback = callback;
  }

  async getAllFilesFromHead(): Promise<Array<{ filePath: string; fileContents: string }>> {
    try {
      const oid = await git.resolveRef({ ...this.gitConfig, ref: 'HEAD' });
      return await this.readFilesFromCommit(oid);
    } catch {
      return [];
    }
  }

  async init(): Promise<void> {
    try {
      await git.init({ ...this.gitConfig, defaultBranch: 'main' });
      console.log('[Git] Repository initialized');
    } catch (error) {
      console.log('[Git] Repository already initialized:', error);
    }
  }

  /**
   * Stage files without committing them
   * Useful for batching multiple operations before a single commit
   */
  async stage(files: FileSnapshot[]): Promise<void> {
    if (!files.length) {
      console.log('[Git] No files to stage');
      return;
    }

    console.log(`[Git] Staging ${files.length} files`);

    for (const file of files) {
      try {
        const path = this.normalizePath(file.filePath);
        await this.fs.writeFile(path, file.fileContents);
        await git.add({ ...this.gitConfig, filepath: path, cache: {} });
      } catch (error) {
        console.error(`[Git] Failed to stage file ${file.filePath}:`, error);
        throw new Error(
          `Failed to stage file ${file.filePath}: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }

    console.log(`[Git] Staged ${files.length} files`, files);
  }

  private normalizePath(path: string): string {
    return path.startsWith('/') ? path.slice(1) : path;
  }

  async commit(files: FileSnapshot[], message?: string): Promise<string | null> {
    console.log(`[Git] Starting commit with ${files.length} files`);
    if (files.length) {
      // Stage all files first
      await this.stage(files);
    }

    if (!(await this.hasChanges())) {
      console.log('[Git] No changes to commit');
      return null;
    }

    console.log('[Git] Creating commit...');
    try {
      const oid = await git.commit({
        ...this.gitConfig,
        message: message || `Auto-checkpoint (${new Date().toISOString()})`,
        author: {
          name: this.author.name,
          email: this.author.email,
          timestamp: Math.floor(Date.now() / 1000),
        },
      });
      console.log(`[Git] Commit created: ${oid}`);
      return oid;
    } catch (error) {
      console.error('[Git] Error creating commit:', error);
      throw new Error(
        `Failed to create commit: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  private async hasChanges(): Promise<boolean> {
    try {
      const status = (await git.statusMatrix(this.gitConfig)) as Array<
        [string, number, number, number]
      >;
      return status.some(row => row[1] !== row[2]);
    } catch (error) {
      console.error('[Git] Error checking for changes:', error);
      return true;
    }
  }

  async log(limit = 50): Promise<CommitInfo[]> {
    try {
      const commits = (await git.log({ ...this.gitConfig, depth: limit, ref: 'main' })) as Array<{
        oid: string;
        commit: {
          message: string;
          author: { name: string; email: string; timestamp: number };
        };
      }>;
      return commits.map(c => ({
        oid: c.oid,
        message: c.commit.message,
        author: `${c.commit.author.name} <${c.commit.author.email}>`,
        timestamp: new Date(c.commit.author.timestamp * 1000).toISOString(),
      }));
    } catch (error) {
      console.error('[Git] Error fetching log:', error);
      return [];
    }
  }

  private async readFilesFromCommit(oid: string): Promise<FileSnapshot[]> {
    const { commit } = await git.readCommit({ ...this.gitConfig, oid });
    const files: FileSnapshot[] = [];
    await this.walkTree(commit.tree, '', files);
    return files;
  }

  async show(oid: string, options?: { includeDiff?: boolean }): Promise<GitShowResult> {
    const { commit } = await git.readCommit({ ...this.gitConfig, oid });

    if (!commit.parent || commit.parent.length === 0) {
      const files = await git.listFiles({ ...this.gitConfig, ref: oid });
      return this.formatShowResult(commit, oid, files);
    }

    const parentOid = commit.parent[0];
    const { commit: parentCommit } = await git.readCommit({ ...this.gitConfig, oid: parentOid });

    const [currentFileOids, parentFileOids] = await Promise.all([
      this.collectTreeOids(commit.tree),
      this.collectTreeOids(parentCommit.tree),
    ]);

    const changedFiles = this.findChangedFiles(currentFileOids, parentFileOids);
    const diffs = options?.includeDiff
      ? await this.generateDiffs(changedFiles, currentFileOids, parentFileOids)
      : undefined;

    return this.formatShowResult(commit, oid, changedFiles, diffs);
  }

  private findChangedFiles(
    currentFileOids: Map<string, string>,
    parentFileOids: Map<string, string>
  ): string[] {
    const allPaths = new Set([...currentFileOids.keys(), ...parentFileOids.keys()]);
    const changedFiles: string[] = [];

    for (const path of allPaths) {
      if (currentFileOids.get(path) !== parentFileOids.get(path)) {
        changedFiles.push(path);
      }
    }

    return changedFiles;
  }

  private async generateDiffs(
    changedFiles: string[],
    currentFileOids: Map<string, string>,
    parentFileOids: Map<string, string>
  ): Promise<FileDiff[]> {
    const diffs: FileDiff[] = [];

    for (const path of changedFiles) {
      const [oldContent, newContent] = await Promise.all([
        this.readBlobContent(parentFileOids.get(path)),
        this.readBlobContent(currentFileOids.get(path)),
      ]);

      if (oldContent !== newContent) {
        const diff = Diff.createPatch(path, oldContent, newContent);
        if (diff) {
          diffs.push({ path, diff });
        }
      }
    }

    return diffs;
  }

  private async readBlobContent(oid: string | undefined): Promise<string> {
    if (!oid) return '';
    const { blob } = await git.readBlob({ ...this.gitConfig, oid });
    return new TextDecoder('utf-8').decode(blob);
  }

  private formatShowResult(
    commit: { message: string; author: { name: string; email: string; timestamp: number } },
    oid: string,
    fileList: string[],
    diffs?: FileDiff[]
  ): GitShowResult {
    return {
      oid,
      message: commit.message,
      author: `${commit.author.name} <${commit.author.email}>`,
      timestamp: new Date(commit.author.timestamp * 1000).toISOString(),
      files: fileList.length,
      fileList,
      ...(diffs && { diffs }),
    };
  }

  private buildPath(prefix: string, name: string): string {
    return prefix ? `${prefix}/${name}` : name;
  }

  /**
   * Efficiently collect file paths and their OIDs from a tree (no blob content read)
   */
  private async collectTreeOids(
    treeOid: string,
    prefix: string = ''
  ): Promise<Map<string, string>> {
    const fileOids = new Map<string, string>();
    const { tree } = await git.readTree({ ...this.gitConfig, oid: treeOid });

    for (const entry of tree) {
      const path = this.buildPath(prefix, entry.path);

      if (entry.type === 'blob') {
        fileOids.set(path, entry.oid);
      } else if (entry.type === 'tree') {
        const subtreeOids = await this.collectTreeOids(entry.oid, path);
        for (const [subpath, oid] of subtreeOids) {
          fileOids.set(subpath, oid);
        }
      }
    }

    return fileOids;
  }

  async reset(
    ref: string,
    options?: { hard?: boolean }
  ): Promise<{ ref: string; filesReset: number }> {
    const oid = await git.resolveRef({ ...this.gitConfig, ref });
    await git.writeRef({ ...this.gitConfig, ref: 'HEAD', value: oid, force: true });

    if (options?.hard !== false) {
      await git.checkout({ ...this.gitConfig, ref, force: true });
    }

    const files = await git.listFiles({ ...this.gitConfig, ref });

    this.onFilesChangedCallback?.();

    return { ref, filesReset: files.length };
  }

  private async walkTree(treeOid: string, prefix: string, files: FileSnapshot[]): Promise<void> {
    const { tree } = await git.readTree({ ...this.gitConfig, oid: treeOid });

    for (const entry of tree) {
      const path = this.buildPath(prefix, entry.path);

      if (entry.type === 'blob') {
        const textContent = await this.tryReadTextBlob(entry.oid);
        if (textContent) {
          files.push({ filePath: path, fileContents: textContent });
        }
      } else if (entry.type === 'tree') {
        await this.walkTree(entry.oid, path, files);
      }
    }
  }

  private async tryReadTextBlob(oid: string): Promise<string | null> {
    try {
      const { blob } = await git.readBlob({ ...this.gitConfig, oid });
      const content = new TextDecoder('utf-8').decode(blob);
      return content.includes('\0') ? null : content;
    } catch {
      return null;
    }
  }

  async getHead(): Promise<string | null> {
    try {
      let timeoutId: ReturnType<typeof setTimeout> | null = null;

      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(new Error('git.resolveRef timed out after 5 seconds'));
        }, 5000);
      });

      const resolvePromise = git.resolveRef({ ...this.gitConfig, ref: 'HEAD' });

      try {
        const result = await Promise.race([resolvePromise, timeoutPromise]);
        return result;
      } finally {
        if (timeoutId !== null) {
          clearTimeout(timeoutId);
        }
      }
    } catch (error) {
      console.error('[Git] Error resolving HEAD:', error);
      return null;
    }
  }

  /**
   * Get storage statistics for monitoring and observability
   */
  getStorageStats(): {
    totalObjects: number;
    totalBytes: number;
    largestObject: { path: string; size: number } | null;
  } {
    return this.fs.getStorageStats();
  }

  /**
   * Check if the repository has been initialized (has a .git directory)
   */
  async isInitialized(): Promise<boolean> {
    try {
      await this.fs.stat('.git');
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Create initial commit with the provided files
   * @param files - Record of path to content (Uint8Array)
   */
  async createInitialCommit(files: Record<string, Uint8Array>): Promise<string> {
    // Ensure repo is initialized
    await this.init();

    console.log(`[Git] Creating initial commit with ${Object.keys(files).length} files`);

    // Write files and stage them
    for (const [path, content] of Object.entries(files)) {
      const normalizedPath = this.normalizePath(path);
      await this.fs.writeFile(normalizedPath, content);
      await git.add({ ...this.gitConfig, filepath: normalizedPath });
    }

    // Commit
    const oid = await git.commit({
      ...this.gitConfig,
      message: 'Initial commit',
      author: {
        name: this.author.name,
        email: this.author.email,
        timestamp: Math.floor(Date.now() / 1000),
      },
    });

    console.log(`[Git] Initial commit created: ${oid}`);
    return oid;
  }

  /**
   * Export all git objects for cloning
   * Returns raw binary data for each object
   */
  exportGitObjects(): Array<{ path: string; data: Uint8Array }> {
    return this.fs.exportGitObjects();
  }

  /**
   * Import git objects (e.g., from a push operation)
   * Writes all objects to the filesystem
   */
  async importGitObjects(objects: Array<{ path: string; data: Uint8Array }>): Promise<void> {
    // Ensure repo is initialized
    const initialized = await this.isInitialized();
    if (!initialized) {
      await this.init();
    }

    console.log(`[Git] Importing ${objects.length} git objects`);

    for (const obj of objects) {
      await this.fs.writeFile(obj.path, obj.data);
    }

    console.log('[Git] Git objects imported successfully');
  }

  /**
   * Get directory tree contents at a specific ref and path
   * @param ref - Branch name (e.g., "main", "HEAD") or commit SHA
   * @param path - Optional path to a subdirectory (defaults to root)
   */
  async getTree(ref: string, path?: string): Promise<TreeResult> {
    // Resolve ref to commit OID
    const commitOid = await git.resolveRef({ ...this.gitConfig, ref });

    // Read commit to get root tree OID
    const commit = await git.readCommit({ ...this.gitConfig, oid: commitOid });
    let treeOid = commit.commit.tree;

    // Navigate to subdirectory if path is provided
    const normalizedPath = path?.replace(/^\/+|\/+$/g, '') || '';
    if (normalizedPath) {
      const pathParts = normalizedPath.split('/');

      for (const part of pathParts) {
        const tree = await git.readTree({ ...this.gitConfig, oid: treeOid });
        const entry = tree.tree.find((e: { path: string }) => e.path === part);

        if (!entry) {
          throw new Error(`Path not found: ${normalizedPath}`);
        }

        if (entry.type !== 'tree') {
          throw new Error(`Path is not a directory: ${normalizedPath}`);
        }

        treeOid = entry.oid;
      }
    }

    // Read tree entries at current path
    const tree = await git.readTree({ ...this.gitConfig, oid: treeOid });

    const entries: TreeEntry[] = tree.tree.map(
      (entry: { path: string; type: string; oid: string; mode: string }) => ({
        name: entry.path,
        type: entry.type as 'blob' | 'tree',
        oid: entry.oid,
        mode: entry.mode,
      })
    );

    return { entries, sha: commitOid };
  }

  /**
   * Get blob (file) contents at a specific ref and path
   * @param ref - Branch name (e.g., "main", "HEAD") or commit SHA
   * @param path - Path to the file
   */
  async getBlob(ref: string, path: string): Promise<BlobResult> {
    // Resolve ref to commit OID
    const commitOid = await git.resolveRef({ ...this.gitConfig, ref });

    // Read commit to get root tree OID
    const commit = await git.readCommit({ ...this.gitConfig, oid: commitOid });
    let treeOid = commit.commit.tree;

    // Navigate to file
    const normalizedPath = path.replace(/^\/+|\/+$/g, '');
    if (!normalizedPath) {
      throw new Error('Path is required for blob');
    }

    const pathParts = normalizedPath.split('/');
    const fileName = pathParts.pop();

    if (!fileName) {
      throw new Error('Invalid path');
    }

    // Navigate to parent directory
    for (const part of pathParts) {
      const tree = await git.readTree({ ...this.gitConfig, oid: treeOid });
      const entry = tree.tree.find((e: { path: string }) => e.path === part);

      if (!entry) {
        throw new Error(`Path not found: ${normalizedPath}`);
      }

      if (entry.type !== 'tree') {
        throw new Error(`Path is not a directory: ${part}`);
      }

      treeOid = entry.oid;
    }

    // Find the blob entry
    const tree = await git.readTree({ ...this.gitConfig, oid: treeOid });
    const blobEntry = tree.tree.find((e: { path: string }) => e.path === fileName);

    if (!blobEntry) {
      throw new Error(`File not found: ${normalizedPath}`);
    }

    if (blobEntry.type !== 'blob') {
      throw new Error(`Path is a directory, not a file: ${normalizedPath}`);
    }

    // Read blob content
    const blob = await git.readBlob({ ...this.gitConfig, oid: blobEntry.oid });

    return {
      content: blob.blob,
      size: blob.blob.length,
      sha: blobEntry.oid,
    };
  }
}
