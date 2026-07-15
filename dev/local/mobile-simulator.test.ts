import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  bootSimulator,
  claimSimulator,
  releaseSimulator,
  type SimulatorDevice,
} from './mobile-simulator';

type ExecCall = { command: string; args: readonly string[]; options: unknown };
type OutputCall = { command: string; args: readonly string[] };
type CommandResult = { stdout: string; stderr: string; status: number | null };

function recordingExec(
  behavior: (call: ExecCall) => Error | undefined
): (command: string, args: readonly string[], options: unknown) => Buffer {
  const calls: ExecCall[] = [];
  const exec = ((command: string, args: readonly string[], options: unknown) => {
    const call: ExecCall = { command, args, options };
    calls.push(call);
    const result = behavior(call);
    if (result) throw result;
    return Buffer.from('');
  }) as (command: string, args: readonly string[], options: unknown) => Buffer;
  (exec as { calls?: ExecCall[] }).calls = calls;
  return exec;
}

function callsOf(exec: ReturnType<typeof recordingExec>): string[] {
  return (exec as unknown as { calls: ExecCall[] }).calls.map(call => {
    const action = call.args[1] ?? '';
    return `${action} ${call.args.slice(2).join(' ')}`.trim();
  });
}

type OutputBehavior = (call: OutputCall) => CommandResult;

function recordingOutput(
  behavior: OutputBehavior
): (command: string, args: readonly string[]) => CommandResult {
  return (command: string, args: readonly string[]) => behavior({ command, args });
}

const devices: SimulatorDevice[] = [
  { id: 'A', name: 'Kilo E2E-A', state: 'Booted' },
  { id: 'B', name: 'Kilo E2E-B', state: 'Shutdown' },
];

test('claims an unowned simulator instead of sharing another worktree simulator', () => {
  const lockRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-simulator-locks-'));
  const one = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-worktree-one-'));
  const two = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-worktree-two-'));
  claimSimulator({ devices, lockRoot, worktreeRoot: one, requestedId: 'A' });

  const claim = claimSimulator({ devices, lockRoot, worktreeRoot: two });

  assert.equal(claim.device.id, 'B');
  fs.rmSync(lockRoot, { recursive: true, force: true });
  fs.rmSync(one, { recursive: true, force: true });
  fs.rmSync(two, { recursive: true, force: true });
});

test('refuses to release a simulator claimed by another worktree', () => {
  const lockRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-simulator-locks-'));
  const one = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-worktree-one-'));
  const two = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-worktree-two-'));
  claimSimulator({ devices, lockRoot, worktreeRoot: one, requestedId: 'A' });

  assert.throws(
    () => releaseSimulator({ deviceId: 'A', lockRoot, worktreeRoot: two }),
    new RegExp(`claimed by ${one}`)
  );
  fs.rmSync(lockRoot, { recursive: true, force: true });
  fs.rmSync(one, { recursive: true, force: true });
  fs.rmSync(two, { recursive: true, force: true });
});

test('uses exclusive claim creation to prevent concurrent simulator sharing', () => {
  const source = fs.readFileSync(new URL('./mobile-simulator.ts', import.meta.url), 'utf8');
  assert.match(source, /flag: 'wx'/);
});

