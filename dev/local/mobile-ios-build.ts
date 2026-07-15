import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createProjectHashAsync, DEFAULT_SOURCE_SKIPS, SourceSkips } from '@expo/fingerprint';

import { withNativeBuildSemaphore } from './mobile-native-build';

// Compatibility dimensions hashed into the cache key. Any change must
// invalidate the key so cached artifacts are not reused for an
// incompatible environment.
export type CompatibilityDimensions = {
  nativeHash: string;
  xcodeBuildVersion: string;
  simulatorSdkVersion: string;
  hostArch: string;
  buildMode: 'debug-dev-client';
};

// Manifest persisted next to the cached `.app`. The schema is strict:
// every field is required, types are exact, and `createdAt` must parse
// as an ISO-8601 date. A manifest that fails any check is a miss.
export type Manifest = {
  key: string;
  nativeHash: string;
  xcodeBuildVersion: string;
  simulatorSdkVersion: string;
  hostArch: string;
  buildMode: 'debug-dev-client';
  bundleId: string;
  artifactChecksum: string;
  producerWorktree: string;
  createdAt: string;
};

// Host environment captured at runtime. All fields are injectable for
// tests; production reads them once per process.
export type CacheEnvironment = {
  home: string;
  cacheRoot: string;
  platform: NodeJS.Platform;
  arch: string;
  xcodeBuildVersion: string;
  simulatorSdkVersion: string;
  now: () => Date;
};

const BUNDLE_ID = 'com.kilocode.kiloapp';
const BUILD_MODE = 'debug-dev-client';
const ENTRY_BUNDLE_NAME = 'Kilo.app';
const MANIFEST_NAME = 'manifest.json';
// Producer wait budget: if a concurrent producer has not published
// within this window, the wait is abandoned and the wait caller
// throws. Multi-minute builds need a generous ceiling; abandoned-lock
// recovery handles the producer-died case faster.
const DEFAULT_WAIT_FOR_RESULT_MS = 10 * 60 * 1000;
const DEFAULT_POLL_INTERVAL_MS = 1000;
const DEFAULT_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;

// Lock record persisted under each key's lock directory. Identity is
// process-start identity (ps lstart) so PID reuse is detected. A
// matching (pid, identity) is the source of truth for "still alive".
export type LockRecord = {
  key: string;
  pid: number;
  identity: string;
  startedAt: string;
};

export type CacheLockDeps = {
  env: CacheEnvironment;
  sleep?: (ms: number) => Promise<void>;
  // Override the liveness probe. Default: process.kill(pid, 0) truthy
  // and ESRCH → false.
  pidAlive?: (pid: number) => boolean;
  // Override the process identity probe. Default: `ps -o lstart= -p <pid>`.
  processIdentity?: (pid: number) => string | undefined;
  // Override the active-lock decision. Default: pidAlive(pid) AND
  // processIdentity(pid) === record.identity.
  isLockActive?: (record: LockRecord) => boolean;
  // Overrides for tests; production uses DEFAULT_WAIT_FOR_RESULT_MS.
  waitForResultMs?: number;
  pollIntervalMs?: number;
};

export type WithFingerprintLockArgs<T> = {
  key: string;
  lockRoot: string;
  deps: CacheLockDeps;
  producer: () => Promise<T>;
  // Called after the lock completes (for both producer and waiter) to
  // read the canonical published result from disk. The result file in
  // the lock directory is only a completion signal; it never carries
  // the serialized result value, so arbitrary in-memory values are
  // not trusted across processes.
  readResult: () => Promise<T>;
};

export type LookupCacheArgs = {
  env: CacheEnvironment;
  key: string;
  onMiss: () => Promise<unknown>;
};

export type LookupCacheResult = {
  manifest: Manifest;
  appPath: string;
};

export type BuildInstallCommand = {
  command: string;
  args: string[];
};

export type PruneCacheArgs = {
  env: CacheEnvironment;
  retentionMs?: number;
  // Used to determine whether a lock is still active. When the lock
  // is active, the entry is protected from pruning. Default probes
  // process identity.
  isLockActive?: (record: LockRecord) => boolean;
};

export type PruneResult = {
  removed: string[];
  kept: string[];
};

export type CliArgs =
  | { command: 'fingerprint' }
  | { command: 'build'; udid: string }
  | { command: 'prune' };

// ── Fingerprint ──────────────────────────────────────────────────────

// Build the option bag used to compute the native project hash. Only
// the Expo `extra` section is skipped beyond the library defaults —
// versions, schemes, bundle ID, plugins, assets, permissions, and
// optional native config all remain in the hash.
export function buildFingerprintOptions(): {
  platforms: ['ios'];
  sourceSkips: number;
  silent: boolean;
} {
  return {
    platforms: ['ios'],
    sourceSkips: DEFAULT_SOURCE_SKIPS | SourceSkips.ExpoConfigExtraSection,
    silent: true,
  };
}

// Hash the normalized JSON form of the compatibility dimensions with
// SHA-256. JSON key order is sorted so the key is stable across
// implementations.
export function buildCompatibilityKey(dimensions: CompatibilityDimensions): string {
  const ordered = {
    buildMode: dimensions.buildMode,
    hostArch: dimensions.hostArch,
    nativeHash: dimensions.nativeHash,
    simulatorSdkVersion: dimensions.simulatorSdkVersion,
    xcodeBuildVersion: dimensions.xcodeBuildVersion,
  };
  return createHash('sha256').update(JSON.stringify(ordered)).digest('hex');
}

// ── Cache root ───────────────────────────────────────────────────────

export type ResolveCacheRootArgs = {
  home: string;
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
};

