import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { once } from 'node:events';
import * as fs from 'node:fs';
import { runProcess } from '../utils.js';
import { createOwnedProcessScope } from './owned-processes.js';

const spawned: ReturnType<typeof createOwnedProcessScope>[] = [];

function killPid(pid: number): void {
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    return;
  }
}

afterEach(async () => {
  await Promise.all(spawned.splice(0).map(scope => scope.stop(Date.now() + 1_000)));
});

const descendantThatExitsMs = (ms: number) =>
  `const { spawn } = require('node:child_process'); const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, ${ms})'], { stdio: 'ignore' }); process.stdout.write(String(child.pid)); setTimeout(() => process.exit(0), 20);`;

const immortalDescendant = `const { spawn } = require('node:child_process'); const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }); process.stdout.write(String(child.pid)); setTimeout(() => process.exit(0), 20);`;

describe('owned process scopes', () => {
  it('coalesces cleanup and treats unavailable containment as unconfirmed', async () => {
    const scope = createOwnedProcessScope();
    spawned.push(scope);
    const child = scope.spawn(process.execPath, ['-e', 'setInterval(() => {}, 1_000)'], {
      cwd: process.cwd(),
      env: process.env,
    });
    const exited = once(child, 'exit');
    const first = scope.stop(Date.now() + 1_000);
    const second = scope.stop(Date.now() + 500);

    expect(second).toBe(first);
    const stopped = await first;
    expect(stopped).toBe(await scope.verify(false));
    await exited;
    if (process.platform !== 'linux') expect(await scope.verify(false)).toBe(false);
  });

  it('keeps proven death after a bounded cgroup removal failure on Linux', async () => {
    if (process.platform !== 'linux') return;
    const scope = createOwnedProcessScope();
    spawned.push(scope);
    const child = scope.spawn(process.execPath, ['-e', 'process.exit(0)'], {
      cwd: process.cwd(),
      env: process.env,
    });
    await once(child, 'exit');
    if (!scope.observesOccupancy()) return;
    const removal = spyOn(fs, 'rmdirSync').mockImplementation(() => {
      throw new Error('simulated cgroup removal failure');
    });
    try {
      expect(await scope.stop(Date.now() + 1_000)).toBe(true);
      const deadlineAt = Date.now() + 1_000;
      while (removal.mock.calls.length === 0 && Date.now() < deadlineAt) await Bun.sleep(5);
      expect(removal).toHaveBeenCalled();
      expect(await scope.verify(false)).toBe(true);
    } finally {
      removal.mockRestore();
    }
  });

  it('removes a delayed descendant that outlives its tracked parent when containment is available', async () => {
    if (process.platform !== 'linux') return;
    const scope = createOwnedProcessScope();
    spawned.push(scope);
    const parent = scope.spawn(
      process.execPath,
      [
        '-e',
        "const { spawn } = require('node:child_process'); setTimeout(() => { const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }); process.stdout.write(String(child.pid)); setTimeout(() => process.exit(0), 20); }, 20);",
      ],
      { cwd: process.cwd(), env: process.env }
    );
    let output = '';
    parent.stdout.on('data', data => {
      output += data.toString();
    });
    await once(parent, 'exit');
    const descendant = Number(output);
    expect(Number.isSafeInteger(descendant)).toBe(true);

    if (!(await scope.stop(Date.now() + 1_000))) {
      killPid(descendant);
      return;
    }
    expect(() => process.kill(descendant, 0)).toThrow();
  });

  it('keeps occupancy after a successful parent exit until descendants are gone on Linux', async () => {
    if (process.platform !== 'linux') return;
    const scope = createOwnedProcessScope();
    spawned.push(scope);
    let descendant = 0;
    try {
      const result = await scope.run(() =>
        runProcess(process.execPath, ['-e', immortalDescendant], { timeoutMs: 400 })
      );
      descendant = Number(result.stdout);
      expect(result.exitCode).toBe(0);
      expect(Number.isSafeInteger(descendant) && descendant > 0).toBe(true);
      if (!scope.observesOccupancy()) return;
      expect(await scope.verify(false)).toBe(false);
      expect(scope.dispose()).toBe(false);
      killPid(descendant);
      const deadlineAt = Date.now() + 1_000;
      while (Date.now() < deadlineAt && !(await scope.verify(false))) {
        await Bun.sleep(25);
      }
      expect(await scope.verify(false)).toBe(true);
    } finally {
      if (descendant > 0) killPid(descendant);
    }
  });

  it('waits for a short-lived descendant before treating runProcess as complete on Linux', async () => {
    if (process.platform !== 'linux') return;
    const scope = createOwnedProcessScope();
    spawned.push(scope);
    let descendant = 0;
    try {
      const startedAt = Date.now();
      const result = await scope.run(() =>
        runProcess(process.execPath, ['-e', descendantThatExitsMs(250)], { timeoutMs: 2_000 })
      );
      descendant = Number(result.stdout);
      expect(result.exitCode).toBe(0);
      if (!scope.observesOccupancy()) return;
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(200);
      expect(await scope.verify(false)).toBe(true);
    } finally {
      if (descendant > 0) killPid(descendant);
    }
  });

  it('does not wait for Darwin occupancy after the tracked parent exits', async () => {
    if (process.platform === 'linux') return;
    const scope = createOwnedProcessScope();
    spawned.push(scope);
    let descendant = 0;
    try {
      const startedAt = Date.now();
      const result = await scope.run(() =>
        runProcess(process.execPath, ['-e', immortalDescendant], { timeoutMs: 2_000 })
      );
      descendant = Number(result.stdout);
      expect(result.exitCode).toBe(0);
      expect(Number.isSafeInteger(descendant) && descendant > 0).toBe(true);
      expect(Date.now() - startedAt).toBeLessThan(1_000);
      expect(await scope.verify(false)).toBe(false);
    } finally {
      if (descendant > 0) killPid(descendant);
    }
  });

  it('does not wait out timeoutMs after close when occupancy is unobservable', async () => {
    const scope = createOwnedProcessScope();
    spawned.push(scope);
    const result = await scope.run(async () => {
      const ungated = scope.spawn('/bin/true', [], {
        cwd: process.cwd(),
        env: process.env,
        shell: true,
      });
      await once(ungated, 'close');
      expect(scope.observesOccupancy()).toBe(false);
      const startedAt = Date.now();
      const completed = await runProcess(process.execPath, ['-e', 'process.exit(0)'], {
        timeoutMs: 2_000,
      });
      expect(Date.now() - startedAt).toBeLessThan(1_000);
      return completed;
    });
    expect(result.exitCode).toBe(0);
  });
});
