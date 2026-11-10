import { afterEach, describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { git } from '../utils.js';
import { collectWorktreeSnapshot } from './worktree-changes.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

const baseEnv: NodeJS.ProcessEnv = {
  PATH: process.env.PATH,
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
};

describe('worktree capture prepared environment', () => {
  it('runs every capture command with the prepared HOME and credential helper', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'kilo-capture-env-'));
    roots.push(directory);
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: directory, env: baseEnv });
    await writeFile(path.join(directory, 'README.md'), 'base\n');
    execFileSync('git', ['add', '.'], { cwd: directory, env: baseEnv });
    execFileSync('git', ['commit', '-qm', 'base'], { cwd: directory, env: baseEnv });
    execFileSync('git', ['update-ref', 'refs/remotes/origin/main', 'HEAD'], {
      cwd: directory,
      env: baseEnv,
    });
    execFileSync('git', ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main'], {
      cwd: directory,
      env: baseEnv,
    });

    const preparedEnv: NodeJS.ProcessEnv = {
      HOME: path.join(directory, 'home'),
      PATH: process.env.PATH,
      SYSTEM_GIT_CONFIG_ENV: '1',
      GIT_CONFIG_COUNT: '2',
      GIT_CONFIG_KEY_0: 'credential.helper',
      GIT_CONFIG_VALUE_0: '!kilo-credential-helper',
      GIT_CONFIG_KEY_1: 'credential.useHttpPath',
      GIT_CONFIG_VALUE_1: 'true',
    };
    const calls: Array<{ args: string[]; env: NodeJS.ProcessEnv | undefined }> = [];
    const runGit: typeof git = async (args, options) => {
      calls.push({ args, env: options?.env });
      return git(args, options);
    };

    await collectWorktreeSnapshot(directory, { revision: 1 }, runGit, undefined, {
      env: preparedEnv,
      configArgs: ['-c', 'http.followRedirects=false'],
    });

    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call.env).toMatchObject(preparedEnv);
      expect(call.env?.GIT_CONFIG_GLOBAL).toBe('/dev/null');
      expect(call.env?.GIT_NO_LAZY_FETCH).toBeUndefined();
      expect(call.args).toContain('http.followRedirects=false');
    }
  });
});
