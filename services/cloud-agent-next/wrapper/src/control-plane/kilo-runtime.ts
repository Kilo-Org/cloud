import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createKiloClient } from '@kilocode/sdk';
import { createKiloClient as createKiloEventClient } from '@kilocode/sdk/v2/client';
import type {
  ControlDiagnosticReporter,
  KiloRestartFaultReason,
} from '../../../src/shared/control-diagnostics.js';
import type { ControlPlaneTimers } from '../../../src/shared/control-plane-timers.js';
import { createWrapperKiloClient, type WrapperKiloClient } from '../kilo-api.js';
import { createOwnedProcessScope, type OwnedProcessScope } from '../control/owned-processes.js';
import { isKiloServerProcess } from '../tool-cgroup.js';
import {
  admitControlWorkload,
  isWorkloadAtCap,
  type ControlWorkload,
  type WorkloadSnapshot,
} from '../control/workload-cgroup.js';
import {
  createKiloEventFeed,
  type KiloEventFeed,
  type KiloEventFeedSource,
  type KiloFeedEvent,
} from './kilo-event-feed.js';
import { logToFile, withTimeoutAndAbort } from '../utils.js';
import {
  createKiloMemoryHold,
  workloadMemorySampler,
  type KiloMemorySample,
} from './kilo-memory-hold.js';

import {
  createRuntimeActivity,
  type RuntimeActivity,
  type ActivityFault,
} from './runtime-activity.js';
import type { readSessionSnapshot } from './session-snapshot.js';
import type { ExecutionIdentity, ExecutionFailure } from './session-supervisor.js';

const PIDFILE_SUFFIX = '.pid.json';
const KILO_STARTUP_READY_PATTERN = /^kilo server listening on (http:\/\/127\.0\.0\.1:\d+)\r?\n/m;
const KILO_STARTUP_OUTPUT_LIMIT = 65_536;
/** Stop a replaced runtime within this bound; the wrapper's own cleanup budget. */
const KILO_STOP_TIMEOUT_MS = 30_000;
/** Watchdog granularity: six checks per silence window detects the 30 s rule promptly. */
const SILENCE_CHECKS_PER_WINDOW = 6;
/**
 * Fraction of the silence window a reconnected stream gets to deliver a real
 * event: 12 s at the 30 s rule, past Kilo's first heartbeat (10 s after connect).
 * The first watchdog check after it (15 s) replaces a stream that stayed silent,
 * so the six reconnects still fit in the reconnect window.
 */
const RECONNECT_PROOF_FRACTION = 0.4;
/** The `/global/event` handshake frame (see `turn.ts` synthetic events). */
const KILO_CONNECTED_EVENT = 'server.connected';
/** Bound on one control-plane Kilo request (legacy `KILO_CONTROL_REQUEST_TIMEOUT_MS`). */
const KILO_CONTROL_REQUEST_TIMEOUT_MS = 10_000;

export type KiloPidfile = { pid: number; startTime: string };

export function parseKiloPidfile(text: string): KiloPidfile | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const { pid, startTime } = record;
  if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0) return undefined;
  if (typeof startTime !== 'string' || !/^\d+$/.test(startTime)) return undefined;
  return { pid, startTime };
}

export function kiloPidfilePath(directory: string, pid: number): string {
  return path.join(directory, `${pid}${PIDFILE_SUFFIX}`);
}

/** Spec §7 "Crash resistance": the stable pidfile directory across wrapper restarts. */
export function defaultKiloPidfileDirectory(env: Record<string, string | undefined> = process.env) {
  const home = env.HOME && env.HOME.length > 0 ? env.HOME : os.tmpdir();
  return path.join(home, '.kilo-control', 'pids');
}

function readLinuxProcessStartTime(pid: number): string | undefined {
  if (process.platform !== 'linux') return undefined;
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = stat
      .slice(stat.lastIndexOf(')') + 2)
      .trim()
      .split(/\s+/);
    // Field 3 (state) is index 0, so field 22 (starttime) is index 19.
    const startTime = fields[19];
    return startTime !== undefined && /^\d+$/.test(startTime) ? startTime : undefined;
  } catch {
    return undefined;
  }
}

function defaultKillProcessGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // The process is already gone.
    }
  }
}

export type StaleKiloPidfileDeps = {
  directory: string;
  readProcessStartTime?: (pid: number) => string | undefined;
  killProcessGroup?: (pid: number, signal: NodeJS.Signals) => void;
  log?: (message: string) => void;
};

/**
 * Spec §7 "Crash resistance": at startup kill the process groups of stale
 * pidfiles whose PID and process start time still match, then clear the file.
 * A reused PID or an unreadable start time is never kill authority.
 */
export async function cleanupStaleKiloPidfiles(deps: StaleKiloPidfileDeps): Promise<number> {
  const log = deps.log ?? logToFile;
  const readStartTime = deps.readProcessStartTime ?? readLinuxProcessStartTime;
  const kill = deps.killProcessGroup ?? defaultKillProcessGroup;
  let entries: string[];
  try {
    entries = await fsp.readdir(deps.directory);
  } catch {
    return 0;
  }
  let killed = 0;
  for (const entry of entries) {
    if (!entry.endsWith(PIDFILE_SUFFIX)) continue;
    const file = path.join(deps.directory, entry);
    let record: KiloPidfile | undefined;
    try {
      record = parseKiloPidfile(await fsp.readFile(file, 'utf8'));
    } catch {
      record = undefined;
    }
    if (record) {
      const current = readStartTime(record.pid);
      if (current !== undefined && current === record.startTime) {
        kill(record.pid, 'SIGKILL');
        killed += 1;
        log(`control-plane killed stale kilo pid=${record.pid}`);
      }
    }
    await fsp.rm(file, { force: true }).catch(() => undefined);
  }
  return killed;
}

export type KiloRestartReason = KiloRestartFaultReason | 'credentials';
export type KiloRestartInfo = {
  directory: string;
  reason: KiloRestartReason;
  interruptedExecutions?: ExecutionIdentity[];
  outcomeReason?: string;
};

