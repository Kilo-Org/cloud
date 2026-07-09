/**
 * Sandbox memory partition via dedicated cgroup v2 slices.
 *
 * A runaway tool process (e.g. `tsc` on a large monorepo) can pin the whole
 * container at its memory ceiling, where cache-reclaim thrash freezes every
 * process for hours without ever triggering the kernel OOM killer. This module
 * confines tool subprocesses — and, separately, the kilo server itself — to
 * dedicated cgroups so the offender is killed in seconds with a visible error
 * instead. Design rationale: `MEMORY_CGROUPS_PLAN.md`.
 *
 * Placement: both cgroups are created at the cgroup-fs root as siblings of the
 * platform's container cgroup. The instance memory limit is the microVM's RAM
 * (the platform cgroups are unlimited), so sibling placement escapes nothing.
 *
 * Membership: the kilo server is a child process of the wrapper, and tool
 * subprocesses are its descendants — spawned outside this process, so they
 * cannot be intercepted here. Instead a periodic sweep walks /proc and
 * classifies every strict descendant of the wrapper as either the kilo-server
 * chain or tool work, migrating each into its respective cgroup. Traversal
 * passes through the server chain so tools it spawns are still classified.
 *
 * Two tiers:
 * - `kilo-tools`: `memory.oom.group=1` — the whole tree dies atomically so a
 *   multi-process build cannot escape the cap by splitting memory across
 *   workers. This is the incident class this module was built for.
 * - `kilo-server`: `memory.oom.group=0`, hardcoded — a fresh tool child can
 *   inherit this cgroup for up to one sweep interval before migration; with
 *   group-kill the server would die for a half-second-old tool. With `0` the
 *   kernel kills the biggest resident instead: either the leaking server
 *   (intended) or a fat newborn tool (better — server survives).
 *
 * Modes (TOOL_CGROUP_MODE) govern the tool tier: `off` (default — unset/empty/
 * invalid all resolve here, so a wrapper outside the Worker's org allowlist
 * never migrates a single process); `observe` — migrate + report usage but no
 * limit, for rollout validation; `enforce` — memory.max = MemTotal − reserve.
 * The server tier is independently controlled by `TOOL_CGROUP_SERVER_LIMIT_MB`
 * (unset/0 = observe-only, uncapped) whenever the feature is not `off`.
 *
 * CPU: each slice can carry a `cpu.weight` (`TOOL_CGROUP_CPU_WEIGHT` /
 * `TOOL_CGROUP_SERVER_CPU_WEIGHT`). Weight is proportional priority under
 * contention only — tools still use idle cores freely, but a parallel build
 * pinning every core can no longer starve the kilo server's event loop.
 * Unlike memory.max there are no kill semantics, so like the server memory
 * limit the weights apply in every mode except `off`; unset/0 leaves the
 * kernel default (100).
 */

import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { appendFile, readFile, readdir } from 'fs/promises';
import { join } from 'path';
import {
  TOOL_CGROUP_CPU_WEIGHT_ENV,
  TOOL_CGROUP_MODE_ENV,
  TOOL_CGROUP_OOM_GROUP_ENV,
  TOOL_CGROUP_RESERVE_MB_ENV,
  TOOL_CGROUP_SERVER_CPU_WEIGHT_ENV,
  TOOL_CGROUP_SERVER_LIMIT_MB_ENV,
  TOOL_CGROUP_SWEEP_INTERVAL_MS_ENV,
} from '../../src/shared/tool-cgroup-env.js';
import { logToFile } from './utils.js';

export type ToolCgroupMode = 'off' | 'observe' | 'enforce';

export type ToolCgroupConfig = {
  mode: ToolCgroupMode;
  reserveBytes: number;
  /** null = unset/0 = server slice stays uncapped (observe-only). */
  serverLimitBytes: number | null;
  /** cpu.weight for the tool slice; null = unset/0 = kernel default (100). */
  cpuWeight: number | null;
  /** cpu.weight for the server slice; null = unset/0 = kernel default (100). */
  serverCpuWeight: number | null;
  sweepIntervalMs: number;
  statsIntervalMs: number;
  /** kilo-tools only; kilo-server always runs with oom.group=0. */
  oomGroup: boolean;
  cgroupRoot: string;
  procRoot: string;
  toolCgroupName: string;
  serverCgroupName: string;
  selfPid: number;
};

