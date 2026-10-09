import { spawnSync } from 'node:child_process';
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  statfsSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import type {
  ControlDiagnosticFields,
  ControlDiagnosticReporter,
} from '../../../src/shared/control-diagnostics.js';
import { isKiloServerProcess, readMemTotalBytes } from '../tool-cgroup.js';

export const CONTROL_WORKLOAD_CGROUP_ENV = 'CONTROL_WORKLOAD_CGROUP';
export const CONTROL_WORKLOAD_RESERVE_MB_ENV = 'CONTROL_WORKLOAD_RESERVE_MB';
export const CONTROL_WORKLOAD_LIMIT_MB_ENV = 'CONTROL_WORKLOAD_LIMIT_MB';

export const DEFAULT_CONTROL_RESERVE_BYTES = 1024 * 1024 * 1024;
/**
 * Part of the aggregate that tools can never take, so a tool at its cap is reclaimed and
 * OOM-killed inside the tools group while Kilo keeps this much room under the shared parent.
 */
export const KILO_SERVER_HEADROOM_BYTES = 1536 * 1024 * 1024;
/** Kilo's `memory.min`: reclaim at the shared cap takes tools and page cache before this. */
export const KILO_SERVER_MIN_BYTES = 1024 * 1024 * 1024;
export const MIN_WORKLOAD_CAP_BYTES = 1024 * 1024 * 1024;
export const WORKLOAD_CPU_WEIGHT = 50;
export const WORKLOAD_SWEEP_INTERVAL_MS = 1000;
/**
 * Stats are observation only, so they sample far slower than the containment
 * sweep. The sweep still runs every second to migrate new processes; emitting
 * its monotonic cpu/io/memory counters at that rate floods the diagnostic stream.
 */
export const WORKLOAD_STATS_INTERVAL_MS = 30_000;
/**
 * Bounds the immediate triggers (throttle/memory-event increases, first
 * pressure crossing). Those counters are monotonic and can increase on
 * consecutive one-second sweeps, so without a cooldown a scope parked at its
 * limit would emit on almost every sweep.
 */
export const WORKLOAD_STATS_EVENT_COOLDOWN_MS = 10_000;
export const WORKLOAD_MEMORY_PRESSURE_FRACTION = 0.9;
/**
 * Pressure latches at `WORKLOAD_MEMORY_PRESSURE_FRACTION` and only releases
 * below this fraction, so `memory.current` oscillating around the threshold
 * cannot re-arm the trigger every sweep.
 */
export const WORKLOAD_MEMORY_PRESSURE_RELEASE_FRACTION = 0.8;
export const WORKLOAD_PARENT_NAME = 'kilo-workloads';
export const WORKLOAD_SERVER_NAME = 'server';
export const WORKLOAD_TOOLS_NAME = 'tools';
export const WORKLOAD_RUNTIME_NAME = 'kilo-runtime';
export const WORKLOAD_DEFAULT_CPU_WEIGHT = 100;
export const CGROUP_FS_MAGIC = 0x63677270;

const MAX_EVACUATION_PASSES = 3;

export type WorkloadFailure =
  | 'flag_off'
  | 'no_finite_limit'
  | 'below_minimum'
  | 'not_delegated'
  | 'occupied'
  | 'controller_unavailable'
  | 'readback_mismatch'
  | 'write_failed'
  | 'unavailable'
  | 'pid_changed'
  | 'membership_unconfirmed';

export type WorkloadPhase =
  | 'probe'
  | 'applied'
  | 'protection'
  | 'migration'
  | 'oom'
  | 'stats'
  | 'rollback'
  | 'failed';

export type WorkloadLimitSource = 'cgroup' | 'explicit' | 'meminfo';

export type WorkloadPlacement = {
  parentFd: number;
  parentDev: number;
  parentIno: number;
  parentReference: string;
  parentDirectory: string;
  aggregateMaxBytes: number;
  toolsMaxBytes: number;
  appliedReadbackBytes: number;
  containerLimitBytes: number;
  limitSource: WorkloadLimitSource;
  cpuWeight: number;
  cpuController: boolean;
  sweepIntervalMs: number;
  report?: ControlDiagnosticReporter;
};

export type ControlWorkload = {
  enabled: boolean;
  placement?: WorkloadPlacement;
  failure?: WorkloadFailure;
};

export type WorkloadProcessEntry = { pid: number; ppid: number; argv: string[] };

export type WorkloadStats = {
  currentBytes?: number;
  peakBytes?: number;
  anonBytes?: number;
  /** Page cache including `shmemBytes`; only the non-shmem part is reclaimable without swap. */
  fileBytes?: number;
  shmemBytes?: number;
  memoryMaxEvents?: number;
  memoryOomEvents?: number;
  oomKills: number;
  oomGroupKills: number;
  /** Whether the kernel exposes cgroup v2 `memory.pressure` (PSI). */
  pressureAvailable: boolean;
  pressureSomeTotal?: number;
  pressureFullTotal?: number;
  cpuUsageUsec?: number;
  cpuThrottledUsec?: number;
  cpuThrottleCount?: number;
  ioReadBytes?: number;
  ioWriteBytes?: number;
};

/**
 * The last observed workload state for one scope. Unlike an emitted stats
 * record it is updated on every sweep, so a restart decision made between
 * samples still sees the current attribution.
 */
