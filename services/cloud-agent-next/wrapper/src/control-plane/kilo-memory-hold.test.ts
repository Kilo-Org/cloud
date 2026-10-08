import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ControlDiagnosticFields } from '../../../src/shared/control-diagnostics.js';
import type { ControlWorkload } from '../control/workload-cgroup.js';
import {
  createKiloMemoryHold,
  isUnderMemoryPressure,
  MEMORY_PRESSURE_MARGIN_BYTES,
  workloadMemorySampler,
  type KiloMemorySample,
} from './kilo-memory-hold.js';

const LIMIT = 8 * 1024 * 1024 * 1024;
const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function sample(currentBytes: number, maxEvents: number): KiloMemorySample {
  return { currentBytes, limitBytes: LIMIT, maxEvents };
}

describe('isUnderMemoryPressure', () => {
  it('needs usage at the cap and new reclaim at it since the previous sample', () => {
    expect(isUnderMemoryPressure(sample(LIMIT, 10), sample(LIMIT - 4096, 11))).toBe(true);
    expect(isUnderMemoryPressure(sample(LIMIT, 10), sample(LIMIT, 10))).toBe(false);
    expect(
      isUnderMemoryPressure(sample(LIMIT, 10), sample(LIMIT - MEMORY_PRESSURE_MARGIN_BYTES - 1, 11))
    ).toBe(false);
  });
});

describe('createKiloMemoryHold', () => {
  function hold(samples: KiloMemorySample[]) {
    const reports: ControlDiagnosticFields[] = [];
    const held: boolean[] = [];
    const memoryHold = createKiloMemoryHold({
      directory: '/workspace',
      holdMs: 600_000,
      sample: () => samples.shift(),
      log: () => undefined,
      report: (_event, fields) => reports.push(fields),
      onHeld: value => held.push(value),
    });
    return { memoryHold, reports, held };
  }

  it('ends the hold as cleared only after reclaim stops for two samples in a row', () => {
    const freed = LIMIT - 2 * MEMORY_PRESSURE_MARGIN_BYTES;
    const { memoryHold, reports, held } = hold([
      sample(LIMIT, 1),
      sample(LIMIT, 5),
      sample(freed, 5),
      sample(LIMIT, 9),
      sample(freed, 9),
      sample(freed, 9),
    ]);
    memoryHold.sample(0, false);
    memoryHold.sample(1_000, false);

    expect(memoryHold.holds(1_000)).toBe(true);
    // A second restart path in the same check gets the same answer and counts no quiet sample.
    expect(memoryHold.holds(1_000)).toBe(true);
    memoryHold.sample(6_000, false);
    expect(memoryHold.holds(6_000)).toBe(true);
    // Pressure resets the quiet count.
    memoryHold.sample(11_000, false);
    memoryHold.sample(16_000, false);
    expect(memoryHold.holds(16_000)).toBe(true);
    memoryHold.sample(21_000, false);
    expect(memoryHold.holds(21_000)).toBe(false);
    expect(held).toEqual([true, false]);
    expect(reports.at(-1)).toMatchObject({
      phase: 'kilo_memory_hold_ended',
      memoryHoldOutcome: 'cleared',
      elapsedMs: 20_000,
    });
  });

  it('holds one episode at most holdMs, then not again until Kilo is healthy', () => {
    const { memoryHold, reports, held } = hold(
      Array.from({ length: 200 }, (_, index) => sample(LIMIT, index))
    );
    memoryHold.sample(0, false);
    memoryHold.sample(5_000, false);
    expect(memoryHold.holds(5_000)).toBe(true);
    for (let at = 10_000; at < 605_000; at += 5_000) {
      memoryHold.sample(at, false);
      expect(memoryHold.holds(at)).toBe(true);
    }
    memoryHold.sample(605_000, false);
    expect(memoryHold.holds(605_000)).toBe(false);
    memoryHold.sample(610_000, false);
    expect(memoryHold.holds(610_000)).toBe(false);
    expect(held).toEqual([true, false]);
    expect(reports.map(fields => fields.memoryHoldOutcome).filter(Boolean)).toEqual(['expired']);

    // A healthy Kilo starts a new episode.
    memoryHold.sample(615_000, true);
    memoryHold.sample(620_000, false);
    expect(memoryHold.holds(620_000)).toBe(true);
  });

  it('ends the hold as recovered once Kilo is healthy', () => {
    const { memoryHold, reports, held } = hold([
      sample(LIMIT, 1),
      sample(LIMIT, 2),
      sample(LIMIT, 3),
    ]);
    memoryHold.sample(0, false);
    memoryHold.sample(5_000, false);
    expect(memoryHold.holds(5_000)).toBe(true);
    memoryHold.sample(10_000, true);
    expect(held).toEqual([true, false]);
    expect(reports.at(-1)).toMatchObject({ memoryHoldOutcome: 'recovered', elapsedMs: 5_000 });
  });

  it('does not hold without two samples and reports nothing for a release with no hold', () => {
    const { memoryHold, reports, held } = hold([sample(LIMIT, 5)]);

    memoryHold.sample(0, false);
    expect(memoryHold.holds(1_000)).toBe(false);
    memoryHold.release(2_000, 'restarted');
    expect(reports).toEqual([]);
    expect(held).toEqual([]);
  });
});

describe('workloadMemorySampler', () => {
  it('reads usage and reclaim events from the shared workload parent', () => {
    const parent = mkdtempSync(path.join(tmpdir(), 'kilo-memory-hold-'));
    directories.push(parent);
    writeFileSync(path.join(parent, 'memory.current'), `${LIMIT - 4096}\n`);
    writeFileSync(path.join(parent, 'memory.events'), 'low 0\nhigh 0\nmax 42\noom 0\noom_kill 0\n');
    const workload = {
      enabled: true,
      placement: { parentReference: parent, aggregateMaxBytes: LIMIT },
    } as unknown as ControlWorkload;

    expect(workloadMemorySampler(workload)()).toEqual({
      currentBytes: LIMIT - 4096,
      limitBytes: LIMIT,
      maxEvents: 42,
    });
    expect(workloadMemorySampler({ enabled: false })()).toBeUndefined();
  });
});