export function resolveCacheRoot(args: ResolveCacheRootArgs): string {
  if (args.platform === 'darwin') {
    return path.join(args.home, 'Library/Caches/Kilo/mobile-ios-builds');
  }
  const xdg = args.env.XDG_CACHE_HOME;
  if (typeof xdg === 'string' && xdg.length > 0) {
    return path.join(xdg, 'Kilo/mobile-ios-builds');
  }
  return path.join(args.home, '.cache/Kilo/mobile-ios-builds');
}

// ── Artifact checksum ───────────────────────────────────────────────

// Deterministic directory hash. Walks the directory recursively,
// reading each file in order, and feeds its relative path + contents
// into SHA-256. Symlinks are rejected so the checksum cannot traverse
// arbitrary host paths. Empty directories contribute their relative
// path only.
export async function computeArtifactChecksum(root: string): Promise<string> {
  const hash = createHash('sha256');
  const entries: WalkEntry[] = [];
  walk(root, '', entries);
  for (const entry of entries) {
    hash.update(entry.relativePath);
    hash.update('\0');
    if (entry.isFile) {
      await hashFileChunks(entry.absolutePath, hash);
      hash.update('\0');
    }
  }
  return hash.digest('hex');
}

type WalkEntry = {
  relativePath: string;
  absolutePath: string;
  isFile: boolean;
};

function walk(root: string, prefix: string, out: WalkEntry[]): void {
  const names = fs.readdirSync(root).sort();
  for (const name of names) {
    const abs = path.join(root, name);
    const rel = prefix === '' ? name : `${prefix}/${name}`;
    const lstat = fs.lstatSync(abs);
    if (lstat.isSymbolicLink()) {
      throw new Error(
        `Symlink found at ${rel}; refusing to follow for deterministic artifact checksum`
      );
    }
    if (lstat.isDirectory()) {
      out.push({ relativePath: rel, absolutePath: abs, isFile: false });
      walk(abs, rel, out);
    } else if (lstat.isFile()) {
      out.push({ relativePath: rel, absolutePath: abs, isFile: true });
    }
  }
}

const CHECKSUM_CHUNK_SIZE = 64 * 1024; // 64KB

function hashFileChunks(filePath: string, hash: ReturnType<typeof createHash>): Promise<void> {
  return new Promise((resolve, reject) => {
    const fd = fs.openSync(filePath, 'r');
    const buffer = Buffer.alloc(CHECKSUM_CHUNK_SIZE);
    try {
      let bytesRead: number;
      do {
        bytesRead = fs.readSync(fd, buffer, 0, CHECKSUM_CHUNK_SIZE, null);
        if (bytesRead > 0) {
          hash.update(bytesRead === CHECKSUM_CHUNK_SIZE ? buffer : buffer.slice(0, bytesRead));
        }
      } while (bytesRead > 0);
      resolve();
    } catch (error) {
      reject(error);
    } finally {
      try {
        fs.closeSync(fd);
      } catch {
        // ignore
      }
    }
  });
}

// ── Manifest validation ──────────────────────────────────────────────

// Strict manifest check. Returns true iff every field is present and
// well-typed. Bundle ID, key, and build mode must match the
// requested values. The producer worktree is recorded for audit but
// not validated here — a successful rebuild from a different
// worktree is a valid cache hit.
export function isValidManifest(
  obj: unknown,
  expected: { key: string; bundleId: string }
): obj is Manifest {
  if (typeof obj !== 'object' || obj === null) return false;
  const o = obj as Record<string, unknown>;
  if (typeof o.key !== 'string' || o.key !== expected.key) return false;
  if (typeof o.nativeHash !== 'string' || o.nativeHash.length === 0) return false;
  if (typeof o.xcodeBuildVersion !== 'string' || o.xcodeBuildVersion.length === 0) return false;
  if (typeof o.simulatorSdkVersion !== 'string' || o.simulatorSdkVersion.length === 0) return false;
  if (typeof o.hostArch !== 'string' || o.hostArch.length === 0) return false;
  if (o.buildMode !== 'debug-dev-client') return false;
  if (typeof o.bundleId !== 'string' || o.bundleId !== expected.bundleId) return false;
  if (typeof o.artifactChecksum !== 'string' || !/^[0-9a-f]{64}$/.test(o.artifactChecksum))
    return false;
  if (typeof o.producerWorktree !== 'string' || o.producerWorktree.length === 0) return false;
  if (typeof o.createdAt !== 'string') return false;
  // Strict ISO-8601 validation: the value must parse and roundtrip.
  const parsedDate = new Date(o.createdAt);
  if (Number.isNaN(parsedDate.getTime()) || parsedDate.toISOString() !== o.createdAt) return false;
  return true;
}

// ── Cache lookup ─────────────────────────────────────────────────────