for (const initialClaim of ['missing', 'invalid', 'stale'] as const) {
  test(`serializes iOS claim cleanup after reading a ${initialClaim} claim`, () => {
    const lockRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-simulator-locks-'));
    const firstWorktree = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-worktree-one-'));
    const secondWorktree = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-worktree-two-'));
    const staleWorktree = path.join(lockRoot, 'removed-worktree');
    const filePath = path.join(lockRoot, 'A.json');
    if (initialClaim === 'invalid') fs.writeFileSync(filePath, '{');
    if (initialClaim === 'stale') {
      fs.writeFileSync(filePath, JSON.stringify({ worktreeRoot: staleWorktree }));
    }
    let concurrentClaimError: unknown;
    let concurrentClaimSucceeded = false;
    let injected = false;

    try {
      const claim = claimSimulator({
        devices,
        lockRoot,
        worktreeRoot: firstWorktree,
        requestedId: 'A',
        fileOperations: {
          readFileSync: (candidate, encoding) => {
            let value: string;
            try {
              value = fs.readFileSync(candidate, encoding);
            } catch (error) {
              if (!injected) {
                injected = true;
                try {
                  claimSimulator({
                    devices,
                    lockRoot,
                    worktreeRoot: secondWorktree,
                    requestedId: 'A',
                  });
                  concurrentClaimSucceeded = true;
                } catch (claimError) {
                  concurrentClaimError = claimError;
                }
              }
              throw error;
            }
            if (!injected) {
              injected = true;
              try {
                claimSimulator({
                  devices,
                  lockRoot,
                  worktreeRoot: secondWorktree,
                  requestedId: 'A',
                });
                concurrentClaimSucceeded = true;
              } catch (error) {
                concurrentClaimError = error;
              }
            }
            return value;
          },
        },
      });

      assert.equal(concurrentClaimSucceeded, false);
      assert.match(String(concurrentClaimError), /claim is being updated concurrently/);
      assert.equal(claim.device.id, 'A');
      assert.equal(JSON.parse(fs.readFileSync(filePath, 'utf8')).worktreeRoot, firstWorktree);
    } finally {
      fs.rmSync(lockRoot, { recursive: true, force: true });
      fs.rmSync(firstWorktree, { recursive: true, force: true });
      fs.rmSync(secondWorktree, { recursive: true, force: true });
    }
  });
}

for (const failedCommand of ['boot', 'bootstatus'] as const) {
  test(`releases a newly acquired iOS claim when ${failedCommand} fails`, () => {
    const lockRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-simulator-locks-'));
    const worktreeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-worktree-'));
    const commands: string[] = [];

    try {
      assert.throws(
        () =>
          claimSimulator({
            devices,
            lockRoot,
            worktreeRoot,
            requestedId: 'B',
            prepare: () => {
              for (const command of ['boot', 'bootstatus']) {
                commands.push(command);
                if (command === failedCommand) throw new Error(`${command} failed`);
              }
            },
          }),
        new RegExp(`${failedCommand} failed`)
      );

      assert.deepEqual(commands, failedCommand === 'boot' ? ['boot'] : ['boot', 'bootstatus']);
      assert.equal(fs.existsSync(path.join(lockRoot, 'B.json')), false);
    } finally {
      fs.rmSync(lockRoot, { recursive: true, force: true });
      fs.rmSync(worktreeRoot, { recursive: true, force: true });
    }
  });
}

test('preserves an existing iOS claim when simulator preparation fails', () => {
  const lockRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-simulator-locks-'));
  const worktreeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-worktree-'));

  try {
    claimSimulator({ devices, lockRoot, worktreeRoot, requestedId: 'B' });

    assert.throws(
      () =>
        claimSimulator({
          devices,
          lockRoot,
          worktreeRoot,
          requestedId: 'B',
          prepare: () => {
            throw new Error('bootstatus failed');
          },
        }),
      /bootstatus failed/
    );
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(lockRoot, 'B.json'), 'utf8')).worktreeRoot,
      worktreeRoot
    );
  } finally {
    fs.rmSync(lockRoot, { recursive: true, force: true });
    fs.rmSync(worktreeRoot, { recursive: true, force: true });
  }
});