export type WorkloadSnapshot = {
  scopeId?: string;
  aggregateMaxBytes: number;
  toolsMaxBytes: number;
  containerLimitBytes: number;
  currentBytes?: number;
  peakBytes?: number;
  anonBytes?: number;
  fileBytes?: number;
  shmemBytes?: number;
  toolCurrentBytes?: number;
  toolPeakBytes?: number;
  serverCurrentBytes?: number;
  serverPeakBytes?: number;
  pressureAvailable: boolean;
  memoryMaxEvents?: number;
  memoryOomEvents?: number;
  oomKills: number;
  oomGroupKills: number;
  toolOomKills: number;
  serverOomKills: number;
};

export type WorkloadStatsEmissionState = {
  lastEmittedAtMs: number;
  lastThrottleCount?: number;
  lastMemoryMaxEvents?: number;
  lastMemoryOomEvents?: number;
  highPressure: boolean;
};

export type WorkloadStatsEmissionReason =
  | 'interval'
  | 'throttle_increase'
  | 'memory_events'
  | 'memory_pressure'
  | 'none';

export type WorkloadStatsEmissionDecision = {
  emit: boolean;
  reason: WorkloadStatsEmissionReason;
  state: WorkloadStatsEmissionState;
};

/**
 * Periodic stats are capped to `WORKLOAD_STATS_INTERVAL_MS`, but an actionable
 * change (a new throttle or memory-event counter, or the first crossing into
 * high memory pressure) emits sooner so the signal is not delayed to the next
 * sample. Immediate emissions share `WORKLOAD_STATS_EVENT_COOLDOWN_MS` because
 * the underlying counters are monotonic and would otherwise fire on every
 * one-second sweep. Emission baselines advance only when a record is emitted,
 * so an increase observed between samples still surfaces on the next decision.
 */
export function decideWorkloadStatsEmission(input: {
  nowMs: number;
  stats: WorkloadStats;
  limitBytes?: number;
  state: WorkloadStatsEmissionState;
}): WorkloadStatsEmissionDecision {
  const { nowMs, stats, limitBytes, state } = input;
  const current = stats.currentBytes;
  const abovePressure =
    limitBytes !== undefined &&
    current !== undefined &&
    current >= limitBytes * WORKLOAD_MEMORY_PRESSURE_FRACTION;
  const highPressure =
    abovePressure ||
    (state.highPressure &&
      limitBytes !== undefined &&
      current !== undefined &&
      current >= limitBytes * WORKLOAD_MEMORY_PRESSURE_RELEASE_FRACTION);
  const throttleIncreased =
    stats.cpuThrottleCount !== undefined &&
    state.lastThrottleCount !== undefined &&
    stats.cpuThrottleCount > state.lastThrottleCount;
  const memoryEventsIncreased =
    (stats.memoryMaxEvents !== undefined &&
      state.lastMemoryMaxEvents !== undefined &&
      stats.memoryMaxEvents > state.lastMemoryMaxEvents) ||
    (stats.memoryOomEvents !== undefined &&
      state.lastMemoryOomEvents !== undefined &&
      stats.memoryOomEvents > state.lastMemoryOomEvents);
  const sinceEmittedMs = nowMs - state.lastEmittedAtMs;
  const reason: WorkloadStatsEmissionReason =
    sinceEmittedMs >= WORKLOAD_STATS_INTERVAL_MS
      ? 'interval'
      : sinceEmittedMs < WORKLOAD_STATS_EVENT_COOLDOWN_MS
        ? 'none'
        : throttleIncreased
          ? 'throttle_increase'
          : memoryEventsIncreased
            ? 'memory_events'
            : abovePressure && !state.highPressure
              ? 'memory_pressure'
              : 'none';
  if (reason === 'none') {
    return { emit: false, reason, state: { ...state, highPressure } };
  }
  return {
    emit: true,
    reason,
    state: {
      lastEmittedAtMs: nowMs,
      lastThrottleCount: stats.cpuThrottleCount,
      lastMemoryMaxEvents: stats.memoryMaxEvents,
      lastMemoryOomEvents: stats.memoryOomEvents,
      highPressure,
    },
  };
}

export class WorkloadUnavailableError extends Error {
  constructor(readonly failure: WorkloadFailure) {
    super(`Control workload unavailable: ${failure}`);
    this.name = 'WorkloadUnavailableError';
  }
}

type WorkloadEmission = ControlDiagnosticFields & {
  phase: 'started' | 'completed' | 'failed';
  workloadPhase: WorkloadPhase;
  workloadFailure?: WorkloadFailure;
};

export type WorkloadReporter = {
  emit(scopeId: string | undefined, fields: WorkloadEmission): void;
};

export type ControlWorkloadOptions = {
  env: Record<string, string | undefined>;
  report?: ControlDiagnosticReporter;
  cgroupRoot?: string;
  selfCgroupFile?: string;
  procRoot?: string;
  isCgroupMount?: (root: string) => boolean;
  handlePath?: (descriptor: number, directory: string) => string;
  platform?: NodeJS.Platform;
};

type ProbeResult =
  | { ok: true; placement: WorkloadPlacement }
  | { ok: false; failure: WorkloadFailure };

export function createWorkloadReporter(report?: ControlDiagnosticReporter): WorkloadReporter {
  const last = new Map<string, string>();
  return {
    emit(scopeId, fields) {
      if (!report) return;
      const key = JSON.stringify(fields);
      const bucket = scopeId ?? 'global';
      if (last.get(bucket) === key) return;
      last.set(bucket, key);
      try {
        report('control.workload', scopeId ? { ...fields, scopeId } : { ...fields });
      } catch {
        return;
      }
    },
  };
}