/**
 * The runtime's one lifecycle phase. `running` is healthy, `suspected` has seen
 * silence, `restarting` is replacing Kilo, `unavailable` spent the crash
 * budget, and `stopped` was shut down.
 */
export type KiloRuntimePhase = 'running' | 'suspected' | 'restarting' | 'unavailable' | 'stopped';

export type KiloRuntimeScheduler = {
  now(): number;
  setInterval(handler: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
};

const defaultScheduler: KiloRuntimeScheduler = {
  now: () => Date.now(),
  setInterval: (handler, ms) => setInterval(handler, ms),
  clearInterval: handle => clearInterval(handle as ReturnType<typeof setInterval>),
};

export type KiloProcess = {
  readonly pid: number;
  readonly url: string;
  /** Resolves when the process exits, for any reason. */
  readonly exited: Promise<void>;
  stop(deadlineAt: number): Promise<boolean>;
};

export type KiloProcessSpawnInput = {
  directory: string;
  env: Record<string, string>;
  workload?: ControlWorkload;
  onProcessScope?: (scope: OwnedProcessScope) => void;
  /** Aborts a hung startup; the spawner stops the process before rejecting. */
  signal?: AbortSignal;
};

export type KiloProcessSpawner = (input: KiloProcessSpawnInput) => Promise<KiloProcess>;

async function defaultSpawnKiloProcess(input: KiloProcessSpawnInput): Promise<KiloProcess> {
  const placement = admitControlWorkload(input.workload);
  const processes = createOwnedProcessScope(placement);
  input.onProcessScope?.(processes);
  // Own process group via the owned-process scope's detached spawn.
  const proc = processes.spawn('kilo', ['serve', '--hostname=127.0.0.1', '--port=0'], {
    cwd: input.directory,
    env: input.env,
  });
  proc.stderr.resume();
  const exited = new Promise<void>(resolve => {
    proc.once('exit', () => resolve());
    proc.once('error', () => {
      if (proc.pid === undefined) resolve();
    });
  });
  try {
    const url = await new Promise<string>((resolve, reject) => {
      let output = '';
      const onAbort = (): void => fail(new Error('Kilo server startup aborted'));
      const onData = (chunk: Buffer): void => {
        output = (output + chunk.toString()).slice(-KILO_STARTUP_OUTPUT_LIMIT);
        const match = KILO_STARTUP_READY_PATTERN.exec(output);
        if (match?.[1]) {
          cleanup();
          resolve(match[1]);
        }
      };
      const onExit = (): void => fail(new Error('Kilo server exited before startup'));
      const cleanup = (): void => {
        proc.stdout.removeListener('data', onData);
        proc.removeListener('exit', onExit);
        input.signal?.removeEventListener('abort', onAbort);
      };
      const fail = (error: Error): void => {
        cleanup();
        reject(error);
      };
      proc.stdout.on('data', onData);
      proc.once('exit', onExit);
      proc.on('error', () => fail(new Error('Kilo server failed to start')));
      input.signal?.addEventListener('abort', onAbort, { once: true });
      if (input.signal?.aborted) onAbort();
    });
    proc.stdout.resume();
    if (proc.pid === undefined) throw new Error('Kilo server has no pid');
    await processes.captureBaseline(isKiloServerProcess);
    const pid = proc.pid;
    return { pid, url, exited, stop: deadlineAt => processes.stop(deadlineAt) };
  } catch (error) {
    void processes.stop(Date.now() + KILO_STOP_TIMEOUT_MS);
    throw error;
  }
}

export type KiloRuntimeOptions = {
  directory: string;
  env: Record<string, string>;
  timers: ControlPlaneTimers;
  workload?: ControlWorkload;
  pidfileDirectory: string;
  log?: (message: string) => void;
  onNativeDiagnostic?: ControlDiagnosticReporter;
  onEvent?: (event: KiloFeedEvent) => void;
  onActivityChange?: () => void;
  onDeadline?: (identity: ExecutionIdentity, reason: ExecutionFailure) => void;
  readSnapshot?: typeof readSessionSnapshot;
  /** Fired after Kilo comes back with a fresh process; B8 hands over busy turns. */
  onRestart?: (info: KiloRestartInfo) => void;
  /**
   * Overrides the workload snapshot source. Production reads the runtime's own
   * process scope; tests that cannot spawn one inject a snapshot here.
   */
  latestWorkloadSnapshot?: () => WorkloadSnapshot | undefined;
  /** Fired once when the 3-in-10-minutes budget is spent (spec §7 "Kilo supervision"). */
  onUnavailable?: (directory: string) => void;
  /** Fired when a hang restart starts or stops waiting on memory pressure (spec §7). */
  onMemoryHold?: (info: { directory: string; held: boolean }) => void;
  /** Samples the memory cap Kilo shares with tools; defaults to the workload parent. */
  sampleMemory?: () => KiloMemorySample | undefined;
  scheduler?: KiloRuntimeScheduler;
  spawnKilo?: KiloProcessSpawner;
  openFeed?: (source: KiloEventFeedSource, callbacks: KiloFeedCallbacks) => KiloEventFeed;
  /** One `GET /global/health`; resolves true when Kilo answered healthy. */
  probeHealth?: (signal: AbortSignal) => Promise<boolean>;
  /** Reads the OS process start time; undefined means "cannot verify". */
  readProcessStartTime?: (pid: number) => string | undefined;
  /** True when every session is idle and no PTY is open (credential install gate). */
  isIdle?: (client: WrapperKiloClient, directory: string, signal: AbortSignal) => Promise<boolean>;
  /** Creates the Kilo home/auth/runtime directories before spawn (spec §7). */
  prepareFilesystem?: (env: Record<string, string>, directory: string) => Promise<void>;
};

export type KiloFeedCallbacks = {
  onEvent: (event: KiloFeedEvent) => void;
  onFailure: () => void;
  /** The runtime's per-attempt abort signal, passed to the feed. */
  signal: AbortSignal;
};

export type KiloRuntime = {
  readonly directory: string;
  readonly env: Record<string, string>;
  readonly client: WrapperKiloClient;
  ensure(): Promise<WrapperKiloClient>;
  /**
   * Stores the env immediately; the turn owner authorizes an idle restart.
   */
  installCredentials(env: Record<string, string>): Promise<void>;
  /** Restarts with the pending credentials when the runtime is idle. B8 calls this. */
  applyPendingCredentials(canRestart: () => boolean): Promise<boolean>;
  isRetiredClient(client: WrapperKiloClient): boolean;
  /** The live phase; the native status line counts these without a second reader. */
  phase(): KiloRuntimePhase;
  isSuspected(): boolean;
  isRestarting(): boolean;
  isUnavailable(): boolean;
  needsCompute(): boolean;
  sessionState(id: string): ReturnType<RuntimeActivity['state']>;
  refreshActivity(): Promise<void>;
  shutdown(): Promise<void>;
};

type HealthProbeObservation = {
  startedAt: number;
  finishedAt?: number;
  signal: AbortSignal;
  outcome:
    | 'pending'
    | 'healthy'
    | 'unhealthy'
    | 'http_error'
    | 'parse_error'
    | 'invalid_payload'
    | 'request_error'
    | 'aborted'
    | 'unknown';
  httpStatus?: number;
};

type HealthRestartTrigger =
  | 'health_probe_false'
  | 'sse_reconnect_budget'
  | 'process_exit'
  | 'no_client_retry'
  | ActivityFault;
type HealthDecisionResolution = 'fulfilled_false' | 'rejected' | 'not_applicable';

function createHealthProbe(
  url: string,
  directory: string,
  timeoutMs: number,
  observe: (observation: HealthProbeObservation) => void
): (signal: AbortSignal) => Promise<boolean> {
  const client = createKiloEventClient({ baseUrl: url, directory });
  return async (): Promise<boolean> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const observation: HealthProbeObservation = {
      startedAt: Date.now(),
      signal: controller.signal,
      outcome: 'pending',
    };
    observe(observation);
    try {
      const result = await client.global.health({ signal: controller.signal });
      const answered = result.data?.healthy === true;
      observation.finishedAt = Date.now();
      try {
        const status = result.response?.status;
        if (
          typeof status === 'number' &&
          Number.isInteger(status) &&
          status >= 100 &&
          status <= 599
        ) {
          observation.httpStatus = status;
        }
        const healthy: unknown = result.data?.healthy;
        observation.outcome = controller.signal.aborted
          ? 'aborted'
          : result.response && !result.response.ok
            ? 'http_error'
            : result.error instanceof SyntaxError
              ? 'parse_error'
              : answered
                ? 'healthy'
                : healthy === false
                  ? 'unhealthy'
                  : !result.response
                    ? 'request_error'
                    : result.error !== undefined
                      ? 'unknown'
                      : 'invalid_payload';
      } catch {
        observation.outcome = 'unknown';
      }
      return answered;
    } catch (error) {
      observation.finishedAt = Date.now();
      try {
        observation.outcome = controller.signal.aborted
          ? 'aborted'
          : error instanceof SyntaxError
            ? 'parse_error'
            : 'request_error';
      } catch {
        observation.outcome = 'unknown';
      }
      return false;
    } finally {
      clearTimeout(timer);
    }
  };
}

