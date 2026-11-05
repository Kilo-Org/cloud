import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  createReadStream,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { mkdtemp, open, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { WORKTREE_SNAPSHOT_RESTORE_MS } from '../../../src/shared/control-plane-timers.js';
import {
  WORKTREE_SNAPSHOT_CAPTURE_MS,
  WORKTREE_SNAPSHOT_MAX_BYTES,
} from '../../../src/shared/worktree-snapshot.js';
import {
  applyWorktreeSnapshot,
  captureWorktreeSnapshot,
  InvalidWorktreeSnapshotError,
} from '../control/worktree-snapshot.js';

const DEBOUNCE_MS = 1_000;
const MAX_WAIT_MS = 15_000;
const RETRY_MS = 30_000;
const UPLOAD_TIMEOUT_MS = 60_000;
const RENEW_TIMEOUT_MS = 60_000;
const MAX_CONCURRENT_CAPTURES = 2;
const DOWNLOAD_ATTEMPTS = 3;
const DOWNLOAD_RETRY_DELAYS_MS = [250, 500];
const RENEW_RETRY_MS = 30_000;
const CACHE_VERSION = 1;

export type WorktreeSnapshotClock = {
  now: () => number;
  setTimeout: (handler: () => void, delayMs: number) => unknown;
  clearTimeout: (handle: unknown) => void;
};

export type WorktreeSnapshotCaptureInput = {
  directory: string;
  worktreeId: string;
  signal: AbortSignal;
};

export type CapturedWorktreeSnapshot = {
  archivePath: string;
  contentDigest: string;
  size: number;
  manifest: unknown;
  cleanup: () => Promise<void>;
};

export type WorktreeSnapshotApplyInput = {
  directory: string;
  worktreeId: string;
  archivePath: string;
  signal: AbortSignal;
};

export type AppliedWorktreeSnapshot = {
  applied: number;
  omitted: number;
  conflicts: string[];
  partial: boolean;
};

export type WorktreeSnapshotRestoreResult = {
  found: boolean;
  invalid?: boolean;
  applied?: number;
  omitted?: number;
  conflicts?: string[];
  partial?: boolean;
};

export type WorktreeSnapshotFetch = (
  url: string,
  init: RequestInit & { duplex?: 'half' }
) => Promise<Response>;

export type WorktreeSnapshots = {
  register: (input: { directory: string; worktreeId: string }) => void;
  unregister: (directory: string) => void;
  requestCapture: (directory: string) => void;
  restore: (input: {
    directory: string;
    worktreeId: string;
    signal: AbortSignal;
  }) => Promise<WorktreeSnapshotRestoreResult>;
  close: () => void;
};

export type WorktreeSnapshotsOptions = {
  url?: string;
  grant?: string;
  log?: (message: string) => void;
  cachePath?: string | null;
  capture?: (input: WorktreeSnapshotCaptureInput) => Promise<CapturedWorktreeSnapshot | null>;
  apply?: (input: WorktreeSnapshotApplyInput) => Promise<AppliedWorktreeSnapshot>;
  fetch?: WorktreeSnapshotFetch;
  clock?: WorktreeSnapshotClock;
};

export class WorktreeSnapshotDownloadError extends Error {
  constructor(
    readonly status?: number,
    options?: { cause?: unknown }
  ) {
    super(
      status === undefined
        ? 'worktree snapshot download failed'
        : `worktree snapshot download failed with status ${status}`,
      options
    );
    this.name = 'WorktreeSnapshotDownloadError';
  }
}

export class WorktreeSnapshotRestoreError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'WorktreeSnapshotRestoreError';
  }
}

class WorktreeSnapshotTimeoutError extends Error {
  constructor() {
    super('worktree snapshot operation timed out');
    this.name = 'WorktreeSnapshotTimeoutError';
  }
}

class SnapshotUploadError extends Error {
  constructor(readonly status: number) {
    super(`snapshot upload rejected with status ${status}`);
    this.name = 'SnapshotUploadError';
  }
}

type TimerHandle = unknown;

type WorktreeState = {
  directory: string;
  worktreeId: string;
  lifecycle: AbortController;
  inFlight: boolean;
  trailing: boolean;
  due: boolean;
  queued: boolean;
  removed: boolean;
  uploadBlocked?: 'grant' | 'worktree';
  debounce?: TimerHandle;
  maxWait?: TimerHandle;
  retry?: TimerHandle;
  lastAcceptedContentDigest?: string;
};

