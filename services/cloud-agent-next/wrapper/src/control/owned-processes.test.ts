import { afterEach, describe, expect, it } from 'bun:test';
import { once } from 'node:events';
import { createOwnedProcessScope } from './owned-processes.js';

const spawned: ReturnType<typeof createOwnedProcessScope>[] = [];

afterEach(async () => {
  await Promise.all(spawned.splice(0).map(scope => scope.stop(Date.now() + 1_000)));
});

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
    expect(await first).toBe(process.platform === 'linux');
    await exited;
    if (process.platform !== 'linux') expect(await scope.verify(false)).toBe(false);
  });

  it('removes a delayed descendant that outlives its tracked parent on Linux', async () => {
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

    expect(await scope.stop(Date.now() + 1_000)).toBe(true);
    expect(() => process.kill(descendant, 0)).toThrow();
  });
});
