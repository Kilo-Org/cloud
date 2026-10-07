import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  decideWorkloadStatsEmission,
  readWorkloadStats,
  WORKLOAD_MEMORY_PRESSURE_FRACTION,
  WORKLOAD_STATS_INTERVAL_MS,
  type WorkloadStats,
  type WorkloadStatsEmissionState,
} from './workload-cgroup.js';

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe('readWorkloadStats', () => {
  it('reads CPU, I/O, pressure, and memory-limit counters without process content', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'workload-stats-'));
    directories.push(directory);
    writeFileSync(path.join(directory, 'memory.current'), '1024\n');
    writeFileSync(path.join(directory, 'memory.peak'), '2048\n');
    writeFileSync(
      path.join(directory, 'memory.events'),
      'max 4\noom 2\noom_kill 1\noom_group_kill 0\n'
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
      memoryMaxEvents: 4,
      memoryOomEvents: 2,
      oomKills: 1,
      oomGroupKills: 0,
      pressureSomeTotal: 50,
      pressureFullTotal: 20,
      cpuUsageUsec: 900,
      cpuThrottleCount: 3,
      cpuThrottledUsec: 75,
      ioReadBytes: 130,
      ioWriteBytes: 240,
    });
  });
});

describe('decideWorkloadStatsEmission', () => {
  const baseStats: WorkloadStats = { oomKills: 0, oomGroupKills: 0 };
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
      nowMs: emitted.lastEmittedAtMs + 1000,
      stats: { ...baseStats, cpuThrottleCount: 4 },
      state: emitted,
    });
    expect(decision).toMatchObject({ emit: true, reason: 'throttle_increase' });
  });

  it('emits as soon as a memory-event counter increases', () => {
    const decision = decideWorkloadStatsEmission({
      nowMs: emitted.lastEmittedAtMs + 1000,
      stats: { ...baseStats, memoryMaxEvents: 2 },
      state: emitted,
    });
    expect(decision).toMatchObject({ emit: true, reason: 'memory_events' });
  });

  it('emits once when the group first crosses the memory-pressure threshold', () => {
    const limitBytes = 1_000_000;
    const pressured = Math.ceil(limitBytes * WORKLOAD_MEMORY_PRESSURE_FRACTION);
    const crossed = decideWorkloadStatsEmission({
      nowMs: emitted.lastEmittedAtMs + 1000,
      stats: { ...baseStats, currentBytes: pressured },
      limitBytes,
      state: emitted,
    });
    expect(crossed).toMatchObject({ emit: true, reason: 'memory_pressure' });
    expect(crossed.state.highPressure).toBe(true);

    const held = decideWorkloadStatsEmission({
      nowMs: emitted.lastEmittedAtMs + 2000,
      stats: { ...baseStats, currentBytes: pressured + 1000 },
      limitBytes,
      state: crossed.state,
    });
    expect(held).toMatchObject({ emit: false, reason: 'none' });
  });

  it('does not treat elevated memory as pressure without a known limit', () => {
    const decision = decideWorkloadStatsEmission({
      nowMs: emitted.lastEmittedAtMs + 1000,
      stats: { ...baseStats, currentBytes: Number.MAX_SAFE_INTEGER },
      state: emitted,
    });
    expect(decision).toMatchObject({ emit: false, reason: 'none' });
  });
});