function parsePositiveMb(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

export function computeWorkloadBudget(input: {
  limits: (number | undefined)[];
  explicitLimitBytes?: number;
  memTotalBytes?: number;
  reserveBytes: number;
}):
  | {
      ok: true;
      containerLimitBytes: number;
      aggregateMaxBytes: number;
      toolsMaxBytes: number;
      source: WorkloadLimitSource;
    }
  | { ok: false; failure: WorkloadFailure } {
  const finite = input.limits.filter(
    (value): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0
  );
  let limit: number;
  let source: WorkloadLimitSource;
  if (finite.length > 0) {
    limit = Math.min(...finite);
    source = 'cgroup';
    if (input.explicitLimitBytes !== undefined && input.explicitLimitBytes < limit) {
      limit = input.explicitLimitBytes;
      source = 'explicit';
    }
  } else if (input.explicitLimitBytes !== undefined) {
    limit = input.explicitLimitBytes;
    source = 'explicit';
  } else if (
    typeof input.memTotalBytes === 'number' &&
    Number.isFinite(input.memTotalBytes) &&
    input.memTotalBytes > 0
  ) {
    limit = input.memTotalBytes;
    source = 'meminfo';
  } else {
    return { ok: false, failure: 'no_finite_limit' };
  }
  const aggregateMaxBytes = limit - input.reserveBytes;
  const toolsMaxBytes = aggregateMaxBytes - KILO_SERVER_HEADROOM_BYTES;
  if (toolsMaxBytes < MIN_WORKLOAD_CAP_BYTES) {
    return { ok: false, failure: 'below_minimum' };
  }
  return { ok: true, containerLimitBytes: limit, aggregateMaxBytes, toolsMaxBytes, source };
}

export function classifyWorkloadMembers(
  members: Iterable<number>,
  table: Map<number, WorkloadProcessEntry>,
  rootPid: number
): { serverPids: number[]; toolPids: number[] } {
  const memberSet = new Set(members);
  const childrenByPpid = new Map<number, WorkloadProcessEntry[]>();
  for (const entry of table.values()) {
    const siblings = childrenByPpid.get(entry.ppid);
    if (siblings) siblings.push(entry);
    else childrenByPpid.set(entry.ppid, [entry]);
  }
  const serverPids: number[] = [];
  const toolPids: number[] = [];
  const reached = new Set<number>();
  const queue = [rootPid];
  for (let index = 0; index < queue.length; index += 1) {
    for (const child of childrenByPpid.get(queue[index]) ?? []) {
      if (!memberSet.has(child.pid) || reached.has(child.pid)) continue;
      reached.add(child.pid);
      (isKiloServerProcess(child.argv) ? serverPids : toolPids).push(child.pid);
      queue.push(child.pid);
    }
  }
  for (const pid of memberSet) {
    if (pid === rootPid || reached.has(pid)) continue;
    toolPids.push(pid);
  }
  return { serverPids, toolPids };
}

export function parsePressureTotal(
  text: string | undefined,
  kind: 'some' | 'full'
): number | undefined {
  if (text === undefined) return undefined;
  for (const line of text.split('\n')) {
    if (!line.startsWith(`${kind} `)) continue;
    const match = /(?:^|\s)total=(\d+)(?:\s|$)/.exec(line);
    if (!match) return undefined;
    const parsed = Number.parseInt(match[1], 10);
    return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
  }
  return undefined;
}

export function readWorkloadStats(reference: string): WorkloadStats {
  const stats: WorkloadStats = { oomKills: 0, oomGroupKills: 0, pressureAvailable: false };
  const current = readControl(path.join(reference, 'memory.current'));
  const peak = readControl(path.join(reference, 'memory.peak'));
  const pressure = readControl(path.join(reference, 'memory.pressure'));
  const events = readControl(path.join(reference, 'memory.events'));
  const memoryStat = readControl(path.join(reference, 'memory.stat'));
  const cpu = readControl(path.join(reference, 'cpu.stat'));
  const io = readControl(path.join(reference, 'io.stat'));
  if (current.ok) {
    const parsed = Number.parseInt(current.text.trim(), 10);
    if (Number.isSafeInteger(parsed) && parsed >= 0) stats.currentBytes = parsed;
  }
  if (peak.ok) {
    const parsed = Number.parseInt(peak.text.trim(), 10);
    if (Number.isSafeInteger(parsed) && parsed >= 0) stats.peakBytes = parsed;
  }
  stats.pressureAvailable = pressure.ok;
  const some = parsePressureTotal(pressure.ok ? pressure.text : undefined, 'some');
  const full = parsePressureTotal(pressure.ok ? pressure.text : undefined, 'full');
  if (some !== undefined) stats.pressureSomeTotal = some;
  if (full !== undefined) stats.pressureFullTotal = full;
  if (memoryStat.ok) {
    for (const line of memoryStat.text.split('\n')) {
      const [key, value] = line.trim().split(/\s+/);
      const parsed = Number.parseInt(value ?? '', 10);
      if (!Number.isSafeInteger(parsed) || parsed < 0) continue;
      if (key === 'anon') stats.anonBytes = parsed;
      if (key === 'file') stats.fileBytes = parsed;
      if (key === 'shmem') stats.shmemBytes = parsed;
    }
  }
  if (events.ok) {
    for (const line of events.text.split('\n')) {
      const [key, value] = line.trim().split(/\s+/);
      const parsed = Number.parseInt(value ?? '', 10);
      if (!Number.isSafeInteger(parsed) || parsed < 0) continue;
      if (key === 'oom_kill') stats.oomKills = parsed;
      if (key === 'oom_group_kill') stats.oomGroupKills = parsed;
      if (key === 'max') stats.memoryMaxEvents = parsed;
      if (key === 'oom') stats.memoryOomEvents = parsed;
    }
  }
  if (cpu.ok) {
    for (const line of cpu.text.split('\n')) {
      const [key, value] = line.trim().split(/\s+/);
      const parsed = Number(value);
      if (!Number.isSafeInteger(parsed) || parsed < 0) continue;
      if (key === 'usage_usec') stats.cpuUsageUsec = parsed;
      if (key === 'throttled_usec') stats.cpuThrottledUsec = parsed;
      if (key === 'nr_throttled') stats.cpuThrottleCount = parsed;
    }
  }
  if (io.ok) {
    let readBytes = 0;
    let writeBytes = 0;
    for (const line of io.text.split('\n')) {
      for (const token of line.trim().split(/\s+/).slice(1)) {
        const [key, value] = token.split('=');
        const parsed = Number(value);
        if (!Number.isSafeInteger(parsed) || parsed < 0) continue;
        if (key === 'rbytes') readBytes += parsed;
        if (key === 'wbytes') writeBytes += parsed;
      }
    }
    if (Number.isSafeInteger(readBytes)) stats.ioReadBytes = readBytes;
    if (Number.isSafeInteger(writeBytes)) stats.ioWriteBytes = writeBytes;
  }
  return stats;
}

export function readWorkloadMembership(selfCgroupFile: string): string | undefined {
  const read = readControl(selfCgroupFile);
  if (!read.ok) return undefined;
  const line = read.text.split('\n').find(candidate => candidate.startsWith('0::'));
  const membership = line?.slice(3);
  if (
    !membership ||
    !path.posix.isAbsolute(membership) ||
    path.posix.normalize(membership) !== membership
  ) {
    return undefined;
  }
  return membership;
}

export function workloadAncestors(membership: string): string[] {
  const ancestors: string[] = [];
  let current = path.posix.dirname(membership);
  while (current !== membership) {
    ancestors.push(current);
    const next = path.posix.dirname(current);
    if (next === current) break;
    current = next;
  }
  return ancestors;
}

type ControlRead = { ok: true; text: string } | { ok: false; missing: boolean };

function isEnoent(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

function readControl(pathname: string): ControlRead {
  try {
    return { ok: true, text: readFileSync(pathname, 'utf8') };
  } catch (error) {
    return { ok: false, missing: isEnoent(error) };
  }
}

function writeControlOptional(pathname: string, value: string): void {
  try {
    writeFileSync(pathname, value);
  } catch {
    return;
  }
}

type TokenSetRead = { ok: true; tokens: Set<string> } | { ok: false; missing: boolean };

function readTokenSet(pathname: string): TokenSetRead {
  const read = readControl(pathname);
  if (!read.ok) return { ok: false, missing: read.missing };
  return {
    ok: true,
    tokens: new Set(
      read.text
        .trim()
        .split(/\s+/)
        .filter(Boolean)
        .map(token => token.replace(/^[+-]/, ''))
    ),
  };
}

type MemoryMaxRead =
  | { kind: 'limit'; bytes: number }
  | { kind: 'unbounded' }
  | { kind: 'missing' }
  | { kind: 'unreadable' };

function readMemoryMax(pathname: string): MemoryMaxRead {
  const read = readControl(pathname);
  if (!read.ok) return read.missing ? { kind: 'missing' } : { kind: 'unreadable' };
  const trimmed = read.text.trim();
  if (trimmed === 'max') return { kind: 'unbounded' };
  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) && parsed > 0
    ? { kind: 'limit', bytes: parsed }
    : { kind: 'unreadable' };
}

function parsePopulation(pathname: string): number | undefined {
  const read = readControl(pathname);
  if (!read.ok) return undefined;
  const entries = read.text.split('\n').filter(line => line.startsWith('populated '));
  if (entries.length !== 1 || !/^populated [01]$/.test(entries[0])) return undefined;
  return Number(entries[0].slice('populated '.length));
}

function isErofs(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'EROFS';
}

function remountCgroupWritable(target: string): void {
  spawnSync('mount', ['-o', 'remount,rw', target], { stdio: 'ignore' });
}

function defaultIsCgroupMount(root: string): boolean {
  try {
    return statfsSync(root).type === CGROUP_FS_MAGIC;
  } catch {
    return false;
  }
}

function defaultHandlePath(descriptor: number): string {
  return `/proc/self/fd/${descriptor}`;
}

type AncestorLookup =
  | { ok: true; relative: string; directory: string }
  | { ok: false; failure: 'not_delegated' | 'unavailable' };

function workloadCgroupCandidates(membership: string): string[] {
  return [membership, ...workloadAncestors(membership)];
}

function candidateDirectory(cgroupRoot: string, relative: string): string {
  return relative === '/' ? cgroupRoot : path.join(cgroupRoot, relative);
}

function scanDelegatingCgroup(cgroupRoot: string, candidates: string[]): AncestorLookup {
  for (const relative of candidates) {
    const directory = candidateDirectory(cgroupRoot, relative);
    const control = readTokenSet(path.join(directory, 'cgroup.subtree_control'));
    if (!control.ok) {
      if (control.missing) continue;
      return { ok: false, failure: 'unavailable' };
    }
    if (control.tokens.has('memory')) return { ok: true, relative, directory };
  }
  return { ok: false, failure: 'not_delegated' };
}

function enableMountRootControllers(cgroupRoot: string): void {
  const controlPath = path.join(cgroupRoot, 'cgroup.subtree_control');
  try {
    const enabled = new Set(readFileSync(controlPath, 'utf8').trim().split(/\s+/).filter(Boolean));
    const missing = ['memory', 'cpu'].filter(controller => !enabled.has(controller));
    if (missing.length > 0) {
      writeFileSync(controlPath, missing.map(controller => `+${controller}`).join(' '));
    }
  } catch {
    return;
  }
}

function readPids(pathname: string): number[] | undefined {
  const read = readControl(pathname);
  if (!read.ok) return undefined;
  const pids: number[] = [];
  for (const token of read.text.split(/\s+/)) {
    if (!token) continue;
    const pid = Number.parseInt(token, 10);
    if (Number.isSafeInteger(pid) && pid > 0) pids.push(pid);
  }
  return pids;
}

type RuntimeDirectory = { ok: true; directory: string } | { ok: false };

function prepareRuntimeDirectory(cgroupRoot: string): RuntimeDirectory {
  const directory = path.join(cgroupRoot, WORKLOAD_RUNTIME_NAME);
  let stat;
  try {
    stat = lstatSync(directory);
  } catch {
    try {
      mkdirSync(directory);
    } catch (error) {
      if (!isErofs(error)) return { ok: false };
      remountCgroupWritable(cgroupRoot);
      try {
        mkdirSync(directory);
      } catch {
        return { ok: false };
      }
    }
    return { ok: true, directory };
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) return { ok: false };
  const memory = readMemoryMax(path.join(directory, 'memory.max'));
  if (memory.kind === 'limit' || memory.kind === 'unreadable') return { ok: false };
  const procs = readControl(path.join(directory, 'cgroup.procs'));
  if (!procs.ok || procs.text.trim() !== '') return { ok: false };
  return { ok: true, directory };
}

function evacuateMountRoot(cgroupRoot: string): boolean {
  let remaining = readPids(path.join(cgroupRoot, 'cgroup.procs'));
  if (remaining === undefined || remaining.length === 0) return false;
  const runtime = prepareRuntimeDirectory(cgroupRoot);
  if (!runtime.ok) return false;
  for (let pass = 0; pass < MAX_EVACUATION_PASSES && remaining.length > 0; pass += 1) {
    for (const pid of remaining) {
      try {
        writeFileSync(path.join(runtime.directory, 'cgroup.procs'), String(pid));
      } catch {
        return false;
      }
    }
    remaining = readPids(path.join(cgroupRoot, 'cgroup.procs'));
    if (remaining === undefined) return false;
  }
  return remaining.length === 0;
}

function findUsableParent(cgroupRoot: string, membership: string): AncestorLookup {
  const delegatedAncestor = scanDelegatingCgroup(cgroupRoot, workloadAncestors(membership));
  if (delegatedAncestor.ok || delegatedAncestor.failure === 'unavailable') return delegatedAncestor;

  enableMountRootControllers(cgroupRoot);

  const selfEnabled = scanDelegatingCgroup(cgroupRoot, workloadCgroupCandidates(membership));
  if (selfEnabled.ok || selfEnabled.failure === 'unavailable') return selfEnabled;
  if (membership !== '/') return selfEnabled;

  if (!evacuateMountRoot(cgroupRoot)) return selfEnabled;

  enableMountRootControllers(cgroupRoot);
  return scanDelegatingCgroup(cgroupRoot, ['/']);
}

function probeWorkloadParent(input: {
  usable: { relative: string; directory: string };
  budget: {
    containerLimitBytes: number;
    aggregateMaxBytes: number;
    toolsMaxBytes: number;
    source: WorkloadLimitSource;
  };
  handlePath: (descriptor: number, directory: string) => string;
  report?: ControlDiagnosticReporter;
}): ProbeResult {
  const parentDirectory = path.join(input.usable.directory, WORKLOAD_PARENT_NAME);
  let parentFd: number | undefined;
  let retained = false;
  try {
    let exists = false;
    try {
      const stat = lstatSync(parentDirectory);
      if (stat.isSymbolicLink() || !stat.isDirectory()) return { ok: false, failure: 'occupied' };
      exists = true;
    } catch {
      exists = false;
    }
    if (exists) {
      const populated = parsePopulation(path.join(parentDirectory, 'cgroup.events'));
      if (populated !== 0) return { ok: false, failure: 'occupied' };
    } else {
      try {
        mkdirSync(parentDirectory);
      } catch (error) {
        if (!isErofs(error)) return { ok: false, failure: 'write_failed' };
        remountCgroupWritable(input.usable.directory);
        try {
          mkdirSync(parentDirectory);
        } catch {
          return { ok: false, failure: 'write_failed' };
        }
      }
    }
    try {
      parentFd = openSync(
        parentDirectory,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
      );
    } catch {
      return { ok: false, failure: 'unavailable' };
    }
    const reference = input.handlePath(parentFd, parentDirectory);
    const { dev, ino } = fstatSync(parentFd);

    try {
      writeFileSync(path.join(reference, 'memory.max'), String(input.budget.aggregateMaxBytes));
    } catch {
      return { ok: false, failure: 'write_failed' };
    }
    const applied = readMemoryMax(path.join(reference, 'memory.max'));
    if (applied.kind !== 'limit' || applied.bytes !== input.budget.aggregateMaxBytes) {
      return { ok: false, failure: 'readback_mismatch' };
    }
    const appliedReadbackBytes = applied.bytes;
    try {
      writeFileSync(path.join(reference, 'memory.oom.group'), '0');
    } catch {
      return { ok: false, failure: 'write_failed' };
    }
    const oomGroup = readControl(path.join(reference, 'memory.oom.group'));
    if (!oomGroup.ok || oomGroup.text.trim() !== '0') {
      return { ok: false, failure: 'readback_mismatch' };
    }
    try {
      writeFileSync(path.join(reference, 'memory.swap.max'), '0');
    } catch {
      // memory.swap.max is optional on kernels without swap accounting.
    }
    const swap = readControl(path.join(reference, 'memory.swap.max'));
    if (swap.ok ? swap.text.trim() !== '0' : !swap.missing) {
      return { ok: false, failure: 'readback_mismatch' };
    }

    let cpuController = false;
    try {
      writeFileSync(path.join(reference, 'cpu.weight'), String(WORKLOAD_CPU_WEIGHT));
      const cpu = readControl(path.join(reference, 'cpu.weight'));
      cpuController = cpu.ok && cpu.text.trim() === String(WORKLOAD_CPU_WEIGHT);
    } catch {
      cpuController = false;
    }

    try {
      writeFileSync(path.join(reference, 'cgroup.subtree_control'), '+memory +cpu');
    } catch {
      try {
        writeFileSync(path.join(reference, 'cgroup.subtree_control'), '+memory');
      } catch {
        return { ok: false, failure: 'controller_unavailable' };
      }
    }
    const subtree = readTokenSet(path.join(reference, 'cgroup.subtree_control'));
    if (!subtree.ok || !subtree.tokens.has('memory')) {
      return { ok: false, failure: 'controller_unavailable' };
    }

    const placement: WorkloadPlacement = {
      parentFd,
      parentDev: dev,
      parentIno: ino,
      parentReference: reference,
      parentDirectory,
      aggregateMaxBytes: input.budget.aggregateMaxBytes,
      toolsMaxBytes: input.budget.toolsMaxBytes,
      appliedReadbackBytes,
      containerLimitBytes: input.budget.containerLimitBytes,
      limitSource: input.budget.source,
      cpuWeight: WORKLOAD_CPU_WEIGHT,
      cpuController,
      sweepIntervalMs: WORKLOAD_SWEEP_INTERVAL_MS,
      ...(input.report ? { report: input.report } : {}),
    };
    retained = true;
    return { ok: true, placement };
  } catch {
    return { ok: false, failure: 'unavailable' };
  } finally {
    if (!retained && parentFd !== undefined) {
      try {
        closeSync(parentFd);
      } catch {
        // Descriptor close failures are not fatal here.
      }
    }
  }
}

function resetWorkloadDirectory(reference: string): boolean {
  let ok = true;
  try {
    const current = readControl(path.join(reference, 'memory.max'));
    if (!current.ok || current.text.trim() !== 'max') {
      writeFileSync(path.join(reference, 'memory.max'), 'max');
    }
  } catch {
    ok = false;
  }
  try {
    const current = readControl(path.join(reference, 'cpu.weight'));
    if (!current.ok || current.text.trim() !== String(WORKLOAD_DEFAULT_CPU_WEIGHT)) {
      writeFileSync(path.join(reference, 'cpu.weight'), String(WORKLOAD_DEFAULT_CPU_WEIGHT));
    }
  } catch {
    ok = false;
  }
  return ok;
}

function resetWorkloadTree(
  directory: string,
  depth: number,
  handlePath: (descriptor: number, directory: string) => string
): boolean {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      directory,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
    );
  } catch {
    return false;
  }
  try {
    const reference = handlePath(descriptor, directory);
    let ok = resetWorkloadDirectory(reference);
    if (depth <= 0) return ok;
    let entries;
    try {
      entries = readdirSync(reference, { withFileTypes: true });
    } catch {
      return false;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink() || !entry.isDirectory()) continue;
      if (!resetWorkloadTree(path.join(reference, entry.name), depth - 1, handlePath)) ok = false;
    }
    return ok;
  } finally {
    try {
      closeSync(descriptor);
    } catch {
      // Descriptor close failures are not fatal here.
    }
  }
}