export type SliceHealth = {
  /** Effective limit in bytes; null when running uncapped. */
  memoryMaxBytes: number | null;
  memoryCurrentBytes: number | null;
  memoryPeakBytes: number | null;
  /** Applied cpu.weight; null when left at the kernel default. */
  cpuWeight: number | null;
  /** Cumulative CPU time from cpu.stat usage_usec; null when unavailable. */
  cpuUsageMicros: number | null;
  oomKills: number;
  oomGroupKills: number;
  migratedTotal: number;
  lastOomAt: number | null;
};

export type ToolCgroupHealth = SliceHealth & {
  mode: ToolCgroupMode;
  server: Omit<SliceHealth, 'oomGroupKills' | 'lastOomAt'>;
};

type MemoryEvents = { oomKill: number; oomGroupKill: number };

type Logger = (message: string) => void;

const DEFAULT_RESERVE_MB = 1536;
const DEFAULT_CPU_WEIGHT = 100;
const MAX_CPU_WEIGHT = 10000;
const DEFAULT_SWEEP_INTERVAL_MS = 1000;
const MIN_SWEEP_INTERVAL_MS = 200;
const DEFAULT_STATS_INTERVAL_MS = 5 * 60 * 1000;
/** Below this cap the box is too small to meaningfully partition; stay uncapped. */
const MIN_CAP_BYTES = 1024 * 1024 * 1024;
/** §2.2 budget check: server cap + this headroom must fit under the tool reserve. */
const SERVER_BUDGET_HEADROOM_BYTES = 512 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

function parseEnvInt(
  env: Record<string, string | undefined>,
  name: string,
  defaultValue: number,
  log: Logger
): number {
  const value = env[name];
  if (!value) return defaultValue;
  const parsed = parseInt(value, 10);
  if (isNaN(parsed) || parsed < 0) {
    log(`WARNING: Invalid integer for ${name}: ${value}, using default ${defaultValue}`);
    return defaultValue;
  }
  return parsed;
}

function parseMode(value: string | undefined, log: Logger): ToolCgroupMode {
  if (value === undefined || value === '') return 'off';
  if (value === 'off' || value === 'observe' || value === 'enforce') return value;
  log(`WARNING: Invalid TOOL_CGROUP_MODE: ${value}, using off`);
  return 'off';
}

function parseServerLimitBytes(
  env: Record<string, string | undefined>,
  log: Logger
): number | null {
  const mb = parseEnvInt(env, TOOL_CGROUP_SERVER_LIMIT_MB_ENV, 0, log);
  return mb > 0 ? mb * 1024 * 1024 : null;
}

/** cpu.weight accepts 1–10000; unset/0/invalid = leave the kernel default. */
function parseCpuWeight(
  env: Record<string, string | undefined>,
  name: string,
  log: Logger
): number | null {
  const weight = parseEnvInt(env, name, 0, log);
  if (weight === 0) return null;
  if (weight > MAX_CPU_WEIGHT) {
    log(`WARNING: ${name} out of range (1-${MAX_CPU_WEIGHT}): ${weight}, using kernel default`);
    return null;
  }
  return weight;
}

export function parseToolCgroupConfig(
  env: Record<string, string | undefined>,
  log: Logger = logToFile
): ToolCgroupConfig {
  return {
    mode: parseMode(env[TOOL_CGROUP_MODE_ENV], log),
    reserveBytes:
      parseEnvInt(env, TOOL_CGROUP_RESERVE_MB_ENV, DEFAULT_RESERVE_MB, log) * 1024 * 1024,
    serverLimitBytes: parseServerLimitBytes(env, log),
    cpuWeight: parseCpuWeight(env, TOOL_CGROUP_CPU_WEIGHT_ENV, log),
    serverCpuWeight: parseCpuWeight(env, TOOL_CGROUP_SERVER_CPU_WEIGHT_ENV, log),
    sweepIntervalMs: Math.max(
      MIN_SWEEP_INTERVAL_MS,
      parseEnvInt(env, TOOL_CGROUP_SWEEP_INTERVAL_MS_ENV, DEFAULT_SWEEP_INTERVAL_MS, log)
    ),
    statsIntervalMs: DEFAULT_STATS_INTERVAL_MS,
    oomGroup: env[TOOL_CGROUP_OOM_GROUP_ENV] !== '0',
    cgroupRoot: '/sys/fs/cgroup',
    procRoot: '/proc',
    toolCgroupName: 'kilo-tools',
    serverCgroupName: 'kilo-server',
    selfPid: process.pid,
  };
}

