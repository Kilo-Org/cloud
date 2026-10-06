import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  emptyWorkspaceDirectory,
  removeStaleHomes,
  stripGitCredentials,
  truncateWrapperLog,
} from './workspace-adoption.js';
import type { WorkspaceGit } from './workspace-adoption.js';

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
};

let root: string;
let repo: string;

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: repo, env: GIT_ENV, encoding: 'utf8' }).trim();
}

const run: WorkspaceGit = async args => {
  try {
    const stdout = execFileSync('git', args, { cwd: repo, env: GIT_ENV, encoding: 'utf8' });
    return { stdout, stderr: '', exitCode: 0 };
  } catch (error) {
    const failed = error as { status?: number; stderr?: Buffer };
    return { stdout: '', stderr: String(failed.stderr ?? ''), exitCode: failed.status ?? 1 };
  }
};

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'adoption-'));
  repo = path.join(root, 'app');
  await fs.mkdir(repo);
  git('init', '-q', '-b', 'main');
  git('remote', 'add', 'origin', 'https://x-access-token:SECRETTOKEN@github.com/acme/repo.git');
  git('commit', '-q', '--allow-empty', '-m', 'first');
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

async function rejection(promise: Promise<unknown>): Promise<Error | undefined> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  return undefined;
}

async function filesContaining(directory: string, needle: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...(await filesContaining(entryPath, needle)));
    else if ((await fs.readFile(entryPath)).includes(needle)) found.push(entryPath);
  }
  return found;
}

describe('stripGitCredentials', () => {
  it('leaves no credential in the remote, the reflogs or FETCH_HEAD', async () => {
    await fs.writeFile(
      path.join(repo, '.git', 'FETCH_HEAD'),
      'abc\t\tbranch main of https://x-access-token:SECRETTOKEN@github.com/acme/repo\n'
    );
    await fs.appendFile(
      path.join(repo, '.git', 'logs', 'HEAD'),
      '0000 1111 Test <t@e.c> 1 +0000\tclone: from https://x-access-token:SECRETTOKEN@github.com/acme/repo.git\n'
    );

    const bare = await stripGitCredentials({
      git: run,
      directory: repo,
      bareUrl: 'https://github.com/acme/repo.git',
    });

    expect(bare).toBe(true);
    expect(git('remote', 'get-url', 'origin')).toBe('https://github.com/acme/repo.git');
    expect(await filesContaining(path.join(repo, '.git'), 'SECRETTOKEN')).toEqual([]);
  });

  it('reports false, and does not touch the reflogs, when origin cannot be made bare', async () => {
    const failing: WorkspaceGit = async args =>
      args[0] === 'remote' ? { stdout: '', stderr: 'no', exitCode: 1 } : run(args);

    expect(
      await stripGitCredentials({
        git: failing,
        directory: repo,
        bareUrl: 'https://github.com/a/b.git',
      })
    ).toBe(false);
    expect(git('reflog').length).toBeGreaterThan(0);
  });

  it('reports false when FETCH_HEAD cannot be removed', async () => {
    const fetchHead = path.join(repo, '.git', 'FETCH_HEAD');
    await fs.mkdir(fetchHead);
    await fs.writeFile(path.join(fetchHead, 'keep'), 'x');

    expect(
      await stripGitCredentials({
        git: run,
        directory: repo,
        bareUrl: 'https://github.com/acme/repo.git',
      })
    ).toBe(false);
  });
});

describe('emptyWorkspaceDirectory', () => {
  it('removes a dedicated directory and everything in it', async () => {
    await emptyWorkspaceDirectory(repo);
    expect(await rejection(fs.access(repo))).toBeInstanceOf(Error);
  });

  it('refuses the filesystem root and a top-level directory', async () => {
    expect((await rejection(emptyWorkspaceDirectory('/')))?.message).toContain('top-level');
    expect((await rejection(emptyWorkspaceDirectory('/workspace')))?.message).toContain(
      'top-level'
    );
  });
});

describe('removeStaleHomes', () => {
  it("removes every home but this route's own", async () => {
    const homes = path.join(root, 'homes');
    await fs.mkdir(path.join(homes, 'mine', '.cache'), { recursive: true });
    await fs.mkdir(path.join(homes, 'previous', '.npm'), { recursive: true });
    await fs.writeFile(path.join(homes, 'previous', '.npmrc'), 'token');
    await fs.writeFile(path.join(homes, 'stray-file'), 'x');

    await removeStaleHomes(homes, path.join(homes, 'mine'));

    expect(await fs.readdir(homes)).toEqual(['mine']);
  });

  it('is a no-op when there is no home root', async () => {
    expect(await rejection(removeStaleHomes(path.join(root, 'absent'), 'x'))).toBeUndefined();
  });
});

describe('truncateWrapperLog', () => {
  it('empties the log in place so later appends continue in the same file', async () => {
    const log = path.join(root, 'wrapper.log');
    await fs.writeFile(log, 'old line\nolder line\n');

    await truncateWrapperLog(log);
    await fs.appendFile(log, 'new line\n');

    expect(await fs.readFile(log, 'utf8')).toBe('new line\n');
  });

  it('ignores a missing path or a missing file', async () => {
    expect(await rejection(truncateWrapperLog(undefined))).toBeUndefined();
    expect(await rejection(truncateWrapperLog(path.join(root, 'absent.log')))).toBeUndefined();
  });
});
