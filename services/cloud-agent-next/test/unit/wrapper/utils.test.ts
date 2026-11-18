import { mkdtemp, open, readFile, rename, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { createSafeProcessDiagnostic, git, runProcess } from '../../../wrapper/src/utils.js';

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
  it('runs non-git commands with captured output and elapsed time', async () => {
    const result = await runProcess(process.execPath, ['-e', 'console.log("hello")'], {
      timeoutMs: 5_000,
    });

    expect(result.stdout).toBe('hello\n');
    expect(result.stderr).toBe('');
    expect(result.exitCode).toBe(0);
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
  });

  it('reads stdin from the opened file descriptor even when its path is replaced', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'wrapper-open-input-'));
    const path = join(directory, 'input');
    const original = Buffer.from([0xff, 0, 1, 2, 10]);
    await writeFile(path, original);
    const handle = await open(path, 'r');
    try {
      await rename(path, join(directory, 'original'));
      await writeFile(path, 'replacement bytes');
      const result = await runProcess(
        process.execPath,
        ['-e', 'process.stdin.pipe(process.stdout)'],
        { stdinFd: handle.fd, rawOutput: true, maxOutputBytes: original.length, timeoutMs: 5_000 }
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdoutBytes).toEqual(original);
      expect(result.stdoutTruncated).toBeUndefined();
    } finally {
      await handle.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('preserves UTF-8 characters split across stdout and stderr chunks', async () => {
    const outputs = { stdout: '', stderr: '' };
    const text = 'é漢字𐐀\tpath\n';
    const result = await runProcess(
      process.execPath,
      [
        '-e',
        `const bytes = Buffer.from(${JSON.stringify(text)}); let i = 0;
        const timer = setInterval(() => {
          const byte = bytes.subarray(i, ++i);
          process.stdout.write(byte);
          process.stderr.write(byte);
          if (i === bytes.length) clearInterval(timer);
        }, 20);`,
      ],
      {
        timeoutMs: 5_000,
        onOutput: (stream, output) => {
          outputs[stream] += output;
        },
      }
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(text);
    expect(result.stderr).toBe(text);
    expect(outputs).toEqual({ stdout: text, stderr: text });
    expect(result.stdoutTruncated).toBeUndefined();
    expect(result.stderrTruncated).toBeUndefined();
  });

  it('captures raw bytes without replacement decoding or forwarding content to progress callbacks', async () => {
    const output: string[] = [];
    const result = await runProcess(
      process.execPath,
      [
        '-e',
        'const bytes = Buffer.from([0xef, 0xbb, 0xbf, 0xc3, 0x28, 0xff, 0]); process.stdout.write(bytes); process.stderr.write(bytes);',
      ],
      { rawOutput: true, timeoutMs: 5_000, onOutput: (_stream, text) => output.push(text) }
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdoutBytes).toEqual(Buffer.from([0xef, 0xbb, 0xbf, 0xc3, 0x28, 0xff, 0]));
    expect(result.stderrBytes).toEqual(result.stdoutBytes);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('');
    expect(output).toEqual([]);
    expect(result.stdoutTruncated).toBeUndefined();
  });

  it.each([0, 1, 7])(
    'bounds both raw streams exactly at %s bytes and reports overflow',
    async maxOutputBytes => {
      const result = await runProcess(
        process.execPath,
        [
          '-e',
          'const bytes = Buffer.from([0xf0, 0x90, 0x90, 0x80, 1, 2, 3, 4]); process.stdout.write(bytes); process.stderr.write(bytes);',
        ],
        { rawOutput: true, timeoutMs: 5_000, maxOutputBytes }
      );

      expect(result.exitCode).toBe(0);
      expect(result.stdoutBytes).toEqual(
        Buffer.from([0xf0, 0x90, 0x90, 0x80, 1, 2, 3, 4]).subarray(0, maxOutputBytes)
      );
      expect(result.stderrBytes).toEqual(result.stdoutBytes);
      expect(result.stdoutTruncated).toBe(true);
      expect(result.stderrTruncated).toBe(true);
    }
  );

  it('retains complete raw multibyte output split across process chunks at the exact bound', async () => {
    const bytes = Buffer.from('é漢𐐀');
    const result = await runProcess(
      process.execPath,
      [
        '-e',
        `const bytes = Buffer.from(${JSON.stringify([...bytes])}); let offset = 0;
        const timer = setInterval(() => {
          process.stdout.write(bytes.subarray(offset, ++offset));
          if (offset === bytes.length) clearInterval(timer);
        }, 10);`,
      ],
      { rawOutput: true, timeoutMs: 5_000, maxOutputBytes: bytes.length }
    );
    expect(result.stdoutBytes).toEqual(bytes);
    expect(result.stdoutTruncated).toBeUndefined();
  });

  it('reports raw output termination rather than presenting partial bytes as complete', async () => {
    const result = await runProcess(
      process.execPath,
      ['-e', 'process.stdout.write(Buffer.from([0xff])); setTimeout(() => {}, 10_000);'],
      { rawOutput: true, timeoutMs: 250, terminationGraceMs: 50 }
    );
    expect(result.stdoutBytes).toEqual(Buffer.from([0xff]));
    expect(result.terminationReason).toBe('timeout');
    expect(result.exitCode).toBe(124);
  });

  it('returns empty raw buffers for an already aborted process', async () => {
    const result = await runProcess('must-not-start', [], {
      rawOutput: true,
      signal: AbortSignal.abort(),
    });
    expect(result.terminationReason).toBe('abort');
    expect(result.stdoutBytes).toEqual(Buffer.alloc(0));
    expect(result.stderrBytes).toEqual(Buffer.alloc(0));
  });

  it('keeps a valid UTF-8 tail within the byte cap', async () => {
    const result = await runProcess(
      process.execPath,
      ['-e', 'process.stdout.write("𐐀".repeat(40) + "end")'],
      { timeoutMs: 5_000, maxOutputBytes: 10 }
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('𐐀end');
    expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(10);
    expect(result.stdoutTruncated).toBe(true);
  });

  it('bounds output while retaining the most recent tail', async () => {
    const result = await runProcess(
      process.execPath,
      ['-e', 'process.stderr.write("a".repeat(20000) + "latest-error")'],
      { timeoutMs: 5_000, maxOutputBytes: 1_024 }
    );

    expect(Buffer.byteLength(result.stderr)).toBeLessThanOrEqual(1_024);
    expect(result.stderr).toContain('latest-error');
    expect(result.stderrTruncated).toBe(true);
  });
});

describe('createSafeProcessDiagnostic', () => {
  it('returns only allowlisted process metadata', () => {
    const sensitiveValues = [
      'bare-unlabeled-token',
      'private-file-content',
      'url-secret',
      'bearer-secret',
      'cookie-secret',
      'env-secret',
    ];
    const detail = createSafeProcessDiagnostic({
      stdout: sensitiveValues.slice(0, 2).join('\n'),
      stderr: [
        'https://user:url-secret@example.com/repo.git',
        'Authorization: Bearer bearer-secret',
        'Cookie: session=cookie-secret',
        'SECRET_VALUE=env-secret',
      ].join('\n'),
      exitCode: 2,
      elapsedMs: 42,
      stdoutTruncated: true,
    });

    expect(detail).toBe('termination nonzero exit, exit code 2, output truncated');
    for (const sensitiveValue of sensitiveValues) expect(detail).not.toContain(sensitiveValue);
  });

  it.each([
    {
      result: { stdout: '', stderr: '', exitCode: 124, terminationReason: 'timeout' as const },
      expected: 'termination timeout',
    },
    {
      result: { stdout: '', stderr: '', exitCode: 124, terminationReason: 'abort' as const },
      expected: 'termination abort',
    },
    {
      result: { stdout: '', stderr: '', exitCode: 0, elapsedMs: 7 },
      expected: 'termination completed',
    },
  ])('reports structured termination metadata', ({ result, expected }) => {
    expect(createSafeProcessDiagnostic(result)).toBe(expected);
  });

  it('terminates a process after its output becomes inactive', async () => {
    const result = await runProcess(process.execPath, ['-e', 'setTimeout(() => {}, 10_000)'], {
      inactivityTimeoutMs: 50,
      hardTimeoutMs: 5_000,
      terminationGraceMs: 50,
    });

    expect(result.exitCode).toBe(124);
    expect(result.terminationReason).toBe('inactivity_timeout');
    expect(result.stderr).toContain('exec inactivity timeout reached');
  });

  it('keeps a process alive while it produces output', async () => {
    const outputs: string[] = [];
    const result = await runProcess(
      process.execPath,
      [
        '-e',
        'let count = 0; const timer = setInterval(() => { console.log(++count); if (count === 4) clearInterval(timer); }, 100)',
      ],
      {
        inactivityTimeoutMs: 500,
        hardTimeoutMs: 2_000,
        onOutput: (_stream, output) => outputs.push(output),
      }
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('4');
    expect(outputs.join('')).toBe(result.stdout);
  });

  it('enforces a hard limit even while a process produces output', async () => {
    const result = await runProcess(
      process.execPath,
      ['-e', 'console.log("active"); setInterval(() => console.log("active"), 100)'],
      {
        inactivityTimeoutMs: 2_000,
        hardTimeoutMs: 1_000,
        terminationGraceMs: 50,
      }
    );

    expect(result.exitCode).toBe(124);
    expect(result.terminationReason).toBe('hard_timeout');
    expect(result.stderr).toContain('exec hard timeout reached');
    expect(result.stdout).toContain('active');
  });

  it('retains only the tail of large process output', async () => {
    const result = await runProcess(
      process.execPath,
      ['-e', 'process.stdout.write("x".repeat(1_100_000) + "END")'],
      { timeoutMs: 5_000 }
    );

    expect(result.exitCode).toBe(0);
    expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(64 * 1_024);
    expect(result.stdout.endsWith('END')).toBe(true);
    expect(result.stdoutTruncated).toBe(true);
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
