import { execFile } from 'node:child_process';
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { WRAPPER_LOG_LIMITS } from '../wrapper-log-budget.js';
import {
  discoverWrapperLogCandidates,
  isWrapperLogFileName,
  readWrapperLogsForRoots,
  type WrapperLogEntry,
  type WrapperLogSession,
} from './wrapper-log-reader.js';

const KIB = 1024;

const roots = new Set<string>();

afterEach(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
  roots.clear();
});

async function sessionRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'wrapper-log-reader-'));
  roots.add(root);
  return root;
}

function entryType(mode: { isSymbolicLink(): boolean; isDirectory(): boolean; isFile(): boolean }) {
  if (mode.isSymbolicLink()) return 'symlink' as const;
  if (mode.isDirectory()) return 'directory' as const;
  return mode.isFile() ? ('file' as const) : ('other' as const);
}

/**
 * An execution session backed by the real filesystem and a real `tail`, so the
 * listing, reading and byte arithmetic below are the production code paths, not
 * restatements of them.
 */
function fileSystemSession(counts: { readFile: number; exec: number }): WrapperLogSession {
  return {
    async listFiles(path) {
      const names = await readdir(path).catch(() => undefined);
      if (!names) return { success: false, files: [] };
      const files: WrapperLogEntry[] = [];
      for (const name of names) {
        const absolutePath = join(path, name);
        const link = await lstat(absolutePath);
        const info = await stat(absolutePath).catch(() => undefined);
        files.push({
          name,
          absolutePath,
          type: entryType(link),
          size: info?.size ?? 0,
          modifiedAt: (info?.mtime ?? new Date(0)).toISOString(),
        });
      }
      return { success: true, files };
    },
    async readFile(path) {
      counts.readFile += 1;
      return { content: await readFile(path, 'utf8') };
    },
    exec(command) {
      counts.exec += 1;
      const startedAt = Date.now();
      const { promise, resolve } = Promise.withResolvers<{
        success: boolean;
        exitCode: number;
        stdout: string;
        stderr: string;
        command: string;
        duration: number;
        timestamp: string;
      }>();
      execFile('sh', ['-c', command], { timeout: 15_000 }, (error, stdout, stderr) => {
        resolve({
          success: error === null,
          exitCode: error === null ? 0 : 1,
          stdout,
          stderr: String(stderr),
          command,
          duration: Date.now() - startedAt,
          timestamp: new Date().toISOString(),
        });
      });
      return promise;
    },
  };
}

function lines(prefix: string, count: number): string {
  return Array.from({ length: count }, (_, index) => `${prefix} ${index}`).join('\n') + '\n';
}

