import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  createWorkloadReporter,
  decideWorkloadStatsEmission,
  isWorkloadAtCap,
  readWorkloadStats,
  WORKLOAD_AT_CAP_FRACTION,
  WORKLOAD_MEMORY_PRESSURE_FRACTION,
  WORKLOAD_MEMORY_PRESSURE_RELEASE_FRACTION,
  WORKLOAD_STATS_EVENT_COOLDOWN_MS,
  WORKLOAD_STATS_INTERVAL_MS,
  type WorkloadSnapshot,
  type WorkloadStats,
  type WorkloadStatsEmissionState,
} from './workload-cgroup.js';

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe('readWorkloadStats', () => {
  it('reads CPU, I/O, pressure, memory-split, and memory-limit counters without process content', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'workload-stats-'));
    directories.push(directory);
    writeFileSync(path.join(directory, 'memory.current'), '1024\n');
    writeFileSync(path.join(directory, 'memory.peak'), '2048\n');
    writeFileSync(
      path.join(directory, 'memory.events'),
      'max 4\noom 2\noom_kill 1\noom_group_kill 0\n'
    );
    writeFileSync(
      path.join(directory, 'memory.stat'),
      'anon 700\nfile 300\nshmem 50\ninactive_file 200\n'
    );
    writeFileSync(
      path.join(directory, 'memory.pressure'),
      'some avg10=0 total=50\nfull avg10=0 total=20\n'
    );
    writeFileSync(
      path.join(directory, 'cpu.stat'),
      'usage_usec 900\nnr_throttled 3\nthrottled_usec 75\n'
    );
    writeFileSync(
      path.join(directory, 'io.stat'),
      '8:0 rbytes=100 wbytes=200\n8:1 rbytes=30 wbytes=40\n'
    );

    expect(readWorkloadStats(directory)).toEqual({
      currentBytes: 1024,
      peakBytes: 2048,
      anonBytes: 700,
      fileBytes: 300,
      shmemBytes: 50,
      memoryMaxEvents: 4,
      memoryOomEvents: 2,
      oomKills: 1,
      oomGroupKills: 0,
      pressureAvailable: true,
      pressureSomeTotal: 50,
      pressureFullTotal: 20,
      cpuUsageUsec: 900,
      cpuThrottleCount: 3,
      cpuThrottledUsec: 75,
      ioReadBytes: 130,
      ioWriteBytes: 240,
    });
  });

  it('reports absent PSI as unavailable and omits the split without memory.stat', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'workload-stats-'));
    directories.push(directory);
    writeFileSync(path.join(directory, 'memory.current'), '512\n');

    expect(readWorkloadStats(directory)).toEqual({
      currentBytes: 512,
      oomKills: 0,
      oomGroupKills: 0,
      pressureAvailable: false,
    });
  });
});