function neutralizeControlWorkload(input: {
  cgroupRoot: string;
  membership: string;
  handlePath: (descriptor: number, directory: string) => string;
  report?: ControlDiagnosticReporter;
}): void {
  const reporter = createWorkloadReporter(input.report);
  for (const relative of workloadCgroupCandidates(input.membership)) {
    const candidate = path.join(
      candidateDirectory(input.cgroupRoot, relative),
      WORKLOAD_PARENT_NAME
    );
    let stat;
    try {
      stat = lstatSync(candidate);
    } catch {
      continue;
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) continue;
    const ok = resetWorkloadTree(candidate, 2, input.handlePath);
    reporter.emit(undefined, {
      phase: ok ? 'completed' : 'failed',
      workloadPhase: 'rollback',
      ...(ok ? {} : { workloadFailure: 'write_failed' as const }),
    });
  }
}

export function initializeControlWorkload(options: ControlWorkloadOptions): ControlWorkload {
  const env = options.env;
  const platform = options.platform ?? process.platform;
  const enabled = env[CONTROL_WORKLOAD_CGROUP_ENV] !== '0';
  const reporter = createWorkloadReporter(options.report);
  if (platform !== 'linux') {
    if (!enabled) return { enabled: false };
    reporter.emit(undefined, {
      phase: 'failed',
      workloadPhase: 'failed',
      workloadFailure: 'unavailable',
    });
    return { enabled: true, failure: 'unavailable' };
  }

  const cgroupRoot = options.cgroupRoot ?? '/sys/fs/cgroup';
  const selfCgroupFile = options.selfCgroupFile ?? '/proc/self/cgroup';
  const procRoot = options.procRoot ?? '/proc';
  const isCgroupMount = options.isCgroupMount ?? defaultIsCgroupMount;
  const handlePath = options.handlePath ?? defaultHandlePath;
  const membership = readWorkloadMembership(selfCgroupFile);
  if (membership === undefined) {
    if (!enabled) return { enabled: false };
    reporter.emit(undefined, {
      phase: 'failed',
      workloadPhase: 'failed',
      workloadFailure: 'unavailable',
    });
    return { enabled: true, failure: 'unavailable' };
  }

  if (!enabled) {
    if (isCgroupMount(cgroupRoot)) {
      neutralizeControlWorkload({
        cgroupRoot,
        membership,
        handlePath,
        ...(options.report ? { report: options.report } : {}),
      });
    }
    return { enabled: false };
  }

  if (!isCgroupMount(cgroupRoot)) {
    reporter.emit(undefined, {
      phase: 'failed',
      workloadPhase: 'failed',
      workloadFailure: 'unavailable',
    });
    return { enabled: true, failure: 'unavailable' };
  }

  const usable = findUsableParent(cgroupRoot, membership);
  if (!usable.ok) {
    reporter.emit(undefined, {
      phase: 'failed',
      workloadPhase: 'failed',
      workloadFailure: usable.failure,
    });
    return { enabled: true, failure: usable.failure };
  }

  const budgetDirectories = [
    usable.directory,
    ...workloadAncestors(usable.relative).map(ancestor => path.join(cgroupRoot, ancestor)),
  ];
  const limits: (number | undefined)[] = [];
  for (const directory of budgetDirectories) {
    const read = readMemoryMax(path.join(directory, 'memory.max'));
    if (read.kind === 'unreadable') {
      reporter.emit(undefined, {
        phase: 'failed',
        workloadPhase: 'failed',
        workloadFailure: 'unavailable',
      });
      return { enabled: true, failure: 'unavailable' };
    }
    limits.push(read.kind === 'limit' ? read.bytes : undefined);
  }
  const budget = computeWorkloadBudget({
    limits,
    explicitLimitBytes: (() => {
      const mb = parsePositiveMb(env[CONTROL_WORKLOAD_LIMIT_MB_ENV]);
      return mb === undefined ? undefined : mb * 1024 * 1024;
    })(),
    memTotalBytes: readMemTotalBytes(procRoot),
    reserveBytes: (() => {
      const mb = parsePositiveMb(env[CONTROL_WORKLOAD_RESERVE_MB_ENV]);
      return mb === undefined ? DEFAULT_CONTROL_RESERVE_BYTES : mb * 1024 * 1024;
    })(),
  });
  if (!budget.ok) {
    reporter.emit(undefined, {
      phase: 'failed',
      workloadPhase: 'failed',
      workloadFailure: budget.failure,
    });
    return { enabled: true, failure: budget.failure };
  }

  const probe = probeWorkloadParent({
    usable,
    budget,
    handlePath,
    ...(options.report ? { report: options.report } : {}),
  });
  if (!probe.ok) {
    reporter.emit(undefined, {
      phase: 'failed',
      workloadPhase: 'failed',
      workloadFailure: probe.failure,
    });
    return { enabled: true, failure: probe.failure };
  }

  reporter.emit(undefined, {
    phase: 'started',
    workloadPhase: 'applied',
    containerLimitBytes: budget.containerLimitBytes,
    aggregateMaxBytes: budget.aggregateMaxBytes,
    toolsMaxBytes: budget.toolsMaxBytes,
    reserveBytes: budget.containerLimitBytes - budget.aggregateMaxBytes,
    appliedMaxBytes: budget.aggregateMaxBytes,
    readbackMaxBytes: probe.placement.appliedReadbackBytes,
    cpuController: probe.placement.cpuController,
    siblingProtection: false,
    workloadLimitSource: budget.source,
  });
  return { enabled: true, placement: probe.placement };
}