describe('readWrapperLogsForRoots', () => {
  it('returns a normal small log set whole', async () => {
    const root = await sessionRoot();
    const cliLogDir = join(root, 'home', '.local/share/kilo/log');
    await mkdir(cliLogDir, { recursive: true });
    await writeFile(join(root, 'kilocode-wrapper-agent_a-1.log'), lines('wrapper', 5));
    await writeFile(join(root, 'unrelated.txt'), 'not a wrapper log');
    await writeFile(join(cliLogDir, 'kilo.log'), lines('cli', 3));

    const readout = await readWrapperLogsForRoots(fileSystemSession({ readFile: 0, exec: 0 }), [
      { path: root, include: isWrapperLogFileName },
      { path: cliLogDir },
    ]);

    expect(Object.keys(readout.files).sort()).toEqual([
      join(cliLogDir, 'kilo.log'),
      join(root, 'kilocode-wrapper-agent_a-1.log'),
    ]);
    expect(readout.files[join(cliLogDir, 'kilo.log')]).toBe(lines('cli', 3));
    expect(readout.truncated).toEqual({});
    expect(readout.skipped).toEqual({});
    expect(readout.omittedFileCount).toBe(0);
  });

  it('returns the newest bytes of an oversized log through tail', async () => {
    const root = await sessionRoot();
    const path = join(root, 'kilocode-wrapper-agent_a-1.log');
    await writeFile(path, lines('line', Math.ceil((4 * WRAPPER_LOG_LIMITS.maxFileBytes) / 12)));
    const counts = { readFile: 0, exec: 0 };

    const readout = await readWrapperLogsForRoots(fileSystemSession(counts), [
      { path: root, include: isWrapperLogFileName },
    ]);

    const expectedTail = (await readFile(path, 'utf8')).slice(-WRAPPER_LOG_LIMITS.maxFileBytes);
    expect(readout.files[path]).toBe(expectedTail);
    expect(readout.truncated[path]).toEqual({
      returnedBytes: WRAPPER_LOG_LIMITS.maxFileBytes,
      omittedBytes: (await stat(path)).size - WRAPPER_LOG_LIMITS.maxFileBytes,
    });
    expect(counts.exec).toBe(1);
    expect(counts.readFile).toBe(0);
  });

  it('reads only the newest files when a directory holds many logs', async () => {
    const root = await sessionRoot();
    for (let index = 0; index < 200; index += 1) {
      await writeFile(
        join(root, `kilocode-wrapper-agent_a-${String(index).padStart(3, '0')}.log`),
        `entry ${index}\n`
      );
    }
    const counts = { readFile: 0, exec: 0 };

    const readout = await readWrapperLogsForRoots(fileSystemSession(counts), [
      { path: root, include: isWrapperLogFileName },
    ]);

    expect(Object.keys(readout.files)).toHaveLength(WRAPPER_LOG_LIMITS.maxFiles);
    expect(counts.readFile).toBe(WRAPPER_LOG_LIMITS.maxFiles);
    expect(Object.values(readout.skipped)).toEqual(
      Array.from(
        { length: WRAPPER_LOG_LIMITS.maxDirectoryEntries - WRAPPER_LOG_LIMITS.maxFiles },
        () => 'file-limit'
      )
    );
  });

  it('spends the total byte budget across files and reports the split', async () => {
    const root = await sessionRoot();
    const size = 200 * KIB;
    for (let index = 0; index < 6; index += 1) {
      await writeFile(
        join(root, `kilocode-wrapper-agent_a-${index}.log`),
        'x'.repeat(size - 1) + String(index)
      );
    }
    const counts = { readFile: 0, exec: 0 };

    const readout = await readWrapperLogsForRoots(fileSystemSession(counts), [
      { path: root, include: isWrapperLogFileName },
    ]);

    const truncatedBytes = WRAPPER_LOG_LIMITS.maxTotalBytes - 2 * size;
    expect(Object.keys(readout.files)).toHaveLength(3);
    expect(Object.values(readout.skipped)).toEqual(Array(3).fill('byte-limit'));
    expect(Object.values(readout.truncated)).toEqual([
      { returnedBytes: truncatedBytes, omittedBytes: size - truncatedBytes },
    ]);
    expect(Object.values(readout.files).reduce((t, c) => t + Buffer.byteLength(c), 0)).toBe(
      WRAPPER_LOG_LIMITS.maxTotalBytes
    );
  });

  it('does not read a symlink in place of a regular log file', async () => {
    const root = await sessionRoot();
    const target = join(root, 'real.log');
    await writeFile(target, 'content\n');
    await symlink(target, join(root, 'kilocode-wrapper-agent_a-1.log'));
    const counts = { readFile: 0, exec: 0 };

    const readout = await readWrapperLogsForRoots(fileSystemSession(counts), [
      { path: root, include: isWrapperLogFileName },
    ]);

    expect(readout.files).toEqual({});
    expect(readout.skipped).toEqual({
      [join(root, 'kilocode-wrapper-agent_a-1.log')]: 'not-regular-file',
    });
    expect(counts.readFile).toBe(0);
  });

  it('walks nested log directories only within the depth budget', async () => {
    const root = await sessionRoot();
    const inside = join(root, 'a', 'b');
    const beyond = join(root, 'a', 'b', 'c');
    await mkdir(inside, { recursive: true });
    await mkdir(beyond, { recursive: true });
    await writeFile(join(inside, 'inside.log'), 'inside\n');
    await writeFile(join(beyond, 'beyond.log'), 'beyond\n');

    const readout = await readWrapperLogsForRoots(fileSystemSession({ readFile: 0, exec: 0 }), [
      { path: root },
    ]);

    expect(Object.keys(readout.files)).toEqual([join(inside, 'inside.log')]);
  });

  it('reports an unreadable log and still returns the readable ones', async () => {
    const root = await sessionRoot();
    const unreadable = join(root, 'kilocode-wrapper-agent_a-1.log');
    const readable = join(root, 'kilocode-wrapper-agent_a-2.log');
    await writeFile(unreadable, 'secret\n');
    await writeFile(readable, 'readable\n');
    const session = fileSystemSession({ readFile: 0, exec: 0 });
    const withFailure: WrapperLogSession = {
      ...session,
      async readFile(path, options) {
        if (path === unreadable) throw new Error('permission denied');
        return session.readFile(path, options);
      },
    };

    const readout = await readWrapperLogsForRoots(withFailure, [
      { path: root, include: isWrapperLogFileName },
    ]);

    expect(readout.files).toEqual({ [readable]: 'readable\n' });
    expect(readout.skipped).toEqual({ [unreadable]: 'read-failed' });
  });

  it('does not descend when a root asks for its own level only', async () => {
    const root = await sessionRoot();
    const nested = join(root, 'nested');
    await mkdir(nested);
    await writeFile(join(root, 'kilocode-wrapper-agent_a-1.log'), 'top\n');
    await writeFile(join(nested, 'kilocode-wrapper-agent_a-2.log'), 'nested\n');

    const discovery = await discoverWrapperLogCandidates(
      fileSystemSession({ readFile: 0, exec: 0 }),
      [{ path: root, include: isWrapperLogFileName, descend: false }]
    );

    expect(discovery.candidates.map(candidate => candidate.path)).toEqual([
      join(root, 'kilocode-wrapper-agent_a-1.log'),
    ]);
  });

  it('collects only wrapper log names from a shared root', async () => {
    const root = await sessionRoot();
    await writeFile(join(root, 'kilocode-wrapper-agent_a-1.log'), 'wrapper\n');
    await writeFile(join(root, 'kilocode-wrapper-agent_b-1.log'), 'other session\n');
    await mkdir(join(root, 'nested'));
    await writeFile(join(root, 'nested', 'kilocode-wrapper-agent_a-2.log'), 'nested\n');

    const discovery = await discoverWrapperLogCandidates(
      fileSystemSession({ readFile: 0, exec: 0 }),
      [{ path: root, include: isWrapperLogFileName }]
    );

    expect(discovery.candidates.map(candidate => candidate.path).sort()).toEqual([
      join(root, 'kilocode-wrapper-agent_a-1.log'),
      join(root, 'kilocode-wrapper-agent_b-1.log'),
      join(root, 'nested', 'kilocode-wrapper-agent_a-2.log'),
    ]);
  });
});
