import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

type NativeBuildOwner = {
  pid: number;
  identity: string;
  token: string;
  startedAt: string;
};

type NativeBuildSemaphoreArgs<T> = {
  root: string;
  run: () => Promise<T>;
  pidAlive?: (pid: number) => boolean;
  processIdentity?: (pid: number) => string | undefined;
  pollIntervalMs?: number;
  waitTimeoutMs?: number;
};

const DEFAULT_POLL_INTERVAL_MS = 1000;
const DEFAULT_WAIT_TIMEOUT_MS = 20 * 60 * 1000;

export async function withNativeBuildSemaphore<T>(args: NativeBuildSemaphoreArgs<T>): Promise<T> {
  fs.mkdirSync(args.root, { recursive: true });
  const lockDir = path.join(args.root, 'native-build.lock');
  const ownerPath = path.join(lockDir, 'owner.json');
  const pidAlive = args.pidAlive ?? defaultPidAlive;
  const processIdentity = args.processIdentity ?? defaultProcessIdentity;
  const deadline = Date.now() + (args.waitTimeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS);

  while (true) {
    const owner = acquire(lockDir, ownerPath, processIdentity);
    if (owner) {
      try {
        return await args.run();
      } finally {
        releaseOwned(lockDir, ownerPath, owner.token);
      }
    }

    const current = readOwner(ownerPath);
    if (!current || !pidAlive(current.pid) || processIdentity(current.pid) !== current.identity) {
      reclaim(lockDir, ownerPath, current);
      continue;
    }
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for native build producer ${current.pid}`);
    }
    await sleep(args.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
  }
}

function acquire(
  lockDir: string,
  ownerPath: string,
  processIdentity: (pid: number) => string | undefined
): NativeBuildOwner | undefined {
  try {
    fs.mkdirSync(lockDir);
  } catch (error) {
    if (hasCode(error, 'EEXIST')) return undefined;
    throw error;
  }
  const owner: NativeBuildOwner = {
    pid: process.pid,
    identity: processIdentity(process.pid) ?? `pid-${process.pid}`,
    token: `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    startedAt: new Date().toISOString(),
  };
  try {
    fs.writeFileSync(ownerPath, JSON.stringify(owner), { flag: 'wx' });
    return owner;
  } catch (error) {
    fs.rmSync(lockDir, { recursive: true, force: true });
    throw error;
  }
}

function reclaim(lockDir: string, ownerPath: string, expected: NativeBuildOwner | undefined): void {
  const current = readOwner(ownerPath);
  if (!sameOwner(current, expected)) return;
  const quarantine = `${lockDir}.stale-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  try {
    fs.renameSync(lockDir, quarantine);
    fs.rmSync(quarantine, { recursive: true, force: true });
  } catch (error) {
    if (!hasCode(error, 'ENOENT')) throw error;
  }
}

function releaseOwned(lockDir: string, ownerPath: string, token: string): void {
  if (readOwner(ownerPath)?.token !== token) return;
  fs.rmSync(lockDir, { recursive: true, force: true });
}

function readOwner(ownerPath: string): NativeBuildOwner | undefined {
  try {
    const value: unknown = JSON.parse(fs.readFileSync(ownerPath, 'utf8'));
    if (typeof value !== 'object' || value === null) return undefined;
    const owner = value as Record<string, unknown>;
    if (
      !Number.isInteger(owner.pid) ||
      typeof owner.identity !== 'string' ||
      typeof owner.token !== 'string' ||
      typeof owner.startedAt !== 'string'
    ) {
      return undefined;
    }
    return {
      pid: owner.pid as number,
      identity: owner.identity,
      token: owner.token,
      startedAt: owner.startedAt,
    };
  } catch {
    return undefined;
  }
}

function sameOwner(
  left: NativeBuildOwner | undefined,
  right: NativeBuildOwner | undefined
): boolean {
  if (!left || !right) return left === right;
  return left.pid === right.pid && left.identity === right.identity && left.token === right.token;
}

function defaultPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return hasCode(error, 'EPERM');
  }
}

function defaultProcessIdentity(pid: number): string | undefined {
  try {
    const value = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8' });
    return value.replace(/\s+/g, ' ').trim() || undefined;
  } catch {
    return undefined;
  }
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
