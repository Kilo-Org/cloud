/**
 * SQLite filesystem adapter for isomorphic-git
 * One DO = one Git repo, stored directly in SQLite via Drizzle ORM
 *
 * Limits:
 * - Cloudflare DO SQLite: 10GB total storage
 * - Max parameter size: ~1MB per SQL statement parameter
 * - Git objects are base64-encoded to safely store binary data
 */

import type { DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite';
import { eq, and, like } from 'drizzle-orm';

import { gitObjects } from '../db/sqlite-schema';
import type { ErrnoException } from '../types';
import { MAX_OBJECT_SIZE } from './constants';

export class SqliteFS {
  private db: DrizzleSqliteDODatabase;
  public promises!: this;

  constructor(db: DrizzleSqliteDODatabase) {
    this.db = db;
  }

  init() {
    // Ensure root directory exists
    this.db
      .insert(gitObjects)
      .values({
        path: '',
        parent_path: '',
        data: '',
        is_dir: 1,
        mtime: Date.now(),
      })
      .onConflictDoNothing()
      .run();

    // promises property required by isomorphic-git
    Object.defineProperty(this, 'promises', {
      value: this,
      enumerable: true,
      writable: false,
      configurable: false,
    });
  }

  getStorageStats(): {
    totalObjects: number;
    totalBytes: number;
    largestObject: { path: string; size: number } | null;
  } {
    const objects = this.db
      .select({
        path: gitObjects.path,
        data: gitObjects.data,
      })
      .from(gitObjects)
      .where(eq(gitObjects.is_dir, 0))
      .all();

    if (objects.length === 0) {
      return { totalObjects: 0, totalBytes: 0, largestObject: null };
    }

    let totalBytes = 0;
    let largestObject: { path: string; size: number } | null = null;

    for (const obj of objects) {
      const size = obj.data.length; // Base64 encoded size
      totalBytes += size;

      if (!largestObject || size > largestObject.size) {
        largestObject = { path: obj.path, size };
      }
    }

    return {
      totalObjects: objects.length,
      totalBytes,
      largestObject,
    };
  }

  async readFile(path: string, options?: { encoding?: 'utf8' }): Promise<Uint8Array | string> {
    const normalized = path.replace(/^\/+/, '');
    const result = this.db
      .select({
        data: gitObjects.data,
        is_dir: gitObjects.is_dir,
      })
      .from(gitObjects)
      .where(eq(gitObjects.path, normalized))
      .all();

    if (!result[0]) {
      const error: ErrnoException = new Error(`ENOENT: no such file or directory, open '${path}'`);
      error.code = 'ENOENT';
      error.errno = -2;
      error.path = path;
      throw error;
    }

    if (result[0].is_dir) {
      const error: ErrnoException = new Error(
        `EISDIR: illegal operation on a directory, read '${path}'`
      );
      error.code = 'EISDIR';
      error.errno = -21;
      error.path = path;
      throw error;
    }

    const base64Data = result[0].data;

    if (!base64Data) {
      return options?.encoding === 'utf8' ? '' : new Uint8Array(0);
    }

    const binaryString = atob(base64Data);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }

    return options?.encoding === 'utf8' ? new TextDecoder().decode(bytes) : bytes;
  }

  async writeFile(path: string, data: Uint8Array | string): Promise<void> {
    const normalized = path.replace(/^\/+/, '');

    if (!normalized) {
      throw new Error('Cannot write to root');
    }

    // Convert to Uint8Array if string
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;

    // Check size limit
    if (bytes.length > MAX_OBJECT_SIZE) {
      const sizeKB = (bytes.length / 1024).toFixed(2);
      const maxKB = (MAX_OBJECT_SIZE / 1024).toFixed(2);

      if (normalized.includes('.git/objects/pack/')) {
        throw new Error(
          `Git packfile too large: ${sizeKB}KB exceeds ${maxKB}KB limit. ` +
            `This packfile combines multiple objects. Try pushing fewer/smaller files at once.`
        );
      }

      throw new Error(`File too large: ${path} (${bytes.length} bytes, max ${MAX_OBJECT_SIZE})`);
    }

    // Check if path exists as directory
    const existing = this.db
      .select({ is_dir: gitObjects.is_dir })
      .from(gitObjects)
      .where(eq(gitObjects.path, normalized))
      .all();

    if (existing[0]?.is_dir === 1) {
      const error: ErrnoException = new Error(
        `EISDIR: illegal operation on a directory, open '${path}'`
      );
      error.code = 'EISDIR';
      error.errno = -21;
      error.path = path;
      throw error;
    }

    // Ensure parent directories exist (git implicitly creates them)
    const parts = normalized.split('/');
    const parentPath = parts.length > 1 ? parts.slice(0, -1).join('/') : '';

    if (parts.length > 1) {
      const now = Date.now();
      for (let i = 0; i < parts.length - 1; i++) {
        const dirPath = parts.slice(0, i + 1).join('/');
        const dirParent = i === 0 ? '' : parts.slice(0, i).join('/');
        this.db
          .insert(gitObjects)
          .values({
            path: dirPath,
            parent_path: dirParent,
            data: '',
            is_dir: 1,
            mtime: now,
          })
          .onConflictDoNothing()
          .run();
      }
    }

    // Encode to base64 for safe storage
    let base64Content = '';
    if (bytes.length > 0) {
      let binaryString = '';
      for (let i = 0; i < bytes.length; i++) {
        binaryString += String.fromCharCode(bytes[i]);
      }
      base64Content = btoa(binaryString);
    }

    const now = Date.now();
    this.db
      .insert(gitObjects)
      .values({
        path: normalized,
        parent_path: parentPath,
        data: base64Content,
        is_dir: 0,
        mtime: now,
      })
      .onConflictDoUpdate({
        target: gitObjects.path,
        set: {
          parent_path: parentPath,
          data: base64Content,
          is_dir: 0,
          mtime: now,
        },
      })
      .run();
  }

  async unlink(path: string): Promise<void> {
    const normalized = path.replace(/^\/+/, '');

    const existing = this.db
      .select({ is_dir: gitObjects.is_dir })
      .from(gitObjects)
      .where(eq(gitObjects.path, normalized))
      .all();

    if (!existing[0]) {
      const error: ErrnoException = new Error(
        `ENOENT: no such file or directory, unlink '${path}'`
      );
      error.code = 'ENOENT';
      error.errno = -2;
      error.path = path;
      throw error;
    }
    if (existing[0].is_dir === 1) {
      const error: ErrnoException = new Error(`EPERM: operation not permitted, unlink '${path}'`);
      error.code = 'EPERM';
      error.errno = -1;
      error.path = path;
      throw error;
    }

    this.db
      .delete(gitObjects)
      .where(and(eq(gitObjects.path, normalized), eq(gitObjects.is_dir, 0)))
      .run();
  }

  async readdir(path: string): Promise<string[]> {
    const normalized = path.replace(/^\/+|\/+$/g, '');

    const dirCheck = this.db
      .select({ is_dir: gitObjects.is_dir })
      .from(gitObjects)
      .where(eq(gitObjects.path, normalized))
      .all();

    if (!dirCheck[0] || !dirCheck[0].is_dir) {
      const error: ErrnoException = new Error(
        `ENOENT: no such file or directory, scandir '${path}'`
      );
      error.code = 'ENOENT';
      error.errno = -2;
      error.path = path;
      throw error;
    }

    const rows = this.db
      .select({ path: gitObjects.path })
      .from(gitObjects)
      .where(eq(gitObjects.parent_path, normalized))
      .all();

    if (rows.length === 0) return [];

    // Extract just the basename from each path
    return rows.map(row => {
      const parts = row.path.split('/');
      return parts[parts.length - 1];
    });
  }

  async mkdir(path: string, _options?: unknown): Promise<void> {
    const normalized = path.replace(/^\/+|\/+$/g, '');

    if (!normalized) return;

    const parts = normalized.split('/');
    const isDirectChildOfRoot = parts.length === 1;

    if (!isDirectChildOfRoot) {
      const parentPath = parts.slice(0, -1).join('/');
      const parent = this.db
        .select({ is_dir: gitObjects.is_dir })
        .from(gitObjects)
        .where(eq(gitObjects.path, parentPath))
        .all();

      if (!parent[0] || parent[0].is_dir !== 1) {
        const error: ErrnoException = new Error(
          `ENOENT: no such file or directory, mkdir '${path}'`
        );
        error.code = 'ENOENT';
        error.errno = -2;
        error.path = path;
        throw error;
      }
    }

    // Check if already exists (after parent check to fail fast on missing parent)
    const existing = this.db
      .select({ is_dir: gitObjects.is_dir })
      .from(gitObjects)
      .where(eq(gitObjects.path, normalized))
      .all();

    if (existing[0]) {
      if (existing[0].is_dir === 1) {
        return;
      } else {
        const error: ErrnoException = new Error(`EEXIST: file already exists, mkdir '${path}'`);
        error.code = 'EEXIST';
        error.errno = -17;
        error.path = path;
        throw error;
      }
    }

    const parentPath = parts.length > 1 ? parts.slice(0, -1).join('/') : '';
    this.db
      .insert(gitObjects)
      .values({
        path: normalized,
        parent_path: parentPath,
        data: '',
        is_dir: 1,
        mtime: Date.now(),
      })
      .onConflictDoNothing()
      .run();
  }

  async rmdir(path: string): Promise<void> {
    const normalized = path.replace(/^\/+|\/+$/g, '');

    if (!normalized) {
      throw new Error('Cannot remove root directory');
    }

    const existing = this.db
      .select({ is_dir: gitObjects.is_dir })
      .from(gitObjects)
      .where(eq(gitObjects.path, normalized))
      .all();

    if (!existing[0]) {
      const error: ErrnoException = new Error(`ENOENT: no such file or directory, rmdir '${path}'`);
      error.code = 'ENOENT';
      error.errno = -2;
      error.path = path;
      throw error;
    }
    if (existing[0].is_dir !== 1) {
      const error: ErrnoException = new Error(`ENOTDIR: not a directory, rmdir '${path}'`);
      error.code = 'ENOTDIR';
      error.errno = -20;
      error.path = path;
      throw error;
    }

    // Check if directory is empty (has no direct children)
    const children = this.db
      .select({ path: gitObjects.path })
      .from(gitObjects)
      .where(eq(gitObjects.parent_path, normalized))
      .limit(1)
      .all();

    if (children.length > 0) {
      const error: ErrnoException = new Error(`ENOTEMPTY: directory not empty, rmdir '${path}'`);
      error.code = 'ENOTEMPTY';
      error.errno = -39;
      error.path = path;
      throw error;
    }

    this.db.delete(gitObjects).where(eq(gitObjects.path, normalized)).run();
  }

  async stat(
    path: string
  ): Promise<{ type: 'file' | 'dir'; mode: number; size: number; mtimeMs: number }> {
    const normalized = path.replace(/^\/+/, '');
    const result = this.db
      .select({
        data: gitObjects.data,
        mtime: gitObjects.mtime,
        is_dir: gitObjects.is_dir,
      })
      .from(gitObjects)
      .where(eq(gitObjects.path, normalized))
      .all();

    if (!result[0]) {
      const error: ErrnoException = new Error(`ENOENT: no such file or directory, stat '${path}'`);
      error.code = 'ENOENT';
      error.errno = -2;
      error.path = path;
      throw error;
    }

    const row = result[0];
    const isDir = row.is_dir === 1;

    // Calculate actual size for files (base64 is ~1.33x larger than binary)
    let size = 0;
    if (!isDir && row.data) {
      // Approximate binary size from base64 length
      size = Math.floor(row.data.length * 0.75);
    }

    const type: 'file' | 'dir' = isDir ? 'dir' : 'file';
    const statResult = {
      type,
      mode: isDir ? 0o040755 : 0o100644,
      size,
      mtimeMs: row.mtime,
      // Node.js stat properties for isomorphic-git
      dev: 0,
      ino: 0,
      uid: 0,
      gid: 0,
      ctime: new Date(row.mtime),
      mtime: new Date(row.mtime),
      ctimeMs: row.mtime,
      isFile: () => !isDir,
      isDirectory: () => isDir,
      isSymbolicLink: () => false,
    };
    return statResult;
  }

  async lstat(path: string) {
    return await this.stat(path);
  }

  async symlink(target: string, path: string): Promise<void> {
    await this.writeFile(path, target);
  }

  async readlink(path: string): Promise<string> {
    return (await this.readFile(path, { encoding: 'utf8' })) as string;
  }

  async exists(path: string): Promise<boolean> {
    try {
      await this.stat(path);
      return true;
    } catch (err) {
      if ((err as ErrnoException).code === 'ENOENT') {
        return false;
      }
      throw err;
    }
  }

  async write(path: string, data: Uint8Array | string): Promise<void> {
    return await this.writeFile(path, data);
  }

  exportGitObjects(): Array<{ path: string; data: Uint8Array }> {
    const objects = this.db
      .select({
        path: gitObjects.path,
        data: gitObjects.data,
      })
      .from(gitObjects)
      .where(and(like(gitObjects.path, '.git/%'), eq(gitObjects.is_dir, 0)))
      .all();

    const exported: Array<{ path: string; data: Uint8Array }> = [];

    for (const obj of objects) {
      // Decode base64 to binary
      const binaryString = atob(obj.data);
      const bytes = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }

      exported.push({
        path: obj.path,
        data: bytes,
      });
    }

    return exported;
  }
}
