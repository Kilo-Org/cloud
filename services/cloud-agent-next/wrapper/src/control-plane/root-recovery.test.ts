import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { WorktreeRecovery } from '../../../src/shared/worktree-changes-wire.js';
import { restoreRootRecoveries } from './root-recovery.js';
import type { RouteRoot } from './workspace-roots.js';
import { restoreWorktreeRecovery } from './worktree-recovery.js';

const exec = promisify(execFile);

const modify = (file: string, before: string, after: string) =>
  `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1 +1 @@\n-${before}\n+${after}\n`;

describe('restoreRootRecoveries', () => {
  let workspace: string;
  let web: RouteRoot;
  let api: RouteRoot;

  async function repository(leaf: string, content: string): Promise<RouteRoot> {
    const directory = path.join(workspace, leaf);
    await fs.mkdir(directory);
    await exec('git', ['init', directory]);
    await fs.writeFile(path.join(directory, 'file.txt'), content);
    await exec('git', ['add', '.'], { cwd: directory });
    return { directory, repoFullName: `acme/${leaf}`, requestedBranch: undefined };
  }

  const read = (root: RouteRoot) => fs.readFile(path.join(root.directory, 'file.txt'), 'utf8');

  beforeEach(async () => {
    workspace = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'root-recovery-')));
    web = await repository('web', 'before\n');
    api = await repository('api', 'before\n');
  });

  afterEach(async () => {
    await fs.rm(workspace, { recursive: true, force: true });
  });

  const run = (
    roots: RouteRoot[],
    recovery: WorktreeRecovery,
    cwd = workspace,
    onRoot: (directory: string, recovered: boolean) => void = () => undefined
  ) =>
    restoreRootRecoveries({
      cwd,
      roots,
      recovery,
      env: process.env,
      rootSignal: () => AbortSignal.timeout(10_000),
      restore: restoreWorktreeRecovery,
      onRoot,
    });

  it('restores each root with its repository-relative patch', async () => {
    const recovered: string[] = [];
    const diffs = await run(
      [web, api],
      {
        files: [
          { path: 'web/file.txt', status: 'modified', patch: modify('file.txt', 'before', 'web') },
          { path: 'api/file.txt', status: 'modified', patch: modify('file.txt', 'before', 'api') },
        ],
      },
      workspace,
      (directory, ok) => ok && recovered.push(directory)
    );

    expect(diffs).toMatchObject({ applied: 2, skipped: 0, total: 2 });
    expect(await read(web)).toBe('web\n');
    expect(await read(api)).toBe('api\n');
    expect(recovered).toEqual([web.directory, api.directory]);
  });

  it('keeps a failed file out of the other root and reports it with its saved path', async () => {
    const diffs = await run([web, api], {
      files: [
        {
          path: 'web/file.txt',
          status: 'modified',
          patch: modify('file.txt', 'older', 'conflict'),
        },
        { path: 'api/file.txt', status: 'modified', patch: modify('file.txt', 'before', 'api') },
      ],
    });

    expect(diffs).toMatchObject({ applied: 1, skipped: 1, total: 2 });
    expect(diffs.skippedDiffs).toEqual([{ file: 'web/file.txt', reason: 'patch_apply_failed' }]);
    expect(await read(web)).toBe('before\n');
    expect(await read(api)).toBe('api\n');
  });

  it('does not send a path that only shares a root prefix to that root', async () => {
    const diffs = await run([web, api], {
      files: [
        { path: 'website/file.txt', status: 'modified', patch: modify('file.txt', 'before', 'x') },
      ],
    });

    expect(diffs).toMatchObject({ applied: 0, skipped: 1, total: 1 });
    expect(diffs.skippedDiffs).toEqual([{ file: 'website/file.txt', reason: 'outside_workspace' }]);
  });

  it('counts a root with nothing to restore as restored', async () => {
    const reported = new Map<string, boolean>();
    await run(
      [web, api],
      {
        files: [
          { path: 'web/file.txt', status: 'modified', patch: modify('file.txt', 'before', 'web') },
        ],
      },
      workspace,
      (directory, ok) => reported.set(directory, ok)
    );
    expect(reported.get(api.directory)).toBe(true);
  });

  it('reports the roots restored before a root fails, so ingest cannot overwrite them', async () => {
    const reported: string[] = [];
    const failure = await restoreRootRecoveries({
      cwd: workspace,
      roots: [web, api],
      recovery: {
        files: [
          {
            path: 'web/file.txt',
            status: 'modified',
            patch: modify('file.txt', 'before', 'web'),
          },
          {
            path: 'api/file.txt',
            status: 'modified',
            patch: modify('file.txt', 'before', 'api'),
          },
        ],
      },
      env: process.env,
      rootSignal: () => AbortSignal.timeout(10_000),
      restore: async (directory, recovery, env, signal) => {
        if (directory === api.directory) throw new Error('boom');
        return restoreWorktreeRecovery(directory, recovery, env, signal);
      },
      onRoot: (directory, ok) => ok && reported.push(directory),
    }).then(
      () => undefined,
      (error: unknown) => error
    );
    expect(failure).toMatchObject({ message: 'boom' });
    expect(reported).toEqual([web.directory]);
  });

  it('gives each root its own time, so a root that times out does not skip the next', async () => {
    const docs = await repository('docs', 'before\n');
    const reported: string[] = [];
    const signals = new Set<AbortSignal>();
    const failure = await restoreRootRecoveries({
      cwd: workspace,
      roots: [web, api, docs],
      recovery: {
        files: [web, api, docs].map(root => ({
          path: `${path.basename(root.directory)}/file.txt`,
          status: 'modified' as const,
          patch: modify('file.txt', 'before', path.basename(root.directory)),
        })),
      },
      env: process.env,
      rootSignal: () => AbortSignal.timeout(300),
      restore: async (directory, recovery, env, signal) => {
        signals.add(signal);
        if (directory === api.directory) {
          // The slow root waits until its own time is over, then reports the abort.
          await new Promise(resolve => signal.addEventListener('abort', resolve));
          signal.throwIfAborted();
        }
        return restoreWorktreeRecovery(directory, recovery, env, signal);
      },
      onRoot: (directory, ok) => ok && reported.push(directory),
    }).then(
      () => undefined,
      (error: unknown) => error
    );

    expect(failure).toBeDefined();
    expect(signals.size).toBe(3);
    expect(reported).toEqual([web.directory, docs.directory]);
    expect(await read(web)).toBe('web\n');
    expect(await read(api)).toBe('before\n');
    expect(await read(docs)).toBe('docs\n');
  });

  it('restores a one-root route exactly as it saved it, with the same recovery value', async () => {
    const recovery: WorktreeRecovery = {
      files: [{ path: 'file.txt', status: 'modified', patch: modify('file.txt', 'before', 'v1') }],
    };
    const seen: WorktreeRecovery[] = [];
    await restoreRootRecoveries({
      cwd: web.directory,
      roots: [web],
      recovery,
      env: process.env,
      rootSignal: () => AbortSignal.timeout(10_000),
      restore: async (directory, value, env, signal) => {
        seen.push(value);
        return restoreWorktreeRecovery(directory, value, env, signal);
      },
      onRoot: () => undefined,
    });

    expect(seen).toEqual([recovery]);
    expect(seen[0]).toBe(recovery);
    expect(await read(web)).toBe('v1\n');
  });
});