type DownloadOutcome =
  | { kind: 'found'; archivePath: string; digest: string }
  | { kind: 'missing' }
  | { kind: 'invalid' }
  | { kind: 'mismatch' }
  | { kind: 'transient'; status?: number; error?: unknown }
  | { kind: 'persistent'; status?: number; error?: unknown };

type SettledDownloadOutcome = Extract<
  DownloadOutcome,
  { kind: 'found' } | { kind: 'missing' } | { kind: 'invalid' }
>;

const defaultClock: WorktreeSnapshotClock = {
  now: () => Date.now(),
  setTimeout: (handler, delayMs) => setTimeout(handler, delayMs),
  clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'unknown';
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason ?? new Error('aborted');
}

function normalizeSha256(value: string): string | undefined {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/^sha256:/, '')
    .replace(/^"|"$/g, '');
  return /^[0-9a-f]{64}$/.test(normalized) ? normalized : undefined;
}

function jwtPayload(token: string): Record<string, unknown> | undefined {
  const payload = token.split('.')[1];
  if (!payload) return undefined;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function jwtTimes(token: string): { iat?: number; exp?: number } | undefined {
  const parsed = jwtPayload(token);
  if (parsed === undefined) return undefined;
  return {
    ...(typeof parsed.iat === 'number' && Number.isFinite(parsed.iat) ? { iat: parsed.iat } : {}),
    ...(typeof parsed.exp === 'number' && Number.isFinite(parsed.exp) ? { exp: parsed.exp } : {}),
  };
}

type GrantIdentity = {
  sandboxId: string;
  allocationId: string;
  wrapperInstanceId: string;
};

function jwtIdentity(token: string): GrantIdentity | undefined {
  const parsed = jwtPayload(token);
  if (parsed === undefined || !isRecord(parsed.identity)) return undefined;
  const { sandboxId, allocationId, wrapperInstanceId } = parsed.identity;
  if (
    typeof sandboxId !== 'string' ||
    typeof allocationId !== 'string' ||
    typeof wrapperInstanceId !== 'string'
  )
    return undefined;
  return { sandboxId, allocationId, wrapperInstanceId };
}

function urlIdentity(baseUrl: string): GrantIdentity | undefined {
  try {
    const segments = new URL(baseUrl).pathname.split('/').filter(Boolean);
    if (segments.length < 3) return undefined;
    const [sandboxId, allocationId, wrapperInstanceId] = segments.slice(-3);
    if (sandboxId === undefined || allocationId === undefined || wrapperInstanceId === undefined)
      return undefined;
    return { sandboxId, allocationId, wrapperInstanceId };
  } catch {
    return undefined;
  }
}

function sameIdentity(left: GrantIdentity, right: GrantIdentity): boolean {
  return (
    left.sandboxId === right.sandboxId &&
    left.allocationId === right.allocationId &&
    left.wrapperInstanceId === right.wrapperInstanceId
  );
}

function defaultGrantCachePath(): string {
  try {
    return join(homedir(), '.kilo-control', 'worktree-snapshot', 'grant.json');
  } catch {
    return join('/home', '.kilo-control', 'worktree-snapshot', 'grant.json');
  }
}

function isInvalidWorktreeSnapshotError(error: unknown): boolean {
  return (
    error instanceof InvalidWorktreeSnapshotError ||
    (error instanceof Error && error.name === 'InvalidWorktreeSnapshotError')
  );
}

function fileStream(archivePath: string): ReadableStream<Uint8Array> {
  const iterator = createReadStream(archivePath)[Symbol.asyncIterator]();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const next = await iterator.next();
      if (next.done) {
        controller.close();
        return;
      }
      controller.enqueue(Buffer.isBuffer(next.value) ? next.value : Buffer.from(next.value));
    },
    async cancel() {
      await iterator.return?.();
    },
  });
}

async function runWithTimeout<T>(input: {
  clock: WorktreeSnapshotClock;
  parent: AbortSignal;
  timeoutMs: number;
  start: (signal: AbortSignal) => Promise<T>;
}): Promise<T> {
  throwIfAborted(input.parent);
  const controller = new AbortController();
  let rejectParent: ((reason: unknown) => void) | undefined;
  const parentAborted = new Promise<never>((_, reject) => {
    rejectParent = reason => reject(reason);
  });
  const forwardAbort = () => {
    const reason: unknown = input.parent.reason ?? new Error('aborted');
    controller.abort(reason);
    rejectParent?.(reason);
  };
  input.parent.addEventListener('abort', forwardAbort, { once: true });

  let timer: TimerHandle = undefined;
  const timedOut = new Promise<never>((_, reject) => {
    timer = input.clock.setTimeout(() => {
      const error = new WorktreeSnapshotTimeoutError();
      controller.abort(error);
      reject(error);
    }, input.timeoutMs);
  });

  try {
    return await Promise.race([input.start(controller.signal), timedOut, parentAborted]);
  } finally {
    input.clock.clearTimeout(timer);
    input.parent.removeEventListener('abort', forwardAbort);
  }
}