// Returns the cached entry iff the manifest is well-formed, the
// bundle id matches, and the artifact checksum is current. On any
// miss, calls `onMiss` for side-effects and returns `undefined`.
// The onMiss return value is intentionally discarded — a miss is
// always `undefined`.
export async function lookupCache(args: LookupCacheArgs): Promise<LookupCacheResult | undefined> {
  const entryDir = path.join(args.env.cacheRoot, 'entries', args.key);
  const appPath = path.join(entryDir, ENTRY_BUNDLE_NAME);
  const manifestPath = path.join(entryDir, MANIFEST_NAME);
  if (!fs.existsSync(manifestPath) || !fs.existsSync(appPath)) {
    await args.onMiss();
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch {
    await args.onMiss();
    return undefined;
  }
  if (!isValidManifest(parsed, { key: args.key, bundleId: BUNDLE_ID })) {
    await args.onMiss();
    return undefined;
  }
  const manifest = parsed as Manifest;
  const actualChecksum = await computeArtifactChecksum(appPath);
  if (actualChecksum !== manifest.artifactChecksum) {
    await args.onMiss();
    return undefined;
  }
  return { manifest, appPath };
}

// ── Producer lock ────────────────────────────────────────────────────

// Run `producer` under a fingerprint-specific host lock. Exactly one
// concurrent caller becomes the producer; the rest wait for the
// published result. An abandoned lock (dead PID or identity mismatch)
// is recovered and a new producer is started. Active locks bound the
// wait; on timeout we fail closed and let the caller decide.
export async function withFingerprintLock<T>(args: WithFingerprintLockArgs<T>): Promise<T> {
  fs.mkdirSync(args.lockRoot, { recursive: true });
  const lockDir = path.join(args.lockRoot, `${args.key}.lock`);
  const lockFile = path.join(lockDir, 'lock.json');
  const resultFile = path.join(lockDir, 'result.json');
  const sleep = args.deps.sleep ?? defaultSleep;
  const waitForResultMs = args.deps.waitForResultMs ?? DEFAULT_WAIT_FOR_RESULT_MS;
  const pollIntervalMs = args.deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const isActive = args.deps.isLockActive ?? defaultIsLockActive(args.deps);
  const identity =
    args.deps.processIdentity?.(process.pid) ??
    defaultProcessIdentity(process.pid) ??
    `pid-${process.pid}`;

  // Fast path: if a previous producer left a valid completion signal and the
  // lock is not active, we may be able to return the canonical result without
  // running a producer. If the marker is stale (no canonical result), fall
  // through and acquire/rebuild so the key is not poisoned.
  const prePublished = readLockResult(resultFile);
  if (prePublished.kind === 'done') {
    try {
      return await args.readResult();
    } catch {
      // Stale done marker with no canonical result: fall through and rebuild.
    }
  }
  if (tryAcquireLock(lockDir, lockFile, args.key, identity)) {
    return runProducer(args, lockFile, resultFile);
  }

  // Phase 2: another caller might be producing. Check the lock first.
  // Only a currently active lock's result markers are trustworthy; an
  // inactive lock means the previous producer died, and any leftover
  // done/error marker in result.json is stale and must be ignored.
  const deadline = Date.now() + waitForResultMs;
  while (Date.now() < deadline) {
    await sleep(pollIntervalMs);
    const record = readLockRecord(lockFile);
    if (record && isActive(record)) {
      // Active producer: wait for its completion/error signal.
      const published = readLockResult(resultFile);
      if (published.kind === 'done') return args.readResult();
      if (published.kind === 'error') throw published.error;
      continue;
    }
    // Lock inactive or missing. A stale `{done:true}` marker may still
    // correspond to a valid canonical result; try to use it before
    // rebuilding. If the result is missing or invalid, adopt/acquire and
    // rebuild so the key is not poisoned by a stale marker.
    const published = readLockResult(resultFile);
    if (published.kind === 'done') {
      try {
        return await args.readResult();
      } catch {
        // Stale done marker with no canonical result: fall through and rebuild.
      }
    }
    // Lock inactive but a record exists. Try to take over atomically. Passing
    // the exact stale record we observed prevents stealing a freshly
    // acquired active lock in the race window.
    if (record && tryAdoptLock(args.lockRoot, lockDir, lockFile, args.key, record, identity)) {
      return runProducer(args, lockFile, resultFile);
    }
    // No lock record: the previous producer already released the lock. A
    // stale error marker is ignored, so acquire directly and rebuild.
    if (!record && tryAcquireLock(lockDir, lockFile, args.key, identity)) {
      return runProducer(args, lockFile, resultFile);
    }
  }
  throw new Error(`Timed out waiting for active producer to publish result for key ${args.key}`);
}

async function runProducer<T>(
  args: WithFingerprintLockArgs<T>,
  lockFile: string,
  resultFile: string
): Promise<T> {
  try {
    // Clear any stale result marker before the producer starts so waiters
    // cannot see an abandoned error/done marker from a previous run.
    try {
      fs.rmSync(resultFile, { force: true });
    } catch {
      // ignore
    }
    await args.producer();
    // Publish only a completion signal; the actual result is read
    // from the canonical on-disk source via readResult.
    writeLockResult(resultFile, { done: true });
  } catch (error) {
    // Errors are serialized as message-only objects. Cross-process waiters
    // receive only a generic `Error` with that message and must not depend
    // on subclass, name, stack, or cause, which could carry secrets or
    // implementation details across process boundaries.
    writeLockResult(resultFile, {
      error: { message: error instanceof Error ? error.message : String(error) },
    });
    throw error;
  } finally {
    // Remove only the lock record. The result file lives in the
    // same directory and must survive release so waiters can read
    // the published value. The next producer (or prune) cleans it
    // up before publishing a new value.
    try {
      fs.rmSync(lockFile, { force: true });
    } catch {
      // ignore
    }
  }
  return args.readResult();
}

export function defaultIsLockActive(deps: CacheLockDeps): (record: LockRecord) => boolean {
  const pidAlive = deps.pidAlive ?? defaultPidAlive;
  const processIdentity = deps.processIdentity ?? defaultProcessIdentity;
  return record => {
    const alive = pidAlive(record.pid);
    const identity = processIdentity(record.pid);
    return alive && identity !== undefined && record.identity === identity;
  };
}

function tryAcquireLock(
  lockDir: string,
  lockFile: string,
  key: string,
  identity?: string
): boolean {
  // Ensure the lock directory exists. A leftover directory from a
  // crashed producer (with no active lock.json) must not block a new
  // producer from claiming the key.
  try {
    fs.mkdirSync(lockDir, { recursive: false });
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) {
      throw error;
    }
  }
  // Atomically claim the lock file. `wx` succeeds only if no other
  // process currently holds the lock. On EEXIST we back off without
  // destroying the directory, because another caller may have just
  // created an active lock. The directory will be cleaned up by prune
  // or the next successful acquisition.
  try {
    const record: LockRecord = createLockRecord(key, identity);
    fs.writeFileSync(lockFile, JSON.stringify(record), { flag: 'wx' });
    return true;
  } catch (error) {
    // Do NOT remove the lock directory here. Another caller may have just
    // created an active lock, and destroying it would break waiters. The
    // directory will be cleaned up by prune or the next successful acquisition.
    if (error instanceof Error && 'code' in error && error.code === 'EEXIST') {
      return false;
    }
    throw error;
  }
}

