import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import fsp, { type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import {
  WORKSPACE_ARTIFACT_EXCLUDED_SEGMENTS,
  WORKSPACE_ARTIFACT_MAX_DEPTH,
  WORKSPACE_ARTIFACT_MAX_FILE_BYTES,
  WORKSPACE_ARTIFACT_SCAN_INTERVAL_MS,
  validateWorkspaceArtifactPath,
  workspaceArtifactContentType,
} from '../../../src/shared/workspace-artifacts.js';
import type {
  SandboxTransferClient,
  SandboxTransferResult,
} from '../control/sandbox-transfer-client.js';

/** The one artifact root, outside every git worktree. */
export const WORKSPACE_ARTIFACT_ROOT = '/artifacts';
/** Persisted outside the root so the synchronizer never publishes its own state. */
export const WORKSPACE_ARTIFACT_STATE_PATH = '/var/lib/kilo/workspace-artifacts.json';

const STATE_VERSION = 1;
const MAX_FILE_BYTES = BigInt(WORKSPACE_ARTIFACT_MAX_FILE_BYTES);
const EXCLUDED_SEGMENTS = new Set<string>(WORKSPACE_ARTIFACT_EXCLUDED_SEGMENTS);
/** Bounds one scan so a folder flooded with entries cannot exhaust the wrapper. */
export const WORKSPACE_ARTIFACT_MAX_SCAN_ENTRIES = 5_000;
const READ_CHUNK_BYTES = 64 * 1024;
const OPEN_ARTIFACT_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const DEFAULT_STOP_BUDGET_MS = 10_000;

export type WorkspaceArtifactDiagnosticSink = (message: string) => void;

export type WorkspaceArtifactSyncTimers = {
  setTimeout: (handler: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimeout: (handle: ReturnType<typeof setTimeout>) => void;
};

export type WorkspaceArtifactSyncOptions = {
  root: string;
  statePath: string;
  allocationId: string;
  client: SandboxTransferClient;
  timers: WorkspaceArtifactSyncTimers;
  log: (message: string) => void;
  onDiagnostic: WorkspaceArtifactDiagnosticSink;
  scanIntervalMs?: number;
  stopBudgetMs?: number;
};

export type WorkspaceArtifactSync = {
  start(): void;
  flush(budgetMs: number): Promise<void>;
  isFlushing(): boolean;
  stop(): Promise<void>;
};

type StateEntry = {
  size: number;
  mtimeNs: string;
  ctimeNs: string;
  inode: string;
  /** Last known content hash, used as the delete fence. */
  hash?: string;
  /** Set only after the current content reached storage. */
  publishedHash?: string;
};

type SyncState = {
  version: typeof STATE_VERSION;
  allocationId: string;
  files: Record<string, StateEntry>;
};

type Signature = { size: number; mtimeNs: string; ctimeNs: string; inode: string };

type ObservedFile = {
  relativePath: string;
  absolutePath: string;
  /** The path the opened descriptor must resolve to; rejects swapped parent directories. */
  canonicalPath: string;
  signature: Signature;
};

type OpenedArtifact = { status: 'opened'; handle: FileHandle } | { status: 'changed' };

type Stability = { signature: Signature; scans: number };

type TransferAction = 'done' | 'retry' | 'backoff' | 'halt' | 'pause';

type ScanKind = 'background' | 'flush';

type ActiveScan = {
  kind: ScanKind;
  controller: AbortController;
  promise: Promise<void>;
};

type Enumeration = {
  files: Map<string, ObservedFile>;
  /** Every name present at a tracked path, including skipped file-like entries. */
  present: Set<string>;
  /** Directories that could not be read; their descendants must not be deleted. */
  unreadableDirectories: Set<string>;
};

function emptyState(allocationId: string): SyncState {
  return { version: STATE_VERSION, allocationId, files: {} };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseState(raw: string): SyncState | undefined {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (
    !isRecord(value) ||
    value.version !== STATE_VERSION ||
    typeof value.allocationId !== 'string' ||
    !isRecord(value.files)
  ) {
    return undefined;
  }
  const files: Record<string, StateEntry> = {};
  for (const [relativePath, entry] of Object.entries(value.files)) {
    if (!isRecord(entry)) return undefined;
    if (
      typeof entry.size !== 'number' ||
      !Number.isSafeInteger(entry.size) ||
      typeof entry.mtimeNs !== 'string' ||
      typeof entry.ctimeNs !== 'string' ||
      typeof entry.inode !== 'string'
    ) {
      return undefined;
    }
    if (entry.hash !== undefined && typeof entry.hash !== 'string') return undefined;
    if (entry.publishedHash !== undefined && typeof entry.publishedHash !== 'string') {
      return undefined;
    }
    files[relativePath] = {
      size: entry.size,
      mtimeNs: entry.mtimeNs,
      ctimeNs: entry.ctimeNs,
      inode: entry.inode,
      ...(entry.hash === undefined ? {} : { hash: entry.hash }),
      ...(entry.publishedHash === undefined ? {} : { publishedHash: entry.publishedHash }),
    };
  }
  return { version: STATE_VERSION, allocationId: value.allocationId, files };
}

function signatureOf(stat: {
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
  ino: bigint;
}): Signature {
  return {
    size: Number(stat.size),
    mtimeNs: stat.mtimeNs.toString(),
    ctimeNs: stat.ctimeNs.toString(),
    inode: stat.ino.toString(),
  };
}

// The plan's baseline rule is size, mtime, or inode; ctime is recorded but not
// part of the publish decision.
function sameSignature(left: Signature, right: Signature): boolean {
  return left.size === right.size && left.mtimeNs === right.mtimeNs && left.inode === right.inode;
}

function isExcludedSegment(segment: string): boolean {
  return segment.startsWith('.') || EXCLUDED_SEGMENTS.has(segment);
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new Error('aborted');
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function inUnreadableDirectory(
  relativePath: string,
  unreadableDirectories: ReadonlySet<string>
): boolean {
  for (const directory of unreadableDirectories) {
    if (relativePath === directory || relativePath.startsWith(`${directory}/`)) return true;
  }
  return false;
}

/**
 * Opens the enumerated file without following a symlink or blocking on a special
 * file, and proves the descriptor is the regular file that was enumerated at its
 * canonical location. The agent can swap entries at any time, so every later read
 * uses this descriptor and never the path.
 */
async function openArtifact(observed: ObservedFile): Promise<OpenedArtifact> {
  let handle: FileHandle;
  try {
    handle = await fsp.open(observed.absolutePath, OPEN_ARTIFACT_FLAGS);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ELOOP') return { status: 'changed' };
    throw error;
  }
  try {
    const stat = await handle.stat({ bigint: true });
    if (!stat.isFile() || !sameSignature(signatureOf(stat), observed.signature)) {
      await handle.close();
      return { status: 'changed' };
    }
    const resolved = await fsp.readlink(`/proc/self/fd/${handle.fd}`);
    if (resolved !== observed.canonicalPath) {
      await handle.close();
      return { status: 'changed' };
    }
    return { status: 'opened', handle };
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

async function* readRange(
  handle: FileHandle,
  size: number,
  signal: AbortSignal
): AsyncGenerator<Uint8Array> {
  let position = 0;
  while (position < size) {
    throwIfAborted(signal);
    const buffer = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, size - position));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
    if (bytesRead === 0) throw new Error('file shrank while reading');
    position += bytesRead;
    yield buffer.subarray(0, bytesRead);
  }
}

async function hashHandle(handle: FileHandle, size: number, signal: AbortSignal): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of readRange(handle, size, signal)) hash.update(chunk);
  return hash.digest('hex');
}

function rangeBody(handle: FileHandle, size: number, signal: AbortSignal): ReadableStream {
  const chunks = readRange(handle, size, signal);
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const next = await chunks.next();
      if (next.done) controller.close();
      else controller.enqueue(next.value);
    },
    async cancel() {
      await chunks.return(undefined);
    },
  });
}

