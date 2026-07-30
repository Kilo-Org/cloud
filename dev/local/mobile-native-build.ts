import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
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
  const lockPath = path.join(args.root, 'native-build.lock');
  const pidAlive = args.pidAlive ?? defaultPidAlive;
  const processIdentity = args.processIdentity ?? defaultProcessIdentity;
  const deadline = Date.now() + (args.waitTimeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS);

  while (true) {
    const owner = acquire(lockPath, processIdentity);
    if (owner) {
      try {
        return await args.run();
      } finally {
        releaseOwned(lockPath, owner.token);
      }
    }

    if (Date.now() >= deadline) {
      throw new Error('Timed out waiting for native build producer');
    }

    const current = readOwner(lockPath);
    if (!current) {
      await sleep(args.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
      continue;
    }
    if (!pidAlive(current.pid) || processIdentity(current.pid) !== current.identity) {
      reclaim(lockPath, current);
      await sleep(args.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
      continue;
    }
    await sleep(args.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
  }
}

// Root-level inputs that change the native build but live outside
// apps/mobile, so @expo/fingerprint never sees them: pnpm patches and
// the workspace/lockfile that pin dependency resolution. Hashed as
// sorted relative paths plus contents so the result is deterministic.
export function hashRootNativeInputs(repoRoot: string): string {
  const hash = createHash('sha256');
  const add = (label: string, filePath: string): void => {
    hash.update(label);
    hash.update('\0');
    try {
      hash.update(fs.readFileSync(filePath));
    } catch (error) {
      if (!hasCode(error, 'ENOENT')) throw error;
      hash.update('<missing>');
    }
    hash.update('\0');
  };
  add('pnpm-workspace.yaml', path.join(repoRoot, 'pnpm-workspace.yaml'));
  add('pnpm-lock.yaml', path.join(repoRoot, 'pnpm-lock.yaml'));
  const patchesRoot = path.join(repoRoot, 'patches');
  for (const relativePath of listFilesRecursively(patchesRoot)) {
    add(`patches/${relativePath}`, path.join(patchesRoot, relativePath));
  }
  return hash.digest('hex');
}

function listFilesRecursively(root: string): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { recursive: true, withFileTypes: true });
  } catch (error) {
    if (hasCode(error, 'ENOENT')) return [];
    throw error;
  }
  return entries
    .filter(entry => entry.isFile())
    .map(entry => path.relative(root, path.join(entry.parentPath, entry.name)))
    .sort();
}

function acquire(
  lockPath: string,
  processIdentity: (pid: number) => string | undefined
): NativeBuildOwner | undefined {
  const stagingPath = `${lockPath}.acquire-${process.pid}-${Date.now()}-${Math.random()
    .toString(16)
    .slice(2)}`;
  const owner: NativeBuildOwner = {
    pid: process.pid,
    identity: processIdentity(process.pid) ?? `pid-${process.pid}`,
    token: `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    startedAt: new Date().toISOString(),
  };
  try {
    fs.writeFileSync(stagingPath, JSON.stringify(owner), { flag: 'wx' });
    fs.linkSync(stagingPath, lockPath);
    return owner;
  } catch (error) {
    if (hasCode(error, 'EEXIST')) return undefined;
    throw error;
  } finally {
    try {
      fs.rmSync(stagingPath, { force: true });
    } catch {
      // Unique staging files are inert; cleanup must not mask lock acquisition.
    }
  }
}

function reclaim(lockPath: string, expected: NativeBuildOwner): void {
  const current = readOwner(lockPath);
  if (!sameOwner(current, expected)) return;
  const quarantine = `${lockPath}.stale-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  try {
    fs.renameSync(lockPath, quarantine);
  } catch (error) {
    if (!hasCode(error, 'ENOENT')) throw error;
    return;
  }
  try {
    fs.rmSync(quarantine, { recursive: true, force: true });
  } catch {
    // A uniquely named quarantine is inert and must not block the next producer.
  }
}

function releaseOwned(lockPath: string, token: string): void {
  if (readOwner(lockPath)?.token !== token) return;
  fs.rmSync(lockPath, { force: true });
}

function readOwner(lockPath: string): NativeBuildOwner | undefined {
  try {
    const ownerPath = fs.statSync(lockPath).isDirectory()
      ? path.join(lockPath, 'owner.json')
      : lockPath;
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

function sameOwner(left: NativeBuildOwner | undefined, right: NativeBuildOwner): boolean {
  if (!left) return false;
  return left.pid === right.pid && left.identity === right.identity && left.token === right.token;
}

function defaultPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
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