function tryAdoptLock(
  lockRoot: string,
  lockDir: string,
  lockFile: string,
  key: string,
  staleRecord: LockRecord,
  identity?: string
): boolean {
  // Verify the canonical lock file still matches the exact stale record
  // we observed before attempting to steal. If another caller has
  // already replaced it with a fresh active lock, we must back off.
  const current = readLockRecord(lockFile);
  if (!current || !lockRecordsEqual(current, staleRecord)) {
    return false;
  }
  // Atomic single-winner takeover: rename the stale lock file to a unique
  // quarantine path. Only one caller wins the rename; losers see ENOENT and
  // back off. The winner then writes a fresh lock record with `wx`.
  const quarantine = path.join(
    lockRoot,
    `${key}.quarantine.${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  try {
    fs.renameSync(lockFile, quarantine);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
  // Winner: write fresh lock record
  try {
    const record: LockRecord = createLockRecord(key, identity);
    fs.writeFileSync(lockFile, JSON.stringify(record), { flag: 'wx' });
  } catch (error) {
    // Another winner already wrote the lockFile; restore quarantine
    try {
      fs.renameSync(quarantine, lockFile);
    } catch {
      // ignore
    }
    if (error instanceof Error && 'code' in error && error.code === 'EEXIST') {
      return false;
    }
    throw error;
  }
  // Clean up quarantine
  try {
    fs.rmSync(quarantine, { force: true });
  } catch {
    // ignore
  }
  return true;
}

function lockRecordsEqual(a: LockRecord, b: LockRecord): boolean {
  return (
    a.key === b.key && a.pid === b.pid && a.identity === b.identity && a.startedAt === b.startedAt
  );
}

function createLockRecord(key: string, identity?: string): LockRecord {
  return {
    key,
    pid: process.pid,
    identity: identity ?? defaultProcessIdentity(process.pid) ?? `pid-${process.pid}`,
    startedAt: new Date().toISOString(),
  };
}

function readLockRecord(lockFile: string): LockRecord | undefined {
  try {
    const raw = fs.readFileSync(lockFile, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    const o = parsed as Record<string, unknown>;
    if (
      typeof o.key !== 'string' ||
      typeof o.pid !== 'number' ||
      typeof o.identity !== 'string' ||
      typeof o.startedAt !== 'string'
    ) {
      return undefined;
    }
    return { key: o.key, pid: o.pid, identity: o.identity, startedAt: o.startedAt };
  } catch {
    return undefined;
  }
}

type LockResult = { kind: 'pending' } | { kind: 'done' } | { kind: 'error'; error: Error };

// Read the lock completion signal. Errors are deliberately
// message-only generic `Error` instances: waiters MUST NOT depend on
// error subclass, name, stack, or any other fields that could carry
// secrets or implementation details across process boundaries.
function readLockResult(resultFile: string): LockResult {
  try {
    const raw = fs.readFileSync(resultFile, 'utf8');
    const parsed = JSON.parse(raw) as { done?: unknown; error?: { message: string } };
    if (parsed.error && typeof parsed.error.message === 'string') {
      return { kind: 'error', error: new Error(parsed.error.message) };
    }
    if (parsed.done === true) {
      return { kind: 'done' };
    }
    return { kind: 'pending' };
  } catch {
    return { kind: 'pending' };
  }
}

function writeLockResult(
  resultFile: string,
  result: { done: true } | { error: { message: string } }
): void {
  fs.writeFileSync(resultFile, JSON.stringify(result), { flag: 'w' });
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function defaultPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error) {
      if (error.code === 'EPERM') return true;
      if (error.code === 'ESRCH') return false;
    }
    return false;
  }
}

function defaultProcessIdentity(pid: number): string | undefined {
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  try {
    const result = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8',
    });
    const identity = result.replace(/\s+/g, ' ').trim();
    return identity || undefined;
  } catch {
    return undefined;
  }
}

// ── Simulator claim validation ───────────────────────────────────────

// Read-only validation of a claim recorded by the simulator
// wrapper. Accepts the caller's current worktree as the exclusive
// owner; any other recorded worktree (including legacy claims without
// `status`) is rejected.
export function validateSimulatorClaim(
  udid: string,
  worktreeRoot: string,
  claimRoot: string
): void {
  const claimPath = path.join(claimRoot, `${udid}.json`);
  let raw: string;
  try {
    raw = fs.readFileSync(claimPath, 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      throw new Error(`Simulator ${udid} is not claimed by this worktree`, { cause: error });
    }
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Simulator ${udid} claim is corrupt`, { cause: error });
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error(`Simulator ${udid} claim is corrupt`);
  }
  const o = parsed as Record<string, unknown>;
  if (typeof o.worktreeRoot !== 'string' || o.worktreeRoot.length === 0) {
    throw new Error(`Simulator ${udid} claim is corrupt`);
  }
  if (o.worktreeRoot !== worktreeRoot) {
    throw new Error(`Simulator ${udid} is claimed by ${o.worktreeRoot}`);
  }
  // For the build cache we require a current-format ready claim. A
  // preparing claim (same worktree or not) cannot be used to install
  // an app; legacy claims (no status) are also rejected — the E2E
  // simulator wrapper must reclaim/upgrade them first.
  if (typeof o.status !== 'string' || o.status !== 'ready') {
    throw new Error(`Simulator ${udid} is not ready for build (status=${String(o.status)})`);
  }
  if (typeof o.claimId !== 'string' || o.claimId.length === 0) {
    throw new Error(`Simulator ${udid} claim is corrupt`);
  }
  if (typeof o.claimedAt !== 'string' || Number.isNaN(Date.parse(o.claimedAt))) {
    throw new Error(`Simulator ${udid} claim is corrupt`);
  }
}