test('recovers an orphaned iOS claim mutation lock', () => {
  const lockRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-simulator-locks-'));
  const worktreeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-worktree-'));
  const mutationLockPath = path.join(lockRoot, 'A.json.lock');
  fs.mkdirSync(mutationLockPath);
  const settledTime = new Date(Date.now() - 6000);
  fs.utimesSync(mutationLockPath, settledTime, settledTime);

  try {
    const claim = claimSimulator({ devices, lockRoot, worktreeRoot, requestedId: 'A' });
    assert.equal(claim.device.id, 'A');
    releaseSimulator({ deviceId: 'A', lockRoot, worktreeRoot });
  } finally {
    fs.rmSync(lockRoot, { recursive: true, force: true });
    fs.rmSync(worktreeRoot, { recursive: true, force: true });
  }
});

test('blocks a same-worktree adoption during prepare so a failed first prepare cannot delete the adopted claim', () => {
  const lockRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-simulator-locks-'));
  const worktreeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-worktree-'));
  let secondClaimError: unknown = null;
  let secondClaimResult: ReturnType<typeof claimSimulator> | null = null;
  let firstClaimError: unknown = null;

  try {
    claimSimulator({
      devices,
      lockRoot,
      worktreeRoot,
      requestedId: 'B',
      prepare: () => {
        // While the first call's prepare is running, a second same-worktree
        // claim attempt must be blocked by the device mutation lock instead of
        // adopting the claim that the first call owns.
        try {
          secondClaimResult = claimSimulator({
            devices,
            lockRoot,
            worktreeRoot,
            requestedId: 'B',
          });
        } catch (error) {
          secondClaimError = error;
        }
        throw new Error('bootstatus failed');
      },
    });
  } catch (error) {
    firstClaimError = error;
  }

  assert.match(String(firstClaimError), /bootstatus failed/);
  assert.equal(secondClaimResult, null);
  assert.match(String(secondClaimError), /claim is being updated concurrently/);
});

test('shuts down a simulator booted by this attempt when bootstatus fails', () => {
  const device = { id: 'B', name: 'Kilo E2E-B', state: 'Shutdown' };
  const exec = recordingExec(() => undefined);
  const runWithOutput = recordingOutput(() => {
    throw new Error('bootstatus failed');
  });

  assert.throws(() => bootSimulator(device, exec, runWithOutput), /bootstatus failed/);
  assert.deepEqual(callsOf(exec), ['boot B', 'shutdown B']);
});

test('does not shut down when boot fails', () => {
  const device = { id: 'B', name: 'Kilo E2E-B', state: 'Shutdown' };
  const exec = recordingExec(call => {
    if (call.args[1] === 'boot') return new Error('boot failed');
    return undefined;
  });
  const runWithOutput = recordingOutput(() => {
    throw new Error('bootstatus should not be reached');
  });

  assert.throws(() => bootSimulator(device, exec, runWithOutput), /boot failed/);
  assert.deepEqual(callsOf(exec), ['boot B']);
});

test('does not boot or shut down an already-booted simulator', () => {
  const device = { id: 'A', name: 'Kilo E2E-A', state: 'Booted' };
  const exec = recordingExec(() => undefined);
  const runWithOutput = recordingOutput(() => {
    throw new Error('runWithOutput should not be reached');
  });

  bootSimulator(device, exec, runWithOutput);
  assert.deepEqual(callsOf(exec), []);
});

test('does not shut down a simulator when boot and bootstatus both succeed', () => {
  const device = { id: 'B', name: 'Kilo E2E-B', state: 'Shutdown' };
  const exec = recordingExec(() => undefined);
  const runWithOutput = recordingOutput(() => ({
    stdout: 'Status=0, isTerminal=YES',
    stderr: '',
    status: 0,
  }));

  bootSimulator(device, exec, runWithOutput);
  assert.deepEqual(callsOf(exec), ['boot B']);
});

test('shut down after bootstatus failure swallows the shutdown error so the original cause surfaces', () => {
  const device = { id: 'B', name: 'Kilo E2E-B', state: 'Shutdown' };
  const exec = recordingExec(call => {
    if (call.args[1] === 'shutdown') return new Error('shutdown failed');
    return undefined;
  });
  const runWithOutput = recordingOutput(() => {
    throw new Error('bootstatus failed');
  });

  assert.throws(() => bootSimulator(device, exec, runWithOutput), /bootstatus failed/);
  assert.deepEqual(callsOf(exec), ['boot B', 'shutdown B']);
});

