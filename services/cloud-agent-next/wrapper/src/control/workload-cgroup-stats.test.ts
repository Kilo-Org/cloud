import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readWorkloadStats } from './workload-cgroup.js';

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
