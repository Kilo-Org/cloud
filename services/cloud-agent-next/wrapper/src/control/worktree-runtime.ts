import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createKiloClient } from '@kilocode/sdk';
import { createKiloClient as createKiloEventClient } from '@kilocode/sdk/v2/client';
import { CONTROL_PLANE_SANDBOX_PERMISSION } from '../../../src/shared/control-plane-permission.js';
import type {
  ControlDiagnosticFields,
  ControlDiagnosticReporter,
} from '../../../src/shared/control-diagnostics.js';
import { safeSandboxRuntimeVersion } from '../../../src/shared/sandbox-status.js';
import {
  SANDBOX_CONTROL_CLEANUP_TIMEOUT_MS,
  worktreeDeletePayloadSchema,
  type ControlErrorCode,
  type SessionAttachPayload,
  type SessionRequestIdentity,
  type SessionEventIdentity,
} from '../../../src/shared/sandbox-control-protocol.js';
import { CONTROL_RUNTIME_RESERVED_ENV_VARS } from '../../../src/shared/runtime-environment.js';
import {
  createWrapperKiloClient,
  type KiloServerHandle,
  type WrapperKiloClient,
} from '../kilo-api.js';
import { logToFile, withTimeoutAndAbort } from '../utils.js';
import { isKiloServerProcess } from '../tool-cgroup.js';
import {
  createOwnedProcessScope,
  OWNED_PROCESS_OBSERVATION_TIMEOUT_MS,
  type DirectProcessObserver,
  type OwnedProcessScope,
} from './owned-processes.js';
import type { NativeOperationTarget, NativeRetirement } from './session-operation-cleanup.js';
import {
  retireWorktreeRuntime,
  settleNativeCleanup,
  stopWithinCleanupBudget,
} from './worktree-runtime-cleanup.js';
import {
  forgetAttachedRoot,
  ownerDirectoryForSession,
  rememberAttachedRoot,
} from './session-directories.js';
import { withKiloRequestDeadline, type KiloEventFeedError } from './sandbox-control-runtime.js';
import { createWorktreeFeed, type KiloFeedEvent, type WorktreeFeed } from './worktree-feed.js';

export type WorktreeKiloAuth = NonNullable<SessionAttachPayload['kilo']>;
type RuntimeIsolation = 'directory-shared' | 'per-session';

type WorktreeKiloFailure = {
  identity: SessionRequestIdentity;
  retirementId: string;
  directory: string;
  reason: KiloEventFeedError['reason'] | 'process_exited' | 'credential_refresh_failed';
  runtimeId: string;
  cleanup: 'confirmed' | 'unconfirmed';
  cleanupDeadlineAt: number;
};

export type WorktreeKiloRuntime = {
  readonly identity?: SessionRequestIdentity;
  readonly isolation?: RuntimeIsolation;
  readonly scopeId: string;
  readonly runtimeId: string;
  readonly directory: string;
  readonly env: Record<string, string>;
  readonly kiloClient: WrapperKiloClient;
  readonly signal: AbortSignal;
};

export type WorktreeKiloAttachment = {
  ready: Promise<WorktreeKiloRuntime>;
  signal: AbortSignal;
  cleanup?(deadlineAt: number): Promise<NativeRetirement>;
  commit(): void;
  release(): void;
};

type RecoveryRetirement = 'retired' | 'absent' | 'acknowledged';
export type RootRuntimeRetirement = {
  directory: string;
  root: string;
  nativeRuntimeId: string;
  target: NativeOperationTarget;
  result: NativeRetirement;
  retirementId?: string;
  reason?: string;
  cleanupDeadlineAt?: number;
  reportToService?: boolean;
};

export type RootRuntimeRetirementStarted = {
  directory: string;
  root: string;
  nativeRuntimeId: string;
  target: NativeOperationTarget;
  retirementId: string;
  reason: string;
  cleanupDeadlineAt: number;
  reportToService?: boolean;
};

export type RootRuntimeDisappearance = {
  directory: string;
  root: string;
  nativeRuntimeId: string;
  target: NativeOperationTarget;
};
export type RootRetirementScope = 'shared' | 'sole' | 'stale';

export type WorktreeKiloRuntimes = {
  readonly kiloCliVersion?: string | null;
  attach(
    identity: SessionRequestIdentity,
    kilo: WorktreeKiloAuth,
    env?: Record<string, string>,
    canRefreshCredentials?: () => boolean,
    runtimeIsolation?: RuntimeIsolation,
    beforeMutation?: () => void,
    onCleanupTarget?: (cleanup: (deadlineAt: number) => Promise<NativeRetirement>) => void
  ): WorktreeKiloAttachment;
  detach(identity: SessionRequestIdentity): boolean;
  retireForRecovery(
    identity: SessionRequestIdentity,
    recoveryId: string,
    assertIdle: () => void
  ): Promise<RecoveryRetirement>;
  deleteDirectory(directory: string): Promise<void>;
  retireRuntime?(
    directory: string,
    deadlineAt: number,
    target?: NativeOperationTarget
  ): Promise<NativeRetirement>;
  retireRuntimeIfUnshared?(
    directory: string,
    target: NativeOperationTarget,
    retiringRoot: string,
    deadlineAt: number,
    reason?: string
  ): Promise<NativeRetirement | 'shared'>;
  deferRuntimeRetirementIfShared?(
    directory: string,
    target: NativeOperationTarget,
    retiringRoot: string,
    deadlineAt: number,
    reason?: string
  ): Promise<NativeRetirement | 'shared'>;
  rootRetirementScope?(
    directory: string,
    target: NativeOperationTarget,
    retiringRoot: string
  ): RootRetirementScope;
  verifyQuiescence?(
    directory: string,
    target: NativeOperationTarget,
    deadlineAt: number
  ): Promise<boolean>;
  getRetained?(
    identity: SessionRequestIdentity | string,
    runtimeId?: string
  ): WorktreeKiloRuntime | undefined;
  get(identity: SessionRequestIdentity | string): WorktreeKiloRuntime | undefined;
  getAll?(directory: string): WorktreeKiloRuntime[];
  isCurrent?(runtime: WorktreeKiloRuntime): boolean;
  getEntryRuntimeId?(directory: string, root?: string): string | undefined;
  prepareForNewWork?(directory: string): boolean;
  feedRecovering?(directory: string): boolean;
  recordRootPublicationDiagnostic?(
    identity: SessionEventIdentity,
    fields: ControlDiagnosticFields
  ): boolean;
  snapshotRootPublicationDiagnostics?(): void;
  isHealthy(): boolean;
  shutdown(): void;
};

type WorktreeKiloEvent = KiloFeedEvent;

type ServerOptions = {
  directory: string;
  env: Record<string, string>;
  signal: AbortSignal;
  timeoutMs?: number;
  onProcessScope?: (scope: OwnedProcessScope) => void;
  onProcessObserver?: (observer: DirectProcessObserver) => void;
  claimCleanupDeadline?: (deadlineAt?: number) => number;
};

type WorktreeKiloServerHandle = Omit<KiloServerHandle, 'close'> & {
  close(deadlineAt?: number): void;
  stopped?: Promise<void>;
  exited?: Promise<void>;
  processes?: OwnedProcessScope;
  processObserver?: DirectProcessObserver;
};

type RuntimeEntry = {
  identity: SessionRequestIdentity;
  isolation: RuntimeIsolation;
  kilo: WorktreeKiloAuth;
  directory: string;
  env: Record<string, string>;
  abort: AbortController;
  roots: Set<RootAttachment>;
  runtime?: WorktreeKiloRuntime;
  kiloClient?: WrapperKiloClient;
  processAbort?: AbortController;
  processes?: OwnedProcessScope;
  processObserver?: DirectProcessObserver;
  descendantsUnverified?: boolean;
  processIssued?: boolean;
  runtimeId: string;
  pendingPtys: number;
  feed?: WorktreeFeed;
  starting?: Promise<WorktreeKiloRuntime>;
  stopped?: Promise<void>;
  retiring?: Promise<NativeRetirement>;
  retirementResult?: NativeRetirement;
  observing?: Promise<boolean>;
  cleanupDeadlineAt?: number;
};

type RootAttachment = {
  createdAt: number;
  identity: SessionRequestIdentity;
  entry: RuntimeEntry;
  abort: AbortController;
  attached: boolean;
  pending: Set<symbol>;
  publication: RootPublicationCounters;
};

type RootPublicationCounters = {
  failures: number;
  acknowledged: number;
  rejected: number;
  timedOut: number;
  connectionClosed: number;
  trackingEvicted: number;
  expired: number;
  queueOverflow: number;
  socketOverflow: number;
  pendingCount: number;
  pendingBytes: number;
  socketBufferedBytes: number;
  outstandingEventAcks: number;
  dirty: boolean;
  firstFailure?: ControlDiagnosticFields;
};

const KILO_STARTUP_TIMEOUT_MS = 30_000;
const BITBUCKET_METADATA_ENV_VARS = new Set([
  'KILO_BITBUCKET_WORKSPACE_SLUG',
  'KILO_BITBUCKET_REPOSITORY_SLUG',
  'KILO_BITBUCKET_WORKSPACE_UUID',
  'KILO_BITBUCKET_REPOSITORY_UUID',
]);
const INHERITED_GIT_CREDENTIALS = new Set([
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'GITLAB_TOKEN',
  'GITLAB_OAUTH_TOKEN',
  'BITBUCKET_TOKEN',
  'BITBUCKET_APP_PASSWORD',
]);