/** `memory.min` the kernel honoured on the Kilo server, or why it could not be applied. */
export type ServerMemoryProtection =
  | { ok: true; bytes: number }
  | { ok: false; failure: 'write_failed' | 'readback_mismatch' };

function writeMemoryMin(
  reference: string,
  bytes: number
): 'ok' | 'write_failed' | 'readback_mismatch' {
  try {
    writeFileSync(path.join(reference, 'memory.min'), String(bytes));
  } catch {
    return 'write_failed';
  }
  const read = readControl(path.join(reference, 'memory.min'));
  return read.ok && read.text.trim() === String(bytes) ? 'ok' : 'readback_mismatch';
}

/**
 * Reclaim at the shared parent's cap takes tool and page-cache memory before Kilo's first
 * `KILO_SERVER_MIN_BYTES`. A child's `memory.min` counts only up to its parent's, so the
 * scope group carries the same value. Optional: an unsupported kernel keeps the hard caps.
 */
function protectServerMemory(input: {
  parentReference: string;
  serverReference: string;
}): ServerMemoryProtection {
  const bytes = KILO_SERVER_MIN_BYTES;
  for (const reference of [input.parentReference, input.serverReference]) {
    const outcome = writeMemoryMin(reference, bytes);
    if (outcome !== 'ok') return { ok: false, failure: outcome };
  }
  return { ok: true, bytes };
}

