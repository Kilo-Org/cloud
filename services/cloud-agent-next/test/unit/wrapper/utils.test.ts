import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { git, runProcess } from '../../../wrapper/src/utils.js';

const createdRepos: string[] = [];

async function createRepo(): Promise<string> {
  const repoPath = await mkdtemp(join(tmpdir(), 'wrapper-git-timeout-'));
  createdRepos.push(repoPath);
  await git(['init'], { cwd: repoPath, timeoutMs: 5_000 });
  await git(['config', 'user.email', 'test@example.com'], { cwd: repoPath, timeoutMs: 5_000 });
  await git(['config', 'user.name', 'Test User'], { cwd: repoPath, timeoutMs: 5_000 });
  return repoPath;
}

describe('runProcess', () => {
  it('runs non-git commands with captured output', async () => {
    const result = await runProcess(process.execPath, ['-e', 'console.log("hello")'], {
      timeoutMs: 5_000,
    });

    expect(result).toEqual({ stdout: 'hello\n', stderr: '', exitCode: 0 });
  });
});

describe('git', () => {
  afterEach(async () => {
    await Promise.all(
      createdRepos.splice(0).map(repoPath => rm(repoPath, { recursive: true, force: true }))
    );
  });

  it('waits for close and returns timeout result after terminating a hook process group', async () => {
    const repoPath = await createRepo();
    const hooksPath = join(repoPath, '.git', 'hooks');
    await writeFile(
      join(hooksPath, 'pre-commit'),
      '#!/bin/sh\ntrap "exit 0" TERM\nsleep 30 &\nwait\n',
      { mode: 0o755 }
    );
    await writeFile(join(repoPath, 'file.txt'), 'content\n');
    await git(['add', 'file.txt'], { cwd: repoPath, timeoutMs: 5_000 });

    const start = Date.now();
    const result = await git(['commit', '-m', 'test'], { cwd: repoPath, timeoutMs: 50 });
    const elapsedMs = Date.now() - start;

    expect(result.exitCode).toBe(124);
    expect(result.terminationReason).toBe('timeout');
    expect(result.stderr).toContain('exec timeout reached');
    expect(elapsedMs).toBeLessThan(10_000);
  }, 15_000);

  it('settles after the SIGKILL grace when an escaped child keeps stdio open', async () => {
    const repoPath = await createRepo();
    const hooksPath = join(repoPath, '.git', 'hooks');
    const escapedChildPidPath = join(repoPath, '.git', 'escaped-child.pid');
    await writeFile(
      join(hooksPath, 'pre-commit'),
      `#!/bin/sh
node <<'NODE'
const { spawn } = require('child_process');
const { writeFileSync } = require('fs');
const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], {
  detached: true,
  stdio: 'inherit',
});
writeFileSync('.git/escaped-child.pid', String(child.pid));
child.unref();
setTimeout(() => {}, 10000);
NODE
`,
      { mode: 0o755 }
    );
    await writeFile(join(repoPath, 'file.txt'), 'content\n');
    await git(['add', 'file.txt'], { cwd: repoPath, timeoutMs: 5_000 });

    let escapedChildPid: number | undefined;
    try {
      const start = Date.now();
      const result = await git(['commit', '-m', 'test'], { cwd: repoPath, timeoutMs: 50 });
      const elapsedMs = Date.now() - start;
      const pidText = await readFile(escapedChildPidPath, 'utf8').catch(() => '');
      const pid = Number(pidText);
      if (Number.isInteger(pid) && pid > 0) {
        escapedChildPid = pid;
      }

      expect(result.exitCode).toBe(124);
      expect(result.terminationReason).toBe('timeout');
      expect(result.stderr).toContain('exec timeout reached');
      expect(elapsedMs).toBeLessThan(4_000);
    } finally {
      if (escapedChildPid !== undefined) {
        try {
          process.kill(escapedChildPid, 'SIGKILL');
        } catch {
          // The escaped child may have exited before cleanup.
        }
      }
    }
  }, 15_000);

  it('cancels an in-flight git command with an AbortSignal', async () => {
    const repoPath = await createRepo();
    const hooksPath = join(repoPath, '.git', 'hooks');
    await writeFile(join(hooksPath, 'pre-commit'), '#!/bin/sh\nsleep 30\n', { mode: 0o755 });
    await writeFile(join(repoPath, 'file.txt'), 'content\n');
    await git(['add', 'file.txt'], { cwd: repoPath, timeoutMs: 5_000 });

    const controller = new AbortController();
    const promise = git(['commit', '-m', 'test'], {
      cwd: repoPath,
      timeoutMs: 30_000,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 50);

    const result = await promise;

    expect(result.exitCode).toBe(124);
    expect(result.terminationReason).toBe('abort');
    expect(result.stderr).toContain('exec aborted');
  }, 15_000);

  it('does not spawn git when AbortSignal is already aborted', async () => {
    const missingPath = await mkdtemp(join(tmpdir(), 'wrapper-git-timeout-missing-'));
    await rm(missingPath, { recursive: true, force: true });
    const controller = new AbortController();
    controller.abort();

    const result = await git(['status', '--porcelain'], {
      cwd: missingPath,
      timeoutMs: 30_000,
      signal: controller.signal,
    });

    expect(result.exitCode).toBe(124);
    expect(result.terminationReason).toBe('abort');
    expect(result.stderr).toContain('exec aborted');
  }, 15_000);
});