export class WorktreeKiloRuntimeError extends Error {
  constructor(
    readonly code: ControlErrorCode,
    message: string,
    readonly retryable: boolean
  ) {
    super(message);
    this.name = 'WorktreeKiloRuntimeError';
  }
}

export function isRetirementReportCurrent(
  currentRuntimeId: string | undefined,
  retiredRuntimeId: string
): boolean {
  return currentRuntimeId === undefined || currentRuntimeId === retiredRuntimeId;
}

export function buildWorktreeKiloEnvironment(
  directory: string,
  home: string,
  kilo: WorktreeKiloAuth,
  environment: Record<string, string> = {},
  inherited: NodeJS.ProcessEnv = process.env
): Record<string, string> {
  const env: Record<string, string> = {};
  const reserved = new Set<string>(CONTROL_RUNTIME_RESERVED_ENV_VARS);
  const isRuntimeOwned = (name: string): boolean =>
    reserved.has(name) ||
    name === 'HOME' ||
    name.startsWith('XDG_') ||
    name.startsWith('KILO') ||
    name.startsWith('OPENCODE');

  for (const [name, value] of Object.entries(inherited)) {
    if (value !== undefined && !isRuntimeOwned(name) && !INHERITED_GIT_CREDENTIALS.has(name)) {
      env[name] = value;
    }
  }
  for (const [name, value] of Object.entries(environment)) {
    if (!isRuntimeOwned(name) || BITBUCKET_METADATA_ENV_VARS.has(name)) env[name] = value;
  }

  const config = JSON.stringify({
    autoupdate: false,
    permission: CONTROL_PLANE_SANDBOX_PERMISSION,
    provider: {
      kilo: {
        options: {
          apiKey: kilo.token,
          kilocodeToken: kilo.token,
          ...(kilo.organizationId ? { kilocodeOrganizationId: kilo.organizationId } : {}),
          baseURL: kilo.targets.providerBaseUrl,
        },
      },
    },
  });

  return {
    ...env,
    PWD: directory,
    HOME: home,
    XDG_DATA_HOME: path.join(home, '.local', 'share'),
    XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_CACHE_HOME: path.join(home, '.cache'),
    XDG_STATE_HOME: path.join(home, '.local', 'state'),
    XDG_RUNTIME_DIR: path.join(home, '.run'),
    KILO_PLATFORM: 'cloud-agent',
    KILO_DISABLE_AUTOUPDATE: 'true',
    KILO_DEBUG_SESSION_INGEST: '1',
    KILOCODE_TOKEN: kilo.token,
    KILOCODE_FEATURE: environment.KILOCODE_FEATURE ?? 'cloud-agent',
    ...(kilo.organizationId ? { KILOCODE_ORGANIZATION_ID: kilo.organizationId } : {}),
    KILO_AUTH_CONTENT: JSON.stringify({ kilo: { type: 'api', key: kilo.token } }),
    KILOCODE_BACKEND_BASE_URL: kilo.targets.backendBaseUrl,
    KILO_API_URL: kilo.targets.backendBaseUrl,
    KILO_OPENROUTER_BASE: kilo.targets.providerBaseUrl,
    KILO_SESSION_INGEST_URL: kilo.targets.sessionIngestBaseUrl,
    KILO_CONFIG_CONTENT: config,
    OPENCODE_CONFIG_CONTENT: config,
  };
}

export async function startWorktreeKiloServer(
  options: ServerOptions
): Promise<WorktreeKiloServerHandle & { stopped: Promise<void> }> {
  options.signal.throwIfAborted();
  const processes = createOwnedProcessScope();
  options.onProcessScope?.(processes);
  const proc = processes.spawn('kilo', ['serve', '--hostname=127.0.0.1', '--port=0'], {
    cwd: options.directory,
    env: options.env,
  });
  const processObserver = processes.observeChild(proc);
  if (processObserver) options.onProcessObserver?.(processObserver);
  proc.stderr.resume();
  const stopped = new Promise<void>(resolve => {
    proc.once('close', () => resolve());
  });
  const exited = new Promise<void>(resolve => {
    proc.once('exit', () => resolve());
    proc.once('error', () => {
      if (proc.pid === undefined) resolve();
    });
  });
  let cleanupDeadlineAt: number | undefined;
  const claimCleanupDeadline = (requested?: number): number => {
    const owned = options.claimCleanupDeadline?.(requested) ?? requested;
    cleanupDeadlineAt ??= owned ?? Date.now() + SANDBOX_CONTROL_CLEANUP_TIMEOUT_MS;
    cleanupDeadlineAt = Math.min(cleanupDeadlineAt, owned ?? cleanupDeadlineAt);
    return cleanupDeadlineAt;
  };
  let closed = false;
  const closeAt = (deadlineAt?: number): void => {
    if (closed) return;
    closed = true;
    options.signal.removeEventListener('abort', close);
    if (deadlineAt === undefined) {
      if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGTERM');
      return;
    }
    void processes.stop(claimCleanupDeadline(deadlineAt));
  };
  const close = (): void => closeAt();
  options.signal.addEventListener('abort', close, { once: true });

  try {
    const url = await new Promise<string>((resolve, reject) => {
      let output = '';
      const timeout = setTimeout(
        () => fail('Kilo server startup timed out'),
        options.timeoutMs ?? KILO_STARTUP_TIMEOUT_MS
      );
      const cleanup = (): void => {
        clearTimeout(timeout);
        options.signal.removeEventListener('abort', onAbort);
        proc.stdout.removeListener('data', onOutput);
        proc.removeListener('exit', onExit);
      };
      const fail = (message: string): void => {
        cleanup();
        reject(new Error(message));
      };
      const onAbort = (): void => fail('Kilo server startup aborted');
      const onExit = (): void => fail('Kilo server exited before startup');
      const onOutput = (chunk: Buffer): void => {
        output = (output + chunk.toString()).slice(-65_536);
        const match = /^kilo server listening on (http:\/\/127\.0\.0\.1:\d+)\r?\n/m.exec(output);
        if (!match?.[1]) return;
        cleanup();
        resolve(match[1]);
      };
      proc.stdout.on('data', onOutput);
      proc.once('exit', onExit);
      proc.on('error', () => fail('Kilo server failed to start'));
      options.signal.addEventListener('abort', onAbort, { once: true });
      if (options.signal.aborted) onAbort();
    });
    proc.stdout.resume();
    proc.once('exit', close);
    await processes.captureBaseline(isKiloServerProcess);
    options.signal.throwIfAborted();
    return { url, close: closeAt, stopped, exited, processes, processObserver };
  } catch {
    const deadlineAt = claimCleanupDeadline();
    const cleanup = stopWithinCleanupBudget(processes, true, deadlineAt);
    closeAt(deadlineAt);
    await withTimeoutAndAbort(cleanup, {
      timeoutMs: Math.max(1, deadlineAt - Date.now()),
      timeoutMessage: 'Kilo startup cleanup expired',
      abortMessage: 'Kilo startup cleanup cancelled',
    }).catch(() => false);
    throw new Error('Kilo server failed to start');
  }
}

function sameAuth(left: WorktreeKiloAuth, right: WorktreeKiloAuth): boolean {
  return (
    left.scopeId === right.scopeId &&
    (left.containmentEnabled !== false) === (right.containmentEnabled !== false) &&
    (left.containmentEnabled === false || left.token === right.token) &&
    left.organizationId === right.organizationId &&
    left.targets.backendBaseUrl === right.targets.backendBaseUrl &&
    left.targets.providerBaseUrl === right.targets.providerBaseUrl &&
    left.targets.sessionIngestBaseUrl === right.targets.sessionIngestBaseUrl
  );
}

// Environment keys whose value derives from the Kilo token. A difference in any of
// these is the only wrapper-side proof that the payload rotated the token.
const TOKEN_DERIVED_ENV_KEYS = new Set([
  'KILOCODE_TOKEN',
  'KILO_AUTH_CONTENT',
  'KILO_CONFIG_CONTENT',
  'OPENCODE_CONFIG_CONTENT',
]);

type WorktreeAttachAction = 'reuse' | 'mint' | 'refresh';

function worktreeIdFromDirectory(directory: string): string | undefined {
  const parsed = worktreeDeletePayloadSchema.shape.worktreeId.safeParse(path.basename(directory));
  return parsed.success ? parsed.data : undefined;
}