export function applyManagedWorkloadLimits(input: {
  parentReference: string;
  serverReference: string;
  toolsReference: string;
  toolsMaxBytes: number;
}): { cpuController: boolean; serverProtection: ServerMemoryProtection } {
  try {
    writeFileSync(path.join(input.parentReference, 'cgroup.subtree_control'), '+memory +cpu');
  } catch {
    writeFileSync(path.join(input.parentReference, 'cgroup.subtree_control'), '+memory');
  }
  const subtree = readTokenSet(path.join(input.parentReference, 'cgroup.subtree_control'));
  if (!subtree.ok || !subtree.tokens.has('memory')) {
    throw new Error('Managed workload memory controller unavailable');
  }

  writeFileSync(path.join(input.toolsReference, 'memory.max'), String(input.toolsMaxBytes));
  // 0: an OOM kills the largest tool process, not every tool, MCP server and LSP of the runtime.
  writeFileSync(path.join(input.toolsReference, 'memory.oom.group'), '0');
  writeFileSync(path.join(input.serverReference, 'memory.oom.group'), '0');
  writeControlOptional(path.join(input.toolsReference, 'memory.swap.max'), '0');
  writeControlOptional(path.join(input.toolsReference, 'cpu.weight'), String(WORKLOAD_CPU_WEIGHT));

  const toolsMax = readMemoryMax(path.join(input.toolsReference, 'memory.max'));
  if (toolsMax.kind !== 'limit' || toolsMax.bytes !== input.toolsMaxBytes) {
    throw new Error('Managed workload tool memory.max readback mismatch');
  }
  const toolsOomGroup = readControl(path.join(input.toolsReference, 'memory.oom.group'));
  if (!toolsOomGroup.ok || toolsOomGroup.text.trim() !== '0') {
    throw new Error('Managed workload tool memory.oom.group readback mismatch');
  }
  const serverOomGroup = readControl(path.join(input.serverReference, 'memory.oom.group'));
  if (!serverOomGroup.ok || serverOomGroup.text.trim() !== '0') {
    throw new Error('Managed workload server memory.oom.group readback mismatch');
  }
  const serverMax = readControl(path.join(input.serverReference, 'memory.max'));
  if (serverMax.ok ? serverMax.text.trim() !== 'max' : !serverMax.missing) {
    throw new Error('Managed workload server memory.max readback mismatch');
  }
  const toolsSwap = readControl(path.join(input.toolsReference, 'memory.swap.max'));
  if (toolsSwap.ok ? toolsSwap.text.trim() !== '0' : !toolsSwap.missing) {
    throw new Error('Managed workload tool memory.swap.max readback mismatch');
  }
  return { ...readCpuWeight(input.toolsReference), serverProtection: protectServerMemory(input) };
}