/** PTY half of credential maintenance; native idle comes from the supervisor. */
async function defaultIsIdle(
  client: WrapperKiloClient,
  directory: string,
  signal: AbortSignal
): Promise<boolean> {
  // The 10 s request deadline bounds a hung Kilo so it cannot stall the
  // credential re-prepare path before `session.ready`.
  const controller = new AbortController();
  const probeSignal = AbortSignal.any([signal, controller.signal]);
  try {
    return await withTimeoutAndAbort(
      (async () => {
        const url = new URL('/pty', client.serverUrl);
        url.searchParams.set('directory', directory);
        const response = await fetch(url, { signal: probeSignal });
        if (!response.ok) return false;
        const ptys: unknown = await response.json();
        return Array.isArray(ptys) && ptys.length === 0;
      })(),
      {
        signal,
        timeoutMs: KILO_CONTROL_REQUEST_TIMEOUT_MS,
        timeoutMessage: 'Kilo request timed out',
        abortMessage: 'Kilo request cancelled',
      }
    );
  } finally {
    controller.abort();
  }
}

/**
 * Spec §7 "Preparation" (legacy `worktree-runtime.ts` pre-spawn): create the
 * Kilo home and runtime directories and write auth.json before Kilo starts.
 * Kilo reads auth.json from disk, and a route with no git and no setup
 * commands never created the worktree directory itself.
 */
async function defaultPrepareFilesystem(
  env: Record<string, string>,
  directory: string
): Promise<void> {
  const dataHome = env.XDG_DATA_HOME;
  if (dataHome !== undefined && dataHome.length > 0) {
    const authDirectory = path.join(dataHome, 'kilo');
    await fsp.mkdir(authDirectory, { recursive: true, mode: 0o700 });
    await fsp.writeFile(path.join(authDirectory, 'auth.json'), env.KILO_AUTH_CONTENT ?? '', {
      mode: 0o600,
    });
  }
  const runtimeDir = env.XDG_RUNTIME_DIR;
  if (runtimeDir !== undefined && runtimeDir.length > 0) {
    await fsp.mkdir(runtimeDir, { recursive: true, mode: 0o700 });
  }
  await fsp.mkdir(directory, { recursive: true });
}