async function writeStateAtomic(statePath: string, state: SyncState): Promise<void> {
  const temporary = `${statePath}.${process.pid}.tmp`;
  await fsp.mkdir(path.dirname(statePath), { recursive: true, mode: 0o700 });
  await fsp.writeFile(temporary, JSON.stringify(state), { mode: 0o600 });
  await fsp.rename(temporary, statePath);
}

function artifactObjectPath(relativePath: string, expectedHash?: string): string {
  const query = new URLSearchParams({ path: relativePath });
  if (expectedHash !== undefined) query.set('hash', expectedHash);
  return `objects?${query.toString()}`;
}

export function createWorkspaceArtifactSync(
  options: WorkspaceArtifactSyncOptions
): WorkspaceArtifactSync {
  const log = options.log;
  const report = options.onDiagnostic;
  const scanIntervalMs = options.scanIntervalMs ?? WORKSPACE_ARTIFACT_SCAN_INTERVAL_MS;

  let state: SyncState = emptyState(options.allocationId);
  let baselinePending = true;
  let started = false;
  let stopped = false;
  let halted = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let activeScan: ActiveScan | undefined;
  let scanQueue: Promise<void> = Promise.resolve();
  let flushPromise: Promise<void> | undefined;
  let flushing = false;
  let persistChain: Promise<void> = Promise.resolve();
  let loaded: Promise<void> | undefined;
  let pausedGrant: string | undefined;
  let lastScanError: string | undefined;
  const stability = new Map<string, Stability>();
  const missingScans = new Map<string, number>();
  const reportedSkips = new Map<string, string>();
  const skippedUntilChange = new Map<string, Signature>();
  const stopController = new AbortController();

  function diagnose(message: string): void {
    report(message);
  }

  function reportSkip(
    relativePath: string,
    reason: string,
    signature?: Signature,
    untilChange = false
  ): void {
    if (untilChange && signature !== undefined) {
      skippedUntilChange.set(relativePath, signature);
    }
    const key = signature
      ? `${reason}:${signature.size}:${signature.mtimeNs}:${signature.inode}`
      : reason;
    if (reportedSkips.get(relativePath) === key) return;
    reportedSkips.set(relativePath, key);
    diagnose(`workspace artifact skipped: ${relativePath} (${reason})`);
  }

  function keepBookkeeping(relativePath: string, enumeration: Enumeration): boolean {
    return (
      enumeration.present.has(relativePath) ||
      enumeration.files.has(relativePath) ||
      inUnreadableDirectory(relativePath, enumeration.unreadableDirectories)
    );
  }

  function pruneBookkeeping(enumeration: Enumeration): void {
    for (const map of [stability, reportedSkips, skippedUntilChange]) {
      for (const relativePath of map.keys()) {
        if (!keepBookkeeping(relativePath, enumeration)) map.delete(relativePath);
      }
    }
  }

  function persist(): Promise<void> {
    const snapshot: SyncState = {
      version: state.version,
      allocationId: state.allocationId,
      files: { ...state.files },
    };
    persistChain = persistChain
      .then(() => writeStateAtomic(options.statePath, snapshot))
      .catch(error => {
        log(`workspace artifact state write failed: ${messageOf(error)}`);
      });
    return persistChain;
  }

  async function loadState(): Promise<void> {
    let raw: string;
    try {
      raw = await fsp.readFile(options.statePath, 'utf8');
    } catch {
      state = emptyState(options.allocationId);
      baselinePending = true;
      log('workspace artifacts starting without prior state; baselining the folder');
      return;
    }
    const parsed = parseState(raw);
    if (parsed === undefined || parsed.allocationId !== options.allocationId) {
      state = emptyState(options.allocationId);
      baselinePending = true;
      log('workspace artifacts starting a new allocation; baselining the folder');
      return;
    }
    state = parsed;
    baselinePending = false;
  }

  function ensureLoaded(): Promise<void> {
    loaded ??= loadState();
    return loaded;
  }

  async function enumerate(signal: AbortSignal): Promise<Enumeration> {
    const rootStat = await fsp.lstat(options.root, { bigint: true });
    if (!rootStat.isDirectory()) {
      throw new Error('artifact root is not a directory');
    }
    const canonicalRoot = await fsp.realpath(options.root);
    const files = new Map<string, ObservedFile>();
    const present = new Set<string>();
    const unreadableDirectories = new Set<string>();
    let seenEntries = 0;

    async function walk(directory: string, prefix: string, depth: number): Promise<void> {
      throwIfAborted(signal);
      const handle = await fsp.opendir(directory).catch(error => {
        if (prefix.length === 0) throw error;
        unreadableDirectories.add(prefix);
        reportSkip(prefix, `unreadable:${messageOf(error)}`);
        return undefined;
      });
      if (handle === undefined) return;
      try {
        for (;;) {
          throwIfAborted(signal);
          const entry = await handle.read().catch(error => {
            if (prefix.length === 0) throw error;
            unreadableDirectories.add(prefix);
            reportSkip(prefix, `unreadable:${messageOf(error)}`);
            return null;
          });
          if (entry === null) break;
          throwIfAborted(signal);
          seenEntries += 1;
          if (seenEntries > WORKSPACE_ARTIFACT_MAX_SCAN_ENTRIES) {
            throw new Error(
              `artifact folder has more than ${WORKSPACE_ARTIFACT_MAX_SCAN_ENTRIES} entries`
            );
          }
          if (isExcludedSegment(entry.name)) continue;
          const relativePath = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
          const absolutePath = path.join(directory, entry.name);
          const validation = validateWorkspaceArtifactPath(relativePath);
          if (!validation.ok) {
            if (validation.reason !== 'excluded_segment') {
              present.add(relativePath);
              reportSkip(relativePath, validation.reason);
            }
            continue;
          }
          const stat = await fsp.lstat(absolutePath, { bigint: true }).catch(error => {
            present.add(relativePath);
            unreadableDirectories.add(relativePath);
            reportSkip(relativePath, `unreadable:${messageOf(error)}`);
            return undefined;
          });
          if (stat === undefined) continue;
          if (stat.isSymbolicLink()) {
            present.add(relativePath);
            reportSkip(relativePath, 'symlink');
            continue;
          }
          if (stat.isDirectory()) {
            if (depth + 1 < WORKSPACE_ARTIFACT_MAX_DEPTH) {
              await walk(absolutePath, relativePath, depth + 1);
            }
            continue;
          }
          if (!stat.isFile()) {
            present.add(relativePath);
            reportSkip(relativePath, 'special_file');
            continue;
          }
          present.add(relativePath);
          if (stat.size > MAX_FILE_BYTES) {
            reportSkip(relativePath, 'file_too_large');
            continue;
          }
          files.set(relativePath, {
            relativePath,
            absolutePath,
            canonicalPath: path.join(canonicalRoot, relativePath),
            signature: signatureOf(stat),
          });
        }
      } finally {
        await handle.close().catch(() => undefined);
      }
    }

    await walk(options.root, '', 0);
    return { files, present, unreadableDirectories };
  }

  function pauseForAuth(relativePath: string): void {
    const grant = options.client.currentGrant()?.grant;
    if (grant === undefined || pausedGrant === grant) return;
    pausedGrant = grant;
    diagnose(`workspace artifact transfer paused after rejection: ${relativePath}`);
  }

  function transferSucceeded(): void {
    pausedGrant = undefined;
  }

  async function openObserved(
    observed: ObservedFile,
    signal: AbortSignal
  ): Promise<FileHandle | undefined> {
    let opened: OpenedArtifact;
    try {
      opened = await openArtifact(observed);
    } catch (error) {
      if (!signal.aborted && !stopped) {
        reportSkip(observed.relativePath, `unreadable:${messageOf(error)}`, observed.signature);
      }
      return undefined;
    }
    if (opened.status === 'changed') {
      log(`workspace artifact changed before reading: ${observed.relativePath}`);
      return undefined;
    }
    return opened.handle;
  }

  async function upload(observed: ObservedFile, signal: AbortSignal): Promise<TransferAction> {
    const handle = await openObserved(observed, signal);
    if (handle === undefined) return 'retry';
    try {
      return await uploadFrom(handle, observed, signal);
    } finally {
      await handle.close().catch(() => undefined);
    }
  }

  async function uploadFrom(
    handle: FileHandle,
    observed: ObservedFile,
    signal: AbortSignal
  ): Promise<TransferAction> {
    const { relativePath, absolutePath, signature } = observed;
    const previous = state.files[relativePath];
    let contentHash: string;
    try {
      contentHash = await hashHandle(handle, signature.size, signal);
    } catch (error) {
      if (signal.aborted || stopped) return 'retry';
      reportSkip(relativePath, `unreadable:${messageOf(error)}`, signature);
      return 'retry';
    }
    throwIfAborted(signal);

    let afterHash: Signature;
    try {
      afterHash = signatureOf(await fsp.lstat(absolutePath, { bigint: true }));
    } catch {
      return 'retry';
    }
    if (!sameSignature(afterHash, signature)) {
      log(`workspace artifact changed while hashing: ${relativePath}`);
      return 'retry';
    }

    const lastKnownHash = previous?.publishedHash ?? previous?.hash;
    if (lastKnownHash !== undefined && lastKnownHash === contentHash) {
      state.files[relativePath] = {
        ...previous,
        ...signature,
        hash: contentHash,
      };
      skippedUntilChange.delete(relativePath);
      reportedSkips.delete(relativePath);
      await persist();
      return 'done';
    }

    let outcome: SandboxTransferResult;
    try {
      outcome = await options.client.put(artifactObjectPath(relativePath), {
        body: () => rangeBody(handle, signature.size, signal),
        contentLength: signature.size,
        contentType: workspaceArtifactContentType(relativePath),
        sha256: contentHash,
        signal,
      });
    } catch (error) {
      if (signal.aborted || stopped) return 'retry';
      log(`workspace artifact upload failed: ${relativePath}: ${messageOf(error)}`);
      return 'retry';
    }
    if (outcome.status === 'unavailable') {
      log(`workspace artifact upload unavailable: ${relativePath}`);
      return 'backoff';
    }
    if (outcome.status === 'rejected') {
      if (outcome.statusCode === 409) {
        halt('stale allocation');
        return 'halt';
      }
      if (outcome.statusCode === 401) {
        pauseForAuth(relativePath);
        return 'pause';
      }
      if (outcome.statusCode === 413) {
        reportSkip(relativePath, 'quota_exceeded', signature, true);
        return 'done';
      }
      if (outcome.statusCode === 400) {
        reportSkip(relativePath, 'invalid_path', signature, true);
        return 'done';
      }
      if (outcome.statusCode === 422) {
        reportSkip(relativePath, 'hash_mismatch', signature);
        return 'retry';
      }
      log(`workspace artifact upload rejected: ${relativePath} status=${outcome.statusCode}`);
      return outcome.statusCode === 429 || outcome.statusCode >= 500 ? 'backoff' : 'retry';
    }

    throwIfAborted(signal);
    let afterUpload: Signature;
    try {
      afterUpload = signatureOf(await fsp.lstat(absolutePath, { bigint: true }));
    } catch {
      return 'retry';
    }
    if (!sameSignature(afterUpload, signature)) {
      log(`workspace artifact changed during upload: ${relativePath}`);
      return 'retry';
    }
    state.files[relativePath] = {
      ...signature,
      hash: contentHash,
      publishedHash: contentHash,
    };
    skippedUntilChange.delete(relativePath);
    reportedSkips.delete(relativePath);
    transferSucceeded();
    await persist();
    log(`workspace artifact published: ${relativePath}`);
    return 'done';
  }

  async function remove(
    relativePath: string,
    expectedHash: string,
    signal: AbortSignal
  ): Promise<TransferAction> {
    let outcome: SandboxTransferResult;
    try {
      outcome = await options.client.delete(artifactObjectPath(relativePath, expectedHash), {
        signal,
      });
    } catch (error) {
      if (signal.aborted || stopped) return 'retry';
      log(`workspace artifact delete failed: ${relativePath}: ${messageOf(error)}`);
      return 'retry';
    }
    if (outcome.status === 'unavailable') return 'backoff';
    if (outcome.status === 'rejected') {
      if (outcome.statusCode === 409) {
        halt('stale allocation');
        return 'halt';
      }
      if (outcome.statusCode === 401) {
        pauseForAuth(relativePath);
        return 'pause';
      }
      log(`workspace artifact delete rejected: ${relativePath} status=${outcome.statusCode}`);
      return outcome.statusCode === 429 || outcome.statusCode >= 500 ? 'backoff' : 'retry';
    }
    delete state.files[relativePath];
    missingScans.delete(relativePath);
    skippedUntilChange.delete(relativePath);
    reportedSkips.delete(relativePath);
    transferSucceeded();
    await persist();
    log(`workspace artifact removed: ${relativePath}`);
    return 'done';
  }

  function halt(reason: string): void {
    if (halted) return;
    halted = true;
    log(`workspace artifact synchronizer stopped: ${reason}`);
    diagnose(`workspace artifact synchronizer stopped: ${reason}`);
    clearScanTimer();
  }

  function clearScanTimer(): void {
    if (timer === undefined) return;
    options.timers.clearTimeout(timer);
    timer = undefined;
  }

  async function baseline(observed: Map<string, ObservedFile>, signal: AbortSignal): Promise<void> {
    for (const file of observed.values()) {
      throwIfAborted(signal);
      const handle = await openObserved(file, signal);
      if (handle === undefined) {
        if (signal.aborted || stopped) return;
        continue;
      }
      let contentHash: string;
      try {
        contentHash = await hashHandle(handle, file.signature.size, signal);
      } catch (error) {
        if (signal.aborted || stopped) return;
        reportSkip(file.relativePath, `unreadable:${messageOf(error)}`, file.signature);
        continue;
      } finally {
        await handle.close().catch(() => undefined);
      }
      throwIfAborted(signal);
      let afterHash: Signature;
      try {
        afterHash = signatureOf(await fsp.lstat(file.absolutePath, { bigint: true }));
      } catch {
        continue;
      }
      if (!sameSignature(afterHash, file.signature)) {
        log(`workspace artifact changed while baselining: ${file.relativePath}`);
        continue;
      }
      state.files[file.relativePath] = { ...file.signature, hash: contentHash };
    }
    baselinePending = false;
    await persist();
    log(`workspace artifacts baselined: ${Object.keys(state.files).length}`);
  }

  async function runScan(kind: ScanKind, signal: AbortSignal): Promise<void> {
    if (pausedGrant !== undefined) {
      if (options.client.currentGrant()?.grant === pausedGrant) return;
      pausedGrant = undefined;
    }

    let enumeration: Enumeration;
    try {
      enumeration = await enumerate(signal);
    } catch (error) {
      if (signal.aborted || stopped) return;
      stability.clear();
      missingScans.clear();
      const message = messageOf(error);
      if (lastScanError !== message) {
        lastScanError = message;
        diagnose(`workspace artifact scan failed: ${message}`);
      }
      return;
    }
    lastScanError = undefined;
    pruneBookkeeping(enumeration);

    if (baselinePending) {
      await baseline(enumeration.files, signal);
      return;
    }

    for (const file of enumeration.files.values()) {
      throwIfAborted(signal);
      const previous = state.files[file.relativePath];
      const skipped = skippedUntilChange.get(file.relativePath);
      if (skipped !== undefined) {
        if (sameSignature(skipped, file.signature)) continue;
        skippedUntilChange.delete(file.relativePath);
        reportedSkips.delete(file.relativePath);
      }

      if (previous !== undefined && sameSignature(previous, file.signature)) {
        stability.delete(file.relativePath);
        if (previous.hash !== undefined) continue;
      }

      const previousStability = stability.get(file.relativePath);
      const scans =
        previousStability !== undefined &&
        sameSignature(previousStability.signature, file.signature)
          ? previousStability.scans + 1
          : 1;
      stability.set(file.relativePath, { signature: file.signature, scans });
      if (scans < (kind === 'flush' ? 1 : 2)) continue;
      stability.delete(file.relativePath);

      const result = await upload(file, signal);
      if (result === 'halt') return;
      if (result === 'pause') return;
      if (result === 'backoff') return;
      if (result === 'retry' && signal.aborted) return;
    }

    const deletions: Array<{ relativePath: string; expectedHash: string }> = [];
    for (const [relativePath, entry] of Object.entries(state.files)) {
      if (
        enumeration.present.has(relativePath) ||
        inUnreadableDirectory(relativePath, enumeration.unreadableDirectories)
      ) {
        missingScans.delete(relativePath);
        continue;
      }
      if (entry.hash === undefined) continue;
      const validation = validateWorkspaceArtifactPath(relativePath);
      if (!validation.ok && validation.reason === 'excluded_segment') continue;
      const count = (missingScans.get(relativePath) ?? 0) + 1;
      missingScans.set(relativePath, count);
      if (count < 2) continue;
      deletions.push({ relativePath, expectedHash: entry.hash });
    }

    for (const deletion of deletions) {
      throwIfAborted(signal);
      const result = await remove(deletion.relativePath, deletion.expectedHash, signal);
      if (result === 'halt' || result === 'pause' || result === 'backoff') return;
      if (result === 'retry' && signal.aborted) return;
    }
  }

  async function runExclusive(kind: ScanKind, signal: AbortSignal): Promise<void> {
    if (kind === 'flush' && activeScan?.kind === 'background') {
      activeScan.controller.abort(new Error('superseded by flush'));
    }
    const previous = scanQueue;
    const next = previous.then(async () => {
      if (stopped || halted || signal.aborted) return;
      const controller = new AbortController();
      const abort = (reason: unknown): void => controller.abort(reason);
      if (signal.aborted) abort(signal.reason);
      const onAbort = (): void => abort(signal.reason);
      signal.addEventListener('abort', onAbort, { once: true });
      const onStop = (): void => abort(stopController.signal.reason);
      if (stopController.signal.aborted) onStop();
      stopController.signal.addEventListener('abort', onStop, { once: true });
      const scan: ActiveScan = {
        kind,
        controller,
        promise: Promise.resolve(),
      };
      scan.promise = runScan(kind, controller.signal)
        .catch(error => {
          if (!controller.signal.aborted) {
            diagnose(`workspace artifact scan failed: ${messageOf(error)}`);
          }
        })
        .finally(() => {
          signal.removeEventListener('abort', onAbort);
          stopController.signal.removeEventListener('abort', onStop);
          if (activeScan === scan) activeScan = undefined;
        });
      activeScan = scan;
      await scan.promise;
    });
    scanQueue = next.catch(() => undefined);
    return next;
  }

  function schedule(): void {
    if (stopped || halted || timer !== undefined) return;
    timer = options.timers.setTimeout(() => {
      timer = undefined;
      void runBackgroundScan();
    }, scanIntervalMs);
  }

  async function runBackgroundScan(): Promise<void> {
    if (stopped || halted) return;
    try {
      await runExclusive('background', stopController.signal);
    } finally {
      if (!stopped && !halted) schedule();
    }
  }

  function start(): void {
    if (started || stopped || halted) return;
    started = true;
    void (async () => {
      await ensureLoaded();
      if (stopped || halted) return;
      await runBackgroundScan();
    })();
  }

  function flush(budgetMs: number): Promise<void> {
    if (stopped || halted) return Promise.resolve();
    if (flushPromise !== undefined) return flushPromise;
    const controller = new AbortController();
    const deadline = options.timers.setTimeout(
      () => controller.abort(new Error('workspace artifact flush budget expired')),
      Math.max(1, budgetMs)
    );
    flushing = true;
    flushPromise = ensureLoaded()
      .then(() => runExclusive('flush', controller.signal))
      .catch(error => {
        if (!controller.signal.aborted) {
          log(`workspace artifact flush failed: ${messageOf(error)}`);
        }
      })
      .finally(() => {
        options.timers.clearTimeout(deadline);
        flushing = false;
        flushPromise = undefined;
      });
    return flushPromise;
  }

  async function stop(): Promise<void> {
    stopped = true;
    clearScanTimer();
    stopController.abort(new Error('workspace artifact synchronizer stopped'));
    const settled = (async () => {
      await activeScan?.promise.catch(() => undefined);
      await scanQueue.catch(() => undefined);
      await flushPromise?.catch(() => undefined);
      await persistChain.catch(() => undefined);
    })();
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<'expired'>(resolve => {
      deadline = options.timers.setTimeout(
        () => resolve('expired'),
        options.stopBudgetMs ?? DEFAULT_STOP_BUDGET_MS
      );
    });
    try {
      if ((await Promise.race([settled, expired])) === 'expired') {
        log('workspace artifact synchronizer stop budget expired; abandoning pending work');
      }
    } finally {
      if (deadline !== undefined) options.timers.clearTimeout(deadline);
    }
  }

  return {
    start,
    flush,
    isFlushing: () => flushing,
    stop,
  };
}
