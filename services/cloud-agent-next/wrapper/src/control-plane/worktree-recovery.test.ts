import { describe, expect, it } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { restoreWorktreeRecovery } from './worktree-recovery.js';

const exec = promisify(execFile);
const added = (file: string, text = 'recovered') =>
  `diff --git a/${file} b/${file}\nnew file mode 100644\n--- /dev/null\n+++ b/${file}\n@@ -0,0 +1 @@\n+${text}\n`;

describe('local worktree recovery', () => {
  it('restores additions, modifications and deletions without changing the index', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'local-recovery-test-'));
    try {
      await exec('git', ['init', root]);
      await fs.writeFile(path.join(root, 'modified.txt'), 'before\n');
      await fs.writeFile(path.join(root, 'deleted.txt'), 'delete\n');
      await exec('git', ['add', '.'], { cwd: root });
      const diff = await restoreWorktreeRecovery(
        root,
        {
          files: [
            { path: 'added.txt', status: 'added', patch: added('added.txt') },
            {
              path: 'modified.txt',
              status: 'modified',
              patch:
                'diff --git a/modified.txt b/modified.txt\n--- a/modified.txt\n+++ b/modified.txt\n@@ -1 +1 @@\n-before\n+after\n',
            },
            {
              path: 'deleted.txt',
              status: 'deleted',
              patch:
                'diff --git a/deleted.txt b/deleted.txt\ndeleted file mode 100644\n--- a/deleted.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-delete\n',
            },
          ],
        },
        process.env,
        AbortSignal.timeout(10_000)
      );
      expect(diff.applied).toBe(3);
      expect(await fs.readFile(path.join(root, 'added.txt'), 'utf8')).toBe('recovered\n');
      expect(await fs.readFile(path.join(root, 'modified.txt'), 'utf8')).toBe('after\n');
      expect(
        await fs.access(path.join(root, 'deleted.txt')).then(
          () => true,
          () => false
        )
      ).toBe(false);
      expect((await exec('git', ['show', ':modified.txt'], { cwd: root })).stdout).toBe('before\n');
      const repeated = await restoreWorktreeRecovery(
        root,
        {
          files: [
            { path: 'added.txt', status: 'added', patch: added('added.txt') },
            {
              path: 'modified.txt',
              status: 'modified',
              patch:
                'diff --git a/modified.txt b/modified.txt\n--- a/modified.txt\n+++ b/modified.txt\n@@ -1 +1 @@\n-before\n+after\n',
            },
            {
              path: 'deleted.txt',
              status: 'deleted',
              patch:
                'diff --git a/deleted.txt b/deleted.txt\ndeleted file mode 100644\n--- a/deleted.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-delete\n',
            },
          ],
        },
        process.env,
        AbortSignal.timeout(10_000)
      );
      expect(repeated.applied).toBe(3);
      expect(repeated.skipped).toBe(0);
      expect(await fs.readFile(path.join(root, 'modified.txt'), 'utf8')).toBe('after\n');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('skips conflicts, missing patches, traversal, symlinks and multi-file patches', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'local-recovery-test-'));
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'local-recovery-outside-'));
    try {
      await exec('git', ['init', root]);
      await fs.writeFile(path.join(root, 'exists.txt'), 'surviving\n');
      await fs.writeFile(path.join(root, 'conflict.txt'), 'older ingest\n');
      await fs.symlink(outside, path.join(root, 'link'));
      const diff = await restoreWorktreeRecovery(
        root,
        {
          files: [
            { path: 'exists.txt', status: 'added', patch: added('exists.txt') },
            {
              path: 'conflict.txt',
              status: 'modified',
              patch:
                'diff --git a/conflict.txt b/conflict.txt\n--- a/conflict.txt\n+++ b/conflict.txt\n@@ -1 +1 @@\n-base\n+newer local\n',
            },
            { path: 'missing.txt', status: 'modified' },
            { path: '../escape.txt', status: 'added', patch: added('../escape.txt') },
            { path: 'link/escape.txt', status: 'added', patch: added('link/escape.txt') },
            { path: 'safe.txt', status: 'added', patch: added('safe.txt') + added('other.txt') },
            { path: '.git/config', status: 'modified', patch: added('.git/config') },
            {
              path: 'symlink',
              status: 'added',
              patch: added('symlink').replace('100644', '120000'),
            },
          ],
        },
        process.env,
        AbortSignal.timeout(10_000)
      );
      expect(diff.applied).toBe(0);
      expect(diff.skipped).toBe(8);
      expect(await fs.readFile(path.join(root, 'exists.txt'), 'utf8')).toBe('surviving\n');
      expect(await fs.readFile(path.join(root, 'conflict.txt'), 'utf8')).toBe('older ingest\n');
      expect(await fs.readdir(outside)).toEqual([]);
      expect(
        await fs.access(path.join(root, 'safe.txt')).then(
          () => true,
          () => false
        )
      ).toBe(false);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
      await fs.rm(outside, { recursive: true, force: true });
    }
  });
});