// Diagnostics only: reports which `attach()` branch ran and why. Never includes
// credential values — only environment key names and the token-change flag.
function emitWorktreeAttachDecision(
  onDiagnostic: ControlDiagnosticReporter | undefined,
  decision: {
    directory: string;
    kiloSessionId: string;
    scopeId: string;
    action: WorktreeAttachAction;
    reason: string;
    runtimeId?: string;
    previousPresent: boolean;
    retiring: boolean;
    retirementResult?: NativeRetirement;
    newRoot: boolean;
    aborted: boolean;
    committedCount: number;
    pendingCount: number;
    tokenChanged: boolean;
    changedKeys: string[];
  }
): void {
  const worktreeId = worktreeIdFromDirectory(decision.directory);
  const changedKeys = decision.changedKeys.join(',');
  // `tc` is first so the token-change discriminator survives `detail` truncation.
  const detail = [
    `tc=${decision.tokenChanged ? 1 : 0}`,
    `newRoot=${decision.newRoot ? 1 : 0}`,
    `prev=${decision.previousPresent ? 1 : 0}`,
    `ret=${decision.retiring ? 1 : 0}`,
    `unconf=${decision.retirementResult === 'unconfirmed' ? 1 : 0}`,
    ...(decision.retirementResult ? [`rr=${decision.retirementResult}`] : []),
    ...(changedKeys ? [`changed=${changedKeys}`] : []),
  ]
    .join(',')
    .slice(0, 128);
  onDiagnostic?.('control.request', {
    operation: 'session.attach',
    phase: 'started',
    stage: 'runtime_attach',
    kiloSessionId: decision.kiloSessionId,
    scopeId: decision.scopeId,
    ...(worktreeId ? { worktreeId } : {}),
    ...(decision.runtimeId ? { nativeRuntimeId: decision.runtimeId } : {}),
    reason: `${decision.action}:${decision.reason}`,
    sessionCount: decision.committedCount,
    pendingCount: decision.pendingCount,
    aborted: decision.aborted,
    detail,
  });
  logToFile(
    `worktree runtime attach decision action=${decision.action} reason=${decision.reason} directory=${path.basename(decision.directory)} kiloSessionId=${decision.kiloSessionId} runtimeId=${decision.runtimeId ?? 'none'} prev=${decision.previousPresent ? 1 : 0} ret=${decision.retiring ? 1 : 0} rr=${decision.retirementResult ?? 'none'} newRoot=${decision.newRoot ? 1 : 0} aborted=${decision.aborted ? 1 : 0} unconf=${decision.retirementResult === 'unconfirmed' ? 1 : 0} tokenChanged=${decision.tokenChanged ? 1 : 0} committed=${decision.committedCount} pending=${decision.pendingCount} changed=${changedKeys || 'none'}`
  );
}

// Diagnostics only: emitted when refresh/mint actually allocates a new runtime id,
// so the pre-decision and post-allocation identities are both observable.
function emitWorktreeRuntimeAllocation(
  onDiagnostic: ControlDiagnosticReporter | undefined,
  allocation: {
    directory: string;
    kiloSessionId?: string;
    scopeId: string;
    action: 'mint' | 'refresh';
    previousRuntimeId?: string;
    runtimeId: string;
  }
): void {
  const worktreeId = worktreeIdFromDirectory(allocation.directory);
  onDiagnostic?.('control.request', {
    operation: 'session.attach',
    phase: 'started',
    stage: 'runtime_attach',
    ...(allocation.kiloSessionId ? { kiloSessionId: allocation.kiloSessionId } : {}),
    scopeId: allocation.scopeId,
    ...(worktreeId ? { worktreeId } : {}),
    nativeRuntimeId: allocation.runtimeId,
    reason: `${allocation.action}:allocated`,
    detail: `previousRuntimeId=${allocation.previousRuntimeId ?? 'none'}`,
  });
  logToFile(
    `worktree runtime allocation action=${allocation.action} directory=${path.basename(allocation.directory)} runtimeId=${allocation.runtimeId} previousRuntimeId=${allocation.previousRuntimeId ?? 'none'}`
  );
}