// ── Install command ──────────────────────────────────────────────────

export function buildInstallCommand(udid: string, appPath: string): BuildInstallCommand {
  return {
    command: 'xcrun',
    args: ['simctl', 'install', udid, appPath],
  };
}

// ── Pruning ──────────────────────────────────────────────────────────

export async function pruneCache(args: PruneCacheArgs): Promise<PruneResult> {
  const entriesRoot = path.join(args.env.cacheRoot, 'entries');
  const locksRoot = path.join(args.env.cacheRoot, 'locks');
  const retentionMs = args.retentionMs ?? DEFAULT_RETENTION_MS;
  const isActive = args.isLockActive ?? defaultIsLockActive({ env: args.env });
  const removed: string[] = [];
  const kept: string[] = [];
  if (!fs.existsSync(entriesRoot)) return { removed, kept };
  const now = args.env.now().getTime();
  for (const key of fs.readdirSync(entriesRoot)) {
    const manifestPath = path.join(entriesRoot, key, MANIFEST_NAME);
    if (!fs.existsSync(manifestPath)) {
      kept.push(key);
      continue;
    }
    // Active locks (those with a real lock record) protect entries
    // from pruning. A missing lock record means the entry is not
    // currently being produced and is eligible for age-based pruning.
    const lockDir = path.join(locksRoot, `${key}.lock`);
    const lockFile = path.join(lockDir, 'lock.json');
    const lockRecord = readLockRecord(lockFile);
    if (lockRecord && isActive(lockRecord)) {
      kept.push(key);
      continue;
    }
    let manifest: unknown;
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    } catch {
      removeEntry(entriesRoot, key);
      removeLockArtifacts(lockDir);
      removed.push(key);
      continue;
    }
    const createdAt = (manifest as { createdAt?: unknown }).createdAt;
    if (typeof createdAt !== 'string' || Number.isNaN(Date.parse(createdAt))) {
      removeEntry(entriesRoot, key);
      removeLockArtifacts(lockDir);
      removed.push(key);
      continue;
    }
    const age = now - Date.parse(createdAt);
    if (age >= retentionMs) {
      removeEntry(entriesRoot, key);
      removeLockArtifacts(lockDir);
      removed.push(key);
    } else {
      kept.push(key);
    }
  }
  // Cleanup orphan lock/quarantine directories that have no corresponding
  // entry and are not active. Active locks are always protected.
  if (fs.existsSync(locksRoot)) {
    for (const name of fs.readdirSync(locksRoot)) {
      const full = path.join(locksRoot, name);
      const stat = fs.statSync(full);
      // Locks are directories; tryAdoptLock quarantines lock.json as a file.
      if (!/\.(lock|quarantine\..*)$/.test(name)) continue;
      const key = name.replace(/\.(lock|quarantine\..*)$/, '');
      if (fs.existsSync(path.join(entriesRoot, key))) continue;
      if (!stat.isDirectory()) {
        removeLockArtifacts(full);
        continue;
      }
      const lockFile = path.join(full, 'lock.json');
      const lockRecord = readLockRecord(lockFile);
      if (lockRecord && isActive(lockRecord)) continue;
      removeLockArtifacts(full);
    }
  }
  return { removed, kept };
}

function removeEntry(entriesRoot: string, key: string): void {
  fs.rmSync(path.join(entriesRoot, key), { recursive: true, force: true });
}

