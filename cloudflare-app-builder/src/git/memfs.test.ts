/**
 * Unit tests for MemFS in-memory filesystem
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { MemFS } from './memfs';

describe('MemFS', () => {
  let fs: MemFS;

  beforeEach(() => {
    fs = new MemFS();
  });

  describe('constructor', () => {
    it('sets promises property to self for isomorphic-git compatibility', () => {
      expect((fs as unknown as { promises: MemFS }).promises).toBe(fs);
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

    it('overwrites existing file', async () => {
      await fs.writeFile('file.txt', 'original');
      await fs.writeFile('file.txt', 'updated');
      const content = await fs.readFile('file.txt', { encoding: 'utf8' });
      expect(content).toBe('updated');
    });

    it('handles nested paths', async () => {
      await fs.writeFile('a/b/c/file.txt', 'nested');
      const content = await fs.readFile('a/b/c/file.txt', { encoding: 'utf8' });
      expect(content).toBe('nested');
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
      }
    });

    it('handles paths with leading slashes', async () => {
      await fs.writeFile('file.txt', 'content');
      const content = await fs.readFile('/file.txt', { encoding: 'utf8' });
      expect(content).toBe('content');
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

    it('handles root directory with slash', async () => {
      await fs.writeFile('root-file.txt', 'content');

      const entries = await fs.readdir('/');
      expect(entries).toContain('root-file.txt');
    });

    it('handles root directory with empty string', async () => {
      await fs.writeFile('root-file.txt', 'content');

      const entries = await fs.readdir('');
      expect(entries).toContain('root-file.txt');
    });

    it('returns empty array for directory with no children', async () => {
      await fs.writeFile('other/file.txt', 'content');

      // 'emptydir' has no files - readdir should return empty
      const entries = await fs.readdir('emptydir');
      expect(entries).toEqual([]);
    });

    it('normalizes paths with leading slashes', async () => {
      await fs.writeFile('mydir/file.txt', 'content');

      const entries = await fs.readdir('/mydir');
      expect(entries).toContain('file.txt');
    });
  });

  describe('stat', () => {
    it('returns file stats', async () => {
      await fs.writeFile('file.txt', 'Hello World');
      const stat = await fs.stat('file.txt');

      expect(stat.type).toBe('file');
      expect(stat.mode).toBe(0o100644);
      expect(stat.size).toBe(11);
      expect(stat.isFile()).toBe(true);
      expect(stat.isDirectory()).toBe(false);
      expect(stat.isSymbolicLink()).toBe(false);
    });

    it('returns directory stats', async () => {
      await fs.writeFile('mydir/file.txt', 'content');
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

    it('normalizes paths with leading slashes', async () => {
      await fs.writeFile('file.txt', 'content');
      const stat = await fs.stat('/file.txt');
      expect(stat.type).toBe('file');
    });

    it('includes timestamp properties', async () => {
      await fs.writeFile('file.txt', 'content');
      const stat = await fs.stat('file.txt');

      expect(stat.mtimeMs).toBeGreaterThan(0);
      expect(stat.ctimeMs).toBeGreaterThan(0);
      expect(stat.ctime).toBeInstanceOf(Date);
      expect(stat.mtime).toBeInstanceOf(Date);
    });
  });

  describe('lstat', () => {
    it('delegates to stat', async () => {
      await fs.writeFile('file.txt', 'content');
      const stat = await fs.stat('file.txt');
      const lstat = await fs.lstat('file.txt');

      expect(lstat.type).toBe(stat.type);
      expect(lstat.mode).toBe(stat.mode);
      expect(lstat.size).toBe(stat.size);
    });
  });

  describe('mkdir', () => {
    it('is a no-op (directories are implicit)', async () => {
      await fs.mkdir('somedir');
      // No error should occur, directories are implicit in MemFS
    });

    it('accepts options parameter', async () => {
      await fs.mkdir('somedir', { recursive: true });
      // No error should occur
    });
  });

  describe('rmdir', () => {
    it('is a no-op', async () => {
      await fs.writeFile('dir/file.txt', 'content');
      await fs.rmdir('dir');
      // No error should occur - rmdir is no-op in MemFS
    });
  });

  describe('rename', () => {
    it('renames a file', async () => {
      await fs.writeFile('old.txt', 'content');
      await fs.rename('old.txt', 'new.txt');

      const content = await fs.readFile('new.txt', { encoding: 'utf8' });
      expect(content).toBe('content');

      // Old file should no longer exist
      try {
        await fs.readFile('old.txt');
        expect.fail('Should have thrown');
      } catch (err) {
        expect((err as NodeJS.ErrnoException).code).toBe('ENOENT');
      }
    });

    it('normalizes paths with leading slashes', async () => {
      await fs.writeFile('file.txt', 'content');
      await fs.rename('/file.txt', '/renamed.txt');

      const content = await fs.readFile('renamed.txt', { encoding: 'utf8' });
      expect(content).toBe('content');
    });

    it('does nothing if source does not exist', async () => {
      await fs.rename('nonexistent.txt', 'new.txt');
      // No error, just no-op
    });
  });

  describe('chmod', () => {
    it('is a no-op', async () => {
      await fs.writeFile('file.txt', 'content');
      await fs.chmod('file.txt', 0o755);
      // No error should occur - chmod is no-op in MemFS
    });
  });

  describe('readlink', () => {
    it('throws error (symlinks not supported)', async () => {
      await expect(fs.readlink('anypath')).rejects.toThrow('Symbolic links not supported');
    });
  });

  describe('symlink', () => {
    it('throws error (symlinks not supported)', async () => {
      await expect(fs.symlink('/target', '/link')).rejects.toThrow('Symbolic links not supported');
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

    it('normalizes paths with leading slashes', async () => {
      await fs.writeFile('file.txt', 'content');
      await fs.unlink('/file.txt');

      try {
        await fs.readFile('file.txt');
        expect.fail('Should have thrown');
      } catch (err) {
        expect((err as NodeJS.ErrnoException).code).toBe('ENOENT');
      }
    });

    it('does nothing for non-existent file', async () => {
      await fs.unlink('nonexistent.txt');
      // No error - just deletes from map (no-op if not present)
    });
  });

  describe('edge cases', () => {
    it('handles empty file content', async () => {
      await fs.writeFile('empty.txt', '');
      const content = await fs.readFile('empty.txt', { encoding: 'utf8' });
      expect(content).toBe('');
    });

    it('handles binary data with null bytes', async () => {
      const data = new Uint8Array([0, 1, 2, 0, 3, 4, 0]);
      await fs.writeFile('binary.bin', data);
      const content = await fs.readFile('binary.bin');
      expect(Array.from(content as Uint8Array)).toEqual([0, 1, 2, 0, 3, 4, 0]);
    });

    it('handles deeply nested paths', async () => {
      const path = 'a/b/c/d/e/f/g/h/file.txt';
      await fs.writeFile(path, 'deep');
      const content = await fs.readFile(path, { encoding: 'utf8' });
      expect(content).toBe('deep');

      // Intermediate directories should be detected
      const stat = await fs.stat('a/b/c');
      expect(stat.type).toBe('dir');
    });

    it('handles unicode content', async () => {
      const unicode = '你好世界 🌍 مرحبا';
      await fs.writeFile('unicode.txt', unicode);
      const content = await fs.readFile('unicode.txt', { encoding: 'utf8' });
      expect(content).toBe(unicode);
    });
  });
});