test('rejects bootstatus with terminal Data Migration Failed output even when exit is 0', () => {
  const device = { id: 'B', name: 'Kilo E2E-B', state: 'Shutdown' };
  const exec = recordingExec(() => undefined);
  const runWithOutput = recordingOutput(() => ({
    stdout: 'Status=3, isTerminal=YES\nData Migration Failed\n',
    stderr: '',
    status: 0,
  }));

  assert.throws(
    () => bootSimulator(device, exec, runWithOutput),
    /bootstatus reported terminal failure[\s\S]*Data Migration Failed/
  );
  assert.deepEqual(callsOf(exec), ['boot B', 'shutdown B']);
});

test('rejects bootstatus when terminal failure appears on stderr only', () => {
  const device = { id: 'B', name: 'Kilo E2E-B', state: 'Shutdown' };
  const exec = recordingExec(() => undefined);
  const runWithOutput = recordingOutput(() => ({
    stdout: 'Status=0, isTerminal=NO\n',
    stderr: 'Status=3, isTerminal=YES\nData Migration Failed\n',
    status: 0,
  }));

  assert.throws(
    () => bootSimulator(device, exec, runWithOutput),
    /bootstatus reported terminal failure/
  );
  assert.deepEqual(callsOf(exec), ['boot B', 'shutdown B']);
});

test('accepts bootstatus with successful terminal output and does not shut down', () => {
  const device = { id: 'B', name: 'Kilo E2E-B', state: 'Shutdown' };
  const exec = recordingExec(() => undefined);
  const runWithOutput = recordingOutput(() => ({
    stdout: 'Status=0, isTerminal=YES\nDevice booted.\n',
    stderr: '',
    status: 0,
  }));

  bootSimulator(device, exec, runWithOutput);
  assert.deepEqual(callsOf(exec), ['boot B']);
});

test('preserves non-zero bootstatus error precedence over a swallowed shutdown failure', () => {
  const device = { id: 'B', name: 'Kilo E2E-B', state: 'Shutdown' };
  const exec = recordingExec(call => {
    if (call.args[1] === 'shutdown') return new Error('shutdown failed');
    return undefined;
  });
  const runWithOutput = recordingOutput(() => {
    const error = new Error('xcrun simctl bootstatus B exited with status 1');
    (error as Error & { status?: number | null }).status = 1;
    throw error;
  });

  assert.throws(() => bootSimulator(device, exec, runWithOutput), /exited with status 1/);
  assert.deepEqual(callsOf(exec), ['boot B', 'shutdown B']);
});

test('rolls back the iOS claim when bootstatus reports a terminal failure', () => {
  const lockRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-simulator-locks-'));
  const worktreeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-worktree-'));

  try {
    assert.throws(
      () =>
        claimSimulator({
          devices,
          lockRoot,
          worktreeRoot,
          requestedId: 'B',
          prepare: () => {
            // Simulate the real failure path: bootSimulator sees a terminal
            // bootstatus output, throws, and rolls back the claim.
            const exec = recordingExec(() => undefined);
            const runWithOutput = recordingOutput(() => ({
              stdout: 'Status=3, isTerminal=YES\nData Migration Failed\n',
              stderr: '',
              status: 0,
            }));
            bootSimulator({ id: 'B', name: 'Kilo E2E-B', state: 'Shutdown' }, exec, runWithOutput);
          },
        }),
      /bootstatus reported terminal failure/
    );
    assert.equal(fs.existsSync(path.join(lockRoot, 'B.json')), false);
  } finally {
    fs.rmSync(lockRoot, { recursive: true, force: true });
    fs.rmSync(worktreeRoot, { recursive: true, force: true });
  }
});
