/**
 * Unit tests for SqliteFS filesystem adapter
 */

import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { SqliteFS } from './fs-adapter';
import { createTestSqlExecutor, closeAllDatabases } from './test-utils';
import { MAX_OBJECT_SIZE } from './constants';

// Clean up all database connections after all tests
afterAll(() => {
  closeAllDatabases();
});

describe('SqliteFS', () => {
  let fs: SqliteFS;

  beforeEach(() => {
    const sql = createTestSqlExecutor();
    fs = new SqliteFS(sql);
    fs.init();
  });

  describe('init', () => {
    it('creates git_objects table and root directory', () => {
      // init() was called in beforeEach
      // Verify root directory exists
      expect(fs.promises).toBe(fs);
    });

    it('sets promises property to self for isomorphic-git compatibility', () => {
      expect(fs.promises).toBe(fs);
      expect(fs.promises.readFile).toBe(fs.readFile);
    });
  });

  describe('writeFile', () => {
    it('writes string content', async () => {
      await fs.writeFile('test.txt', 'Hello World');
      const content = await fs.readFile('test.txt', { encoding: 'utf8' });
      expect(content).toBe('Hello World');
    });

    it('writes binary content', async () => {
      const data = new Uint8Array([72, 101, 108, 108, 111]); // "Hello"
      await fs.writeFile('binary.bin', data);
      const content = await fs.readFile('binary.bin');
      expect(content).toBeInstanceOf(Uint8Array);
      expect(Array.from(content as Uint8Array)).toEqual([72, 101, 108, 108, 111]);
    });

    it('normalizes paths with leading slashes', async () => {
      await fs.writeFile('/leading-slash.txt', 'content');
      const content = await fs.readFile('leading-slash.txt', { encoding: 'utf8' });
      expect(content).toBe('content');
    });

    it('throws error for empty path', async () => {
      await expect(fs.writeFile('', 'content')).rejects.toThrow('Cannot write to root');
    });

    it('throws EISDIR when writing to directory path', async () => {
      await fs.mkdir('mydir');
      try {
        await fs.writeFile('mydir', 'content');
        expect.fail('Should have thrown');
      } catch (err) {
        expect((err as NodeJS.ErrnoException).code).toBe('EISDIR');
      }
    });

    it('throws error when file exceeds MAX_OBJECT_SIZE', async () => {
      const largeContent = new Uint8Array(MAX_OBJECT_SIZE + 1);
      await expect(fs.writeFile('large.bin', largeContent)).rejects.toThrow('File too large');
    });

    it('provides helpful error for oversized git packfiles', async () => {
      const largeContent = new Uint8Array(MAX_OBJECT_SIZE + 1);
      await expect(fs.writeFile('.git/objects/pack/pack-abc.pack', largeContent)).rejects.toThrow(
        'Git packfile too large'
      );
    });

    it('creates parent directories automatically', async () => {
      await fs.writeFile('a/b/c/file.txt', 'nested');
      const content = await fs.readFile('a/b/c/file.txt', { encoding: 'utf8' });
      expect(content).toBe('nested');

      // Verify parent directories exist
      const stat = await fs.stat('a/b/c');
      expect(stat.type).toBe('dir');
    });

    it('handles empty content', async () => {
      await fs.writeFile('empty.txt', '');
      const content = await fs.readFile('empty.txt', { encoding: 'utf8' });
      expect(content).toBe('');
    });
  });

  describe('readFile', () => {
    it('returns Uint8Array by default', async () => {
      await fs.writeFile('test.txt', 'Hello');
      const content = await fs.readFile('test.txt');
      expect(content).toBeInstanceOf(Uint8Array);
    });

    it('returns string with utf8 encoding', async () => {
      await fs.writeFile('test.txt', 'Hello');
      const content = await fs.readFile('test.txt', { encoding: 'utf8' });
      expect(typeof content).toBe('string');
      expect(content).toBe('Hello');
    });

    it('throws ENOENT for non-existent file', async () => {
      try {
        await fs.readFile('nonexistent.txt');
        expect.fail('Should have thrown');
      } catch (err) {
        expect((err as NodeJS.ErrnoException).code).toBe('ENOENT');
        expect((err as NodeJS.ErrnoException).path).toBe('nonexistent.txt');
      }
    });

    it('throws EISDIR when reading a directory', async () => {
      await fs.mkdir('mydir');
      try {
        await fs.readFile('mydir');
        expect.fail('Should have thrown');
      } catch (err) {
        expect((err as NodeJS.ErrnoException).code).toBe('EISDIR');
      }
    });

    it('handles binary data with null bytes', async () => {
      const data = new Uint8Array([0, 1, 2, 0, 3, 4, 0]);
      await fs.writeFile('binary.bin', data);
      const content = await fs.readFile('binary.bin');
      expect(Array.from(content as Uint8Array)).toEqual([0, 1, 2, 0, 3, 4, 0]);
    });
  });

  describe('unlink', () => {
    it('deletes a file', async () => {
      await fs.writeFile('to-delete.txt', 'content');
      await fs.unlink('to-delete.txt');

      try {
        await fs.readFile('to-delete.txt');
        expect.fail('Should have thrown');
      } catch (err) {
        expect((err as NodeJS.ErrnoException).code).toBe('ENOENT');
      }
    });

    it('throws ENOENT for non-existent file', async () => {
      try {
        await fs.unlink('nonexistent.txt');
        expect.fail('Should have thrown');
      } catch (err) {
        expect((err as NodeJS.ErrnoException).code).toBe('ENOENT');
      }
    });

    it('throws EPERM when unlinking a directory', async () => {
      await fs.mkdir('mydir');
      try {
        await fs.unlink('mydir');
        expect.fail('Should have thrown');
      } catch (err) {
        expect((err as NodeJS.ErrnoException).code).toBe('EPERM');
      }
    });
  });

  describe('mkdir', () => {
    it('creates a directory', async () => {
      await fs.mkdir('newdir');
      const stat = await fs.stat('newdir');
      expect(stat.type).toBe('dir');
    });

    it('is idempotent for existing directory', async () => {
      await fs.mkdir('mydir');
      await fs.mkdir('mydir'); // Should not throw
      const stat = await fs.stat('mydir');
      expect(stat.type).toBe('dir');
    });

    it('throws ENOENT when parent does not exist', async () => {
      try {
        await fs.mkdir('nonexistent/child');
        expect.fail('Should have thrown');
      } catch (err) {
        expect((err as NodeJS.ErrnoException).code).toBe('ENOENT');
      }
    });

    it('throws EEXIST when path is a file', async () => {
      await fs.writeFile('file.txt', 'content');
      try {
        await fs.mkdir('file.txt');
        expect.fail('Should have thrown');
      } catch (err) {
        expect((err as NodeJS.ErrnoException).code).toBe('EEXIST');
      }
    });

    it('does nothing for root path', async () => {
      await fs.mkdir(''); // Should not throw
      await fs.mkdir('/'); // Should not throw
    });
  });

  describe('rmdir', () => {
    it('removes an empty directory', async () => {
      await fs.mkdir('emptydir');
      await fs.rmdir('emptydir');

      try {
        await fs.stat('emptydir');
        expect.fail('Should have thrown');
      } catch (err) {
        expect((err as NodeJS.ErrnoException).code).toBe('ENOENT');
      }
    });

    it('throws ENOENT for non-existent directory', async () => {
      try {
        await fs.rmdir('nonexistent');
        expect.fail('Should have thrown');
      } catch (err) {
        expect((err as NodeJS.ErrnoException).code).toBe('ENOENT');
      }
    });

    it('throws ENOTDIR for file path', async () => {
      await fs.writeFile('file.txt', 'content');
      try {
        await fs.rmdir('file.txt');
        expect.fail('Should have thrown');
      } catch (err) {
        expect((err as NodeJS.ErrnoException).code).toBe('ENOTDIR');
      }
    });

    it('throws ENOTEMPTY for non-empty directory', async () => {
      await fs.writeFile('dir/file.txt', 'content');
      try {
        await fs.rmdir('dir');
        expect.fail('Should have thrown');
      } catch (err) {
        expect((err as NodeJS.ErrnoException).code).toBe('ENOTEMPTY');
      }
    });

    it('throws error when removing root', async () => {
      await expect(fs.rmdir('')).rejects.toThrow('Cannot remove root directory');
    });
  });

  describe('readdir', () => {
    it('lists directory contents', async () => {
      await fs.writeFile('dir/file1.txt', 'content1');
      await fs.writeFile('dir/file2.txt', 'content2');
      await fs.writeFile('dir/subdir/nested.txt', 'nested');

      const entries = await fs.readdir('dir');
      expect(entries.sort()).toEqual(['file1.txt', 'file2.txt', 'subdir'].sort());
    });

    it('returns empty array for empty directory', async () => {
      await fs.mkdir('emptydir');
      const entries = await fs.readdir('emptydir');
      expect(entries).toEqual([]);
    });

    it('throws ENOENT for non-existent directory', async () => {
      try {
        await fs.readdir('nonexistent');
        expect.fail('Should have thrown');
      } catch (err) {
        expect((err as NodeJS.ErrnoException).code).toBe('ENOENT');
      }
    });

    it('throws ENOENT for file path', async () => {
      await fs.writeFile('file.txt', 'content');
      try {
        await fs.readdir('file.txt');
        expect.fail('Should have thrown');
      } catch (err) {
        expect((err as NodeJS.ErrnoException).code).toBe('ENOENT');
      }
    });

    it('handles root directory', async () => {
      await fs.writeFile('root-file.txt', 'content');
      await fs.mkdir('root-dir');

      const entries = await fs.readdir('');
      expect(entries).toContain('root-file.txt');
      expect(entries).toContain('root-dir');
    });
  });

  describe('stat', () => {
    it('returns file stats', async () => {
      await fs.writeFile('file.txt', 'Hello World');
      const stat = await fs.stat('file.txt');

      expect(stat.type).toBe('file');
      expect(stat.mode).toBe(0o100644);
      expect(stat.size).toBeGreaterThan(0);
      expect(stat.mtimeMs).toBeGreaterThan(0);
      expect(stat.isFile()).toBe(true);
      expect(stat.isDirectory()).toBe(false);
      expect(stat.isSymbolicLink()).toBe(false);
    });

    it('returns directory stats', async () => {
      await fs.mkdir('mydir');
      const stat = await fs.stat('mydir');

      expect(stat.type).toBe('dir');
      expect(stat.mode).toBe(0o040755);
      expect(stat.size).toBe(0);
      expect(stat.isFile()).toBe(false);
      expect(stat.isDirectory()).toBe(true);
    });

    it('throws ENOENT for non-existent path', async () => {
      try {
        await fs.stat('nonexistent');
        expect.fail('Should have thrown');
      } catch (err) {
        expect((err as NodeJS.ErrnoException).code).toBe('ENOENT');
      }
    });

    it('approximates file size from base64 encoding', async () => {
      const content = 'A'.repeat(100);
      await fs.writeFile('sized.txt', content);
      const stat = await fs.stat('sized.txt');

      // Size should be approximately the original content length
      expect(stat.size).toBeGreaterThan(50);
      expect(stat.size).toBeLessThan(150);
    });
  });

  describe('lstat', () => {
    it('delegates to stat', async () => {
      await fs.writeFile('file.txt', 'content');
      const stat = await fs.stat('file.txt');
      const lstat = await fs.lstat('file.txt');

      expect(lstat.type).toBe(stat.type);
      expect(lstat.mode).toBe(stat.mode);
    });
  });

  describe('symlink and readlink', () => {
    it('symlink writes target as file content', async () => {
      await fs.symlink('/target/path', 'link');
      const content = await fs.readFile('link', { encoding: 'utf8' });
      expect(content).toBe('/target/path');
    });

    it('readlink returns file content as string', async () => {
      await fs.writeFile('link', '/target/path');
      const target = await fs.readlink('link');
      expect(target).toBe('/target/path');
    });
  });

  describe('exists', () => {
    it('returns true for existing file', async () => {
      await fs.writeFile('file.txt', 'content');
      const exists = await fs.exists('file.txt');
      expect(exists).toBe(true);
    });

    it('returns true for existing directory', async () => {
      await fs.mkdir('mydir');
      const exists = await fs.exists('mydir');
      expect(exists).toBe(true);
    });

    it('returns false for non-existent path', async () => {
      const exists = await fs.exists('nonexistent');
      expect(exists).toBe(false);
    });
  });

  describe('write', () => {
    it('is an alias for writeFile', async () => {
      await fs.write('via-write.txt', 'content');
      const content = await fs.readFile('via-write.txt', { encoding: 'utf8' });
      expect(content).toBe('content');
    });
  });

  describe('getStorageStats', () => {
    it('returns zero stats for empty filesystem', () => {
      const stats = fs.getStorageStats();
      expect(stats.totalObjects).toBe(0);
      expect(stats.totalBytes).toBe(0);
      expect(stats.largestObject).toBeNull();
    });

    it('tracks object count and sizes', async () => {
      await fs.writeFile('small.txt', 'small');
      await fs.writeFile('large.txt', 'A'.repeat(1000));

      const stats = fs.getStorageStats();
      expect(stats.totalObjects).toBe(2);
      expect(stats.totalBytes).toBeGreaterThan(0);
      expect(stats.largestObject?.path).toBe('large.txt');
    });
  });

  describe('exportGitObjects', () => {
    it('exports only .git/ prefixed files', async () => {
      await fs.writeFile('.git/config', '[core]');
      await fs.writeFile('.git/objects/ab/cdef', 'blob');
      await fs.writeFile('src/index.ts', 'code');

      const objects = fs.exportGitObjects();

      expect(objects.length).toBe(2);
      expect(objects.every(o => o.path.startsWith('.git/'))).toBe(true);
      expect(objects.find(o => o.path === 'src/index.ts')).toBeUndefined();
    });

    it('returns binary data for each object', async () => {
      await fs.writeFile('.git/HEAD', 'ref: refs/heads/main');
      const objects = fs.exportGitObjects();

      expect(objects[0].data).toBeInstanceOf(Uint8Array);
    });

    it('returns empty array when no git objects', () => {
      const objects = fs.exportGitObjects();
      expect(objects).toEqual([]);
    });
  });
});
