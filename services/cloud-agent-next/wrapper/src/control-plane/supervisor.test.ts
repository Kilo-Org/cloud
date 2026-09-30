import { describe, expect, it } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SUPERVISOR_PATH = join(import.meta.dir, '..', '..', 'control-plane-supervisor.sh');

const FAKE_SOURCE = `const { appendFileSync, readFileSync, writeFileSync } = require('node:fs');
const log = process.env.FAKE_LOG;
let runs = 0;
try {
  runs = readFileSync(log, 'utf8').split('\\n').filter(Boolean).length;
} catch {}
appendFileSync(log, Date.now() + '\\n');
if (process.env.FAKE_PID_FILE) writeFileSync(process.env.FAKE_PID_FILE, String(process.pid));
const mode = process.env.FAKE_MODE ?? 'fail';
const sleepMs = Number(process.env.FAKE_SLEEP_MS ?? '0');
if (mode === 'exit0') process.exit(0);
if (mode === 'recover' && runs >= 1) process.exit(0);
if (mode === 'sleep-first' && runs < Number(process.env.FAKE_SLEEP_RUNS ?? '0') && sleepMs > 0) {
  Bun.sleepSync(sleepMs);
}
if (mode === 'sleep-every' && sleepMs > 0) Bun.sleepSync(sleepMs);
process.exit(1);
`;

type Harness = {
  dir: string;
  fake: string;
  log: string;
  pidFile: string;
  cleanup: () => Promise<void>;
};

async function createHarness(): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), 'supervisor-'));
  const fake = join(dir, 'fake.cjs');
  const log = join(dir, 'runs.log');
  const pidFile = join(dir, 'pid');
  await writeFile(fake, FAKE_SOURCE);
  return { dir, fake, log, pidFile, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

type SpawnOptions = {
  mode: 'exit0' | 'fail' | 'recover' | 'sleep-first' | 'sleep-every';
  sleepMs?: number;
  sleepRuns?: number;
  backoffMinMs?: number;
  backoffMaxMs?: number;
  divisor?: number;
  recordPid?: boolean;
};

function spawnSupervisor(harness: Harness, options: SpawnOptions): Bun.Subprocess {
  return Bun.spawn(['sh', SUPERVISOR_PATH], {
    env: {
      ...process.env,
      CONTROL_PLANE_WRAPPER_COMMAND: `bun ${harness.fake}`,
      CONTROL_PLANE_SUPERVISOR_BACKOFF_MIN_MS: String(options.backoffMinMs ?? 0),
      CONTROL_PLANE_SUPERVISOR_BACKOFF_MAX_MS: String(options.backoffMaxMs ?? 0),
      CONTROL_PLANE_TIMER_DIVISOR: String(options.divisor ?? 1),
      FAKE_LOG: harness.log,
      FAKE_MODE: options.mode,
      FAKE_SLEEP_MS: String(options.sleepMs ?? 0),
      FAKE_SLEEP_RUNS: String(options.sleepRuns ?? 0),
      ...(options.recordPid ? { FAKE_PID_FILE: harness.pidFile } : {}),
    },
    stdout: 'ignore',
    stderr: 'ignore',
  });
}

async function readTimestamps(log: string): Promise<number[]> {
  try {
    const text = await readFile(log, 'utf8');
    return text
      .split('\n')
      .filter(line => line.length > 0)
      .map(Number);
  } catch {
    return [];
  }
}

async function waitForRuns(log: string, count: number, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while ((await readTimestamps(log)).length < count) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${count} runs`);
    await Bun.sleep(20);
  }
}

async function waitForExit(proc: Bun.Subprocess, timeoutMs: number): Promise<number> {
  return Promise.race([
    proc.exited,
    (async () => {
      await Bun.sleep(timeoutMs);
      return Number.NaN;
    })(),
  ]);
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('control-plane-supervisor.sh', () => {
  it('ends the loop when the wrapper exits 0', async () => {
    const harness = await createHarness();
    try {
      const proc = spawnSupervisor(harness, { mode: 'exit0' });
      expect(await proc.exited).toBe(0);
      expect(await readTimestamps(harness.log)).toHaveLength(1);
    } finally {
      await harness.cleanup();
    }
  });

  it('restarts a failing wrapper five times, backoff growing to the cap, then gives up', async () => {
    const harness = await createHarness();
    try {
      const proc = spawnSupervisor(harness, {
        mode: 'fail',
        backoffMinMs: 250,
        backoffMaxMs: 1000,
        divisor: 1,
      });
      expect(await proc.exited).toBe(1);
      const times = await readTimestamps(harness.log);
      expect(times).toHaveLength(6);
      const gaps = times.slice(1).map((at, index) => at - (times[index] ?? at));
      expect(gaps[0]).toBeGreaterThanOrEqual(150);
      expect(gaps[1]).toBeGreaterThanOrEqual(400);
      expect(gaps[3]).toBeGreaterThanOrEqual(700);
      expect(gaps[4]).toBeGreaterThanOrEqual(700);
      expect(Math.max(...gaps)).toBeLessThanOrEqual(1_800);
    } finally {
      await harness.cleanup();
    }
  }, 20_000);

  it('recovers when a later run exits 0', async () => {
    const harness = await createHarness();
    try {
      const proc = spawnSupervisor(harness, { mode: 'recover' });
      expect(await proc.exited).toBe(0);
      expect(await readTimestamps(harness.log)).toHaveLength(2);
    } finally {
      await harness.cleanup();
    }
  });

  it('prunes restarts outside the window so it does not give up, and forwards TERM', async () => {
    const harness = await createHarness();
    try {
      const proc = spawnSupervisor(harness, {
        mode: 'sleep-every',
        sleepMs: 1_050,
        divisor: 600,
        recordPid: true,
      });
      await waitForRuns(harness.log, 7);
      expect(proc.exitCode).toBeNull();
      // Let the current child reach its sleep so TERM has a live child to kill.
      await Bun.sleep(200);
      const childPid = Number(await readFile(harness.pidFile, 'utf8'));
      process.kill(proc.pid, 'SIGTERM');
      expect(await waitForExit(proc, 5_000)).toBe(0);
      expect(isAlive(childPid)).toBe(false);
    } finally {
      await harness.cleanup();
    }
  }, 30_000);

  it('resets the backoff ladder after the window prunes earlier restarts', async () => {
    const harness = await createHarness();
    try {
      const proc = spawnSupervisor(harness, {
        mode: 'sleep-first',
        sleepMs: 1_050,
        sleepRuns: 4,
        divisor: 600,
        backoffMinMs: 100,
        backoffMaxMs: 3_000,
      });
      await waitForRuns(harness.log, 6);
      const times = await readTimestamps(harness.log);
      const gaps = times.slice(1).map((at, index) => at - (times[index] ?? at));
      // After four pruned slow runs the fifth failure must wait the minimum,
      // not the capped maximum a non-resetting attempt counter would reach.
      const postPrune = gaps[4] ?? Number.POSITIVE_INFINITY;
      expect(postPrune).toBeLessThanOrEqual(700);
      expect(postPrune).toBeLessThan(gaps[0] ?? 0);
      process.kill(proc.pid, 'SIGTERM');
      expect(await waitForExit(proc, 5_000)).toBe(0);
    } finally {
      await harness.cleanup();
    }
  }, 20_000);
});
