/**
 * In-memory filesystem for git clone operations
 * Full async implementation for isomorphic-git compatibility
 */

import type { ErrnoException } from '../types';

export class MemFS {
  private files = new Map<string, Uint8Array>();

  constructor() {
    // promises property required for isomorphic-git
    Object.defineProperty(this, 'promises', {
      value: this,
      enumerable: true,
      writable: false,
      configurable: false,
    });
  }

  async writeFile(path: string, data: string | Uint8Array): Promise<void> {
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;

    const normalized = path.startsWith('/') ? path.slice(1) : path;
    this.files.set(normalized, bytes);
  }

  async readFile(path: string, options?: { encoding?: string }): Promise<Uint8Array | string> {
    const normalized = path.startsWith('/') ? path.slice(1) : path;
    const data = this.files.get(normalized);

    if (!data) {
      const error: ErrnoException = new Error(`ENOENT: no such file or directory, open '${path}'`);
      error.code = 'ENOENT';
      throw error;
    }

    if (options?.encoding === 'utf8') {
      return new TextDecoder().decode(data);
    }

    return data;
  }

  async readdir(dirPath: string): Promise<string[]> {
    const normalized = dirPath === '/' ? '' : dirPath.startsWith('/') ? dirPath.slice(1) : dirPath;
    const prefix = normalized ? normalized + '/' : '';
    const results = new Set<string>();

    for (const filePath of this.files.keys()) {
      if (filePath.startsWith(prefix)) {
        const relative = filePath.slice(prefix.length);
        const firstPart = relative.split('/')[0];
        if (firstPart) {
          results.add(firstPart);
        }
      }
    }

    return Array.from(results);
  }

  async stat(path: string): Promise<{
    type: 'file' | 'dir';
    mode: number;
    size: number;
    mtimeMs: number;
    ino: number;
    uid: number;
    gid: number;
    dev: number;
    ctime: Date;
    mtime: Date;
    ctimeMs: number;
    isFile: () => boolean;
    isDirectory: () => boolean;
    isSymbolicLink: () => boolean;
  }> {
    const normalized = path.startsWith('/') ? path.slice(1) : path;

    // Check if it's a file
    const data = this.files.get(normalized);
    if (data) {
      return {
        type: 'file' as const,
        mode: 0o100644,
        size: data.length,
        mtimeMs: Date.now(),
        ino: 0,
        uid: 0,
        gid: 0,
        dev: 0,
        ctime: new Date(),
        mtime: new Date(),
        ctimeMs: Date.now(),
        isFile: () => true,
        isDirectory: () => false,
        isSymbolicLink: () => false,
      };
    }

    // Check if it's a directory (has children)
    const prefix = normalized ? normalized + '/' : '';
    for (const filePath of this.files.keys()) {
      if (filePath.startsWith(prefix)) {
        return {
          type: 'dir' as const,
          mode: 0o040755,
          size: 0,
          mtimeMs: Date.now(),
          ino: 0,
          uid: 0,
          gid: 0,
          dev: 0,
          ctime: new Date(),
          mtime: new Date(),
          ctimeMs: Date.now(),
          isFile: () => false,
          isDirectory: () => true,
          isSymbolicLink: () => false,
        };
      }
    }

    const error: ErrnoException = new Error(`ENOENT: no such file or directory, stat '${path}'`);
    error.code = 'ENOENT';
    throw error;
  }

  async lstat(path: string) {
    return this.stat(path);
  }

  async mkdir(_path: string, _options?: unknown): Promise<void> {
    // No-op: directories implicit in paths
  }

  async rmdir(_path: string): Promise<void> {
    // No-op
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    const oldNormalized = oldPath.startsWith('/') ? oldPath.slice(1) : oldPath;
    const newNormalized = newPath.startsWith('/') ? newPath.slice(1) : newPath;

    const data = this.files.get(oldNormalized);
    if (data) {
      this.files.set(newNormalized, data);
      this.files.delete(oldNormalized);
    }
  }

  async chmod(_path: string, _mode: number): Promise<void> {
    // No-op
  }

  async readlink(_path: string): Promise<string> {
    throw new Error('Symbolic links not supported in MemFS');
  }

  async symlink(_target: string, _path: string): Promise<void> {
    throw new Error('Symbolic links not supported in MemFS');
  }

  async unlink(path: string): Promise<void> {
    const normalized = path.startsWith('/') ? path.slice(1) : path;
    this.files.delete(normalized);
  }
}