/**
 * Kilo is never an OOM victim, wherever its children's early memory is charged. Its children
 * inherit this until the sweep moves them into tools and makes them killable again.
 */
export const KILO_OOM_SCORE_ADJ = '-1000';
export const TOOL_OOM_SCORE_ADJ = '0';

export function writeOomScoreAdj(pid: number, value: string): boolean {
  try {
    writeFileSync(`/proc/${pid}/oom_score_adj`, value);
    return true;
  } catch {
    return false;
  }
}

function readCpuWeight(toolsReference: string): { cpuController: boolean } {
  const cpu = readControl(path.join(toolsReference, 'cpu.weight'));
  return { cpuController: cpu.ok && cpu.text.trim() === String(WORKLOAD_CPU_WEIGHT) };
}

export function verifyWorkloadParent(placement: WorkloadPlacement): void {
  const stat = fstatSync(placement.parentFd);
  if (stat.dev !== placement.parentDev || stat.ino !== placement.parentIno) {
    throw new WorkloadUnavailableError('readback_mismatch');
  }
  const applied = readMemoryMax(path.join(placement.parentReference, 'memory.max'));
  if (applied.kind !== 'limit' || applied.bytes !== placement.aggregateMaxBytes) {
    throw new WorkloadUnavailableError('readback_mismatch');
  }
  const oomGroup = readControl(path.join(placement.parentReference, 'memory.oom.group'));
  if (!oomGroup.ok || oomGroup.text.trim() !== '0') {
    throw new WorkloadUnavailableError('readback_mismatch');
  }
  const swap = readControl(path.join(placement.parentReference, 'memory.swap.max'));
  if (swap.ok ? swap.text.trim() !== '0' : !swap.missing) {
    throw new WorkloadUnavailableError('readback_mismatch');
  }
}

export function admitControlWorkload(
  workload: ControlWorkload | undefined
): WorkloadPlacement | undefined {
  if (!workload || !workload.enabled) return undefined;
  if (!workload.placement) return undefined;
  try {
    verifyWorkloadParent(workload.placement);
  } catch (error) {
    createWorkloadReporter(workload.placement.report).emit(undefined, {
      phase: 'failed',
      workloadPhase: 'failed',
      workloadFailure: error instanceof WorkloadUnavailableError ? error.failure : 'unavailable',
    });
    return undefined;
  }
  return workload.placement;
}

export function closeControlWorkload(workload: ControlWorkload | undefined): void {
  if (!workload?.placement) return;
  try {
    closeSync(workload.placement.parentFd);
  } catch {
    return;
  }
}