function sleep(clock: WorktreeSnapshotClock, delayMs: number, signal: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const timer = clock.setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, delayMs);
    function onAbort(): void {
      clock.clearTimeout(timer);
      reject(signal.reason ?? new Error('aborted'));
    }
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export function createWorktreeSnapshots(options: WorktreeSnapshotsOptions = {}): WorktreeSnapshots {
  const clock = options.clock ?? defaultClock;
  const fetchImpl: WorktreeSnapshotFetch =
    options.fetch ?? ((url, init) => globalThis.fetch(url, init));
  const capture = options.capture ?? captureWorktreeSnapshot;
  const apply = options.apply ?? applyWorktreeSnapshot;
  const log = options.log ?? (() => undefined);
  const baseUrl = options.url?.trim().replace(/\/+$/, '') || undefined;
  const launchGrant = options.grant?.trim() || undefined;
  const cachePath = options.cachePath === undefined ? defaultGrantCachePath() : options.cachePath;
  const ownsCacheDirectory = options.cachePath === undefined;

  const launchFingerprint =
    launchGrant === undefined ? undefined : createHash('sha256').update(launchGrant).digest('hex');
  const launchIdentity = launchGrant === undefined ? undefined : jwtIdentity(launchGrant);
  const grantUrlIdentity = baseUrl === undefined ? undefined : urlIdentity(baseUrl);
  const configured = baseUrl !== undefined && launchGrant !== undefined;
  let grant = launchGrant;

  const states = new Map<string, WorktreeState>();
  const startQueue: WorktreeState[] = [];
  let globalActive = 0;
  let closed = false;
  let renewalTimer: TimerHandle = undefined;
  let renewalAbort: AbortController | undefined;
  let renewing = false;
  let renewalStopped = false;

  function snapshotUrl(worktreeId: string): string | undefined {
    if (baseUrl === undefined) return undefined;
    return `${baseUrl}/${encodeURIComponent(worktreeId)}`;
  }

  function loadCachedGrant(): string | undefined {
    if (cachePath === null || baseUrl === undefined || launchFingerprint === undefined)
      return undefined;
    try {
      const raw: unknown = JSON.parse(readFileSync(cachePath, 'utf8'));
      if (
        !isRecord(raw) ||
        raw.version !== CACHE_VERSION ||
        raw.url !== baseUrl ||
        raw.launch !== launchFingerprint
      )
        return undefined;
      if (typeof raw.grant !== 'string' || raw.grant.length === 0 || raw.grant.length > 4096)
        return undefined;
      const times = jwtTimes(raw.grant);
      if (times?.exp === undefined || times.exp * 1000 <= clock.now()) return undefined;
      const cachedIdentity = jwtIdentity(raw.grant);
      if (
        launchIdentity !== undefined &&
        (cachedIdentity === undefined || !sameIdentity(cachedIdentity, launchIdentity))
      )
        return undefined;
      if (
        cachedIdentity !== undefined &&
        grantUrlIdentity !== undefined &&
        !sameIdentity(cachedIdentity, grantUrlIdentity)
      )
        return undefined;
      return raw.grant;
    } catch {
      return undefined;
    }
  }

  function saveCachedGrant(nextGrant: string): void {
    if (cachePath === null || baseUrl === undefined || launchFingerprint === undefined) return;
    const target = resolve(cachePath);
    let temporary: string | undefined;
    try {
      const directory = dirname(target);
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      if (ownsCacheDirectory) {
        try {
          chmodSync(directory, 0o700);
        } catch {
          // The file mode still protects the token when the directory is not ours.
        }
      }
      temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
      writeFileSync(
        temporary,
        JSON.stringify({
          version: CACHE_VERSION,
          url: baseUrl,
          launch: launchFingerprint,
          grant: nextGrant,
        }),
        { encoding: 'utf8', mode: 0o600, flag: 'wx' }
      );
      renameSync(temporary, target);
      temporary = undefined;
      try {
        chmodSync(target, 0o600);
      } catch {
        // Write mode already requested 0600; chmod is defense in depth.
      }
    } catch {
      if (temporary !== undefined) {
        try {
          rmSync(temporary, { force: true });
        } catch {
          // Best effort; the temporary name is unguessable and contains no grant.
        }
      }
      log('worktree snapshot credential cache write failed');
    }
  }

  const cachedGrant = configured ? loadCachedGrant() : undefined;
  if (cachedGrant !== undefined) {
    grant = cachedGrant;
    log('worktree snapshot credential cache loaded');
  }

  function clearTimer(handle: TimerHandle): undefined {
    if (handle !== undefined) clock.clearTimeout(handle);
    return undefined;
  }

  function clearTimers(state: WorktreeState): void {
    state.debounce = clearTimer(state.debounce);
    state.maxWait = clearTimer(state.maxWait);
    state.retry = clearTimer(state.retry);
  }

  function clearRenewal(): void {
    renewalTimer = clearTimer(renewalTimer);
    renewalAbort?.abort();
    renewalAbort = undefined;
  }

  function enqueue(state: WorktreeState): void {
    if (closed || state.removed || state.inFlight || state.queued) return;
    state.due = true;
    state.queued = true;
    startQueue.push(state);
    pump();
  }

  function pump(): void {
    while (!closed && globalActive < MAX_CONCURRENT_CAPTURES && startQueue.length > 0) {
      const state = startQueue.shift();
      if (state === undefined) return;
      state.queued = false;
      if (state.removed || state.inFlight || !state.due) continue;
      state.due = false;
      startCapture(state);
    }
  }

  function startCapture(state: WorktreeState): void {
    globalActive += 1;
    state.inFlight = true;
    state.trailing = false;
    clearTimers(state);
    void runCapture(state);
  }

  async function hashFile(
    archivePath: string,
    signal: AbortSignal
  ): Promise<{ digest: string; size: number }> {
    const hash = createHash('sha256');
    let size = 0;
    for await (const chunk of createReadStream(archivePath)) {
      throwIfAborted(signal);
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.byteLength;
      hash.update(bytes);
    }
    return { digest: hash.digest('hex'), size };
  }

  async function upload(
    worktreeId: string,
    archivePath: string,
    size: number,
    signal: AbortSignal
  ): Promise<{ digest: string; size: number }> {
    const url = snapshotUrl(worktreeId);
    if (url === undefined || grant === undefined) throw new Error('snapshot transport unset');
    const archive = await hashFile(archivePath, signal);
    if (archive.size !== size) throw new Error('capture archive size changed');
    const body = fileStream(archivePath);
    const response = await fetchImpl(url, {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${grant}`,
        'content-length': String(archive.size),
        'x-kilo-sha256': archive.digest,
      },
      body,
      duplex: 'half',
      signal,
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new SnapshotUploadError(response.status);
    }
    return archive;
  }

  type CapturePhaseResult = {
    captured: CapturedWorktreeSnapshot | null;
    failure?: 'timeout' | 'aborted';
    error?: unknown;
  };

  async function runCapturePhase(state: WorktreeState): Promise<CapturePhaseResult> {
    if (state.lifecycle.signal.aborted) {
      return { captured: null, failure: 'aborted', error: state.lifecycle.signal.reason };
    }

    const abort = new AbortController();
    let parentAborted = false;
    let timedOut = false;
    let resolveParent: (() => void) | undefined;
    const parentSignal = new Promise<void>(resolve => {
      resolveParent = resolve;
    });
    const forwardParent = () => {
      parentAborted = true;
      abort.abort(state.lifecycle.signal.reason);
      resolveParent?.();
    };
    state.lifecycle.signal.addEventListener('abort', forwardParent, { once: true });

    let timer: TimerHandle = undefined;
    const deadline = new Promise<'timeout'>(resolve => {
      timer = clock.setTimeout(() => {
        timedOut = true;
        abort.abort(new WorktreeSnapshotTimeoutError());
        resolve('timeout');
      }, WORKTREE_SNAPSHOT_CAPTURE_MS);
    });

    let operation: Promise<CapturedWorktreeSnapshot | null>;
    try {
      operation = capture({
        directory: state.directory,
        worktreeId: state.worktreeId,
        signal: abort.signal,
      });
    } catch (error) {
      operation = Promise.reject(error);
    }
    const settled = operation.then(
      value => ({ kind: 'value' as const, value }),
      (error: unknown) => ({ kind: 'error' as const, error })
    );

    const first = await Promise.race([
      settled,
      deadline.then(() => ({ kind: 'timeout' as const })),
      parentSignal.then(() => ({ kind: 'aborted' as const })),
    ]);

    clock.clearTimeout(timer);
    state.lifecycle.signal.removeEventListener('abort', forwardParent);

    if (!timedOut && !parentAborted) {
      if (first.kind === 'value') return { captured: first.value };
      if (first.kind === 'error') return { captured: null, error: first.error };
    }

    const final = await settled;
    return {
      captured: final.kind === 'value' ? final.value : null,
      failure: parentAborted ? 'aborted' : 'timeout',
      error: final.kind === 'error' ? final.error : undefined,
    };
  }

  async function runCapture(state: WorktreeState): Promise<void> {
    let captured: CapturedWorktreeSnapshot | null = null;
    let failed = false;
    let phase = 'capture';
    let uploadAuthorization: 401 | 403 | undefined;

    try {
      const captureResult = await runCapturePhase(state);
      captured = captureResult.captured;
      if (captureResult.failure !== undefined || captureResult.error !== undefined) {
        failed = true;
        phase =
          captureResult.failure === 'timeout' ||
          captureResult.error instanceof WorktreeSnapshotTimeoutError
            ? 'capture_timeout'
            : captureResult.failure === 'aborted'
              ? 'capture_aborted'
              : 'capture';
        log(
          `worktree snapshot failed worktree=${state.worktreeId} phase=${phase} reason=${errorName(captureResult.error)}`
        );
      } else if (captured === null) {
        log(`worktree snapshot capture skipped worktree=${state.worktreeId}`);
      } else {
        const snapshot = captured;
        const contentDigest = normalizeSha256(snapshot.contentDigest);
        if (contentDigest === undefined) throw new Error('capture returned an invalid digest');
        if (!Number.isSafeInteger(snapshot.size) || snapshot.size < 0)
          throw new Error('capture returned an invalid size');
        if (snapshot.size > WORKTREE_SNAPSHOT_MAX_BYTES)
          throw new Error('capture exceeded the upload cap');

        if (contentDigest === state.lastAcceptedContentDigest) {
          log(
            `worktree snapshot upload skipped worktree=${state.worktreeId} contentDigest=${contentDigest}`
          );
        } else {
          phase = 'upload';
          const uploaded = await runWithTimeout({
            clock,
            parent: state.lifecycle.signal,
            timeoutMs: UPLOAD_TIMEOUT_MS,
            start: signal => upload(state.worktreeId, snapshot.archivePath, snapshot.size, signal),
          });
          state.lastAcceptedContentDigest = contentDigest;
          log(
            `worktree snapshot upload worktree=${state.worktreeId} size=${uploaded.size} contentDigest=${contentDigest} digest=${uploaded.digest} sha256=${uploaded.digest}`
          );
        }
      }
    } catch (error) {
      failed = true;
      phase = error instanceof WorktreeSnapshotTimeoutError ? `${phase}_timeout` : phase;
      if (error instanceof SnapshotUploadError) {
        if (error.status === 401 || error.status === 403) {
          uploadAuthorization = error.status;
          state.uploadBlocked = error.status === 401 ? 'grant' : 'worktree';
          if (error.status === 401) void renewGrant();
        }
      }
      log(
        `worktree snapshot failed worktree=${state.worktreeId} phase=${phase} reason=${errorName(error)}`
      );
    } finally {
      if (captured !== null) await captured.cleanup().catch(() => undefined);
      globalActive -= 1;
      state.inFlight = false;

      if (!closed && !state.removed) {
        if (failed) {
          state.trailing = false;
          clearTimers(state);
          if (uploadAuthorization === undefined) {
            state.retry = clock.setTimeout(() => {
              state.retry = undefined;
              if (!closed && !state.removed && state.uploadBlocked === undefined) {
                state.due = true;
                enqueue(state);
              }
            }, RETRY_MS);
          } else if (state.uploadBlocked === undefined) {
            requestCapture(state.directory);
          }
        } else if (state.trailing) {
          state.trailing = false;
          state.due = true;
          enqueue(state);
        }
      }

      pump();
    }
  }

  function trigger(state: WorktreeState): void {
    if (closed || state.removed) return;
    state.debounce = clearTimer(state.debounce);
    state.maxWait = clearTimer(state.maxWait);
    if (state.inFlight) {
      state.trailing = true;
      return;
    }
    enqueue(state);
  }

  function scheduleSignalTimers(state: WorktreeState): void {
    if (state.maxWait === undefined) {
      state.maxWait = clock.setTimeout(() => {
        state.maxWait = undefined;
        trigger(state);
      }, MAX_WAIT_MS);
    }
    state.debounce = clearTimer(state.debounce);
    state.debounce = clock.setTimeout(() => {
      state.debounce = undefined;
      trigger(state);
    }, DEBOUNCE_MS);
  }

  function requestCapture(directory: string): void {
    if (closed || !configured) return;
    const state = states.get(directory);
    if (state === undefined || state.removed || state.uploadBlocked !== undefined) return;
    state.retry = clearTimer(state.retry);
    if (state.inFlight) {
      scheduleSignalTimers(state);
      return;
    }
    if (state.due || state.queued) return;
    scheduleSignalTimers(state);
  }

  function register(input: { directory: string; worktreeId: string }): void {
    if (closed) return;
    const existing = states.get(input.directory);
    if (existing !== undefined && existing.worktreeId !== input.worktreeId) {
      unregister(input.directory);
    }
    const current = states.get(input.directory);
    if (current !== undefined) {
      current.uploadBlocked = undefined;
    } else {
      states.set(input.directory, {
        directory: input.directory,
        worktreeId: input.worktreeId,
        lifecycle: new AbortController(),
        inFlight: false,
        trailing: false,
        due: false,
        queued: false,
        removed: false,
      });
    }
    ensureRenewalScheduled();
  }

  function unregister(directory: string): void {
    const state = states.get(directory);
    if (state === undefined) return;
    states.delete(directory);
    state.removed = true;
    clearTimers(state);
    state.lifecycle.abort();
    state.due = false;
    state.queued = false;
    const index = startQueue.indexOf(state);
    if (index >= 0) startQueue.splice(index, 1);
    if (states.size === 0) clearRenewal();
  }

  function renewalDelay(now: number): number | undefined {
    if (grant === undefined) return undefined;
    const times = jwtTimes(grant);
    if (times?.exp === undefined) return undefined;
    const expires = times.exp * 1000;
    if (expires <= now) return undefined;
    const issued = times.iat === undefined ? now : times.iat * 1000;
    const halfLife = issued + (expires - issued) / 2;
    return Math.max(0, halfLife - now);
  }

  function scheduleRenewal(delayMs?: number): void {
    if (closed || !configured || renewalStopped || renewalTimer !== undefined || states.size === 0)
      return;
    const delay = delayMs ?? renewalDelay(clock.now());
    if (delay === undefined) return;
    renewalTimer = clock.setTimeout(() => {
      renewalTimer = undefined;
      void renewGrant();
    }, delay);
  }

  function ensureRenewalScheduled(): void {
    if (renewalTimer === undefined && !renewing) scheduleRenewal();
  }

  function resumeGrantBlockedCaptures(): void {
    for (const state of states.values()) {
      if (state.uploadBlocked !== 'grant') continue;
      state.uploadBlocked = undefined;
      requestCapture(state.directory);
    }
  }

  async function renewGrant(): Promise<void> {
    if (closed || !configured || renewalStopped || renewing || grant === undefined) return;
    const worktreeIds = [...new Set([...states.values()].map(state => state.worktreeId))];
    if (worktreeIds.length === 0) return;
    const times = jwtTimes(grant);
    if (times?.exp !== undefined && times.exp * 1000 <= clock.now()) {
      renewalStopped = true;
      log('worktree snapshot grant expired; captures resume after the wrapper relaunches');
      return;
    }

    renewing = true;
    renewalTimer = clearTimer(renewalTimer);
    const abort = new AbortController();
    renewalAbort = abort;
    let status: number | undefined;
    let renewed = false;
    let authFailure = false;
    let timedOut = false;
    const renewDeadline = clock.now() + RENEW_TIMEOUT_MS;
    try {
      for (const worktreeId of worktreeIds) {
        if (closed || abort.signal.aborted) break;
        const remaining = renewDeadline - clock.now();
        if (remaining <= 0) {
          timedOut = true;
          break;
        }
        const url = snapshotUrl(worktreeId);
        if (url === undefined) continue;
        let outcome: { status: number; body?: unknown };
        try {
          outcome = await runWithTimeout({
            clock,
            parent: abort.signal,
            timeoutMs: remaining,
            start: async signal => {
              const response = await fetchImpl(`${url}/renew`, {
                method: 'POST',
                headers: { authorization: `Bearer ${grant}` },
                signal,
              });
              if (!response.ok) {
                await response.body?.cancel().catch(() => undefined);
                return { status: response.status };
              }
              const body: unknown = await response.json().catch(() => undefined);
              return {
                status: response.status,
                body,
              };
            },
          });
        } catch (error) {
          if (error instanceof WorktreeSnapshotTimeoutError) timedOut = true;
          status = undefined;
          break;
        }
        status = outcome.status;
        if (status >= 200 && status < 300) {
          if (
            isRecord(outcome.body) &&
            typeof outcome.body.grant === 'string' &&
            outcome.body.grant.length > 0
          ) {
            grant = outcome.body.grant;
            renewed = true;
            saveCachedGrant(grant);
            log('worktree snapshot grant renewed');
            break;
          }
          break;
        }
        if (status === 401) {
          authFailure = true;
          break;
        }
        if (status !== 403) break;
      }
    } finally {
      renewing = false;
      if (renewalAbort === abort) renewalAbort = undefined;
    }

    if (closed || states.size === 0) return;
    if (abort.signal.aborted) {
      ensureRenewalScheduled();
      return;
    }
    if (renewed) {
      resumeGrantBlockedCaptures();
      const delay = renewalDelay(clock.now());
      scheduleRenewal(delay === undefined ? undefined : Math.max(delay, RENEW_RETRY_MS));
      return;
    }
    if (authFailure) {
      renewalStopped = true;
      log('worktree snapshot grant renewal stopped status=401');
      return;
    }
    log(
      `worktree snapshot grant renewal failed status=${
        timedOut ? 'timeout' : status === undefined ? 'network' : status
      }`
    );
    scheduleRenewal(RENEW_RETRY_MS);
  }

  async function downloadOnce(input: {
    worktreeId: string;
    archivePath: string;
    signal: AbortSignal;
  }): Promise<DownloadOutcome> {
    const url = snapshotUrl(input.worktreeId);
    if (url === undefined || grant === undefined) return { kind: 'persistent' };

    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: 'GET',
        headers: { authorization: `Bearer ${grant}` },
        signal: input.signal,
      });
    } catch (error) {
      if (input.signal.aborted) throw input.signal.reason ?? error;
      return { kind: 'transient', error };
    }

    if (response.status === 404) {
      await response.body?.cancel().catch(() => undefined);
      return { kind: 'missing' };
    }
    if (response.status === 401 || response.status === 403) {
      await response.body?.cancel().catch(() => undefined);
      return { kind: 'persistent', status: response.status };
    }
    if (response.status === 429 || response.status >= 500) {
      await response.body?.cancel().catch(() => undefined);
      return { kind: 'transient', status: response.status };
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      return { kind: 'persistent', status: response.status };
    }

    const lengthHeader = response.headers.get('content-length');
    const declaredLength =
      lengthHeader !== null && /^\d+$/.test(lengthHeader) ? Number(lengthHeader) : undefined;
    if (declaredLength !== undefined && declaredLength > WORKTREE_SNAPSHOT_MAX_BYTES) {
      await response.body?.cancel().catch(() => undefined);
      return { kind: 'invalid' };
    }
    const expected = normalizeSha256(response.headers.get('x-kilo-sha256') ?? '');
    if (expected === undefined || response.body === null) {
      await response.body?.cancel().catch(() => undefined);
      return { kind: 'mismatch' };
    }

    const hash = createHash('sha256');
    const handle = await open(input.archivePath, 'w', 0o600);
    const reader = response.body.getReader();
    let size = 0;
    try {
      while (true) {
        throwIfAborted(input.signal);
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > WORKTREE_SNAPSHOT_MAX_BYTES) {
          await reader.cancel().catch(() => undefined);
          return { kind: 'invalid' };
        }
        hash.update(value);
        let written = 0;
        while (written < value.byteLength) {
          const result = await handle.write(value, written, value.byteLength - written);
          if (result.bytesWritten === 0) throw new Error('snapshot download write stalled');
          written += result.bytesWritten;
        }
      }
    } catch (error) {
      if (input.signal.aborted) throw input.signal.reason ?? error;
      await reader.cancel().catch(() => undefined);
      return { kind: 'transient', error };
    } finally {
      await handle.close().catch(() => undefined);
    }

    const digest = hash.digest('hex');
    if (declaredLength !== undefined && size !== declaredLength) return { kind: 'mismatch' };
    if (digest !== expected) return { kind: 'mismatch' };
    return { kind: 'found', archivePath: input.archivePath, digest };
  }

  async function downloadWithRetries(input: {
    worktreeId: string;
    archivePath: string;
    signal: AbortSignal;
  }): Promise<SettledDownloadOutcome> {
    for (let attempt = 1; attempt <= DOWNLOAD_ATTEMPTS; attempt += 1) {
      throwIfAborted(input.signal);
      const outcome = await downloadOnce(input);
      if (outcome.kind === 'found' || outcome.kind === 'missing' || outcome.kind === 'invalid') {
        return outcome;
      }
      if (outcome.kind === 'persistent') {
        throw new WorktreeSnapshotDownloadError(
          outcome.status,
          outcome.error === undefined ? undefined : { cause: outcome.error }
        );
      }
      if (attempt === DOWNLOAD_ATTEMPTS) {
        if (outcome.kind === 'mismatch') {
          log(
            `worktree snapshot restore invalid worktree=${input.worktreeId} stage=transfer attempts=${attempt}`
          );
          return { kind: 'invalid' };
        }
        log(
          `worktree snapshot download failed worktree=${input.worktreeId} attempts=${attempt} status=${outcome.status ?? 'network'}`
        );
        throw new WorktreeSnapshotDownloadError(
          outcome.status,
          outcome.error === undefined ? undefined : { cause: outcome.error }
        );
      }
      const delay =
        DOWNLOAD_RETRY_DELAYS_MS[attempt - 1] ??
        DOWNLOAD_RETRY_DELAYS_MS[DOWNLOAD_RETRY_DELAYS_MS.length - 1] ??
        0;
      await sleep(clock, delay, input.signal);
    }
    throw new WorktreeSnapshotDownloadError();
  }

  async function restoreWithSignal(
    input: {
      directory: string;
      worktreeId: string;
    },
    signal: AbortSignal
  ): Promise<WorktreeSnapshotRestoreResult> {
    const temporary = await mkdtemp(join(tmpdir(), 'kilo-worktree-snapshot-'));
    const archivePath = join(temporary, 'snapshot.tar.gz');
    try {
      const downloaded = await downloadWithRetries({
        worktreeId: input.worktreeId,
        archivePath,
        signal,
      });
      if (downloaded.kind === 'missing') return { found: false };
      if (downloaded.kind === 'invalid') {
        log(`worktree snapshot restore invalid worktree=${input.worktreeId} stage=download`);
        return { found: true, invalid: true };
      }

      try {
        const applied = await apply({
          directory: input.directory,
          worktreeId: input.worktreeId,
          archivePath: downloaded.archivePath,
          signal,
        });
        log(
          `worktree snapshot restore worktree=${input.worktreeId} applied=${applied.applied} omitted=${applied.omitted} conflicts=${applied.conflicts.length} partial=${applied.partial}`
        );
        return {
          found: true,
          applied: applied.applied,
          omitted: applied.omitted,
          conflicts: applied.conflicts,
          partial: applied.partial,
        };
      } catch (error) {
        if (isInvalidWorktreeSnapshotError(error)) {
          log(`worktree snapshot restore invalid worktree=${input.worktreeId} stage=apply`);
          return { found: true, invalid: true };
        }
        throw error;
      }
    } finally {
      await rm(temporary, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  async function restore(input: {
    directory: string;
    worktreeId: string;
    signal: AbortSignal;
  }): Promise<WorktreeSnapshotRestoreResult> {
    unregister(input.directory);
    if (closed || !configured) return { found: false };
    try {
      return await runWithTimeout({
        clock,
        parent: input.signal,
        timeoutMs: WORKTREE_SNAPSHOT_RESTORE_MS,
        start: signal => restoreWithSignal(input, signal),
      });
    } catch (error) {
      if (error instanceof WorktreeSnapshotTimeoutError) {
        log(`worktree snapshot restore timed out worktree=${input.worktreeId}`);
        throw new WorktreeSnapshotRestoreError('worktree snapshot restore timed out', {
          cause: error,
        });
      }
      throw error;
    }
  }

  function close(): void {
    if (closed) return;
    closed = true;
    for (const state of states.values()) {
      state.removed = true;
      clearTimers(state);
      state.lifecycle.abort();
    }
    states.clear();
    startQueue.length = 0;
    clearRenewal();
  }

  return { register, unregister, requestCapture, restore, close };
}