export function createWorktreeKiloRuntimes(options: {
  homeRoot?: string;
  inheritedEnv?: NodeJS.ProcessEnv;
  startServer?: (options: ServerOptions) => Promise<WorktreeKiloServerHandle>;
  onEvent?: (runtime: WorktreeKiloRuntime, event: WorktreeKiloEvent) => unknown;
  onRootRetirementStarted?: (retirement: RootRuntimeRetirementStarted) => void;
  onRootRetirement?: (retirement: RootRuntimeRetirement) => void;
  onRootDisappeared?: (disappearance: RootRuntimeDisappearance) => void;
  onDiagnostic?: ControlDiagnosticReporter;
  onUnexpectedClose: (failure: WorktreeKiloFailure) => void;
}): WorktreeKiloRuntimes {
  const entries = new Map<string, RuntimeEntry>();
  const directoriesByScope = new Map<string, string>();
  const roots = new Map<string, RootAttachment>();
  const recoveryGates = new Map<string, Promise<void>>();
  const recoveryAcknowledgements = new Map<string, Map<string, Promise<RecoveryRetirement>>>();
  const homesByDirectory = new Map<string, Set<string>>();
  const deletedDirectories = new Set<string>();
  const deferredRetirements = new Map<
    string,
    {
      directory: string;
      root: string;
      nativeRuntimeId: string;
      entry: RuntimeEntry;
      target: NativeOperationTarget;
      reason: string;
      deadlineAt: number;
    }
  >();
  const evaluatingDeferredRetirements = new Set<RuntimeEntry>();
  let observedVersion: string | null | undefined;
  let closed = false;

  const emptyPublicationCounters = (): RootPublicationCounters => ({
    failures: 0,
    acknowledged: 0,
    rejected: 0,
    timedOut: 0,
    connectionClosed: 0,
    trackingEvicted: 0,
    expired: 0,
    queueOverflow: 0,
    socketOverflow: 0,
    pendingCount: 0,
    pendingBytes: 0,
    socketBufferedBytes: 0,
    outstandingEventAcks: 0,
    dirty: false,
  });

  function publicationRoot(identity: SessionEventIdentity): RootAttachment | undefined {
    const rootId = identity.rootKiloSessionId ?? identity.kiloSessionId;
    if (!rootId) return undefined;
    const ownerDirectory = ownerDirectoryForSession(identity);
    const root = [...roots.values()].find(
      candidate =>
        candidate.identity.kiloSessionId === rootId &&
        candidate.identity.directory === ownerDirectory
    );
    if (!root) return undefined;
    if (identity.nativeRuntimeId !== undefined && identity.nativeRuntimeId !== root.entry.runtimeId)
      return undefined;
    return root;
  }

  function recordRootPublicationDiagnostic(
    identity: SessionEventIdentity,
    fields: ControlDiagnosticFields
  ): boolean {
    const root = publicationRoot(identity);
    if (!root) return false;
    if (
      (typeof fields.sentAt === 'number' && fields.sentAt < root.createdAt) ||
      (typeof fields.preparedAt === 'number' && fields.preparedAt < root.createdAt)
    )
      return false;
    const counters = root.publication;
    counters.dirty = true;
    const outcome = fields.outcome;
    const failure =
      fields.phase === 'publication_failed' ||
      (typeof outcome === 'string' && outcome !== 'acknowledged');
    const firstFailure = failure && counters.firstFailure === undefined;
    if (fields.phase === 'publication_failed') {
      counters.failures = Math.min(Number.MAX_SAFE_INTEGER, counters.failures + 1);
      if (fields.failureReason === 'expired')
        counters.expired = Math.min(Number.MAX_SAFE_INTEGER, counters.expired + 1);
      if (fields.failureReason === 'queue_overflow')
        counters.queueOverflow = Math.min(Number.MAX_SAFE_INTEGER, counters.queueOverflow + 1);
      if (fields.failureReason === 'socket_overflow')
        counters.socketOverflow = Math.min(Number.MAX_SAFE_INTEGER, counters.socketOverflow + 1);
    } else if (outcome === 'acknowledged') {
      counters.acknowledged = Math.min(Number.MAX_SAFE_INTEGER, counters.acknowledged + 1);
    } else if (outcome === 'rejected') {
      if (fields.neverSent === true)
        counters.failures = Math.min(Number.MAX_SAFE_INTEGER, counters.failures + 1);
      else counters.rejected = Math.min(Number.MAX_SAFE_INTEGER, counters.rejected + 1);
    } else if (outcome === 'timed_out') {
      counters.timedOut = Math.min(Number.MAX_SAFE_INTEGER, counters.timedOut + 1);
    } else if (outcome === 'connection_closed') {
      counters.connectionClosed = Math.min(Number.MAX_SAFE_INTEGER, counters.connectionClosed + 1);
    } else if (outcome === 'tracking_evicted') {
      counters.trackingEvicted = Math.min(Number.MAX_SAFE_INTEGER, counters.trackingEvicted + 1);
    }
    if (fields.phase === 'publication_failed') {
      if (typeof fields.pendingCount === 'number') counters.pendingCount = fields.pendingCount;
      if (typeof fields.pendingBytes === 'number') counters.pendingBytes = fields.pendingBytes;
    }
    if (typeof fields.socketBufferedBytes === 'number')
      counters.socketBufferedBytes = fields.socketBufferedBytes;
    if (typeof fields.outstandingEventAcks === 'number')
      counters.outstandingEventAcks = fields.outstandingEventAcks;
    if (firstFailure) {
      counters.firstFailure = { ...fields };
      options.onDiagnostic?.('control.event', fields);
    }
    return true;
  }

  function emitRootPublicationSummary(root: RootAttachment): void {
    const counters = root.publication;
    if (!counters.dirty) return;
    options.onDiagnostic?.('control.event', {
      phase: 'publication_summary',
      category: 'session_event',
      kiloSessionId: root.identity.kiloSessionId,
      rootKiloSessionId: root.identity.kiloSessionId,
      nativeRuntimeId: root.entry.runtimeId,
      failureCount: counters.failures,
      acknowledgedCount: counters.acknowledged,
      rejectedCount: counters.rejected,
      timeoutCount: counters.timedOut,
      connectionClosedCount: counters.connectionClosed,
      trackingEvictionCount: counters.trackingEvicted,
      expiredCount: counters.expired,
      queueOverflowCount: counters.queueOverflow,
      socketOverflowCount: counters.socketOverflow,
      pendingCount: counters.pendingCount,
      pendingBytes: counters.pendingBytes,
      socketBufferedBytes: counters.socketBufferedBytes,
      outstandingEventAcks: counters.outstandingEventAcks,
      ...(counters.firstFailure?.failureReason
        ? { failureReason: counters.firstFailure.failureReason }
        : {}),
      ...(counters.firstFailure?.outcome ? { outcome: counters.firstFailure.outcome } : {}),
      ...(counters.firstFailure?.reason ? { reason: counters.firstFailure.reason } : {}),
      ...(counters.firstFailure?.requestId ? { requestId: counters.firstFailure.requestId } : {}),
      ...(counters.firstFailure?.receiptId ? { receiptId: counters.firstFailure.receiptId } : {}),
      ...(counters.firstFailure?.sequence !== undefined
        ? { sequence: counters.firstFailure.sequence }
        : {}),
      ...(counters.firstFailure?.sentAt !== undefined
        ? { sentAt: counters.firstFailure.sentAt }
        : {}),
      ...(counters.firstFailure?.preparedAt !== undefined
        ? { preparedAt: counters.firstFailure.preparedAt }
        : {}),
      ...(counters.firstFailure?.eventType ? { eventType: counters.firstFailure.eventType } : {}),
      ...(counters.firstFailure?.detail ? { detail: counters.firstFailure.detail } : {}),
      ...(counters.firstFailure?.queueWaitMs !== undefined
        ? { queueWaitMs: counters.firstFailure.queueWaitMs }
        : {}),
      ...(counters.firstFailure?.requestWaitMs !== undefined
        ? { requestWaitMs: counters.firstFailure.requestWaitMs }
        : {}),
      ...(counters.firstFailure?.connectionState
        ? { connectionState: counters.firstFailure.connectionState }
        : {}),
      ...(counters.firstFailure?.connectionId
        ? { connectionId: counters.firstFailure.connectionId }
        : {}),
      ...(counters.firstFailure?.wrapperInstanceId
        ? { wrapperInstanceId: counters.firstFailure.wrapperInstanceId }
        : {}),
      ...(counters.firstFailure?.neverSent !== undefined
        ? { neverSent: counters.firstFailure.neverSent }
        : {}),
      ...(counters.firstFailure?.sentWithoutResponse !== undefined
        ? { sentWithoutResponse: counters.firstFailure.sentWithoutResponse }
        : {}),
    });
    counters.dirty = false;
  }

  function snapshotRootPublicationDiagnostics(): void {
    for (const root of roots.values()) emitRootPublicationSummary(root);
  }

  function resetRootPublicationCountersForRuntimeRotation(entry: RuntimeEntry): void {
    for (const root of entry.roots) {
      emitRootPublicationSummary(root);
      root.publication = emptyPublicationCounters();
    }
  }

  function recordVersion(value: unknown): void {
    const version = safeSandboxRuntimeVersion(value);
    observedVersion = observedVersion === undefined || observedVersion === version ? version : null;
  }

  const identityKey = (identity: SessionRequestIdentity): string =>
    `${identity.sessionId}\0${identity.kiloSessionId}\0${identity.directory}`;

  const entryKey = (identity: SessionRequestIdentity, isolation: RuntimeIsolation): string =>
    isolation === 'per-session' ? identityKey(identity) : identity.directory;

  function findRoot(identity: SessionRequestIdentity): RootAttachment | undefined {
    return roots.get(identityKey(identity));
  }

  function cleanupDeadline(entry: RuntimeEntry, requested?: number): number {
    entry.cleanupDeadlineAt ??= requested ?? Date.now() + SANDBOX_CONTROL_CLEANUP_TIMEOUT_MS;
    entry.cleanupDeadlineAt = Math.min(
      entry.cleanupDeadlineAt,
      requested ?? entry.cleanupDeadlineAt
    );
    return entry.cleanupDeadlineAt;
  }

  function runtimeTargetMatches(entry: RuntimeEntry, target: NativeOperationTarget): boolean {
    return (
      entry.runtimeId === target.runtimeId &&
      (target.client === undefined || target.client === entry.kiloClient)
    );
  }

  function reportRootRetirement(
    intent: Omit<RootRuntimeRetirement, 'result'>,
    result: NativeRetirement
  ): void {
    options.onRootRetirement?.({ ...intent, result });
  }

  function reportRuntimeRetirement(
    intent: {
      directory: string;
      root: string;
      nativeRuntimeId: string;
      target: NativeOperationTarget;
    },
    retirement: Promise<NativeRetirement>
  ): Promise<NativeRetirement> {
    void retirement.then(result => reportRootRetirement(intent, result));
    return retirement;
  }

  function liveRoots(entry: RuntimeEntry): RootAttachment[] {
    return [...entry.roots].filter(root => root.attached || root.pending.size > 0);
  }

  function deferredRetirementKey(root: string, nativeRuntimeId: string): string {
    return JSON.stringify([root, nativeRuntimeId]);
  }

  function settleDeferredRetirement(
    intent: {
      directory: string;
      root: string;
      nativeRuntimeId: string;
    },
    result: NativeRetirement
  ): void {
    const id = deferredRetirementKey(intent.root, intent.nativeRuntimeId);
    const current = deferredRetirements.get(id);
    if (!current || current.directory !== intent.directory) return;
    deferredRetirements.delete(id);
    reportRootRetirement({ ...intent, target: current.target }, result);
  }

  function settleEntryDeferredRetirements(
    entry: RuntimeEntry,
    target: NativeOperationTarget | undefined,
    result: NativeRetirement
  ): Set<string> {
    const settled = new Set<string>();
    for (const intent of [...deferredRetirements.values()]) {
      if (intent.entry !== entry) continue;
      if (
        target &&
        (target.runtimeId !== intent.nativeRuntimeId ||
          (target.client !== undefined &&
            intent.target.client !== undefined &&
            target.client !== intent.target.client))
      )
        continue;
      settled.add(deferredRetirementKey(intent.root, intent.nativeRuntimeId));
      settleDeferredRetirement(intent, result);
    }
    return settled;
  }

  function evaluateDeferredRetirements(entry: RuntimeEntry): void {
    if (entry.retiring || evaluatingDeferredRetirements.has(entry)) return;
    const live = liveRoots(entry);
    evaluatingDeferredRetirements.add(entry);
    try {
      for (const intent of [...deferredRetirements.values()]) {
        if (intent.entry !== entry) continue;
        const failedRoot = [...entry.roots].find(
          root => root.identity.kiloSessionId === intent.root
        );
        if (!failedRoot || !live.includes(failedRoot)) {
          settleDeferredRetirement(intent, 'stale');
          continue;
        }
        if (!runtimeTargetMatches(entry, intent.target)) {
          settleDeferredRetirement(intent, 'stale');
          continue;
        }
        if (live.some(root => root !== failedRoot)) continue;

        deferredRetirements.delete(deferredRetirementKey(intent.root, intent.nativeRuntimeId));
        const now = Date.now();
        const physicalDeadlineAt =
          now >= intent.deadlineAt
            ? now + SANDBOX_CONTROL_CLEANUP_TIMEOUT_MS
            : Math.min(intent.deadlineAt, now + SANDBOX_CONTROL_CLEANUP_TIMEOUT_MS);
        void retire(entry, physicalDeadlineAt, intent.target, {
          reason: intent.reason,
          cleanupDeadlineAt: physicalDeadlineAt,
          reportToService: true,
        });
      }
    } finally {
      evaluatingDeferredRetirements.delete(entry);
    }
  }

  function unregisterRoot(root: RootAttachment): void {
    emitRootPublicationSummary(root);
    root.entry.roots.delete(root);
    root.attached = false;
    root.pending.clear();
    if (roots.get(identityKey(root.identity)) === root) {
      roots.delete(identityKey(root.identity));
      forgetAttachedRoot(root.identity.kiloSessionId, root.identity.directory);
      if (!root.entry.retiring)
        options.onRootDisappeared?.({
          directory: root.entry.directory,
          root: root.identity.kiloSessionId,
          nativeRuntimeId: root.entry.runtimeId,
          target: { runtimeId: root.entry.runtimeId, client: root.entry.kiloClient },
        });
    }
    evaluateDeferredRetirements(root.entry);
  }

  function retire(
    entry: RuntimeEntry,
    requested?: number,
    target?: NativeOperationTarget,
    metadata: {
      reason?: string;
      cleanupDeadlineAt?: number;
      reportToService?: boolean;
    } = {}
  ): Promise<NativeRetirement> {
    const settlementTarget = target ?? { runtimeId: entry.runtimeId, client: entry.kiloClient };
    const affectedRoots = [...entry.roots].map(root => root.identity.kiloSessionId);
    const retirementId = crypto.randomUUID();
    const cleanupDeadlineAt =
      metadata.cleanupDeadlineAt ?? requested ?? Date.now() + SANDBOX_CONTROL_CLEANUP_TIMEOUT_MS;
    const reason = metadata.reason ?? 'Native runtime retirement requested';
    for (const root of affectedRoots)
      options.onRootRetirementStarted?.({
        directory: entry.directory,
        root,
        nativeRuntimeId: settlementTarget.runtimeId,
        target: settlementTarget,
        retirementId,
        reason,
        cleanupDeadlineAt,
        ...(metadata.reportToService ? { reportToService: true } : {}),
      });
    const retirement = retireWorktreeRuntime(entry, requested, target, {
      cleanupDeadline,
      unregisterRoot,
      unverifiedCleanup: directProcessAbsent,
      removeEntry: retiring => {
        if (entries.get(entryKey(retiring.identity, retiring.isolation)) === retiring) {
          entries.delete(entryKey(retiring.identity, retiring.isolation));
          if (directoriesByScope.get(retiring.kilo.scopeId) === retiring.directory)
            directoriesByScope.delete(retiring.kilo.scopeId);
        }
      },
    });
    void retirement.then(result => {
      const settled = settleEntryDeferredRetirements(entry, target, result);
      for (const root of affectedRoots) {
        if (settled.has(deferredRetirementKey(root, settlementTarget.runtimeId))) continue;
        reportRootRetirement(
          {
            directory: entry.directory,
            root,
            nativeRuntimeId: settlementTarget.runtimeId,
            target: settlementTarget,
            retirementId,
            reason,
            cleanupDeadlineAt,
            ...(metadata.reportToService ? { reportToService: true } : {}),
          },
          result
        );
      }
    });
    return retirement;
  }

  function retireRuntimeIfUnshared(
    directory: string,
    target: NativeOperationTarget,
    retiringRoot: string,
    deadlineAt: number,
    reason = 'Native runtime retirement requested',
    defer = false
  ): Promise<NativeRetirement | 'shared'> {
    const entry = [...entries.values()].find(
      entry => entry.directory === directory && runtimeTargetMatches(entry, target)
    );
    const intent = {
      directory,
      root: retiringRoot,
      nativeRuntimeId: target.runtimeId,
      target,
    };
    if (!entry || !runtimeTargetMatches(entry, target)) {
      settleDeferredRetirement(intent, 'stale');
      return reportRuntimeRetirement(intent, Promise.resolve('stale'));
    }
    const live = liveRoots(entry);
    if (entry.retiring) return entry.retiring;
    const failedRoot = [...entry.roots].find(root => root.identity.kiloSessionId === retiringRoot);
    if (!failedRoot || !(failedRoot.attached || failedRoot.pending.size > 0)) {
      settleDeferredRetirement(intent, 'stale');
      return reportRuntimeRetirement(intent, Promise.resolve('stale'));
    }
    if (live.some(root => root !== failedRoot)) {
      if (defer)
        deferredRetirements.set(deferredRetirementKey(retiringRoot, target.runtimeId), {
          ...intent,
          entry,
          reason,
          deadlineAt,
        });
      return Promise.resolve('shared');
    }
    deferredRetirements.delete(deferredRetirementKey(retiringRoot, target.runtimeId));
    const physicalDeadlineAt = Date.now() + SANDBOX_CONTROL_CLEANUP_TIMEOUT_MS;
    return retire(entry, physicalDeadlineAt, target, {
      reason,
      cleanupDeadlineAt: physicalDeadlineAt,
      reportToService: true,
    });
  }

  function deferRuntimeRetirementIfShared(
    directory: string,
    target: NativeOperationTarget,
    retiringRoot: string,
    deadlineAt: number,
    reason?: string
  ): Promise<NativeRetirement | 'shared'> {
    return retireRuntimeIfUnshared(directory, target, retiringRoot, deadlineAt, reason, true);
  }

  function rootRetirementScope(
    directory: string,
    target: NativeOperationTarget,
    retiringRoot: string
  ): RootRetirementScope {
    const entry = [...entries.values()].find(
      entry => entry.directory === directory && runtimeTargetMatches(entry, target)
    );
    if (!entry || entry.retiring || !runtimeTargetMatches(entry, target)) return 'stale';
    const failedRoot = [...entry.roots].find(root => root.identity.kiloSessionId === retiringRoot);
    if (!failedRoot || !(failedRoot.attached || failedRoot.pending.size > 0)) return 'stale';
    return liveRoots(entry).some(root => root !== failedRoot) ? 'shared' : 'sole';
  }

  // Mutates the entry and reports diagnostics: releases abandoned streams when recovery is allowed.
  async function directProcessAbsent(entry: RuntimeEntry, deadlineAt: number): Promise<boolean> {
    const observer = entry.processObserver;
    if (!observer) {
      const absent = (await entry.processes?.verify(false, deadlineAt)) === true;
      if (!absent) {
        options.onDiagnostic?.('wrapper.lifecycle', {
          phase: 'stopped',
          stage: 'process_cleanup',
          ok: false,
          detail: 'direct process observation unavailable',
          nativeRuntimeId: entry.runtimeId,
        });
      }
      return absent;
    }
    const observation = await observer.observe(deadlineAt).catch(() => 'unknown' as const);
    if (observation !== 'absent' && observation !== 'reused') {
      options.onDiagnostic?.('wrapper.lifecycle', {
        phase: 'stopped',
        stage: 'process_cleanup',
        ok: false,
        detail:
          observation === 'alive'
            ? 'direct process is still alive'
            : 'direct process identity unavailable',
        nativeRuntimeId: entry.runtimeId,
      });
      return false;
    }
    entry.processes?.releaseAbandoned?.();
    entry.descendantsUnverified = true;
    options.onDiagnostic?.('wrapper.lifecycle', {
      phase: 'stopped',
      stage: 'process_cleanup',
      ok: true,
      detail: 'direct process absent; descendants unverified',
      nativeRuntimeId: entry.runtimeId,
      ...(observation === 'reused' ? { reason: 'pid_identity_reused' } : {}),
    });
    return true;
  }

  function observeRetained(entry: RuntimeEntry): Promise<boolean> {
    if (entry.observing) return entry.observing;
    const runtimeId = entry.runtimeId;
    const runtime = entry.runtime;
    const deadlineAt = Date.now() + OWNED_PROCESS_OBSERVATION_TIMEOUT_MS;
    const observation = Promise.resolve()
      .then(() => directProcessAbsent(entry, deadlineAt))
      .catch(() => false)
      .then(async proven => {
        if (!proven || Date.now() >= deadlineAt) return false;
        const starting = entry.starting;
        if (starting !== undefined) {
          try {
            await withTimeoutAndAbort(
              Promise.resolve(starting).catch(() => undefined),
              {
                timeoutMs: Math.max(1, deadlineAt - Date.now()),
                timeoutMessage: 'Native runtime startup settlement expired',
                abortMessage: 'Native runtime startup settlement cancelled',
              }
            );
          } catch {
            return false;
          }
        }
        if (Date.now() >= deadlineAt) return false;
        if (
          entries.get(entryKey(entry.identity, entry.isolation)) !== entry ||
          entry.runtimeId !== runtimeId ||
          entry.runtime !== runtime ||
          entry.retirementResult !== 'unconfirmed' ||
          !entry.abort.signal.aborted
        )
          return false;
        entries.delete(entryKey(entry.identity, entry.isolation));
        if (directoriesByScope.get(entry.kilo.scopeId) === entry.directory)
          directoriesByScope.delete(entry.kilo.scopeId);
        return true;
      })
      .then(
        proven => {
          if (!proven && entry.observing === observation) entry.observing = undefined;
          return proven;
        },
        error => {
          if (entry.observing === observation) entry.observing = undefined;
          throw error;
        }
      );
    entry.observing = observation;
    return observation;
  }

  function removeRoot(root: RootAttachment): void {
    if (roots.get(identityKey(root.identity)) !== root) return;
    unregisterRoot(root);
    root.abort.abort();
    if (root.entry.roots.size === 0) void retire(root.entry);
  }

  function failRuntime(entry: RuntimeEntry, reason: WorktreeKiloFailure['reason']): void {
    if (entry.abort.signal.aborted) return;
    const deadlineAt = cleanupDeadline(entry);
    const runtimeId = entry.runtimeId;
    void retire(entry, deadlineAt, undefined, {
      reason,
      cleanupDeadlineAt: deadlineAt,
    }).then(result => {
      options.onUnexpectedClose({
        identity: entry.identity,
        retirementId: crypto.randomUUID(),
        directory: entry.directory,
        reason,
        runtimeId,
        cleanup:
          result === 'unconfirmed' || entry.descendantsUnverified ? 'unconfirmed' : 'confirmed',
        cleanupDeadlineAt: deadlineAt,
      });
    });
  }

  async function start(
    entry: RuntimeEntry,
    retiring: Promise<NativeRetirement> | undefined,
    beforeMutation?: () => void
  ): Promise<WorktreeKiloRuntime> {
    const abort = new AbortController();
    entry.feed?.close();
    entry.feed = undefined;
    entry.processes = undefined;
    entry.processObserver = undefined;
    entry.descendantsUnverified = undefined;
    entry.processIssued = false;
    entry.stopped = undefined;
    entry.processAbort = abort;
    const stopProcess = () => {
      void entry.processes?.stop(cleanupDeadline(entry));
      abort.abort();
    };
    entry.abort.signal.addEventListener('abort', stopProcess, { once: true });
    abort.signal.addEventListener(
      'abort',
      () => entry.abort.signal.removeEventListener('abort', stopProcess),
      { once: true }
    );
    if (entry.abort.signal.aborted) abort.abort();
    let server: WorktreeKiloServerHandle | undefined;
    let serverClosed = false;
    const closeServer = (): void => {
      if (!server || serverClosed) return;
      serverClosed = true;
      const deadlineAt = cleanupDeadline(entry);
      void server.processes?.stop(deadlineAt);
      server.close(deadlineAt);
    };
    abort.signal.addEventListener('abort', closeServer, { once: true });
    try {
      if (retiring && (await retiring) !== 'retired')
        throw new Error('Predecessor native runtime is not contained');
      abort.signal.throwIfAborted();
      beforeMutation?.();
      const authDirectory = path.join(entry.env.XDG_DATA_HOME, 'kilo');
      await fs.mkdir(authDirectory, { recursive: true, mode: 0o700 });
      await fs.mkdir(entry.env.XDG_RUNTIME_DIR, { recursive: true, mode: 0o700 });
      await fs.mkdir(entry.directory, { recursive: true });
      await fs.writeFile(path.join(authDirectory, 'auth.json'), entry.env.KILO_AUTH_CONTENT, {
        mode: 0o600,
      });
      abort.signal.throwIfAborted();
      server = await (options.startServer ?? startWorktreeKiloServer)({
        directory: entry.directory,
        env: entry.env,
        signal: abort.signal,
        onProcessScope: processes => {
          entry.processes = processes;
          entry.processIssued = true;
          if (entry.cleanupDeadlineAt !== undefined) void processes.stop(entry.cleanupDeadlineAt);
        },
        onProcessObserver: observer => {
          entry.processObserver = observer;
        },
        claimCleanupDeadline: deadlineAt =>
          entry.processAbort === abort ? cleanupDeadline(entry, deadlineAt) : (deadlineAt ?? 0),
      });
      entry.processes = server.processes ?? entry.processes;
      entry.processObserver = server.processObserver ?? entry.processObserver;
      entry.processIssued = true;
      entry.stopped = server.stopped;
      void (server.exited ?? server.stopped)?.then(() => {
        if (!abort.signal.aborted) failRuntime(entry, 'process_exited');
      });
      abort.signal.throwIfAborted();
      const client = createKiloClient({ baseUrl: server.url, directory: entry.directory });
      const kiloClient = createWrapperKiloClient(client, server.url, entry.directory);
      const runtimeKiloClient: WrapperKiloClient = {
        ...kiloClient,
        async createPty(options) {
          if (entry.starting) {
            throw new WorktreeKiloRuntimeError(
              'session_busy',
              'Worktree credentials are refreshing',
              true
            );
          }
          entry.pendingPtys += 1;
          try {
            return await kiloClient.createPty(options);
          } finally {
            entry.pendingPtys -= 1;
          }
        },
      };
      entry.kiloClient = runtimeKiloClient;
      const runtime: WorktreeKiloRuntime = entry.runtime ?? {
        identity: { ...entry.identity },
        isolation: entry.isolation,
        scopeId: entry.kilo.scopeId,
        get runtimeId() {
          return entry.runtimeId;
        },
        directory: entry.directory,
        get env() {
          return entry.env;
        },
        get kiloClient() {
          if (!entry.kiloClient)
            throw new WorktreeKiloRuntimeError('not_ready', 'Kilo worktree is not ready', true);
          return entry.kiloClient;
        },
        signal: entry.abort.signal,
      };
      const feed = createWorktreeFeed({
        source: {
          scopeId: entry.kilo.scopeId,
          runtimeId: entry.runtimeId,
          directory: entry.directory,
          kiloClient: runtimeKiloClient,
          signal: abort.signal,
        },
        isCurrent: (runtimeId, client) =>
          entries.get(entryKey(entry.identity, entry.isolation)) === entry &&
          entry.runtimeId === runtimeId &&
          entry.kiloClient === client &&
          entry.processAbort === abort,
        onEvent: event => options.onEvent?.(runtime, event),
        onFailure: reason => failRuntime(entry, reason),
        onDiagnostic: options.onDiagnostic,
      });
      entry.feed = feed;
      await withTimeoutAndAbort(feed.open(), {
        timeoutMs: KILO_STARTUP_TIMEOUT_MS,
        timeoutMessage: 'Kilo event feed startup timed out',
        signal: abort.signal,
        abortMessage: 'Kilo worktree closed',
      });
      abort.signal.throwIfAborted();
      entry.runtime = runtime;
      const eventClient = createKiloEventClient({
        baseUrl: server.url,
        directory: entry.directory,
      });
      void withKiloRequestDeadline(
        signal => eventClient.global.health({ signal }),
        abort.signal
      ).then(
        health => {
          if (closed || abort.signal.aborted || entry.processAbort !== abort) return;
          recordVersion(health.data?.healthy === true ? health.data.version : null);
        },
        () => {
          if (!closed && !abort.signal.aborted && entry.processAbort === abort) {
            recordVersion(null);
          }
        }
      );
      return runtime;
    } catch {
      if (!server) entry.processIssued = false;
      if (entry.runtime) failRuntime(entry, 'credential_refresh_failed');
      else void retire(entry);
      closeServer();
      throw new WorktreeKiloRuntimeError('not_ready', 'Kilo worktree failed to start', true);
    } finally {
      entry.starting = undefined;
    }
  }

  async function refreshCredentials(
    entry: RuntimeEntry,
    kilo: WorktreeKiloAuth,
    env: Record<string, string>,
    canRefreshCredentials: () => boolean,
    beforeMutation?: () => void,
    onDestructiveRefresh?: () => void
  ): Promise<WorktreeKiloRuntime> {
    const retry = () =>
      new WorktreeKiloRuntimeError(
        'session_busy',
        'Worktree credentials require an idle runtime',
        true
      );
    const client = entry.kiloClient;
    if (!client || !entry.processAbort || !entry.stopped) {
      throw new WorktreeKiloRuntimeError('not_ready', 'Worktree cannot refresh credentials', true);
    }
    if (entry.pendingPtys > 0 || !canRefreshCredentials()) throw retry();
    const startedAt = Date.now();
    let probeStep: 'session_status' | 'pty' | 'pty_body' = 'session_status';
    try {
      const idle = await withKiloRequestDeadline(async signal => {
        probeStep = 'session_status';
        const statuses = await client.getSessionStatuses(entry.directory, signal);
        if (Object.values(statuses).some(status => status.type !== 'idle')) return false;
        const url = new URL('/pty', client.serverUrl);
        url.searchParams.set('directory', entry.directory);
        probeStep = 'pty';
        const response = await fetch(url, { signal });
        if (!response.ok) throw new Error(`Worktree PTY probe failed: HTTP ${response.status}`);
        probeStep = 'pty_body';
        let ptys: unknown;
        try {
          ptys = await response.json();
        } catch (error) {
          if (signal.aborted) throw error;
          throw new Error('Worktree PTY probe failed: invalid payload');
        }
        if (!Array.isArray(ptys)) throw new Error('Worktree PTY probe failed: invalid payload');
        return ptys.length === 0;
      }, entry.abort.signal);
      if (!idle || entry.pendingPtys > 0 || !canRefreshCredentials()) throw retry();
    } catch (error) {
      if (error instanceof WorktreeKiloRuntimeError) throw error;
      const elapsedMs = Date.now() - startedAt;
      const name = (error instanceof Error ? error.name : typeof error).slice(0, 128);
      const message = (error instanceof Error ? error.message : '').slice(0, 128);
      const cause =
        error instanceof Error && error.cause instanceof Error
          ? `;cause=${error.cause.name.slice(0, 128)}:${error.cause.message.slice(0, 128)}`
          : '';
      const target = `${client.serverUrl}${path.basename(entry.directory)}`;
      logToFile(
        `worktree idle probe failed step=${probeStep} target=${target} attempt=1 elapsedMs=${elapsedMs} name=${name} message=${message}${cause}`
      );
      const failure = new WorktreeKiloRuntimeError(
        'session_busy',
        'Worktree idle probe failed',
        true
      );
      options.onDiagnostic?.('control.request', {
        operation: 'session.attach',
        phase: 'failed',
        stage: 'runtime_attach',
        errorCode: failure.code,
        retryable: failure.retryable,
        elapsedMs,
        attempt: 1,
        reason: 'idle_probe_failed',
        detail: `step=${probeStep};name=${name}:${message}`.slice(0, 128),
      });
      throw failure;
    }
    const deadlineAt = cleanupDeadline(entry);
    onDestructiveRefresh?.();
    entry.processAbort.abort();
    try {
      const settled = await settleNativeCleanup({
        processes: entry.processes,
        processIssued: entry.processIssued === true,
        deadlineAt,
        observeDirect: innerDeadlineAt => directProcessAbsent(entry, innerDeadlineAt),
      });
      if (!settled) {
        throw new Error('Original native execution is not contained');
      }
      if (Date.now() >= deadlineAt) {
        throw new Error('Original native execution is not contained');
      }
      settleEntryDeferredRetirements(entry, undefined, 'stale');
      entry.kilo = { ...kilo, targets: { ...kilo.targets } };
      entry.env = env;
      entry.cleanupDeadlineAt = undefined;
      entry.kiloClient = undefined;
      resetRootPublicationCountersForRuntimeRotation(entry);
      const previousRuntimeId = entry.runtimeId;
      entry.runtimeId = crypto.randomUUID();
      emitWorktreeRuntimeAllocation(options.onDiagnostic, {
        directory: entry.directory,
        scopeId: entry.kilo.scopeId,
        action: 'refresh',
        previousRuntimeId,
        runtimeId: entry.runtimeId,
      });
      return await start(entry, undefined, beforeMutation);
    } catch {
      failRuntime(entry, 'credential_refresh_failed');
      throw new WorktreeKiloRuntimeError(
        'runtime_unhealthy',
        'Kilo worktree credential refresh failed',
        true
      );
    }
  }

  return {
    get kiloCliVersion() {
      return observedVersion ?? null;
    },
    attach(
      identity,
      kilo,
      environment,
      canRefreshCredentials,
      runtimeIsolation,
      beforeMutation,
      onCleanupTarget
    ) {
      if (closed) {
        throw new WorktreeKiloRuntimeError('not_ready', 'Kilo worktrees are closed', false);
      }
      const { directory } = identity;
      const isolation = runtimeIsolation ?? 'directory-shared';
      const key = entryKey(identity, isolation);
      if (recoveryGates.has(identityKey(identity))) {
        throw new WorktreeKiloRuntimeError('session_busy', 'Kilo runtime is retiring', true);
      }
      if (!path.isAbsolute(directory) || path.resolve(directory) !== directory) {
        throw new WorktreeKiloRuntimeError('protocol_error', 'Invalid worktree directory', false);
      }
      if (deletedDirectories.has(directory)) {
        throw new WorktreeKiloRuntimeError('not_ready', 'Kilo worktree is deleted', false);
      }
      let root = findRoot(identity);
      const scopeDirectory =
        isolation === 'directory-shared' ? directoriesByScope.get(kilo.scopeId) : undefined;
      const previous = entries.get(key);
      let entry = previous?.retiring ? undefined : previous;
      let cleanupRequired = false;
      let entryCreated = false;
      let refreshStarted = false;
      let changedEnvKeys: string[] = [];
      // A root is new when no attachment is already registered for this identity.
      // The containment-off refresh branch below must distinguish a sibling join
      // from renewal of an already-attached root.
      const newRoot = !root;
      if (
        (scopeDirectory && scopeDirectory !== directory) ||
        (entry && !sameAuth(entry.kilo, kilo)) ||
        (previous?.retirementResult === 'unconfirmed' && !sameAuth(previous.kilo, kilo))
      ) {
        throw new WorktreeKiloRuntimeError(
          'unauthorized',
          'Kilo worktree auth context mismatch',
          false
        );
      }
      if (previous?.retirementResult === 'unconfirmed') {
        void observeRetained(previous);
        throw new WorktreeKiloRuntimeError(
          'not_ready',
          'Native runtime retirement is unconfirmed',
          true
        );
      }
      if (entry?.abort.signal.aborted) {
        throw new WorktreeKiloRuntimeError('runtime_unhealthy', 'Kilo worktree is closed', true);
      }
      if (entry?.runtime && entry.starting) {
        throw new WorktreeKiloRuntimeError(
          'session_busy',
          'Worktree credentials are refreshing',
          true
        );
      }
      if (entry && kilo.containmentEnabled === false) {
        const env = buildWorktreeKiloEnvironment(
          directory,
          entry.env.HOME,
          kilo,
          environment,
          options.inheritedEnv
        );
        const currentEnv = entry.env;
        changedEnvKeys = Object.keys({ ...currentEnv, ...env }).filter(
          key => currentEnv[key] !== env[key]
        );
        // One live native runtime owns each directory. A brand-new root joining an
        // entry that already has live roots must reuse that runtime and its
        // credentials instead of rotating the fenced incarnation out from under a
        // committed sibling. Mandatory renewal stays on re-attach of an
        // already-attached root (newRoot === false); a sole root with no other live
        // root (for example after a detach) still refreshes. The incoming root is
        // not yet registered, so liveRoots() describes the siblings already in the
        // entry.
        const joiningLiveEntry = newRoot && liveRoots(entry).length > 0;
        if (changedEnvKeys.length > 0 && !joiningLiveEntry) {
          if (
            !entry.runtime ||
            entry.starting ||
            !canRefreshCredentials ||
            !canRefreshCredentials() ||
            [...entry.roots].some(current => current.pending.size > 0)
          ) {
            throw new WorktreeKiloRuntimeError(
              'session_busy',
              'Worktree credentials require an idle runtime',
              true
            );
          }
          const refreshing = entry;
          entry.starting = Promise.resolve()
            .then(() =>
              refreshCredentials(
                refreshing,
                kilo,
                env,
                canRefreshCredentials,
                beforeMutation,
                () => {
                  cleanupRequired = true;
                }
              )
            )
            .finally(() => {
              refreshing.starting = undefined;
            });
          refreshStarted = true;
        }
      }
      if (!entry) {
        if (previous) settleEntryDeferredRetirements(previous, undefined, 'stale');
        const homeId = createHash('sha256')
          .update(isolation === 'per-session' ? key : kilo.scopeId)
          .update('\0')
          .update(directory)
          .digest('hex');
        const home = path.join(
          options.homeRoot ?? path.join(os.tmpdir(), 'kilo-worktrees'),
          homeId
        );
        entry = {
          identity: { ...identity },
          isolation,
          kilo: { ...kilo, targets: { ...kilo.targets } },
          directory,
          env: buildWorktreeKiloEnvironment(
            directory,
            home,
            kilo,
            environment,
            options.inheritedEnv
          ),
          abort: new AbortController(),
          roots: new Set(),
          runtimeId: crypto.randomUUID(),
          pendingPtys: 0,
        };
        const homes = homesByDirectory.get(directory) ?? new Set<string>();
        homes.add(home);
        homesByDirectory.set(directory, homes);
        entries.set(key, entry);
        cleanupRequired = true;
        if (isolation === 'directory-shared') directoriesByScope.set(kilo.scopeId, directory);
        entryCreated = true;
      }
      // Capture the decision before this root is registered as pending so the
      // committed/pending counts describe the entry as the attaching root sees it.
      const decisionEntry = previous ?? entry;
      const committedRootCount = [...decisionEntry.roots].filter(
        current => current.attached
      ).length;
      const pendingRootCount = liveRoots(decisionEntry).length - committedRootCount;
      const action: WorktreeAttachAction = refreshStarted
        ? 'refresh'
        : entryCreated
          ? 'mint'
          : 'reuse';
      const reason = refreshStarted
        ? newRoot
          ? 'new_root_env_changed'
          : 'existing_root_env_changed'
        : entryCreated
          ? previous
            ? 'retiring'
            : 'no_entry'
          : 'live_entry';
      emitWorktreeAttachDecision(options.onDiagnostic, {
        directory,
        kiloSessionId: identity.kiloSessionId,
        scopeId: kilo.scopeId,
        action,
        reason,
        ...(previous ? { runtimeId: previous.runtimeId } : {}),
        previousPresent: previous !== undefined,
        retiring: previous?.retiring !== undefined,
        ...(previous?.retirementResult ? { retirementResult: previous.retirementResult } : {}),
        newRoot,
        aborted: decisionEntry.abort.signal.aborted,
        committedCount: committedRootCount,
        pendingCount: pendingRootCount,
        tokenChanged: changedEnvKeys.some(key => TOKEN_DERIVED_ENV_KEYS.has(key)),
        changedKeys: changedEnvKeys,
      });
      if (entryCreated) {
        emitWorktreeRuntimeAllocation(options.onDiagnostic, {
          directory,
          kiloSessionId: identity.kiloSessionId,
          scopeId: kilo.scopeId,
          action: 'mint',
          ...(previous ? { previousRuntimeId: previous.runtimeId } : {}),
          runtimeId: entry.runtimeId,
        });
      }
      if (!root) {
        root = {
          createdAt: Date.now(),
          identity: { ...identity },
          entry,
          abort: new AbortController(),
          attached: false,
          pending: new Set(),
          publication: emptyPublicationCounters(),
        };
        roots.set(identityKey(identity), root);
        entry.roots.add(root);
        rememberAttachedRoot(identity.kiloSessionId, directory);
      }
      const attachedRoot = root;
      const cleanupTarget = Object.freeze({ runtimeId: entry.runtimeId });
      onCleanupTarget?.(deadlineAt =>
        cleanupRequired ? retire(entry, deadlineAt, cleanupTarget) : Promise.resolve('stale')
      );
      const attempt = Symbol();
      attachedRoot.pending.add(attempt);
      const signal = AbortSignal.any([attachedRoot.abort.signal, entry.abort.signal]);
      const ready =
        entry.starting ??
        (entry.runtime
          ? Promise.resolve(entry.runtime)
          : (entry.starting = start(entry, previous?.retiring, beforeMutation)));
      return {
        ready,
        signal,
        cleanup(deadlineAt) {
          return cleanupRequired
            ? retire(entry, deadlineAt, cleanupTarget)
            : Promise.resolve('stale');
        },
        commit() {
          signal.throwIfAborted();
          if (!attachedRoot.pending.delete(attempt)) return;
          attachedRoot.attached = true;
        },
        release() {
          if (!attachedRoot.pending.delete(attempt)) return;
          if (!attachedRoot.attached && attachedRoot.pending.size === 0) removeRoot(attachedRoot);
        },
      };
    },
    detach(identity) {
      const root = findRoot(identity);
      if (!root) return false;
      removeRoot(root);
      return true;
    },
    async retireForRecovery(identity, recoveryId, assertIdle) {
      const key = identityKey(identity);
      const acknowledgements = recoveryAcknowledgements.get(key);
      const acknowledged = acknowledgements?.get(recoveryId);
      if (acknowledged) {
        await acknowledged;
        return 'acknowledged';
      }
      if (recoveryGates.has(key)) {
        throw new WorktreeKiloRuntimeError('session_busy', 'Kilo runtime is retiring', true);
      }
      const root = findRoot(identity);
      if (!root) {
        assertIdle();
        if (entries.has(entryKey(identity, 'per-session'))) {
          throw new WorktreeKiloRuntimeError(
            'not_ready',
            'Session runtime is not recoverable',
            false
          );
        }
        const absent = Promise.resolve<RecoveryRetirement>('absent');
        const byRecovery = acknowledgements ?? new Map<string, Promise<RecoveryRetirement>>();
        if (!acknowledgements) recoveryAcknowledgements.set(key, byRecovery);
        byRecovery.set(recoveryId, absent);
        return absent;
      }
      if (!root.attached) {
        throw new WorktreeKiloRuntimeError('session_busy', 'Session runtime is attaching', true);
      }
      if (root.entry.isolation !== 'per-session') {
        throw new WorktreeKiloRuntimeError(
          'not_ready',
          'Session runtime is not recoverable',
          false
        );
      }
      const entry = root.entry;
      if (!entry.runtime || !entry.kiloClient || !entry.stopped || entry.starting) {
        throw new WorktreeKiloRuntimeError('not_ready', 'Kilo worktree is not ready', true);
      }
      let releaseGate: () => void = () => {};
      const gate = new Promise<void>(resolve => {
        releaseGate = resolve;
      });
      recoveryGates.set(key, gate);
      const retirement = (async (): Promise<RecoveryRetirement> => {
        try {
          assertIdle();
          removeRoot(root);
          await retire(entry);
          return 'retired';
        } finally {
          recoveryGates.delete(key);
          releaseGate();
        }
      })();
      const byRecovery = acknowledgements ?? new Map<string, Promise<RecoveryRetirement>>();
      if (!acknowledgements) recoveryAcknowledgements.set(key, byRecovery);
      byRecovery.set(recoveryId, retirement);
      try {
        return await retirement;
      } catch (error) {
        if (byRecovery.get(recoveryId) === retirement) byRecovery.delete(recoveryId);
        throw error;
      }
    },
    async deleteDirectory(directory) {
      deletedDirectories.add(directory);
      for (const root of roots.values()) {
        if (root.identity.directory === directory) removeRoot(root);
      }
      for (const entry of [...entries.values()]) {
        if (entry.directory !== directory) continue;
        let quiescent = await withTimeoutAndAbort(retire(entry), {
          timeoutMs: KILO_STARTUP_TIMEOUT_MS,
          timeoutMessage: 'Kilo worktree retirement timed out',
          abortMessage: 'Kilo worktree retirement cancelled',
        });
        if (quiescent !== 'retired' && entry.retirementResult === 'unconfirmed') {
          if (
            (await observeRetained(entry)) ||
            entries.get(entryKey(entry.identity, entry.isolation)) !== entry
          )
            quiescent = 'retired';
        }
        if (quiescent !== 'retired') throw new Error('Native worktree cleanup is unconfirmed');
      }
      for (const home of homesByDirectory.get(directory) ?? []) {
        await fs.rm(home, { recursive: true, force: true });
      }
      homesByDirectory.delete(directory);
    },
    async retireRuntime(directory, deadlineAt, target) {
      const entry = target
        ? [...entries.values()].find(
            entry => entry.directory === directory && entry.runtimeId === target.runtimeId
          )
        : (entries.get(directory) ??
          [...entries.values()].find(entry => entry.directory === directory));
      if (!entry) return 'stale';
      return retire(entry, deadlineAt, target);
    },
    async retireRuntimeIfUnshared(directory, target, retiringRoot, deadlineAt, reason) {
      return retireRuntimeIfUnshared(directory, target, retiringRoot, deadlineAt, reason);
    },
    async deferRuntimeRetirementIfShared(directory, target, retiringRoot, deadlineAt, reason) {
      return deferRuntimeRetirementIfShared(directory, target, retiringRoot, deadlineAt, reason);
    },
    rootRetirementScope,
    async verifyQuiescence(directory, target, deadlineAt) {
      const entry = [...entries.values()].find(
        entry => entry.directory === directory && entry.runtimeId === target.runtimeId
      );
      if (
        !entry ||
        entry.runtimeId !== target.runtimeId ||
        entry.kiloClient !== target.client ||
        Date.now() >= deadlineAt
      )
        return false;
      const verified = await (entry.processes?.verify(true, deadlineAt) ?? Promise.resolve(false));
      return (
        verified &&
        Date.now() < deadlineAt &&
        entries.get(entryKey(entry.identity, entry.isolation)) === entry &&
        entry.runtimeId === target.runtimeId &&
        entry.kiloClient === target.client &&
        !entry.abort.signal.aborted
      );
    },
    getRetained(identity, runtimeId) {
      if (typeof identity === 'string') {
        const entry =
          runtimeId === undefined
            ? (entries.get(identity) ??
              [...entries.values()].find(entry => entry.directory === identity))
            : [...entries.values()].find(
                entry => entry.directory === identity && entry.runtimeId === runtimeId
              );
        return entry?.runtime;
      }
      const entry =
        entries.get(entryKey(identity, 'per-session')) ?? entries.get(identity.directory);
      if (runtimeId === undefined || entry?.runtimeId === runtimeId) return entry?.runtime;
      return [...entries.values()].find(
        entry => entry.directory === identity.directory && entry.runtimeId === runtimeId
      )?.runtime;
    },
    getEntryRuntimeId(directory, root) {
      const entry =
        [...entries.values()].find(
          entry =>
            entry.directory === directory &&
            entry.isolation === 'per-session' &&
            (root === undefined || entry.identity.kiloSessionId === root)
        ) ?? entries.get(directory);
      return entry?.runtimeId;
    },
    get(identity) {
      const entry =
        typeof identity === 'string'
          ? (entries.get(identity) ??
            [...entries.values()].find(entry => entry.directory === identity))
          : (entries.get(entryKey(identity, 'per-session')) ?? entries.get(identity.directory));
      const runtime = entry?.starting ? undefined : entry?.runtime;
      return !closed && runtime && !runtime.signal.aborted ? runtime : undefined;
    },
    prepareForNewWork(directory) {
      return [...entries.values()]
        .filter(entry => entry.directory === directory)
        .every(
          entry =>
            !entry.abort.signal.aborted &&
            (entry.runtime === undefined || entry.feed?.prepareForNewWork() === true)
        );
    },
    getAll(directory) {
      return [...entries.values()]
        .flatMap(entry => {
          const runtime = entry.starting ? undefined : entry.runtime;
          return !closed && runtime && !runtime.signal.aborted && entry.feed?.isFresh()
            ? [runtime]
            : [];
        })
        .filter(runtime => runtime.directory === directory);
    },
    isCurrent(runtime) {
      return (
        !closed &&
        runtime.identity !== undefined &&
        entries.get(entryKey(runtime.identity, runtime.isolation ?? 'directory-shared'))
          ?.runtime === runtime &&
        !runtime.signal.aborted
      );
    },
    feedRecovering(directory) {
      return [...entries.values()].some(
        entry =>
          entry.directory === directory &&
          !entry.abort.signal.aborted &&
          entry.runtime !== undefined &&
          entry.feed?.isRecovering() === true
      );
    },
    recordRootPublicationDiagnostic,
    snapshotRootPublicationDiagnostics,
    isHealthy() {
      return !closed;
    },
    shutdown() {
      if (closed) return;
      closed = true;
      for (const root of roots.values()) removeRoot(root);
      for (const entry of entries.values()) void retire(entry);
      for (const intent of [...deferredRetirements.values()])
        settleDeferredRetirement(intent, 'stale');
      directoriesByScope.clear();
    },
  };
}