function removeLockArtifacts(lockDir: string): void {
  try {
    fs.rmSync(lockDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

// ── CLI ──────────────────────────────────────────────────────────────

export function parseCliArgs(argv: readonly string[]): CliArgs {
  const [command, ...rest] = argv;
  if (command === 'fingerprint') {
    if (rest.length !== 0) throw new Error('Usage: pnpm dev:mobile:ios fingerprint');
    return { command: 'fingerprint' };
  }
  if (command === 'build') {
    if (rest.length !== 1) throw new Error('Usage: pnpm dev:mobile:ios build <udid>');
    return { command: 'build', udid: rest[0] };
  }
  if (command === 'prune') {
    if (rest.length !== 0) throw new Error('Usage: pnpm dev:mobile:ios prune');
    return { command: 'prune' };
  }
  throw new Error('Usage: pnpm dev:mobile:ios [fingerprint|build <udid>|prune]');
}

// ── Xcode workspace and build command ───────────────────────────────

// Check that the generated native project exists. Expo generates
// `apps/mobile/ios/Kilo.xcworkspace` via `npx expo prebuild --platform
// ios` (or as a side effect of `expo run:ios`). We do NOT run prebuild
// ourselves — the caller is expected to have done so. A missing
// workspace is a clear, actionable error.
export function validateXcodeWorkspace(mobileRoot: string): void {
  const workspace = path.join(mobileRoot, 'ios', 'Kilo.xcworkspace');
  if (!fs.existsSync(workspace)) {
    throw new Error(
      `Native iOS project is missing at ${workspace}. Run \`npx expo prebuild --platform ios\` in apps/mobile before invoking this command.`
    );
  }
}

// Build the exact xcodebuild invocation. A dedicated derivedDataPath
// under our staging directory is the ONLY source of the produced
// `.app` — we never scan global DerivedData. The command targets
// Debug / iphonesimulator and pins the destination to the requested
// UDID.
export function buildXcodeBuildCommand(args: {
  mobileRoot: string;
  udid: string;
  derivedDataPath: string;
}): BuildInstallCommand {
  return {
    command: 'xcodebuild',
    args: [
      '-workspace',
      path.join(args.mobileRoot, 'ios', 'Kilo.xcworkspace'),
      '-scheme',
      'Kilo',
      '-configuration',
      'Debug',
      '-sdk',
      'iphonesimulator',
      '-destination',
      `id=${args.udid}`,
      '-derivedDataPath',
      args.derivedDataPath,
      'build',
    ],
  };
}

// Locate the produced `.app` at the canonical xcodebuild path. Throws
// if missing — the producer must not silently fall back to a
// different artifact.
export function locateProducedApp(derivedDataPath: string): string {
  const app = path.join(derivedDataPath, 'Build', 'Products', 'Debug-iphonesimulator', 'Kilo.app');
  if (!fs.existsSync(app)) {
    throw new Error(
      `Produced app not found at ${app}. xcodebuild did not produce the expected artifact.`
    );
  }
  return app;
}

// ── Build flow types ────────────────────────────────────────────────

// All side-effecting boundaries the build flow needs. Tests inject
// stubs; production wires real implementations.
export type BuildDeps = {
  env: CacheEnvironment;
  worktreeRoot: string;
  claimRoot: string;
  mobileRoot: string;
  fingerprint: (
    root: string,
    options: ReturnType<typeof buildFingerprintOptions>
  ) => Promise<string>;
  build: (args: {
    stagingDir: string;
    derivedDataPath: string;
    udid: string;
    mobileRoot: string;
  }) => Promise<void>;
  readInfoPlist: (appPath: string, key: string) => string | undefined;
  install: (udid: string, appPath: string) => void;
  copyDir: (src: string, dest: string) => void;
  mkdtemp: (prefix: string) => string;
  withNativeBuildSlot: <T>(run: () => Promise<T>) => Promise<T>;
  validateClaim: (udid: string, worktreeRoot: string, claimRoot: string) => void;
  sleep?: (ms: number) => Promise<void>;
};

export type RunFingerprintDeps = {
  env: CacheEnvironment;
  mobileRoot: string;
  fingerprint: (
    root: string,
    options: ReturnType<typeof buildFingerprintOptions>
  ) => Promise<string>;
  write: (chunk: string) => void;
};

export type RunPruneDeps = {
  env: CacheEnvironment;
  isLockActive?: (record: LockRecord) => boolean;
  write: (chunk: string) => void;
};

// ── Publish flow ────────────────────────────────────────────────────

// Build, verify, and atomically publish a cache entry. Called as the
// sole producer inside the fingerprint lock. On entry, the cache is
// re-checked — if a concurrent caller already published a valid
// entry, we return it without rebuilding (this also covers the
// "abandoned lock recovery must not overwrite a valid entry"
// requirement).
export async function publishCacheEntry(args: {
  env: CacheEnvironment;
  key: string;
  compatibility: CompatibilityDimensions;
  worktreeRoot: string;
  udid: string;
  deps: BuildDeps;
}): Promise<LookupCacheResult> {
  validateKey(args.key);
  // Re-check: another caller may have published between our
  // pre-lock lookup and acquiring the lock.
  const existing = await lookupCache({
    env: args.env,
    key: args.key,
    onMiss: async () => undefined,
  });
  if (existing) return existing;

  const stagingRoot = path.join(args.env.cacheRoot, 'staging');
  fs.mkdirSync(stagingRoot, { recursive: true });
  const staging = args.deps.mkdtemp(path.join(stagingRoot, `kilo-mobile-ios-build-${args.key}-`));
  const derivedDataPath = path.join(staging, 'DerivedData');
  fs.mkdirSync(derivedDataPath, { recursive: true });
  try {
    await args.deps.build({
      stagingDir: staging,
      derivedDataPath,
      udid: args.udid,
      mobileRoot: args.deps.mobileRoot,
    });
    const builtApp = locateProducedApp(derivedDataPath);
    const stagingApp = path.join(staging, ENTRY_BUNDLE_NAME);
    args.deps.copyDir(builtApp, stagingApp);
    const bundleId = args.deps.readInfoPlist(stagingApp, 'CFBundleIdentifier');
    if (bundleId !== BUNDLE_ID) {
      throw new Error(
        `Produced app has unexpected bundle id "${bundleId}" (expected ${BUNDLE_ID})`
      );
    }
    const artifactChecksum = await computeArtifactChecksum(stagingApp);
    const manifest: Manifest = {
      key: args.key,
      nativeHash: args.compatibility.nativeHash,
      xcodeBuildVersion: args.compatibility.xcodeBuildVersion,
      simulatorSdkVersion: args.compatibility.simulatorSdkVersion,
      hostArch: args.compatibility.hostArch,
      buildMode: BUILD_MODE,
      bundleId: BUNDLE_ID,
      artifactChecksum,
      producerWorktree: args.worktreeRoot,
      createdAt: args.env.now().toISOString(),
    };
    fs.writeFileSync(path.join(staging, MANIFEST_NAME), JSON.stringify(manifest), {
      flag: 'w',
    });
    const finalDir = path.join(args.env.cacheRoot, 'entries', args.key);
    fs.mkdirSync(path.dirname(finalDir), { recursive: true });
    try {
      fs.renameSync(staging, finalDir);
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        throw new Error(`Failed to publish cache entry: staging directory vanished`);
      }
      // Defensive fallback: if another producer won the race, verify the
      // existing entry rather than overwriting. This only applies to
      // expected rename-over-directory races; other failures propagate.
      if (
        error instanceof Error &&
        'code' in error &&
        (error.code === 'EEXIST' || error.code === 'ENOTEMPTY')
      ) {
        const concurrent = await lookupCache({
          env: args.env,
          key: args.key,
          onMiss: async () => undefined,
        });
        if (concurrent) return concurrent;
      }
      throw error;
    }
    // Re-validate the on-disk entry. This is the canonical source of
    // truth for both the producer and any waiters.
    const verified = await lookupCache({
      env: args.env,
      key: args.key,
      onMiss: async () => undefined,
    });
    if (!verified) {
      throw new Error(`Cache entry failed post-publish validation for key ${args.key}`);
    }
    return verified;
  } finally {
    // If staging still exists (publish failed), clean it up. Use
    // rmSync with force to swallow EBUSY etc.
    try {
      fs.rmSync(staging, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}

// ── Build orchestration ─────────────────────────────────────────────

// Run the full `build <udid>` flow. On a cache hit, install without
// building. On a miss, enter the fingerprint lock; the sole producer
// publishes a validated entry, and all callers (including waiters)
// re-validate the on-disk entry before installing. This guarantees
// the installed `.app` is always checksum-verified and manifest-
// signed, never an unvalidated in-memory producer value.
// Defense-in-depth: the cache key is the SHA-256 output of
// buildCompatibilityKey, so it is always 64 hex characters. Reject any
// other shape before deriving filesystem paths, guarding against accidental
// caller mistakes just as much as malicious input.
function validateKey(key: string): void {
  if (!/^[0-9a-f]{64}$/.test(key)) {
    throw new Error(`Invalid cache key: expected 64 hex characters, got ${key}`);
  }
}

export async function runBuild(udid: string, deps: BuildDeps): Promise<void> {
  // 1. Validate exclusive claim for the current worktree.
  deps.validateClaim(udid, deps.worktreeRoot, deps.claimRoot);

  // 2. Compute compatibility dimensions and key.
  const nativeHash = await deps.fingerprint(deps.mobileRoot, buildFingerprintOptions());
  const compatibility: CompatibilityDimensions = {
    nativeHash,
    xcodeBuildVersion: deps.env.xcodeBuildVersion,
    simulatorSdkVersion: deps.env.simulatorSdkVersion,
    hostArch: deps.env.arch,
    buildMode: BUILD_MODE,
  };
  const key = buildCompatibilityKey(compatibility);
  validateKey(key);

  // 3. Pre-lock lookup. A hit here avoids the lock entirely.
  const preHit = await lookupCache({
    env: deps.env,
    key,
    onMiss: async () => undefined,
  });
  if (preHit) {
    deps.install(udid, preHit.appPath);
    return;
  }

  // 4. Miss: enter the fingerprint lock. publishCacheEntry
  // re-checks the cache (covers abandoned-lock + valid-entry) and
  // publishes a validated entry for the sole producer.
  const lockRoot = path.join(deps.env.cacheRoot, 'locks');
  const lockDeps: CacheLockDeps = {
    env: deps.env,
    sleep: deps.sleep,
  };
  await withFingerprintLock<LookupCacheResult>({
    key,
    lockRoot,
    deps: lockDeps,
    producer: () =>
      deps.withNativeBuildSlot(() =>
        publishCacheEntry({
          env: deps.env,
          key,
          compatibility,
          worktreeRoot: deps.worktreeRoot,
          udid,
          deps,
        })
      ),
    readResult: async () =>
      lookupCache({
        env: deps.env,
        key,
        onMiss: async () => undefined,
      }).then(r => {
        if (!r) {
          throw new Error(
            `Cache entry missing after publish for key ${key}; refusing to install unvalidated artifact`
          );
        }
        return r;
      }),
  });

  // 5. Re-validate from disk (requirement 7). Both the producer
  // (who built and published) and the waiter (who observed the
  // result file) must observe the same validated on-disk entry.
  // readResult already performs this, and we repeat it here so
  // runBuild owns the final install decision.
  const revalidated = await lookupCache({
    env: deps.env,
    key,
    onMiss: async () => undefined,
  });
  if (!revalidated) {
    throw new Error(
      `Cache entry missing after publish for key ${key}; refusing to install unvalidated artifact`
    );
  }
  deps.install(udid, revalidated.appPath);
}

// ── Fingerprint orchestration ───────────────────────────────────────

// Print sanitized compatibility dimensions and the cache key. No
// environment values, no source lists, no secrets. Uses the injected
// `fingerprint` function (which in production calls
// `@expo/fingerprint.createProjectHashAsync` directly — no child
// process indirection).
export async function runFingerprint(deps: RunFingerprintDeps): Promise<void> {
  const nativeHash = await deps.fingerprint(deps.mobileRoot, buildFingerprintOptions());
  const compatibility: CompatibilityDimensions = {
    nativeHash,
    xcodeBuildVersion: deps.env.xcodeBuildVersion,
    simulatorSdkVersion: deps.env.simulatorSdkVersion,
    hostArch: deps.env.arch,
    buildMode: BUILD_MODE,
  };
  const sanitized = {
    key: buildCompatibilityKey(compatibility),
    nativeHash,
    xcodeBuildVersion: deps.env.xcodeBuildVersion,
    simulatorSdkVersion: deps.env.simulatorSdkVersion,
    hostArch: deps.env.arch,
    buildMode: BUILD_MODE,
    bundleId: BUNDLE_ID,
  };
  deps.write(`${JSON.stringify(sanitized, null, 2)}\n`);
}

// ── Prune orchestration ─────────────────────────────────────────────

export async function runPrune(deps: RunPruneDeps): Promise<void> {
  const result = await pruneCache({ env: deps.env, isLockActive: deps.isLockActive });
  deps.write(`${JSON.stringify(result, null, 2)}\n`);
}

// ── Main entry point ─────────────────────────────────────────────────

async function main(): Promise<void> {
  const parsed = parseCliArgs(process.argv.slice(2));
  const env = productionEnvironment();
  if (parsed.command === 'fingerprint') {
    await runFingerprint({
      env,
      mobileRoot: mobileRoot(),
      fingerprint: async (root, options) =>
        createProjectHashAsync(root, options as Parameters<typeof createProjectHashAsync>[1]),
      write: (chunk: string) => process.stdout.write(chunk),
    });
    return;
  }
  if (parsed.command === 'prune') {
    await runPrune({
      env,
      write: (chunk: string) => process.stdout.write(chunk),
    });
    return;
  }
  if (parsed.command === 'build') {
    const worktreeRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
    }).trim();
    const claimRoot = path.join(os.tmpdir(), 'kilo-mobile-simulator-claims');
    await runBuild(parsed.udid, {
      env,
      worktreeRoot,
      claimRoot,
      mobileRoot: mobileRoot(),
      fingerprint: async (root, options) =>
        createProjectHashAsync(root, options as Parameters<typeof createProjectHashAsync>[1]),
      build: productionBuilder,
      readInfoPlist: productionReadInfoPlist,
      install: productionInstall,
      copyDir: productionCopyDir,
      mkdtemp: (prefix: string) => {
        fs.mkdirSync(path.dirname(prefix), { recursive: true });
        return fs.mkdtempSync(prefix);
      },
      withNativeBuildSlot: run =>
        withNativeBuildSemaphore({
          root: path.join(env.cacheRoot, '..'),
          run,
        }),
      validateClaim: (udid: string, worktreeRoot: string, claimRoot: string) =>
        validateSimulatorClaim(udid, worktreeRoot, claimRoot),
    });
    process.stdout.write(`Installed ${parsed.udid}\n`);
    return;
  }
  throw new Error('Usage: pnpm dev:mobile:ios [fingerprint|build <udid>|prune]');
}

// Production builder: validates the Xcode workspace, then invokes
// xcodebuild with a dedicated derivedDataPath under the staging
// directory. The staging directory is created by `runBuild` and
// passed in; we do not prebuild or mutate the global workspace.
async function productionBuilder(args: {
  stagingDir: string;
  derivedDataPath: string;
  udid: string;
  mobileRoot: string;
}): Promise<void> {
  validateXcodeWorkspace(args.mobileRoot);
  const cmd = buildXcodeBuildCommand({
    mobileRoot: args.mobileRoot,
    udid: args.udid,
    derivedDataPath: args.derivedDataPath,
  });
  execFileSync(cmd.command, cmd.args, { stdio: 'inherit' });
  locateProducedApp(args.derivedDataPath);
}

function productionReadInfoPlist(appPath: string, key: string): string | undefined {
  const result = execFileSync(
    'plutil',
    ['-extract', key, 'raw', '-o', '-', path.join(appPath, 'Info.plist')],
    {
      encoding: 'utf8',
    }
  );
  const value = result.trim();
  return value.length === 0 ? undefined : value;
}

function productionInstall(udid: string, appPath: string): void {
  const cmd = buildInstallCommand(udid, appPath);
  execFileSync(cmd.command, cmd.args, { stdio: 'inherit' });
}

function productionCopyDir(src: string, dest: string): void {
  fs.cpSync(src, dest, { recursive: true });
}

function productionEnvironment(): CacheEnvironment {
  const home = os.homedir();
  return {
    home,
    cacheRoot: resolveCacheRoot({ home, platform: process.platform, env: process.env }),
    platform: process.platform,
    arch: process.arch,
    xcodeBuildVersion: queryXcodeBuildVersion(),
    simulatorSdkVersion: querySimulatorSdkVersion(),
    now: () => new Date(),
  };
}

function queryXcodeBuildVersion(): string {
  const raw = execFileSync('xcodebuild', ['-version'], { encoding: 'utf8' });
  const match = raw.match(/Build version (\S+)/);
  if (!match) throw new Error('Unable to determine Xcode build version');
  return match[1];
}

function querySimulatorSdkVersion(): string {
  const raw = execFileSync('xcrun', ['--sdk', 'iphonesimulator', '--show-sdk-version'], {
    encoding: 'utf8',
  });
  return raw.trim();
}

// Resolve the mobile project root from this module's location, never from
// process.cwd(). The module lives at dev/local/mobile-ios-build.ts, so two
// directories up is the repo root, then apps/mobile.
export function mobileRoot(): string {
  return path.resolve(import.meta.dirname, '..', '..', 'apps', 'mobile');
}

export function resolveMobileRoot(repoRoot: string): string {
  return path.resolve(repoRoot, 'apps', 'mobile');
}

const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename);
if (isMain) {
  main().catch(error => {
    process.stderr.write(`${error instanceof Error ? error.message : error}\n`);
    process.exit(1);
  });
}
