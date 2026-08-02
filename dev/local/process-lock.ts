import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

import lockfile from 'proper-lockfile';

export function withProcessLock<T>(lockPath: string, label: string, mutate: () => T): T {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  let release: (() => void) | undefined;
  try {
    release = lockfile.lockSync(lockPath, {
      lockfilePath: lockPath,
      realpath: false,
      stale: 5000,
      update: 1000,
    });
  } catch (error) {
    throw new Error(`${label} is being updated concurrently`, { cause: error });
  }

  try {
    return mutate();
  } finally {
    release();
  }
}

export async function acquireProcessLock(
  lockPath: string,
  label: string,
  waitMs = 0
): Promise<() => Promise<void>> {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  try {
    return await lockfile.lock(lockPath, {
      lockfilePath: lockPath,
      realpath: false,
      stale: 30_000,
      update: 10_000,
      retries:
        waitMs > 0
          ? {
              retries: Math.ceil(waitMs / 1000),
              factor: 1,
              minTimeout: 1000,
              maxTimeout: 1000,
              randomize: false,
            }
          : 0,
    });
  } catch (error) {
    throw new Error(`${label} is locked by another live process`, { cause: error });
  }
}

export async function withProcessLockAsync<T>(
  lockPath: string,
  label: string,
  mutate: () => Promise<T>,
  waitMs = 0
): Promise<T> {
  const release = await acquireProcessLock(lockPath, label, waitMs);
  try {
    return await mutate();
  } finally {
    await release();
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let waitMs = 0;
  if (args[0] === '--wait') {
    const seconds = Number(args[1]);
    if (!Number.isFinite(seconds) || seconds < 0)
      throw new Error('process-lock: --wait must be a non-negative number of seconds');
    waitMs = seconds * 1000;
    args.splice(0, 2);
  }
  const lockPath = args.shift();
  if (!lockPath || args.shift() !== '--' || args.length === 0) {
    throw new Error('Usage: process-lock.ts [--wait <seconds>] <lock-path> -- <command> [args...]');
  }

  const [command, ...commandArgs] = args;
  process.exitCode = await withProcessLockAsync(
    lockPath,
    path.basename(lockPath),
    () =>
      new Promise<number>((resolve, reject) => {
        const child = spawn(command, commandArgs, { stdio: 'inherit' });
        const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;
        const handlers = new Map(
          signals.map(signal => [signal, () => child.kill(signal)] as const)
        );
        for (const [signal, handler] of handlers) process.once(signal, handler);
        child.once('error', reject);
        child.once('exit', code => {
          for (const [signal, handler] of handlers) process.off(signal, handler);
          resolve(code ?? 1);
        });
      }),
    waitMs
  );
}

const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename);
if (isMain) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