describe('decideWorkloadStatsEmission', () => {
  const baseStats: WorkloadStats = { oomKills: 0, oomGroupKills: 0, pressureAvailable: false };
  const emitted: WorkloadStatsEmissionState = {
    lastEmittedAtMs: 1_000_000,
    lastThrottleCount: 0,
    lastMemoryMaxEvents: 0,
    lastMemoryOomEvents: 0,
    highPressure: false,
  };

  it('emits an initial sample and then holds the periodic cadence', () => {
    const first = decideWorkloadStatsEmission({
      nowMs: 1_000_000,
      stats: baseStats,
      state: { lastEmittedAtMs: 0, highPressure: false },
    });
    expect(first).toMatchObject({ emit: true, reason: 'interval' });

    const quiet = decideWorkloadStatsEmission({
      nowMs: 1_000_000 + WORKLOAD_STATS_INTERVAL_MS - 1,
      stats: baseStats,
      state: first.state,
    });
    expect(quiet).toMatchObject({ emit: false, reason: 'none' });

    const due = decideWorkloadStatsEmission({
      nowMs: 1_000_000 + WORKLOAD_STATS_INTERVAL_MS,
      stats: baseStats,
      state: quiet.state,
    });
    expect(due).toMatchObject({ emit: true, reason: 'interval' });
  });

  it('emits as soon as a throttle counter increases', () => {
    const decision = decideWorkloadStatsEmission({
      nowMs: emitted.lastEmittedAtMs + WORKLOAD_STATS_EVENT_COOLDOWN_MS,
      stats: { ...baseStats, cpuThrottleCount: 4 },
      state: emitted,
    });
    expect(decision).toMatchObject({ emit: true, reason: 'throttle_increase' });
  });

  it('holds immediate triggers to the cooldown under sustained pressure', () => {
    const first = decideWorkloadStatsEmission({
      nowMs: emitted.lastEmittedAtMs + WORKLOAD_STATS_EVENT_COOLDOWN_MS,
      stats: { ...baseStats, cpuThrottleCount: 4 },
      state: emitted,
    });
    expect(first).toMatchObject({ emit: true, reason: 'throttle_increase' });

    const tooSoon = decideWorkloadStatsEmission({
      nowMs: emitted.lastEmittedAtMs + WORKLOAD_STATS_EVENT_COOLDOWN_MS + 1000,
      stats: { ...baseStats, cpuThrottleCount: 9 },
      state: first.state,
    });
    expect(tooSoon).toMatchObject({ emit: false, reason: 'none' });

    const later = decideWorkloadStatsEmission({
      nowMs: emitted.lastEmittedAtMs + 2 * WORKLOAD_STATS_EVENT_COOLDOWN_MS,
      stats: { ...baseStats, cpuThrottleCount: 9 },
      state: tooSoon.state,
    });
    expect(later).toMatchObject({ emit: true, reason: 'throttle_increase' });
  });

  it('emits as soon as a memory-event counter increases', () => {
    const decision = decideWorkloadStatsEmission({
      nowMs: emitted.lastEmittedAtMs + WORKLOAD_STATS_EVENT_COOLDOWN_MS,
      stats: { ...baseStats, memoryMaxEvents: 2 },
      state: emitted,
    });
    expect(decision).toMatchObject({ emit: true, reason: 'memory_events' });
  });

  it('emits once when the group first crosses the memory-pressure threshold', () => {
    const limitBytes = 1_000_000;
    const pressured = Math.ceil(limitBytes * WORKLOAD_MEMORY_PRESSURE_FRACTION);
    const crossed = decideWorkloadStatsEmission({
      nowMs: emitted.lastEmittedAtMs + WORKLOAD_STATS_EVENT_COOLDOWN_MS,
      stats: { ...baseStats, currentBytes: pressured },
      limitBytes,
      state: emitted,
    });
    expect(crossed).toMatchObject({ emit: true, reason: 'memory_pressure' });
    expect(crossed.state.highPressure).toBe(true);

    const held = decideWorkloadStatsEmission({
      nowMs: emitted.lastEmittedAtMs + 2 * WORKLOAD_STATS_EVENT_COOLDOWN_MS,
      stats: { ...baseStats, currentBytes: pressured + 1000 },
      limitBytes,
      state: crossed.state,
    });
    expect(held).toMatchObject({ emit: false, reason: 'none' });
    expect(held.state.highPressure).toBe(true);
  });

  it('releases pressure only below the release fraction before it can re-arm', () => {
    const limitBytes = 1_000_000;
    const pressured = Math.ceil(limitBytes * WORKLOAD_MEMORY_PRESSURE_FRACTION);
    const released = Math.floor(limitBytes * WORKLOAD_MEMORY_PRESSURE_RELEASE_FRACTION) - 1;
    const latched: WorkloadStatsEmissionState = { ...emitted, highPressure: true };

    const below = decideWorkloadStatsEmission({
      nowMs: emitted.lastEmittedAtMs + WORKLOAD_STATS_EVENT_COOLDOWN_MS,
      stats: { ...baseStats, currentBytes: released },
      limitBytes,
      state: latched,
    });
    expect(below).toMatchObject({ emit: false, reason: 'none' });
    expect(below.state.highPressure).toBe(false);

    const rearmed = decideWorkloadStatsEmission({
      nowMs: emitted.lastEmittedAtMs + WORKLOAD_STATS_EVENT_COOLDOWN_MS,
      stats: { ...baseStats, currentBytes: pressured },
      limitBytes,
      state: below.state,
    });
    expect(rearmed).toMatchObject({ emit: true, reason: 'memory_pressure' });
  });

  it('does not treat elevated memory as pressure without a known limit', () => {
    const decision = decideWorkloadStatsEmission({
      nowMs: emitted.lastEmittedAtMs + WORKLOAD_STATS_EVENT_COOLDOWN_MS,
      stats: { ...baseStats, currentBytes: Number.MAX_SAFE_INTEGER },
      state: emitted,
    });
    expect(decision).toMatchObject({ emit: false, reason: 'none' });
  });
});

describe('isWorkloadAtCap', () => {
  const gib = 1024 ** 3;
  const snapshot: WorkloadSnapshot = {
    aggregateMaxBytes: 11 * gib,
    toolsMaxBytes: 8 * gib,
    containerLimitBytes: 12 * gib,
    currentBytes: 11 * gib,
    pressureAvailable: false,
    oomKills: 0,
    oomGroupKills: 0,
    toolOomKills: 0,
    serverOomKills: 0,
  };

  it('treats the group at its cap as exhausted', () => {
    expect(isWorkloadAtCap(snapshot)).toBe(true);
  });

  it('treats the cap threshold as exhausted and steps just below it as not', () => {
    const max = 1000;
    const atThreshold: WorkloadSnapshot = {
      ...snapshot,
      aggregateMaxBytes: max,
      currentBytes: Math.ceil(max * WORKLOAD_AT_CAP_FRACTION),
    };
    expect(isWorkloadAtCap(atThreshold)).toBe(true);
    expect(
      isWorkloadAtCap({
        ...atThreshold,
        currentBytes: Math.floor(max * WORKLOAD_AT_CAP_FRACTION) - 1,
      })
    ).toBe(false);
  });

  it('is false below the cap or without a reading', () => {
    expect(isWorkloadAtCap({ ...snapshot, currentBytes: 5 * gib })).toBe(false);
    expect(isWorkloadAtCap({ ...snapshot, currentBytes: undefined })).toBe(false);
  });
});

describe('createWorkloadReporter', () => {
  it('reports a stats record when only a per-child counter changes', () => {
    const reported: Array<Record<string, unknown>> = [];
    const reporter = createWorkloadReporter((_event, fields) => reported.push(fields));
    const stats = { phase: 'completed', workloadPhase: 'stats', currentBytes: 100 } as const;

    reporter.emit('scope', { ...stats, toolCurrentBytes: 60, serverCurrentBytes: 40 });
    reporter.emit('scope', { ...stats, toolCurrentBytes: 60, serverCurrentBytes: 40 });
    reporter.emit('scope', { ...stats, toolCurrentBytes: 30, serverCurrentBytes: 70 });

    expect(reported.map(fields => fields.serverCurrentBytes)).toEqual([40, 70]);
  });
});