export function readMemTotalBytes(procRoot: string): number | undefined {
  try {
    const meminfo = readFileSync(join(procRoot, 'meminfo'), 'utf8');
    const match = meminfo.match(/^MemTotal:\s+(\d+)\s*kB/m);
    if (!match) return undefined;
    return parseInt(match[1], 10) * 1024;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Process table
// ---------------------------------------------------------------------------

export type ProcessEntry = { pid: number; ppid: number; argv: string[] };

async function readProcessEntry(procRoot: string, pid: number): Promise<ProcessEntry | undefined> {
  try {
    const stat = await readFile(join(procRoot, String(pid), 'stat'), 'utf8');
    // Format: `pid (comm) state ppid ...` — comm may contain spaces/parens.
    const afterComm = stat.slice(stat.lastIndexOf(')') + 2);
    const ppid = parseInt(afterComm.split(' ')[1], 10);
    if (isNaN(ppid)) return undefined;
    const cmdline = await readFile(join(procRoot, String(pid), 'cmdline'), 'utf8');
    return { pid, ppid, argv: cmdline.split('\0').filter(Boolean) };
  } catch {
    return undefined; // process exited mid-read
  }
}

/** Async so the periodic sweep never blocks the wrapper's single event-loop thread. */
export async function readProcessTable(procRoot: string): Promise<Map<number, ProcessEntry>> {
  const table = new Map<number, ProcessEntry>();
  let names: string[];
  try {
    names = await readdir(procRoot);
  } catch {
    return table;
  }
  const pids = names.filter(name => /^\d+$/.test(name)).map(name => parseInt(name, 10));
  const entries = await Promise.all(pids.map(pid => readProcessEntry(procRoot, pid)));
  for (const entry of entries) {
    if (entry) table.set(entry.pid, entry);
  }
  return table;
}

/** Basenames of the real kilo server entrypoint (script or re-exec shim). */
const KILO_SERVER_BASENAMES = new Set(['kilo', '.kilo']);

/**
 * The kilo-server chain must never be group-killed under the tool cap: an OOM
 * group kill there would take the session runtime down with the tool. Matches
 * `kilo serve` invocations through interpreter shims and re-execs (`node
 * /usr/local/bin/kilo serve …`, `.kilo serve …`). Requires an exact basename
 * match on the executable/script argv positions with `serve` as the
 * immediately following token — a substring or "serve anywhere in argv" check
 * would let a tool command merely named/mentioning kilo escape the tool
 * cgroup.
 */
export function isKiloServerProcess(argv: string[]): boolean {
  const candidateIndex = argv
    .slice(0, 3)
    .findIndex(arg => KILO_SERVER_BASENAMES.has(arg.slice(arg.lastIndexOf('/') + 1)));
  return candidateIndex !== -1 && argv[candidateIndex + 1] === 'serve';
}

/**
 * True when /proc still shows the same (ppid, argv) for `snapshot.pid`.
 * Checked immediately before migrating a pid: it may have exited after the
 * sweep's /proc snapshot and been reused by an unrelated process, which the
 * cgroup.procs write would then silently capture into the wrong slice. An
 * identical (ppid, argv) replacement would classify identically, so equality
 * suffices; a process that exec()ed since the snapshot is skipped and picked
 * up on the next sweep under its new argv. The residual read→write race is
 * accepted — reuse that fast would mean cycling the whole pid space in
 * microseconds, and a wrongly captured wrapper descendant is re-migrated to
 * its correct slice by the next sweep anyway.
 */
export async function pidStillMatches(procRoot: string, snapshot: ProcessEntry): Promise<boolean> {
  const fresh = await readProcessEntry(procRoot, snapshot.pid);
  return (
    fresh !== undefined &&
    fresh.ppid === snapshot.ppid &&
    fresh.argv.length === snapshot.argv.length &&
    fresh.argv.every((arg, index) => arg === snapshot.argv[index])
  );
}

/**
 * Classifies strict descendants of `rootPid` into tool work vs. the
 * kilo-server chain. Traversal continues through server-chain processes so
 * tools they spawn are still classified as tool work.
 */
export function classifyProcesses(
  table: Map<number, ProcessEntry>,
  rootPid: number
): { toolPids: number[]; serverPids: number[] } {
  const childrenByPpid = new Map<number, ProcessEntry[]>();
  for (const entry of table.values()) {
    const siblings = childrenByPpid.get(entry.ppid);
    if (siblings) {
      siblings.push(entry);
    } else {
      childrenByPpid.set(entry.ppid, [entry]);
    }
  }

  const toolPids: number[] = [];
  const serverPids: number[] = [];
  const queue = [rootPid];
  for (let i = 0; i < queue.length; i++) {
    for (const child of childrenByPpid.get(queue[i]) ?? []) {
      (isKiloServerProcess(child.argv) ? serverPids : toolPids).push(child.pid);
      queue.push(child.pid);
    }
  }
  return { toolPids, serverPids };
}

// ---------------------------------------------------------------------------
// Cgroup slice — a single cgroup v2 directory (kilo-tools or kilo-server)
// ---------------------------------------------------------------------------

/**
 * One cgroup v2 memory slice: creation, limit, membership, OOM-event
 * tracking. Parameterized so the tool and server tiers share behavior while
 * differing in name, limit, and `oom.group`.
 */
class CgroupSlice {
  private readonly dir: string;
  private memoryMaxBytes: number | null = null;
  private cpuWeight: number | null = null;
  private eventsBaseline: MemoryEvents = { oomKill: 0, oomGroupKill: 0 };
  private eventsSeen: MemoryEvents = { oomKill: 0, oomGroupKill: 0 };
  private migratedTotal = 0;
  private lastOomAt: number | null = null;
  private lastMigrateFailureCode: string | undefined;

  constructor(
    cgroupRoot: string,
    private readonly name: string,
    private readonly oomGroup: boolean,
    private readonly oomLogTag: string,
    private readonly log: Logger
  ) {
    this.dir = join(cgroupRoot, name);
  }

  /**
   * Create (idempotent) and apply the memory limit (null = uncapped) and cpu
   * weight (null = kernel default). The weight is always written so a stale
   * value left by a previous wrapper generation in a reused container
   * self-neutralizes.
   */
  setup(memoryMaxBytes: number | null, cpuWeight: number | null): void {
    try {
      mkdirSync(this.dir);
    } catch (error) {
      // Reuse a cgroup left by a previous wrapper generation in this container.
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    this.memoryMaxBytes = memoryMaxBytes;
    this.cpuWeight = cpuWeight;
    // memory.max must apply for enforce to be real; the others are best-effort.
    writeFileSync(
      join(this.dir, 'memory.max'),
      memoryMaxBytes === null ? 'max' : String(memoryMaxBytes)
    );
    this.writeBestEffort('memory.oom.group', this.oomGroup ? '1' : '0');
    this.writeBestEffort('memory.swap.max', memoryMaxBytes === null ? 'max' : '0');
    this.writeBestEffort('cpu.weight', String(cpuWeight ?? DEFAULT_CPU_WEIGHT));
    this.eventsBaseline = this.readMemoryEvents();
    this.eventsSeen = this.eventsBaseline;
  }

  /** Current cgroup members, read once per sweep so migrate() need not stat each pid. */
  async currentMembers(): Promise<Set<number>> {
    try {
      const content = await readFile(join(this.dir, 'cgroup.procs'), 'utf8');
      return new Set(
        content
          .split('\n')
          .filter(Boolean)
          .map(line => parseInt(line, 10))
      );
    } catch {
      return new Set();
    }
  }

  /** `stillCurrent` re-checks a pid against the /proc snapshot right before the write (pid reuse). */
  async migrate(
    pids: number[],
    members: Set<number>,
    stillCurrent: (pid: number) => Promise<boolean>
  ): Promise<void> {
    for (const pid of pids) {
      if (members.has(pid)) continue;
      if (!(await stillCurrent(pid))) continue;
      try {
        await appendFile(join(this.dir, 'cgroup.procs'), `${pid}\n`);
        this.migratedTotal++;
      } catch (error) {
        this.logMigrateFailure(pid, error);
      }
    }
  }

  /**
   * ESRCH is the expected race (the process exited between the /proc walk and
   * the write) and stays silent. Anything else (EACCES, EROFS, removed dir)
   * means migration — the point of this module — has stopped working and must
   * be visible; deduped by code so a persistent failure logs once rather than
   * once per pid per sweep.
   */
  private logMigrateFailure(pid: number, error: unknown): void {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return;
    if (code !== undefined && code === this.lastMigrateFailureCode) return;
    this.lastMigrateFailureCode = code;
    this.log(
      `tool_cgroup_migrate_failed cgroup=${this.name} pid=${pid} error=${error instanceof Error ? error.message : String(error)}`
    );
  }

  /** Logs `oomLogTag` when a new OOM (group) kill happened since the last check. */
  checkOomEvents(): void {
    const events = this.readMemoryEvents();
    if (
      events.oomKill > this.eventsSeen.oomKill ||
      events.oomGroupKill > this.eventsSeen.oomGroupKill
    ) {
      this.lastOomAt = Date.now();
      this.log(
        `${this.oomLogTag} oomKills=${events.oomKill - this.eventsBaseline.oomKill} oomGroupKills=${events.oomGroupKill - this.eventsBaseline.oomGroupKill} memoryMaxBytes=${this.memoryMaxBytes ?? 'none'}`
      );
    }
    this.eventsSeen = events;
  }

  health(): SliceHealth {
    return {
      memoryMaxBytes: this.memoryMaxBytes,
      memoryCurrentBytes: this.readByteCount('memory.current'),
      memoryPeakBytes: this.readByteCount('memory.peak'),
      cpuWeight: this.cpuWeight,
      cpuUsageMicros: this.readCpuUsageMicros(),
      oomKills: this.eventsSeen.oomKill - this.eventsBaseline.oomKill,
      oomGroupKills: this.eventsSeen.oomGroupKill - this.eventsBaseline.oomGroupKill,
      migratedTotal: this.migratedTotal,
      lastOomAt: this.lastOomAt,
    };
  }

  private writeBestEffort(file: string, value: string): void {
    try {
      writeFileSync(join(this.dir, file), value);
    } catch (error) {
      this.log(
        `tool_cgroup_write_failed cgroup=${this.name} file=${file} error=${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  private readMemoryEvents(): MemoryEvents {
    const events: MemoryEvents = { oomKill: 0, oomGroupKill: 0 };
    try {
      const content = readFileSync(join(this.dir, 'memory.events'), 'utf8');
      for (const line of content.split('\n')) {
        const [key, value] = line.split(' ');
        if (key === 'oom_kill') events.oomKill = parseInt(value, 10) || 0;
        if (key === 'oom_group_kill') events.oomGroupKill = parseInt(value, 10) || 0;
      }
    } catch {
      // memory.events missing (old kernel) — counters stay zero.
    }
    return events;
  }

  private readByteCount(file: string): number | null {
    try {
      const value = parseInt(readFileSync(join(this.dir, file), 'utf8'), 10);
      return isNaN(value) ? null : value;
    } catch {
      return null;
    }
  }

  private readCpuUsageMicros(): number | null {
    try {
      const content = readFileSync(join(this.dir, 'cpu.stat'), 'utf8');
      const match = content.match(/^usage_usec (\d+)$/m);
      return match ? parseInt(match[1], 10) : null;
    } catch {
      return null;
    }
  }
}

/**
 * Rollback hygiene (W2): a container reused across wrapper generations may
 * carry controls written by a previous generation. Best-effort neutralize
 * them so `mode=off` truly means unrestricted, without requiring the dir to
 * exist.
 */
function resetStaleControl(
  cgroupRoot: string,
  name: string,
  file: string,
  neutral: string,
  log: Logger
): void {
  const path = join(cgroupRoot, name, file);
  try {
    const current = readFileSync(path, 'utf8').trim();
    if (current !== neutral) {
      writeFileSync(path, neutral);
      log(`tool_cgroup_stale_cap_reset cgroup=${name} file=${file} previous=${current}`);
    }
  } catch {
    // Dir doesn't exist or unreadable — nothing to reset.
  }
}

// ---------------------------------------------------------------------------
// Manager — owns both slices, runs the sweeper
// ---------------------------------------------------------------------------

export class ToolCgroupManager {
  private readonly config: ToolCgroupConfig;
  private readonly log: Logger;
  private readonly toolSlice: CgroupSlice;
  private readonly serverSlice: CgroupSlice;
  private sweepTimer: ReturnType<typeof setInterval> | undefined;
  private statsTimer: ReturnType<typeof setInterval> | undefined;
  private toolMemoryMaxBytes: number | null = null;

  constructor(config: ToolCgroupConfig, log: Logger = logToFile) {
    this.config = config;
    this.log = log;
    this.toolSlice = new CgroupSlice(
      config.cgroupRoot,
      config.toolCgroupName,
      config.oomGroup,
      'tool_cgroup_oom_kill',
      log
    );
    // kilo-server never group-kills (§2.1): a fresh tool inherited by
    // migration lag would otherwise take the server down with it.
    this.serverSlice = new CgroupSlice(
      config.cgroupRoot,
      config.serverCgroupName,
      false,
      'tool_cgroup_server_oom_kill',
      log
    );
  }

  /** Create and configure both slices. Returns false when unavailable. */
  setup(): boolean {
    try {
      this.enableControllers();
      this.toolMemoryMaxBytes = this.computeToolCap();
      this.toolSlice.setup(this.toolMemoryMaxBytes, this.config.cpuWeight);
      this.serverSlice.setup(this.config.serverLimitBytes, this.config.serverCpuWeight);
      this.warnIfBudgetExceeded();
      this.log(
        `tool_cgroup_ready mode=${this.effectiveMode()} memoryMaxBytes=${this.toolMemoryMaxBytes ?? 'none'} serverLimitBytes=${this.config.serverLimitBytes ?? 'none'} cpuWeight=${this.config.cpuWeight ?? 'default'} serverCpuWeight=${this.config.serverCpuWeight ?? 'default'} cgroupRoot=${this.config.cgroupRoot}`
      );
      return true;
    } catch (error) {
      this.log(
        `tool_cgroup_setup_failed error=${error instanceof Error ? error.message : String(error)}`
      );
      return false;
    }
  }

  start(): void {
    if (this.sweepTimer) return;
    this.sweepTimer = setInterval(() => void this.sweep(), this.config.sweepIntervalMs);
    this.sweepTimer.unref?.();
    this.statsTimer = setInterval(() => this.logStats(), this.config.statsIntervalMs);
    this.statsTimer.unref?.();
  }

  stop(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    if (this.statsTimer) clearInterval(this.statsTimer);
    this.sweepTimer = undefined;
    this.statsTimer = undefined;
  }

  /** One sweep tick: classify + migrate pids into their slice, then check OOM events. */
  async sweep(): Promise<void> {
    try {
      const table = await readProcessTable(this.config.procRoot);
      const { toolPids, serverPids } = classifyProcesses(table, this.config.selfPid);
      const [toolMembers, serverMembers] = await Promise.all([
        this.toolSlice.currentMembers(),
        this.serverSlice.currentMembers(),
      ]);
      const stillCurrent = (pid: number) => {
        const snapshot = table.get(pid);
        return snapshot ? pidStillMatches(this.config.procRoot, snapshot) : Promise.resolve(false);
      };
      await Promise.all([
        this.toolSlice.migrate(toolPids, toolMembers, stillCurrent),
        this.serverSlice.migrate(serverPids, serverMembers, stillCurrent),
      ]);
      this.toolSlice.checkOomEvents();
      this.serverSlice.checkOomEvents();
    } catch (error) {
      this.log(
        `tool_cgroup_sweep_failed error=${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  health(): ToolCgroupHealth {
    const tool = this.toolSlice.health();
    const server = this.serverSlice.health();
    return {
      mode: this.effectiveMode(),
      ...tool,
      server: {
        memoryMaxBytes: server.memoryMaxBytes,
        memoryCurrentBytes: server.memoryCurrentBytes,
        memoryPeakBytes: server.memoryPeakBytes,
        cpuWeight: server.cpuWeight,
        cpuUsageMicros: server.cpuUsageMicros,
        oomKills: server.oomKills,
        migratedTotal: server.migratedTotal,
      },
    };
  }

  private logStats(): void {
    const tool = this.toolSlice.health();
    const server = this.serverSlice.health();
    this.log(
      `tool_cgroup_stats toolsCurrent=${tool.memoryCurrentBytes ?? 'unknown'} toolsPeak=${tool.memoryPeakBytes ?? 'unknown'} toolsCpuUsageMicros=${tool.cpuUsageMicros ?? 'unknown'} serverCurrent=${server.memoryCurrentBytes ?? 'unknown'} serverPeak=${server.memoryPeakBytes ?? 'unknown'} serverCpuUsageMicros=${server.cpuUsageMicros ?? 'unknown'}`
    );
  }

  private effectiveMode(): ToolCgroupMode {
    if (this.config.mode === 'enforce' && this.toolMemoryMaxBytes === null) return 'observe';
    return this.config.mode;
  }

  private computeToolCap(): number | null {
    if (this.config.mode !== 'enforce') return null;
    const memTotal = readMemTotalBytes(this.config.procRoot);
    const cap = memTotal === undefined ? undefined : memTotal - this.config.reserveBytes;
    if (cap === undefined || cap < MIN_CAP_BYTES) {
      this.log(
        `tool_cgroup_cap_unavailable memTotalBytes=${memTotal ?? 'unknown'} reserveBytes=${this.config.reserveBytes} — falling back to observe`
      );
      return null;
    }
    return cap;
  }

  /** §2.2 — caps must sum under MemTotal or a thrash corner survives both caps. */
  private warnIfBudgetExceeded(): void {
    const serverLimit = this.config.serverLimitBytes;
    if (serverLimit === null) return;
    if (serverLimit + SERVER_BUDGET_HEADROOM_BYTES > this.config.reserveBytes) {
      this.log(
        `tool_cgroup_budget_warning serverLimitBytes=${serverLimit} headroomBytes=${SERVER_BUDGET_HEADROOM_BYTES} reserveBytes=${this.config.reserveBytes} — server cap plus headroom exceeds the tool reserve`
      );
    }
  }

  private enableControllers(): void {
    const controlPath = join(this.config.cgroupRoot, 'cgroup.subtree_control');
    try {
      // Token match — a substring check would mistake `cpuset` for `cpu`.
      const enabled = new Set(readFileSync(controlPath, 'utf8').trim().split(/\s+/));
      const missing = ['memory', 'cpu'].filter(controller => !enabled.has(controller));
      if (missing.length > 0) {
        writeFileSync(controlPath, missing.map(controller => `+${controller}`).join(' '));
      }
    } catch {
      // Leave it to the slice setup to fail if the controller is truly absent.
    }
  }
}

/**
 * Parse config from env, configure both slices, and start the sweeper.
 * Returns null when disabled or unavailable (e.g. read-only cgroup fs) —
 * the wrapper then runs exactly as before this feature existed.
 *
 * When mode is `off`, best-effort neutralizes any stale cap left by a
 * previous wrapper generation in a reused container (W2) before returning.
 */
export function startToolCgroup(
  env: Record<string, string | undefined>,
  log: Logger = logToFile,
  overrides?: Partial<ToolCgroupConfig>
): ToolCgroupManager | null {
  const config = { ...parseToolCgroupConfig(env, log), ...overrides };
  if (config.mode === 'off') {
    for (const name of [config.toolCgroupName, config.serverCgroupName]) {
      resetStaleControl(config.cgroupRoot, name, 'memory.max', 'max', log);
      resetStaleControl(config.cgroupRoot, name, 'cpu.weight', String(DEFAULT_CPU_WEIGHT), log);
    }
    return null;
  }
  const manager = new ToolCgroupManager(config, log);
  if (!manager.setup()) return null;
  manager.start();
  return manager;
}
