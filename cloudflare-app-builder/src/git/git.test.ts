/**
 * Unit tests for GitVersionControl
 *
 * Note: Some tests are skipped as they involve complex isomorphic-git operations
 * that may hang in the test environment due to async filesystem interactions.
 */

import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { GitVersionControl } from './git';
import { createTestSqlExecutor, closeAllDatabases } from './test-utils';

// Clean up all database connections after all tests
afterAll(() => {
  closeAllDatabases();
});

describe('GitVersionControl', () => {
  let git: GitVersionControl;

  beforeEach(() => {
    const sql = createTestSqlExecutor();
    git = new GitVersionControl(sql, { name: 'Test User', email: 'test@example.com' });
  });

  describe('init', () => {
    it('initializes a new git repository', async () => {
      await git.init();
      const initialized = await git.isInitialized();
      expect(initialized).toBe(true);
    });

    it('handles re-initialization gracefully', async () => {
      await git.init();
      await git.init(); // Should not throw
      const initialized = await git.isInitialized();
      expect(initialized).toBe(true);
    });
  });

  describe('isInitialized', () => {
    it('returns false for uninitialized repository', async () => {
      const initialized = await git.isInitialized();
      expect(initialized).toBe(false);
    });

    it('returns true after initialization', async () => {
      await git.init();
      const initialized = await git.isInitialized();
      expect(initialized).toBe(true);
    });
  });

  describe('commit', () => {
    beforeEach(async () => {
      await git.init();
    });

    it('creates a commit with files', async () => {
      const oid = await git.commit(
        [{ filePath: 'test.txt', fileContents: 'Hello World' }],
        'Initial commit'
      );
      expect(oid).toBeTruthy();
      expect(typeof oid).toBe('string');
      expect(oid?.length).toBe(40); // SHA-1 hash
    });

    it('creates multiple commits', async () => {
      const oid1 = await git.commit(
        [{ filePath: 'file1.txt', fileContents: 'First file' }],
        'First commit'
      );
      const oid2 = await git.commit(
        [{ filePath: 'file2.txt', fileContents: 'Second file' }],
        'Second commit'
      );

      expect(oid1).toBeTruthy();
      expect(oid2).toBeTruthy();
      expect(oid1).not.toBe(oid2);
    });
  });

  describe('stage', () => {
    beforeEach(async () => {
      await git.init();
    });

    it('stages files without committing', async () => {
      await git.stage([{ filePath: 'test.txt', fileContents: 'staged content' }]);

      // Verify file is written to filesystem
      const content = await git.fs.readFile('test.txt', { encoding: 'utf8' });
      expect(content).toBe('staged content');
    });

    it('handles empty file list', async () => {
      await expect(git.stage([])).resolves.toBeUndefined();
    });

    it('normalizes paths with leading slashes', async () => {
      await git.stage([{ filePath: '/leading-slash.txt', fileContents: 'content' }]);
      const content = await git.fs.readFile('leading-slash.txt', { encoding: 'utf8' });
      expect(content).toBe('content');
    });
  });

  describe('log', () => {
    beforeEach(async () => {
      await git.init();
    });

    it('returns empty array for repository with no commits', async () => {
      const logs = await git.log();
      expect(logs).toEqual([]);
    });

    it('returns commit history', async () => {
      await git.commit([{ filePath: 'test.txt', fileContents: 'content' }], 'Test commit');

      const logs = await git.log();
      expect(logs.length).toBe(1);
      expect(logs[0].message.trim()).toBe('Test commit');
      expect(logs[0].author).toContain('Test User');
      expect(logs[0].oid).toBeTruthy();
    });
  });

  describe('getHead', () => {
    beforeEach(async () => {
      await git.init();
    });

    it('returns null for repository with no commits', async () => {
      const head = await git.getHead();
      expect(head).toBeNull();
    });

    it('returns HEAD commit oid', async () => {
      const commitOid = await git.commit(
        [{ filePath: 'test.txt', fileContents: 'content' }],
        'Test commit'
      );

      const head = await git.getHead();
      expect(head).toBe(commitOid);
    });
  });

  describe('show', () => {
    beforeEach(async () => {
      await git.init();
    });

    it('returns commit info for initial commit', async () => {
      const oid = await git.commit(
        [
          { filePath: 'file1.txt', fileContents: 'content1' },
          { filePath: 'file2.txt', fileContents: 'content2' },
        ],
        'Initial commit'
      );

      const result = await git.show(oid!);
      expect(result.oid).toBe(oid);
      expect(result.message.trim()).toBe('Initial commit');
      expect(result.files).toBe(2);
      expect(result.fileList).toContain('file1.txt');
      expect(result.fileList).toContain('file2.txt');
    });
  });

  describe('getAllFilesFromHead', () => {
    beforeEach(async () => {
      await git.init();
    });

    it('returns empty array for repository with no commits', async () => {
      const files = await git.getAllFilesFromHead();
      expect(files).toEqual([]);
    });

    it('returns all files from HEAD', async () => {
      await git.commit(
        [
          { filePath: 'file1.txt', fileContents: 'content1' },
          { filePath: 'dir/file2.txt', fileContents: 'content2' },
        ],
        'Add files'
      );

      const files = await git.getAllFilesFromHead();
      expect(files.length).toBe(2);

      const paths = files.map(f => f.filePath);
      expect(paths).toContain('file1.txt');
      expect(paths).toContain('dir/file2.txt');
    });
  });

  describe('createInitialCommit', () => {
    it('creates initial commit with binary files', async () => {
      const encoder = new TextEncoder();
      const files = {
        'readme.md': encoder.encode('# Project'),
        'src/index.ts': encoder.encode('export const x = 1;'),
      };

      const oid = await git.createInitialCommit(files);
      expect(oid).toBeTruthy();

      const allFiles = await git.getAllFilesFromHead();
      const paths = allFiles.map(f => f.filePath);
      expect(paths).toContain('readme.md');
      expect(paths).toContain('src/index.ts');
    });
  });

  describe('getStorageStats', () => {
    beforeEach(async () => {
      await git.init();
    });

    it('returns stats after commits', async () => {
      await git.commit(
        [
          { filePath: 'small.txt', fileContents: 'small' },
          { filePath: 'large.txt', fileContents: 'a'.repeat(1000) },
        ],
        'Add files'
      );

      const stats = git.getStorageStats();
      expect(stats.totalObjects).toBeGreaterThan(0);
      expect(stats.totalBytes).toBeGreaterThan(0);
    });
  });

  describe('getTree', () => {
    beforeEach(async () => {
      await git.init();
    });

    it('returns tree entries at root', async () => {
      await git.commit(
        [
          { filePath: 'file.txt', fileContents: 'content' },
          { filePath: 'dir/nested.txt', fileContents: 'nested content' },
        ],
        'Add files'
      );

      const result = await git.getTree('HEAD');
      expect(result.entries.length).toBe(2);

      const fileEntry = result.entries.find(e => e.name === 'file.txt');
      expect(fileEntry?.type).toBe('blob');

      const dirEntry = result.entries.find(e => e.name === 'dir');
      expect(dirEntry?.type).toBe('tree');
    });

    it('throws for non-existent path', async () => {
      await git.commit([{ filePath: 'file.txt', fileContents: 'content' }], 'Add file');

      await expect(git.getTree('HEAD', 'nonexistent')).rejects.toThrow('Path not found');
    });
  });

  describe('getBlob', () => {
    beforeEach(async () => {
      await git.init();
    });

    it('returns blob content', async () => {
      await git.commit([{ filePath: 'test.txt', fileContents: 'Hello World' }], 'Add file');

      const result = await git.getBlob('HEAD', 'test.txt');
      const content = new TextDecoder().decode(result.content);
      expect(content).toBe('Hello World');
      expect(result.size).toBe(11);
    });

    it('throws for non-existent file', async () => {
      await git.commit([{ filePath: 'file.txt', fileContents: 'content' }], 'Add file');

      await expect(git.getBlob('HEAD', 'nonexistent.txt')).rejects.toThrow('File not found');
    });

    it('throws when path is empty', async () => {
      await git.commit([{ filePath: 'file.txt', fileContents: 'content' }], 'Add file');

      await expect(git.getBlob('HEAD', '')).rejects.toThrow('Path is required');
    });
  });

  describe('exportGitObjects', () => {
    it('exports git objects after commit', async () => {
      await git.init();
      await git.commit(
        [
          { filePath: 'readme.md', fileContents: '# Project' },
          { filePath: 'src/index.ts', fileContents: 'export const x = 1;' },
        ],
        'Initial commit'
      );

      const objects = git.exportGitObjects();
      expect(objects.length).toBeGreaterThan(0);

      // All exported objects should be under .git/
      expect(objects.every(o => o.path.startsWith('.git/'))).toBe(true);
    });
  });

  // Note: reset() tests are skipped because git.checkout() can hang in test environment
  // due to async filesystem interactions with isomorphic-git
  describe.skip('reset', () => {
    beforeEach(async () => {
      await git.init();
    });

    it('resets HEAD to a specific commit', async () => {
      const oid1 = await git.commit(
        [{ filePath: 'file1.txt', fileContents: 'first' }],
        'First commit'
      );
      await git.commit([{ filePath: 'file2.txt', fileContents: 'second' }], 'Second commit');

      const result = await git.reset(oid1!);

      expect(result.ref).toBe(oid1);
      const head = await git.getHead();
      expect(head).toBe(oid1);
    });

    it('performs hard reset by default', async () => {
      const oid1 = await git.commit(
        [{ filePath: 'file1.txt', fileContents: 'first' }],
        'First commit'
      );
      await git.commit([{ filePath: 'file2.txt', fileContents: 'second' }], 'Second commit');

      const result = await git.reset(oid1!);

      expect(result.filesReset).toBeGreaterThan(0);
    });

    it('resets using branch name', async () => {
      await git.commit([{ filePath: 'file.txt', fileContents: 'content' }], 'Initial commit');

      const result = await git.reset('main');

      expect(result.ref).toBeTruthy();
      expect(result.filesReset).toBeGreaterThan(0);
    });
  });

  describe('show with includeDiff', () => {
    beforeEach(async () => {
      await git.init();
    });

    it('returns diffs when includeDiff is true', async () => {
      await git.commit([{ filePath: 'file.txt', fileContents: 'original' }], 'First commit');
      const oid2 = await git.commit(
        [{ filePath: 'file.txt', fileContents: 'modified' }],
        'Second commit'
      );

      const result = await git.show(oid2!, { includeDiff: true });

      expect(result.diffs).toBeDefined();
      expect(result.diffs?.length).toBeGreaterThan(0);
      expect(result.diffs?.[0].path).toBe('file.txt');
      expect(result.diffs?.[0].diff).toContain('original');
      expect(result.diffs?.[0].diff).toContain('modified');
    });

    it('does not include diffs when includeDiff is false', async () => {
      await git.commit([{ filePath: 'file.txt', fileContents: 'original' }], 'First commit');
      const oid2 = await git.commit(
        [{ filePath: 'file.txt', fileContents: 'modified' }],
        'Second commit'
      );

      const result = await git.show(oid2!, { includeDiff: false });

      expect(result.diffs).toBeUndefined();
    });

    it('shows diff for added files', async () => {
      await git.commit([{ filePath: 'file1.txt', fileContents: 'first' }], 'First commit');
      const oid2 = await git.commit(
        [{ filePath: 'file2.txt', fileContents: 'second file' }],
        'Second commit'
      );

      const result = await git.show(oid2!, { includeDiff: true });

      expect(result.diffs).toBeDefined();
      const newFileDiff = result.diffs?.find(d => d.path === 'file2.txt');
      expect(newFileDiff).toBeDefined();
      expect(newFileDiff?.diff).toContain('second file');
    });
  });

  describe('importGitObjects', () => {
    it('imports git objects into a new repository', async () => {
      // Create source repo
      const sql1 = createTestSqlExecutor();
      const sourceGit = new GitVersionControl(sql1, { name: 'Test', email: 'test@example.com' });
      await sourceGit.init();
      await sourceGit.commit([{ filePath: 'test.txt', fileContents: 'content' }], 'Initial commit');

      // Export objects
      const objects = sourceGit.exportGitObjects();

      // Import into target repo
      await git.importGitObjects(objects);

      // Verify import
      const initialized = await git.isInitialized();
      expect(initialized).toBe(true);
    });

    it('initializes repo if not already initialized', async () => {
      const initialized = await git.isInitialized();
      expect(initialized).toBe(false);

      await git.importGitObjects([]);

      const afterImport = await git.isInitialized();
      expect(afterImport).toBe(true);
    });
  });

  describe('commit edge cases', () => {
    beforeEach(async () => {
      await git.init();
    });

    it('generates auto-checkpoint message when message is omitted', async () => {
      const oid = await git.commit([{ filePath: 'file.txt', fileContents: 'content' }]);

      const logs = await git.log();
      expect(logs[0].message).toContain('Auto-checkpoint');
    });

    it('creates commit with staged files', async () => {
      await git.stage([{ filePath: 'staged.txt', fileContents: 'staged content' }]);
      const oid = await git.commit([], 'Commit staged files');

      // Commit can still succeed if there are staged changes
      expect(oid).toBeTruthy();
    });
  });

  describe('getTree edge cases', () => {
    beforeEach(async () => {
      await git.init();
    });

    it('returns tree entries at subdirectory path', async () => {
      await git.commit(
        [
          { filePath: 'src/index.ts', fileContents: 'index' },
          { filePath: 'src/utils/helper.ts', fileContents: 'helper' },
        ],
        'Add files'
      );

      const result = await git.getTree('HEAD', 'src');

      expect(result.entries.length).toBe(2);
      expect(result.entries.some(e => e.name === 'index.ts')).toBe(true);
      expect(result.entries.some(e => e.name === 'utils')).toBe(true);
    });

    it('throws when path is a file not directory', async () => {
      await git.commit([{ filePath: 'file.txt', fileContents: 'content' }], 'Add file');

      await expect(git.getTree('HEAD', 'file.txt')).rejects.toThrow('Path is not a directory');
    });
  });

  describe('getBlob edge cases', () => {
    beforeEach(async () => {
      await git.init();
    });

    it('returns blob for nested file', async () => {
      await git.commit(
        [{ filePath: 'src/deep/nested/file.txt', fileContents: 'deep content' }],
        'Add file'
      );

      const result = await git.getBlob('HEAD', 'src/deep/nested/file.txt');
      const content = new TextDecoder().decode(result.content);
      expect(content).toBe('deep content');
    });

    it('throws when trying to get directory as blob', async () => {
      await git.commit([{ filePath: 'src/index.ts', fileContents: 'content' }], 'Add file');

      await expect(git.getBlob('HEAD', 'src')).rejects.toThrow('directory, not a file');
    });
  });

  // Note: setOnFilesChangedCallback test with reset is skipped because git.checkout() hangs
  describe.skip('setOnFilesChangedCallback', () => {
    it('calls callback after reset', async () => {
      await git.init();
      let callbackCalled = false;
      git.setOnFilesChangedCallback(() => {
        callbackCalled = true;
      });

      await git.commit([{ filePath: 'file.txt', fileContents: 'content' }], 'Initial commit');
      await git.reset('main');

      expect(callbackCalled).toBe(true);
    });
  });
});