export function createKiloRuntime(options: KiloRuntimeOptions): KiloRuntime {
  const timers = options.timers.wrapper;
  const reconnectProofMs = Math.floor(timers.sseSilenceMs * RECONNECT_PROOF_FRACTION);
  const scheduler = options.scheduler ?? defaultScheduler;
  const log = options.log ?? logToFile;
  const spawnKilo = options.spawnKilo ?? defaultSpawnKiloProcess;
  const prepareFilesystem = options.prepareFilesystem ?? defaultPrepareFilesystem;
  const isIdle = options.isIdle ?? defaultIsIdle;
  const openFeed =
    options.openFeed ??
    ((source: KiloEventFeedSource, callbacks: KiloFeedCallbacks) =>
      createKiloEventFeed({
        source,
        signal: callbacks.signal,
        onEvent: callbacks.onEvent,
        onFailure: callbacks.onFailure,
        log,
      }));

  let kiloProcess: KiloProcess | undefined;
  let latestScope: OwnedProcessScope | undefined;
  // This runtime's own scope, never a sibling's: a restart must be attributed to
  // the memory this runtime's Kilo and tools actually used.
  const latestWorkloadSnapshot = (): WorkloadSnapshot | undefined =>
    latestScope?.latestSnapshot() ?? options.latestWorkloadSnapshot?.();
  let pidfilePath: string | undefined;
  let client: WrapperKiloClient | undefined;
  let feed: KiloEventFeed | undefined;
  let activity: RuntimeActivity | undefined;
  let nativeRuntimeId = '';
  let feedAttempt = 0;
  let probeHealth: ((signal: AbortSignal) => Promise<boolean>) | undefined;
  let healthObservation: HealthProbeObservation | undefined;
  let starting: Promise<WrapperKiloClient> | undefined;
  let startAbort: AbortController | undefined;
  let phase: KiloRuntimePhase = 'running';
  /** Spec §7: one health probe per silence episode, reset by any activity. */
  let probedThisEpisode = false;
  let pendingCredentials = false;
  /** Single-flight owner for the health probe and the reconnect loop. */
  let recovery: Promise<void> | undefined;
  let lastActivityAt = scheduler.now();
  let watchdog: unknown;
  const restarts: number[] = [];
  /** Spec §7: at most `sseReconnectLimit` stream reconnects per `sseReconnectWindowMs`. */
  const reconnects: number[] = [];
  const retiredClients = new WeakSet<WrapperKiloClient>();
  const memoryHold = createKiloMemoryHold({
    directory: options.directory,
    holdMs: timers.kiloMemoryHoldMs,
    sample: options.sampleMemory ?? workloadMemorySampler(options.workload),
    log,
    ...(options.onNativeDiagnostic ? { report: options.onNativeDiagnostic } : {}),
    onHeld: held => {
      activity?.holdMemory(held);
      options.onMemoryHold?.({ directory: options.directory, held });
    },
  });

  function onActivity(): void {
    lastActivityAt = scheduler.now();
    if (phase === 'suspected') phase = 'running';
    probedThisEpisode = false;
  }

  /** Kilo delivers events and its activity is observable, so a memory hold has recovered. */
  function isHealthy(): boolean {
    return (
      phase === 'running' &&
      scheduler.now() - lastActivityAt < timers.sseSilenceMs &&
      (activity?.isReady() ?? false)
    );
  }

  /** Reads the phase without TypeScript narrowing it to a stale assignment. */
  function currentPhase(): KiloRuntimePhase {
    return phase;
  }

  /** A runtime is suspected once it leaves `running`: suspected, restarting or unavailable. */
  function isSuspectedPhase(): boolean {
    return (
      phase === 'suspected' ||
      phase === 'restarting' ||
      phase === 'unavailable' ||
      (activity !== undefined && !activity.isReady())
    );
  }

  function pruneRestarts(now: number): void {
    while (restarts.length > 0 && now - restarts[0] >= timers.kiloRestartWindowMs) {
      restarts.shift();
    }
  }

  function pruneReconnects(now: number): void {
    while (reconnects.length > 0 && now - reconnects[0] >= timers.sseReconnectWindowMs) {
      reconnects.shift();
    }
  }

  /**
   * Opens one feed for a running Kilo and waits for it to prove itself: the
   * first delivered event resolves `true`, and a stream end or the
   * `healthRequestMs` bound resolves `false`. The runtime owns the hang rule,
   * so the feed runs no watchdog of its own.
   */
  function openAttempt(url: string, signal?: AbortSignal): Promise<boolean> {
    const attempt = ++feedAttempt;
    const processId = nativeRuntimeId;
    const currentActivity = activity;
    currentActivity?.lost();
    return new Promise<boolean>(resolve => {
      const controller = new AbortController();
      let settled = false;
      let first = true;
      const finish = (recovered: boolean): boolean => {
        if (settled) return false;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        if (recovered) {
          feed = next;
        } else {
          controller.abort();
          next.close();
        }
        resolve(recovered);
        return true;
      };
      const timer = setTimeout(() => {
        controller.abort();
        finish(false);
      }, timers.healthRequestMs);
      const onAbort = (): void => {
        controller.abort();
        finish(false);
      };
      const next = openFeed(
        { directory: options.directory, serverUrl: url, nativeRuntimeId: processId },
        {
          signal: controller.signal,
          onEvent: event => {
            if (
              controller.signal.aborted ||
              currentPhase() === 'stopped' ||
              processId !== nativeRuntimeId ||
              attempt !== feedAttempt
            )
              return;
            // The first frame is always `server.connected`: it proves the stream
            // opened, not that Kilo is delivering events, so it must not clear
            // the silence episode (`lastActivityAt`, `suspected`, the probe).
            if (event.type !== KILO_CONNECTED_EVENT) onActivity();
            currentActivity?.observe(event);
            options.onEvent?.(event);
            if (first) {
              first = false;
              finish(true);
              currentActivity?.connected();
            }
          },
          onFailure: () => {
            if (
              controller.signal.aborted ||
              processId !== nativeRuntimeId ||
              attempt !== feedAttempt
            )
              return;
            currentActivity?.lost();
            // A stream end completes the current attempt; with none in flight it
            // starts a new recovery episode. It never restarts Kilo directly.
            if (!finish(false)) void enterRecovery();
          },
        }
      );
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) onAbort();
      void next.open().catch(() => finish(false));
    });
  }

  async function runRecovery(): Promise<void> {
    while (phase === 'running' || phase === 'suspected') {
      const now = scheduler.now();
      pruneReconnects(now);
      if (reconnects.length >= timers.sseReconnectLimit) {
        // Spec §7: too many reconnects inside the window without a recovered
        // stream; restart Kilo.
        await restartHung('sse_reconnect_budget');
        return;
      }
      reconnects.push(now);
      phase = 'suspected';
      const current = kiloProcess;
      if (!current) return;
      const previous = feed;
      feed = undefined;
      previous?.close();
      if (await openAttempt(current.url)) return;
    }
  }

  /**
   * Spec §7: a hang restart waits while Kilo stalls in reclaim at the memory cap. The next
   * check probes again, so a Kilo that recovers is seen within one check.
   */
  async function restartHung(
    trigger: HealthRestartTrigger,
    decisionResolution?: HealthDecisionResolution
  ): Promise<void> {
    if (memoryHold.holds(scheduler.now())) {
      probedThisEpisode = false;
      return;
    }
    await restart('hang', trigger, decisionResolution);
  }

  /** Runs `work` under the one single-flight owner for the probe and recovery. */
  function runSingleFlight(work: () => Promise<void>): Promise<void> {
    recovery ??= work().finally(() => {
      recovery = undefined;
    });
    return recovery;
  }

  /** Single-flight recovery shared by the silence probe and stream ends. */
  function enterRecovery(): Promise<void> {
    return runSingleFlight(runRecovery);
  }

  function startWatchdog(): void {
    if (watchdog !== undefined) return;
    const intervalMs = Math.max(1, Math.floor(timers.sseSilenceMs / SILENCE_CHECKS_PER_WINDOW));
    // The first check compares memory against this sample.
    memoryHold.sample(scheduler.now(), false);
    watchdog = scheduler.setInterval(() => {
      memoryHold.sample(scheduler.now(), isHealthy());
      activity?.tick();
      void checkSilence();
    }, intervalMs);
  }

  function stopWatchdog(): void {
    if (watchdog === undefined) return;
    scheduler.clearInterval(watchdog);
    watchdog = undefined;
  }

  async function checkSilence(): Promise<void> {
    if (phase !== 'running' && phase !== 'suspected') return;
    if (recovery) return;
    if (scheduler.now() - lastActivityAt < timers.sseSilenceMs) return;
    // Spec §7: silence means a real fault. New prompts wait from here.
    phase = 'suspected';
    if (!client) {
      // A failed restart left no live Kilo and no exit hook. Keep restarting so
      // the attempts count toward the 3-in-10-minutes budget, then fail routes
      // (`agent_unavailable`) instead of staying degraded with no Kilo forever.
      if (!starting) void restart('exit', 'no_client_retry');
      return;
    }
    if (probedThisEpisode) {
      // Already probed this episode and still silent: keep reconnecting without
      // another probe so the reconnect budget is reachable from the silence
      // path within `sseReconnectWindowMs`. The newest stream first gets its
      // proof window; replacing it sooner would end it before its heartbeat.
      const lastReconnectAt = reconnects.at(-1);
      if (lastReconnectAt !== undefined && scheduler.now() - lastReconnectAt < reconnectProofMs) {
        return;
      }
      await enterRecovery();
      return;
    }
    probedThisEpisode = true;
    const probe = probeHealth;
    if (!probe) return;
    await runSingleFlight(async () => {
      let decisionResolution: HealthDecisionResolution = 'fulfilled_false';
      const answered = await withTimeoutAndAbort(
        probe(AbortSignal.timeout(timers.healthRequestMs)),
        {
          timeoutMs: timers.healthRequestMs,
          timeoutMessage: 'Kilo health request timed out',
          abortMessage: 'Kilo health request aborted',
        }
      ).catch(() => {
        decisionResolution = 'rejected';
        return false;
      });
      if (phase !== 'running' && phase !== 'suspected') return;
      if (!answered) {
        // No HTTP answer: Kilo is hung; restart it at once unless memory holds it.
        await restartHung('health_probe_false', decisionResolution);
        return;
      }
      // Kilo answered, so it is alive but its event stream stalled: recover the
      // stream (attempts are bounded by the reconnect budget) instead of
      // restarting the process.
      await runRecovery();
    });
  }

  async function stopProcess(): Promise<void> {
    feedAttempt++;
    activity?.dispose();
    activity = undefined;
    nativeRuntimeId = '';
    const current = kiloProcess;
    kiloProcess = undefined;
    // L3: never let `ensure` hand out the dead server's client.
    if (client !== undefined) retiredClients.add(client);
    client = undefined;
    probeHealth = undefined;
    const currentPidfile = pidfilePath;
    pidfilePath = undefined;
    const currentFeed = feed;
    feed = undefined;
    currentFeed?.close();
    if (!current) return;
    await current.stop(scheduler.now() + KILO_STOP_TIMEOUT_MS);
    if (currentPidfile !== undefined) {
      await fsp.rm(currentPidfile, { force: true }).catch(() => undefined);
    }
  }

  async function start(): Promise<WrapperKiloClient> {
    // Spec §7 pre-spawn filesystem: Kilo reads auth.json from disk, and a route
    // with no git and no setup commands never created the worktree directory.
    const env = options.env;
    await prepareFilesystem(env, options.directory);
    if (currentPhase() === 'stopped') throw new Error('Kilo runtime is shutting down');
    const controller = new AbortController();
    startAbort = controller;
    const deadline = setTimeout(
      () => controller.abort(new Error('Kilo startup timed out')),
      timers.kiloRuntimeStartMs
    );
    let spawned: KiloProcess;
    try {
      spawned = await spawnKilo({
        directory: options.directory,
        env,
        signal: controller.signal,
        ...(options.workload ? { workload: options.workload } : {}),
        onProcessScope: scope => {
          latestScope = scope;
        },
      });
    } catch (error) {
      clearTimeout(deadline);
      if (startAbort === controller) startAbort = undefined;
      throw error;
    }
    clearTimeout(deadline);
    if (phase === 'stopped') {
      await spawned.stop(scheduler.now() + KILO_STOP_TIMEOUT_MS);
      throw new Error('Kilo runtime is shutting down');
    }
    kiloProcess = spawned;
    nativeRuntimeId = randomUUID();
    let file: string | undefined;
    const startTime = (options.readProcessStartTime ?? readLinuxProcessStartTime)(spawned.pid);
    if (startTime !== undefined) {
      const pidfile = kiloPidfilePath(options.pidfileDirectory, spawned.pid);
      file = pidfile;
      await fsp
        .mkdir(options.pidfileDirectory, { recursive: true })
        .then(() => fsp.writeFile(pidfile, JSON.stringify({ pid: spawned.pid, startTime })))
        .catch(() => undefined);
    }
    if (currentPhase() === 'stopped') {
      if (file !== undefined) await fsp.rm(file, { force: true }).catch(() => undefined);
      throw new Error('Kilo runtime is shutting down');
    }
    pidfilePath = file;
    const kilo = createWrapperKiloClient(
      createKiloClient({ baseUrl: spawned.url, directory: options.directory }),
      spawned.url,
      options.directory
    );
    const processId = nativeRuntimeId;
    activity = createRuntimeActivity({
      nativeRuntimeId: processId,
      directory: options.directory,
      client: kilo,
      timers,
      now: () => scheduler.now(),
      readSnapshot: options.readSnapshot,
      onDeadline: (identity, reason) => options.onDeadline?.(identity, reason),
      onChange: () => options.onActivityChange?.(),
      onFault: reason => {
        if (nativeRuntimeId !== processId) return true;
        // Spec §7: observation that fails while the workload reclaims at its cap is held like
        // a silent Kilo; the activity keeps reading snapshots and faults again next check.
        if (reason === 'activity_observation' && memoryHold.holds(scheduler.now())) return false;
        void restart('hang', reason);
        return true;
      },
    });
    if (!(await openAttempt(spawned.url, controller.signal))) {
      // A failed start must not leave a usable-looking handle behind: clean up
      // so `ensure` re-spawns instead of returning a Kilo without a feed.
      await stopProcess();
      if (startAbort === controller) startAbort = undefined;
      throw new Error('Kilo event feed failed to open');
    }
    if (startAbort === controller) startAbort = undefined;
    if (currentPhase() === 'stopped') {
      await stopProcess();
      throw new Error('Kilo runtime is shutting down');
    }
    kiloProcess = spawned;
    pidfilePath = file;
    client = kilo;
    healthObservation = undefined;
    probeHealth =
      options.probeHealth ??
      createHealthProbe(spawned.url, options.directory, timers.healthRequestMs, observation => {
        healthObservation = observation;
      });
    pendingCredentials = options.env !== env;
    void spawned.exited.then(() => {
      if (spawned !== kiloProcess || (phase !== 'running' && phase !== 'suspected')) return;
      // Spec §7 "Kilo supervision": a Kilo process exit restarts Kilo.
      void restart('exit', 'process_exit');
    });
    lastActivityAt = scheduler.now();
    if (phase === 'suspected') phase = 'running';
    probedThisEpisode = false;
    // A new Kilo starts with a fresh reconnect budget; stale entries from the
    // previous process must not send an ordinary drop straight to restart.
    reconnects.length = 0;
    startWatchdog();
    await activity?.refresh();
    if (nativeRuntimeId !== processId || currentPhase() === 'stopped')
      throw new Error('Kilo runtime retired during activity snapshot');
    return kilo;
  }

  async function ensure(): Promise<WrapperKiloClient> {
    if (phase === 'stopped') throw new Error('Kilo runtime is shutting down');
    if (phase === 'unavailable') throw new Error('Kilo runtime is unavailable');
    if (client) return client;
    starting ??= start().finally(() => {
      starting = undefined;
    });
    return starting;
  }

  async function restart(
    reason: KiloRestartReason,
    trigger: HealthRestartTrigger | undefined,
    decisionResolution: HealthDecisionResolution = 'not_applicable'
  ): Promise<boolean> {
    if (phase === 'stopped' || phase === 'unavailable') return false;
    if (phase === 'restarting') return false;
    const now = scheduler.now();
    memoryHold.release(now, 'restarted');
    // A deliberate credential refresh is not a fault and does not spend the
    // 3-in-10-minutes crash budget (spec §7 "Kilo supervision").
    if (reason !== 'credentials') {
      pruneRestarts(now);
      if (restarts.length >= timers.kiloRestartLimit) {
        // Spec §7: 3 restarts in 10 minutes per runtime, then routes fail.
        phase = 'unavailable';
        stopWatchdog();
        await stopProcess();
        log(`control-plane kilo runtime unavailable directory=${options.directory}`);
        options.onUnavailable?.(options.directory);
        options.onNativeDiagnostic?.('wrapper.lifecycle', { phase: 'kilo_unavailable' });
        return false;
      }
      restarts.push(now);
    }
    const interruptedExecutions =
      activity?.executions().filter(execution => execution.activity !== 'stopping') ?? [];
    phase = 'restarting';
    const restartWorkload = trigger === 'health_probe_false' ? latestWorkloadSnapshot() : undefined;
    const outcomeReason =
      restartWorkload !== undefined && isWorkloadAtCap(restartWorkload)
        ? ('sandbox_out_of_memory' as const)
        : undefined;
    let diagnostic = '';
    if (reason !== 'credentials') {
      const observation = trigger === 'health_probe_false' ? healthObservation : undefined;
      const duration = observation
        ? (observation.finishedAt ?? Date.now()) - observation.startedAt
        : 0;
      const silence = now - lastActivityAt;
      const bound = (value: number) =>
        Number.isFinite(value) ? Math.min(600_000, Math.max(0, Math.floor(value))) : 0;
      diagnostic = ` diagnostic=${JSON.stringify({
        trigger,
        probeOutcome:
          observation?.outcome ?? (trigger === 'health_probe_false' ? 'unknown' : 'not_applicable'),
        decisionResolution,
        innerAbortObserved: observation?.signal.aborted ?? false,
        ...(observation?.httpStatus !== undefined ? { httpStatus: observation.httpStatus } : {}),
        probeDurationMs: bound(duration),
        probeDurationClamped: bound(duration) !== duration,
        sseSilenceMs: bound(silence),
        sseSilenceClamped: bound(silence) !== silence,
        reconnectCount: Math.min(6, reconnects.length),
        ...(trigger === 'health_probe_false' && restartWorkload !== undefined
          ? {
              workload: {
                currentBytes: restartWorkload.currentBytes,
                aggregateMaxBytes: restartWorkload.aggregateMaxBytes,
                anonBytes: restartWorkload.anonBytes,
                fileBytes: restartWorkload.fileBytes,
                shmemBytes: restartWorkload.shmemBytes,
                toolCurrentBytes: restartWorkload.toolCurrentBytes,
                serverCurrentBytes: restartWorkload.serverCurrentBytes,
                pressureAvailable: restartWorkload.pressureAvailable,
              },
            }
          : {}),
      })}`;
    }
    log(
      `control-plane kilo restarting directory=${options.directory} reason=${reason} pid=${kiloProcess?.pid ?? 'none'}${diagnostic}`
    );
    // The decision, before the process is replaced. A credential refresh is not
    // a fault and is not projected.
    if (reason !== 'credentials') {
      options.onNativeDiagnostic?.('wrapper.lifecycle', {
        phase: 'kilo_restarting',
        kiloRestartReason: reason,
      });
    }
    try {
      // Share the start with `ensure` so a concurrent ensure cannot spawn a
      // second Kilo while the old process is being replaced (L3).
      starting ??= (async () => {
        await stopProcess();
        if (currentPhase() === 'stopped') throw new Error('Kilo runtime is shutting down');
        return start();
      })().finally(() => {
        starting = undefined;
      });
      await starting;
    } catch (error) {
      log(
        `control-plane kilo restart failed directory=${options.directory} reason=${reason} error=${
          error instanceof Error ? error.message : String(error)
        }`
      );
      if (currentPhase() !== 'stopped') phase = 'suspected';
      if (currentPhase() !== 'stopped' && reason !== 'credentials') {
        options.onNativeDiagnostic?.('wrapper.lifecycle', {
          phase: 'kilo_restart_failed',
          kiloRestartReason: reason,
        });
      }
      return false;
    }
    // The restart is complete before callbacks run, so a handler that calls
    // `ensure`/`isRestarting` sees a healthy runtime. A throwing handler must
    // not reject `restart()`, whose callers are fire-and-forget.
    const restarted = currentPhase() !== 'stopped';
    if (restarted) phase = 'running';
    log(
      `control-plane kilo restarted directory=${options.directory} reason=${reason} pid=${kiloProcess?.pid ?? 'none'}`
    );
    // A restart that landed on a shutdown is not a completed restart; do not
    // report it as healthy.
    if (restarted && reason !== 'credentials') {
      options.onNativeDiagnostic?.('wrapper.lifecycle', {
        phase: 'kilo_restarted',
        kiloRestartReason: reason,
      });
    }
    try {
      options.onRestart?.({
        directory: options.directory,
        reason,
        interruptedExecutions,
        ...(outcomeReason === undefined ? {} : { outcomeReason }),
      });
    } catch (error) {
      log(
        `control-plane kilo restart handler failed directory=${options.directory} error=${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
    return true;
  }

  async function applyPendingCredentials(canRestart: () => boolean): Promise<boolean> {
    const applyPhase = currentPhase();
    if (
      !pendingCredentials ||
      (activity !== undefined && !activity.isIdle()) ||
      applyPhase === 'stopped' ||
      applyPhase === 'unavailable' ||
      applyPhase === 'restarting'
    ) {
      return false;
    }
    const current = client;
    if (!current) {
      // Nothing running to replace; the next start picks up the stored env.
      if (!starting) pendingCredentials = false;
      return false;
    }
    let idle = false;
    try {
      idle = await isIdle(current, options.directory, new AbortController().signal);
    } catch {
      idle = false;
    }
    const phaseAfterIdle = currentPhase();
    if (
      !idle ||
      (activity !== undefined && !activity.isIdle()) ||
      !pendingCredentials ||
      client !== current ||
      starting !== undefined ||
      phaseAfterIdle === 'stopped' ||
      phaseAfterIdle === 'unavailable' ||
      phaseAfterIdle === 'restarting' ||
      !canRestart()
    ) {
      return false;
    }
    return restart('credentials', undefined);
  }

  return {
    directory: options.directory,
    get env() {
      return options.env;
    },
    get client() {
      if (!client) throw new Error('Kilo runtime has not started');
      return client;
    },
    ensure,
    isRetiredClient: candidate => retiredClients.has(candidate),
    async installCredentials(env: Record<string, string>): Promise<void> {
      // Store the refreshed env immediately; the running process keeps the old
      // grant (valid below 1 h) until an idle restart applies the new one.
      options.env = env;
      pendingCredentials = true;
    },
    applyPendingCredentials,
    needsCompute: () => activity?.needsCompute() ?? false,
    sessionState: id => activity?.state(id),
    refreshActivity: () => activity?.refresh() ?? Promise.resolve(),
    phase: currentPhase,
    isSuspected: isSuspectedPhase,
    isRestarting: () => phase === 'restarting',
    isUnavailable: () => phase === 'unavailable',
    async shutdown(): Promise<void> {
      if (phase === 'stopped') return;
      phase = 'stopped';
      memoryHold.release(scheduler.now(), 'stopped');
      startAbort?.abort(new Error('Kilo runtime is shutting down'));
      stopWatchdog();
      await stopProcess();
      client = undefined;
    },
  };
}

export type KiloRuntimesOptions = Omit<
  KiloRuntimeOptions,
  | 'directory'
  | 'env'
  | 'pidfileDirectory'
  | 'onRestart'
  | 'onUnavailable'
  | 'onDeadline'
  | 'onActivityChange'
  | 'onMemoryHold'
> & {
  pidfileDirectory?: string;
  createRuntime?: (options: KiloRuntimeOptions) => KiloRuntime;
  /** Carries the runtime key so the handler can match its own turns (B8 finding 4). */
  onRestart?: (info: KiloRestartInfo & { key: string }) => void;
  onUnavailable?: (directory: string, key: string) => void;
  onDeadline?: (identity: ExecutionIdentity, reason: ExecutionFailure, key: string) => void;
  onActivityChange?: (key: string) => void;
  onMemoryHold?: (info: { directory: string; held: boolean; key: string }) => void;
};

export type KiloRuntimes = {
  ensure(input: {
    key: string;
    directory: string;
    env: Record<string, string>;
    workload?: ControlWorkload;
  }): Promise<WrapperKiloClient>;
  get(key: string): KiloRuntime | undefined;
  remove(key: string): void;
  needsCompute(): boolean;
  suspected(): boolean;
  unavailable(): boolean;
  /** One walk of the existing runtimes map for the native status line. */
  summary(): {
    runtimeCount: number;
    suspectedCount: number;
    restartingCount: number;
    unavailableCount: number;
  };
  /** Live runtimes serving one directory; worktree deletion retires them (R2). */
  runtimesForDirectory(directory: string): KiloRuntime[];
  /** Stops and removes every runtime serving one directory (worktree deletion). */
  retireDirectory(directory: string): Promise<void>;
  shutdown(): Promise<void>;
};

/**
 * A per-session route asked to reuse a warm runtime whose materialized MCP
 * servers differ. The route must fail rather than silently accept the change
 * (legacy `worktree-runtime.ts` `mcpSignature` drift rejection). Non-retryable:
 * the caller must not drop and recreate the runtime to "fix" it.
 */
export class KiloWorktreeMcpMismatchError extends Error {
  constructor() {
    super('Kilo worktree MCP configuration mismatch');
    this.name = 'KiloWorktreeMcpMismatchError';
  }
}

/**
 * The MCP portion of the runtime configuration. Credential refreshes rotate the
 * Kilo alias inside `KILO_CONFIG_CONTENT`, so comparing the whole config would
 * false-positive; only `mcp` identifies the session's server set.
 */
function mcpConfigurationSignature(env: Record<string, string>): string {
  const raw = env.KILO_CONFIG_CONTENT;
  if (raw === undefined) return '';
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return raw;
    return JSON.stringify((parsed as { mcp?: unknown }).mcp ?? {});
  } catch {
    return raw;
  }
}

/**
 * One Kilo runtime per directory (or per session under per-session isolation).
 * A fresh `ensure` after the restart budget is spent replaces the runtime,
 * which resets the budget (spec §7 "Preparation": a re-prepare starts fresh).
 */
export function createKiloRuntimes(options: KiloRuntimesOptions): KiloRuntimes {
  const createRuntime = options.createRuntime ?? createKiloRuntime;
  const pidfileDirectory = options.pidfileDirectory ?? defaultKiloPidfileDirectory();
  const runtimes = new Map<string, KiloRuntime>();

  const anySuspected = (): boolean => [...runtimes.values()].some(runtime => runtime.isSuspected());

  return {
    async ensure(input) {
      const existing = runtimes.get(input.key);
      if (existing && !existing.isUnavailable()) {
        // A per-session MCP route must own its runtime: reuse only when the
        // materialized servers are unchanged.
        if (mcpConfigurationSignature(existing.env) !== mcpConfigurationSignature(input.env)) {
          throw new KiloWorktreeMcpMismatchError();
        }
        return existing.ensure();
      }
      if (existing) {
        // Retire the old runtime before awaiting its shutdown: a second session
        // on the same key must not see the shutting-down runtime (`stopped`
        // reports not-unavailable) and call `ensure` on it. `remove` and
        // `retireDirectory` already delete before shutting down.
        runtimes.delete(input.key);
        await existing.shutdown();
      }
      const runtime = createRuntime({
        ...options,
        directory: input.directory,
        env: input.env,
        pidfileDirectory,
        ...(input.workload ? { workload: input.workload } : {}),
        onEvent: event => options.onEvent?.({ ...event, runtimeKey: input.key }),
        onRestart: info => options.onRestart?.({ ...info, key: input.key }),
        onDeadline: (identity, reason) => options.onDeadline?.(identity, reason, input.key),
        onActivityChange: () => options.onActivityChange?.(input.key),
        onUnavailable: directory => options.onUnavailable?.(directory, input.key),
        onMemoryHold: info => options.onMemoryHold?.({ ...info, key: input.key }),
      });
      runtimes.set(input.key, runtime);
      return runtime.ensure();
    },
    get: key => runtimes.get(key),
    remove(key) {
      const runtime = runtimes.get(key);
      if (!runtime) return;
      runtimes.delete(key);
      void runtime.shutdown();
    },
    needsCompute: () => [...runtimes.values()].some(runtime => runtime.needsCompute()),
    suspected: anySuspected,
    unavailable: () => [...runtimes.values()].some(runtime => runtime.isUnavailable()),
    summary() {
      let suspectedCount = 0;
      let restartingCount = 0;
      let unavailableCount = 0;
      for (const runtime of runtimes.values()) {
        const phase = runtime.phase();
        if (phase === 'suspected') suspectedCount += 1;
        else if (phase === 'restarting') restartingCount += 1;
        else if (phase === 'unavailable') unavailableCount += 1;
      }
      return {
        runtimeCount: runtimes.size,
        suspectedCount,
        restartingCount,
        unavailableCount,
      };
    },
    runtimesForDirectory: directory =>
      [...runtimes.values()].filter(runtime => runtime.directory === directory),
    async retireDirectory(directory) {
      const targets = [...runtimes.entries()].filter(
        ([, runtime]) => runtime.directory === directory
      );
      for (const [key] of targets) runtimes.delete(key);
      await Promise.all(targets.map(([, runtime]) => runtime.shutdown()));
    },
    async shutdown() {
      const all = [...runtimes.values()];
      runtimes.clear();
      await Promise.all(all.map(runtime => runtime.shutdown()));
    },
  };
}
