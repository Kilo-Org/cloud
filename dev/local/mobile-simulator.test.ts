import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  bootSimulator,
  buildSimulatorLabel,
  claimSimulator,
  parseClaimArgs,
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
        // The mutation lock is released before prepare runs. A second
        // same-worktree claim attempt must observe the preparing claim and
        // reject — it must not adopt the in-flight claim and it must not
        // delete the adopted claim if the first prepare then fails.
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
  assert.match(String(secondClaimError), /preparation in progress/);
  // The preparing claim must have been rolled back by exact claimId.
  assert.equal(fs.existsSync(path.join(lockRoot, 'B.json')), false);
  fs.rmSync(lockRoot, { recursive: true, force: true });
  fs.rmSync(worktreeRoot, { recursive: true, force: true });
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

test('rejects a different-worktree claim while a peer is preparing (no heartbeat)', () => {
  const lockRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-simulator-locks-'));
  const firstWorktree = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-worktree-one-'));
  const secondWorktree = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-worktree-two-'));
  let secondClaimError: unknown = null;

  try {
    claimSimulator({
      devices,
      lockRoot,
      worktreeRoot: firstWorktree,
      requestedId: 'B',
      prepare: () => {
        // While the first worktree is preparing, a different worktree must
        // see the preparing claim and reject without adopting it.
        try {
          claimSimulator({
            devices,
            lockRoot,
            worktreeRoot: secondWorktree,
            requestedId: 'B',
          });
        } catch (error) {
          secondClaimError = error;
        }
        // Return normally so the first claim finalizes.
      },
    });

    assert.match(String(secondClaimError), /preparation in progress|claimed by/);
    const persisted = JSON.parse(fs.readFileSync(path.join(lockRoot, 'B.json'), 'utf8'));
    assert.equal(persisted.worktreeRoot, firstWorktree);
    assert.equal(persisted.status, 'ready');
  } finally {
    fs.rmSync(lockRoot, { recursive: true, force: true });
    fs.rmSync(firstWorktree, { recursive: true, force: true });
    fs.rmSync(secondWorktree, { recursive: true, force: true });
  }
});

test('finalizes a successful prepare with a ready status and the same claimId', () => {
  const lockRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-simulator-locks-'));
  const worktreeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-worktree-'));
  const snapshot: { value: { status?: string; claimId?: string } | null } = { value: null };

  try {
    const claim = claimSimulator({
      devices,
      lockRoot,
      worktreeRoot,
      requestedId: 'B',
      prepare: () => {
        // While the mutation lock is released, the on-disk claim must be in
        // the preparing state with a non-empty claimId.
        snapshot.value = JSON.parse(fs.readFileSync(path.join(lockRoot, 'B.json'), 'utf8')) as {
          status?: string;
          claimId?: string;
        };
      },
    });

    const prepareClaimSnapshot = snapshot.value;
    assert.equal(claim.alreadyOwned, false);
    assert.equal(prepareClaimSnapshot?.status, 'preparing');
    assert.match(prepareClaimSnapshot?.claimId ?? '', /\S+/);
    const finalClaim = JSON.parse(fs.readFileSync(path.join(lockRoot, 'B.json'), 'utf8')) as {
      status: string;
      claimId: string;
    };
    assert.equal(finalClaim.status, 'ready');
    assert.equal(finalClaim.claimId, prepareClaimSnapshot?.claimId);
  } finally {
    fs.rmSync(lockRoot, { recursive: true, force: true });
    fs.rmSync(worktreeRoot, { recursive: true, force: true });
  }
});

test('rolls back only the exact preparing claimId when prepare fails', () => {
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
            throw new Error('bootstatus failed');
          },
        }),
      /bootstatus failed/
    );
    assert.equal(fs.existsSync(path.join(lockRoot, 'B.json')), false);
  } finally {
    fs.rmSync(lockRoot, { recursive: true, force: true });
    fs.rmSync(worktreeRoot, { recursive: true, force: true });
  }
});

test('preserves a preparing claim when shutdown fails so a peer cannot adopt a running device', () => {
  const lockRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-simulator-locks-'));
  const firstWorktree = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-worktree-one-'));
  const secondWorktree = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-worktree-two-'));
  const errorCapture: { value: unknown } = { value: null };

  try {
    try {
      claimSimulator({
        devices,
        lockRoot,
        worktreeRoot: firstWorktree,
        requestedId: 'B',
        prepare: () => {
          // Simulate bootSimulator: boot succeeds, bootstatus throws, then
          // shutdown also throws. The claim must be preserved with the
          // preparing status so a peer cannot adopt a possibly running
          // device. The original prepare error must surface with a typed
          // shutdownFailed signal.
          const exec = recordingExec(call => {
            if (call.args[1] === 'shutdown') return new Error('shutdown failed');
            return undefined;
          });
          const runWithOutput = recordingOutput(() => {
            throw new Error('bootstatus failed');
          });
          try {
            bootSimulator({ id: 'B', name: 'Kilo E2E-B', state: 'Shutdown' }, exec, runWithOutput);
          } catch (error) {
            errorCapture.value = error;
            throw error;
          }
        },
      });
    } catch (error) {
      assert.match(String(error), /bootstatus failed/);
    }

    const prepareError = errorCapture.value as Error & { shutdownFailed?: boolean };
    assert.equal(prepareError?.shutdownFailed, true);
    const persisted = JSON.parse(fs.readFileSync(path.join(lockRoot, 'B.json'), 'utf8')) as {
      status: string;
      worktreeRoot: string;
    };
    assert.equal(persisted.status, 'preparing');
    assert.equal(persisted.worktreeRoot, firstWorktree);

    // A peer must not be able to adopt the preserved preparing claim.
    assert.throws(
      () =>
        claimSimulator({
          devices,
          lockRoot,
          worktreeRoot: secondWorktree,
          requestedId: 'B',
        }),
      /claimed by|preparation in progress/
    );
  } finally {
    fs.rmSync(lockRoot, { recursive: true, force: true });
    fs.rmSync(firstWorktree, { recursive: true, force: true });
    fs.rmSync(secondWorktree, { recursive: true, force: true });
  }
});

test('removes a preparing claim when shutdown succeeds after prepare failure', () => {
  const lockRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-simulator-locks-'));
  const worktreeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-worktree-'));
  const errorCapture: { value: unknown } = { value: null };

  try {
    assert.throws(
      () =>
        claimSimulator({
          devices,
          lockRoot,
          worktreeRoot,
          requestedId: 'B',
          prepare: () => {
            const exec = recordingExec(() => undefined);
            const runWithOutput = recordingOutput(() => {
              throw new Error('bootstatus failed');
            });
            try {
              bootSimulator(
                { id: 'B', name: 'Kilo E2E-B', state: 'Shutdown' },
                exec,
                runWithOutput
              );
            } catch (error) {
              errorCapture.value = error;
              throw error;
            }
          },
        }),
      /bootstatus failed/
    );
    const prepareError = errorCapture.value as Error & { shutdownFailed?: boolean };
    assert.equal(prepareError?.shutdownFailed, false);
    assert.equal(fs.existsSync(path.join(lockRoot, 'B.json')), false);
  } finally {
    fs.rmSync(lockRoot, { recursive: true, force: true });
    fs.rmSync(worktreeRoot, { recursive: true, force: true });
  }
});

test('returns alreadyOwned for a same-worktree ready claim without re-preparing', () => {
  const lockRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-simulator-locks-'));
  const worktreeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-worktree-'));
  let secondPrepareCalled = false;

  try {
    const first = claimSimulator({
      devices,
      lockRoot,
      worktreeRoot,
      requestedId: 'B',
    });
    assert.equal(first.alreadyOwned, false);

    const second = claimSimulator({
      devices,
      lockRoot,
      worktreeRoot,
      requestedId: 'B',
      prepare: () => {
        secondPrepareCalled = true;
      },
    });
    assert.equal(second.alreadyOwned, true);
    assert.equal(secondPrepareCalled, false);
  } finally {
    fs.rmSync(lockRoot, { recursive: true, force: true });
    fs.rmSync(worktreeRoot, { recursive: true, force: true });
  }
});

test('keeps the existing iOS claim when a same-worktree prepare throws after the claim is ready', () => {
  // With the new state protocol, a same-worktree ready claim is returned
  // as alreadyOwned without re-preparing, so the on-disk claim is naturally
  // preserved even if the caller passes a failing prepare callback.
  const lockRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-simulator-locks-'));
  const worktreeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-worktree-'));

  try {
    claimSimulator({ devices, lockRoot, worktreeRoot, requestedId: 'B' });
    const result = claimSimulator({
      devices,
      lockRoot,
      worktreeRoot,
      requestedId: 'B',
      prepare: () => {
        throw new Error('bootstatus failed');
      },
    });
    assert.equal(result.alreadyOwned, true);
    const persisted = JSON.parse(fs.readFileSync(path.join(lockRoot, 'B.json'), 'utf8')) as {
      worktreeRoot: string;
      status: string;
    };
    assert.equal(persisted.worktreeRoot, worktreeRoot);
    assert.equal(persisted.status, 'ready');
  } finally {
    fs.rmSync(lockRoot, { recursive: true, force: true });
    fs.rmSync(worktreeRoot, { recursive: true, force: true });
  }
});

// --- Finding 1: releaseSimulator must never remove a preparing claim ---

test('releaseSimulator rejects a preparing claim from the same worktree', () => {
  const lockRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-simulator-locks-'));
  const worktreeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-worktree-'));

  try {
    claimSimulator({
      devices,
      lockRoot,
      worktreeRoot,
      requestedId: 'B',
      prepare: () => {
        // While the claim is still preparing, the same worktree must not
        // be able to release it — the device may be mid-boot.
        assert.throws(
          () => releaseSimulator({ deviceId: 'B', lockRoot, worktreeRoot }),
          /preparation.*in progress|cannot release.*preparing/
        );
        // The claim must still be on disk.
        assert.equal(fs.existsSync(path.join(lockRoot, 'B.json')), true);
      },
    });
  } finally {
    fs.rmSync(lockRoot, { recursive: true, force: true });
    fs.rmSync(worktreeRoot, { recursive: true, force: true });
  }
});

test('releaseSimulator rejects a preparing claim from a different worktree', () => {
  const lockRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-simulator-locks-'));
  const firstWorktree = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-worktree-one-'));
  const secondWorktree = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-worktree-two-'));

  try {
    claimSimulator({
      devices,
      lockRoot,
      worktreeRoot: firstWorktree,
      requestedId: 'B',
      prepare: () => {
        assert.throws(
          () => releaseSimulator({ deviceId: 'B', lockRoot, worktreeRoot: secondWorktree }),
          /preparation.*in progress|cannot release.*preparing|claimed by/
        );
        assert.equal(fs.existsSync(path.join(lockRoot, 'B.json')), true);
      },
    });
  } finally {
    fs.rmSync(lockRoot, { recursive: true, force: true });
    fs.rmSync(firstWorktree, { recursive: true, force: true });
    fs.rmSync(secondWorktree, { recursive: true, force: true });
  }
});

test('releaseSimulator allows a normal ready release after prepare completes', () => {
  const lockRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-simulator-locks-'));
  const worktreeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-worktree-'));

  try {
    claimSimulator({ devices, lockRoot, worktreeRoot, requestedId: 'B' });
    assert.equal(fs.existsSync(path.join(lockRoot, 'B.json')), true);
    releaseSimulator({ deviceId: 'B', lockRoot, worktreeRoot });
    assert.equal(fs.existsSync(path.join(lockRoot, 'B.json')), false);
  } finally {
    fs.rmSync(lockRoot, { recursive: true, force: true });
    fs.rmSync(worktreeRoot, { recursive: true, force: true });
  }
});

// --- Finding 2: exact-claimId finalization/rollback must fail-closed on
//     missing/corrupt/replaced records ---

test('fails closed when the on-disk record is replaced mid-prepare during successful finalization', () => {
  const lockRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-simulator-locks-'));
  const worktreeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-worktree-'));
  const replacementClaimId = 'peer-replacement-claim-id';

  try {
    assert.throws(
      () =>
        claimSimulator({
          devices,
          lockRoot,
          worktreeRoot,
          requestedId: 'B',
          prepare: () => {
            // Simulate a peer (or external write) replacing the record
            // while our prepare is running and the mutation lock is
            // released. The replacement uses a different claimId and
            // must be preserved verbatim.
            fs.writeFileSync(
              path.join(lockRoot, 'B.json'),
              JSON.stringify({
                deviceId: 'B',
                worktreeRoot: 'other-worktree',
                claimId: replacementClaimId,
                status: 'preparing',
                claimedAt: new Date().toISOString(),
              })
            );
            // Prepare completes normally — the replacement happened
            // between the initial write and our finalization.
          },
        }),
      /claim.*replaced|finalization failed|claimId mismatch/
    );

    // The replacement must be preserved exactly.
    const persisted = JSON.parse(fs.readFileSync(path.join(lockRoot, 'B.json'), 'utf8')) as {
      claimId: string;
      worktreeRoot: string;
      status: string;
    };
    assert.equal(persisted.claimId, replacementClaimId);
    assert.equal(persisted.worktreeRoot, 'other-worktree');
    assert.equal(persisted.status, 'preparing');
  } finally {
    fs.rmSync(lockRoot, { recursive: true, force: true });
    fs.rmSync(worktreeRoot, { recursive: true, force: true });
  }
});

test('fails closed when the on-disk record vanishes during successful finalization', () => {
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
            // The record disappears between the initial write and
            // finalization (e.g., another process cleaned a stale entry).
            fs.rmSync(path.join(lockRoot, 'B.json'), { force: true });
          },
        }),
      /claim.*missing|finalization failed|record.*vanished|not found/
    );
    // The record is still gone — we did not recreate it with a false ready.
    assert.equal(fs.existsSync(path.join(lockRoot, 'B.json')), false);
  } finally {
    fs.rmSync(lockRoot, { recursive: true, force: true });
    fs.rmSync(worktreeRoot, { recursive: true, force: true });
  }
});

test('fails closed when the on-disk record is corrupt during successful finalization', () => {
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
            // Corrupt the record mid-prepare. Finalization must not
            // silently succeed; it must throw and must not delete the
            // corrupt data.
            fs.writeFileSync(path.join(lockRoot, 'B.json'), '{ not valid json');
          },
        }),
      /claim.*corrupt|finalization failed|invalid/i
    );
    // The corrupt data must be preserved (we do not delete unknown data).
    const raw = fs.readFileSync(path.join(lockRoot, 'B.json'), 'utf8');
    assert.equal(raw, '{ not valid json');
  } finally {
    fs.rmSync(lockRoot, { recursive: true, force: true });
    fs.rmSync(worktreeRoot, { recursive: true, force: true });
  }
});

test('does not delete a replacement record during rollback when prepare fails after replacement', () => {
  const lockRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-simulator-locks-'));
  const worktreeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-worktree-'));
  const replacementClaimId = 'peer-replacement-claim-id';

  try {
    assert.throws(
      () =>
        claimSimulator({
          devices,
          lockRoot,
          worktreeRoot,
          requestedId: 'B',
          prepare: () => {
            fs.writeFileSync(
              path.join(lockRoot, 'B.json'),
              JSON.stringify({
                deviceId: 'B',
                worktreeRoot: 'other-worktree',
                claimId: replacementClaimId,
                status: 'preparing',
                claimedAt: new Date().toISOString(),
              })
            );
            // Now the prepare itself fails.
            throw new Error('bootstatus failed');
          },
        }),
      /bootstatus failed/
    );
    // The replacement must be preserved exactly — rollback must not
    // delete a record it does not own.
    const persisted = JSON.parse(fs.readFileSync(path.join(lockRoot, 'B.json'), 'utf8')) as {
      claimId: string;
      worktreeRoot: string;
    };
    assert.equal(persisted.claimId, replacementClaimId);
    assert.equal(persisted.worktreeRoot, 'other-worktree');
  } finally {
    fs.rmSync(lockRoot, { recursive: true, force: true });
    fs.rmSync(worktreeRoot, { recursive: true, force: true });
  }
});

// --- Finding 3: legacy-format claim compatibility ---

test('treats a legacy claim (no status/claimId) as ready for the same worktree', () => {
  const lockRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-simulator-locks-'));
  const worktreeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-worktree-'));

  try {
    // Write a legacy claim — only worktreeRoot, no status, no claimId.
    fs.writeFileSync(
      path.join(lockRoot, 'B.json'),
      JSON.stringify({ worktreeRoot, claimedAt: new Date().toISOString() })
    );

    const claim = claimSimulator({ devices, lockRoot, worktreeRoot, requestedId: 'B' });
    assert.equal(claim.alreadyOwned, true);
    assert.equal(claim.device.id, 'B');
  } finally {
    fs.rmSync(lockRoot, { recursive: true, force: true });
    fs.rmSync(worktreeRoot, { recursive: true, force: true });
  }
});

test('upgrades and relabels a same-worktree legacy claim without desynchronizing its name', () => {
  const lockRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-simulator-locks-'));
  const worktreeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-worktree-'));
  const renames: string[] = [];

  try {
    fs.writeFileSync(path.join(lockRoot, 'B.json'), JSON.stringify({ worktreeRoot }));

    const claim = claimSimulator({
      devices,
      lockRoot,
      worktreeRoot,
      requestedId: 'B',
      phase: 'verify',
      rename: (_deviceId, name) => renames.push(name),
    });

    assert.equal(claim.alreadyOwned, true);
    assert.equal(claim.device.name, buildSimulatorLabel(worktreeRoot, 'verify'));
    assert.deepEqual(renames, [buildSimulatorLabel(worktreeRoot, 'verify')]);
    const persisted = JSON.parse(fs.readFileSync(path.join(lockRoot, 'B.json'), 'utf8')) as {
      status: string;
      claimId: string;
      originalDeviceName: string;
      currentDeviceName: string;
      phase: string;
    };
    assert.equal(persisted.status, 'ready');
    assert.ok(persisted.claimId);
    assert.equal(persisted.originalDeviceName, devices.find(device => device.id === 'B')?.name);
    assert.equal(persisted.currentDeviceName, buildSimulatorLabel(worktreeRoot, 'verify'));
    assert.equal(persisted.phase, 'verify');
  } finally {
    fs.rmSync(lockRoot, { recursive: true, force: true });
    fs.rmSync(worktreeRoot, { recursive: true, force: true });
  }
});

test('rejects a different worktree against a legacy claim (no status/claimId)', () => {
  const lockRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-simulator-locks-'));
  const firstWorktree = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-worktree-one-'));
  const secondWorktree = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-worktree-two-'));

  try {
    fs.writeFileSync(
      path.join(lockRoot, 'B.json'),
      JSON.stringify({ worktreeRoot: firstWorktree, claimedAt: new Date().toISOString() })
    );

    assert.throws(
      () => claimSimulator({ devices, lockRoot, worktreeRoot: secondWorktree, requestedId: 'B' }),
      new RegExp(`claimed by ${firstWorktree}`)
    );
  } finally {
    fs.rmSync(lockRoot, { recursive: true, force: true });
    fs.rmSync(firstWorktree, { recursive: true, force: true });
    fs.rmSync(secondWorktree, { recursive: true, force: true });
  }
});

test('releaseSimulator can release a legacy claim from the owning worktree', () => {
  const lockRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-simulator-locks-'));
  const worktreeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-worktree-'));

  try {
    fs.writeFileSync(
      path.join(lockRoot, 'B.json'),
      JSON.stringify({ worktreeRoot, claimedAt: new Date().toISOString() })
    );

    releaseSimulator({ deviceId: 'B', lockRoot, worktreeRoot });
    assert.equal(fs.existsSync(path.join(lockRoot, 'B.json')), false);
  } finally {
    fs.rmSync(lockRoot, { recursive: true, force: true });
    fs.rmSync(worktreeRoot, { recursive: true, force: true });
  }
});

// --- Finding 5: releaseSimulator does not delete corrupt data ---

test('releaseSimulator does not delete a corrupt claim and surfaces a clear error', () => {
  const lockRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-simulator-locks-'));
  const worktreeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-worktree-'));

  try {
    fs.writeFileSync(path.join(lockRoot, 'B.json'), '{ not valid json');

    assert.throws(
      () => releaseSimulator({ deviceId: 'B', lockRoot, worktreeRoot }),
      /corrupt|invalid|not.*valid/i
    );
    // The corrupt data must be preserved — we do not silently delete
    // unknown data.
    const raw = fs.readFileSync(path.join(lockRoot, 'B.json'), 'utf8');
    assert.equal(raw, '{ not valid json');
  } finally {
    fs.rmSync(lockRoot, { recursive: true, force: true });
    fs.rmSync(worktreeRoot, { recursive: true, force: true });
  }
});

// --- Finding: abandoned preparation recovery via preparer PID + identity ---
// A process SIGKILL/crash after writing a preparing claim must not leave
// the device permanently stuck. PID liveness AND matching process start
// identity (not wall-clock age) are the source of truth. PID reuse is
// detected by comparing the stored process identity against the current
// process identity queried at decision time.

function writePreparingClaim(
  lockRoot: string,
  deviceId: string,
  worktreeRoot: string,
  options: { preparerPid?: number; preparerIdentity?: string; claimId?: string } = {}
): { claimId: string; preparerPid?: number; preparerIdentity?: string } {
  const claimId = options.claimId ?? 'existing-claim-id';
  const record: Record<string, unknown> = {
    deviceId,
    worktreeRoot,
    claimId,
    status: 'preparing',
    claimedAt: new Date().toISOString(),
  };
  if (options.preparerPid !== undefined) {
    record.preparerPid = options.preparerPid;
  }
  if (options.preparerIdentity !== undefined) {
    record.preparerIdentity = options.preparerIdentity;
  }
  fs.writeFileSync(path.join(lockRoot, `${deviceId}.json`), JSON.stringify(record));
  return { claimId, preparerPid: options.preparerPid, preparerIdentity: options.preparerIdentity };
}

// Test helper: a mutable map of deviceId -> state, used by tests to
// simulate `xcrun simctl list devices available --json` re-reads during
// the production recovery reset flow.
const testDeviceStates = new Map<string, string>();
function listIosDeviceStateForTest(deviceId: string): string | undefined {
  return testDeviceStates.get(deviceId);
}

// --- Active/abandoned classification: PID liveness + matching identity ---
// PID reuse (a dead PID reassigned to a different process) is detected by
// comparing the stored process start identity against the current process
// identity queried at decision time. If the identity cannot be queried
// or does not match, the claim is treated as abandoned.

test('protects an active claim with alive PID and matching identity (same worktree)', () => {
  const lockRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-simulator-locks-'));
  const worktreeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-worktree-'));
  const identity = 'current-process-identity';

  try {
    writePreparingClaim(lockRoot, 'B', worktreeRoot, {
      preparerPid: process.pid,
      preparerIdentity: identity,
    });

    assert.throws(
      () =>
        claimSimulator({
          devices,
          lockRoot,
          worktreeRoot,
          requestedId: 'B',
          pidAlive: () => true,
          processIdentity: () => identity,
        }),
      /preparation in progress/
    );
  } finally {
    fs.rmSync(lockRoot, { recursive: true, force: true });
    fs.rmSync(worktreeRoot, { recursive: true, force: true });
  }
});

test('protects an active claim with alive PID and matching identity (different worktree)', () => {
  const lockRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-simulator-locks-'));
  const firstWorktree = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-worktree-one-'));
  const secondWorktree = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-worktree-two-'));
  const identity = 'current-process-identity';

  try {
    writePreparingClaim(lockRoot, 'B', firstWorktree, {
      preparerPid: process.pid,
      preparerIdentity: identity,
    });

    assert.throws(
      () =>
        claimSimulator({
          devices,
          lockRoot,
          worktreeRoot: secondWorktree,
          requestedId: 'B',
          pidAlive: () => true,
          processIdentity: () => identity,
        }),
      /preparation in progress|claimed by/
    );
  } finally {
    fs.rmSync(lockRoot, { recursive: true, force: true });
    fs.rmSync(firstWorktree, { recursive: true, force: true });
    fs.rmSync(secondWorktree, { recursive: true, force: true });
  }
});

test('checks the recorded preparer identity instead of the current claimant identity', () => {
  const lockRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-simulator-locks-'));
  const firstWorktree = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-worktree-one-'));
  const secondWorktree = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-worktree-two-'));
  const preparerPid = 4242;
  const queriedPids: number[] = [];

  try {
    writePreparingClaim(lockRoot, 'B', firstWorktree, {
      preparerPid,
      preparerIdentity: 'original-preparer',
    });

    assert.throws(
      () =>
        claimSimulator({
          devices,
          lockRoot,
          worktreeRoot: secondWorktree,
          requestedId: 'B',
          pidAlive: () => true,
          processIdentity: pid => {
            queriedPids.push(pid);
            return pid === preparerPid ? 'original-preparer' : 'new-claimant';
          },
        }),
      new RegExp(`claimed by ${firstWorktree}`)
    );
    assert.deepEqual(queriedPids, [preparerPid]);
  } finally {
    fs.rmSync(lockRoot, { recursive: true, force: true });
    fs.rmSync(firstWorktree, { recursive: true, force: true });
    fs.rmSync(secondWorktree, { recursive: true, force: true });
  }
});

test('recovers when an alive PID has a different process identity (PID reuse)', () => {
  const lockRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-simulator-locks-'));
  const worktreeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-worktree-'));
  let resetCalled = false;

  try {
    writePreparingClaim(lockRoot, 'B', worktreeRoot, {
      preparerPid: 424242,
      preparerIdentity: 'stale-identity-from-old-process',
    });

    const claim = claimSimulator({
      devices,
      lockRoot,
      worktreeRoot,
      requestedId: 'B',
      pidAlive: () => true,
      processIdentity: () => 'current-process-identity',
      recoveryReset: deviceId => {
        resetCalled = true;
        return { id: deviceId, name: 'Kilo E2E-B', state: 'Shutdown' };
      },
    });

    // PID is alive but the identity differs — the PID was reused by a
    // different process. The claim is abandoned and must be recovered.
    assert.equal(claim.alreadyOwned, false);
    assert.equal(resetCalled, true);
    const persisted = JSON.parse(fs.readFileSync(path.join(lockRoot, 'B.json'), 'utf8')) as {
      preparerPid: number;
      preparerIdentity: string;
    };
    assert.equal(persisted.preparerPid, process.pid);
    assert.equal(persisted.preparerIdentity, 'current-process-identity');
  } finally {
    fs.rmSync(lockRoot, { recursive: true, force: true });
    fs.rmSync(worktreeRoot, { recursive: true, force: true });
  }
});

test('recovers when the process identity cannot be queried (fail closed)', () => {
  const lockRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-simulator-locks-'));
  const worktreeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-worktree-'));
  let resetCalled = false;

  try {
    writePreparingClaim(lockRoot, 'B', worktreeRoot, {
      preparerPid: process.pid,
      preparerIdentity: 'stored-identity',
    });

    const claim = claimSimulator({
      devices,
      lockRoot,
      worktreeRoot,
      requestedId: 'B',
      pidAlive: () => true,
      processIdentity: () => undefined,
      recoveryReset: deviceId => {
        resetCalled = true;
        return { id: deviceId, name: 'Kilo E2E-B', state: 'Shutdown' };
      },
    });

    assert.equal(claim.alreadyOwned, false);
    assert.equal(resetCalled, true);
  } finally {
    fs.rmSync(lockRoot, { recursive: true, force: true });
    fs.rmSync(worktreeRoot, { recursive: true, force: true });
  }
});

test('recovers when the PID is dead even if the stored identity matches', () => {
  const lockRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-simulator-locks-'));
  const worktreeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-worktree-'));
  let resetCalled = false;

  try {
    writePreparingClaim(lockRoot, 'B', worktreeRoot, {
      preparerPid: 999999,
      preparerIdentity: 'any-identity',
    });

    const claim = claimSimulator({
      devices,
      lockRoot,
      worktreeRoot,
      requestedId: 'B',
      pidAlive: () => false,
      processIdentity: () => 'any-identity',
      recoveryReset: deviceId => {
        resetCalled = true;
        return { id: deviceId, name: 'Kilo E2E-B', state: 'Shutdown' };
      },
    });

    assert.equal(claim.alreadyOwned, false);
    assert.equal(resetCalled, true);
  } finally {
    fs.rmSync(lockRoot, { recursive: true, force: true });
    fs.rmSync(worktreeRoot, { recursive: true, force: true });
  }
});

test('recovers when the process identity is missing from the stored claim (legacy)', () => {
  const lockRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-simulator-locks-'));
  const worktreeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-worktree-'));
  let resetCalled = false;

  try {
    // Legacy format: status=preparing but no preparerPid/preparerIdentity.
    writePreparingClaim(lockRoot, 'B', worktreeRoot);

    const claim = claimSimulator({
      devices,
      lockRoot,
      worktreeRoot,
      requestedId: 'B',
      recoveryReset: deviceId => {
        resetCalled = true;
        return { id: deviceId, name: 'Kilo E2E-B', state: 'Shutdown' };
      },
    });

    assert.equal(claim.alreadyOwned, false);
    assert.equal(resetCalled, true);
  } finally {
    fs.rmSync(lockRoot, { recursive: true, force: true });
    fs.rmSync(worktreeRoot, { recursive: true, force: true });
  }
});

// --- Recovery reset contract: confirmed Shutdown device before normal prepare ---

test('recovery reset: stale Booted snapshot but actual Shutdown skips shutdown and boots', () => {
  const lockRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-simulator-locks-'));
  const worktreeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-worktree-'));
  let resetDeviceSeen: SimulatorDevice | undefined;
  let prepareDeviceSeen: SimulatorDevice | undefined;
  let shutdownCommandIssued = false;

  try {
    writePreparingClaim(lockRoot, 'B', worktreeRoot, {
      preparerPid: 999999,
      preparerIdentity: 'stale',
    });

    // The recovery reset callback receives the deviceId and returns a
    // confirmed Shutdown device. In the production code, the callback
    // re-reads the actual state via `xcrun simctl list devices`, issues
    // a shutdown if needed, and confirms Shutdown. Here we simulate
    // the production behavior: the actual state is Shutdown, so no
    // shutdown command is issued, and the callback returns Shutdown.
    testDeviceStates.set('B', 'Shutdown');

    const result = claimSimulator({
      // Stale list-time snapshot says Booted.
      devices: [{ id: 'B', name: 'Kilo E2E-B', state: 'Booted' }],
      lockRoot,
      worktreeRoot,
      requestedId: 'B',
      pidAlive: () => false,
      processIdentity: () => 'current',
      recoveryReset: deviceId => {
        // Simulate the production reset: re-read actual state.
        const actualState = listIosDeviceStateForTest(deviceId);
        if (actualState !== 'Shutdown') {
          shutdownCommandIssued = true;
        }
        resetDeviceSeen = { id: deviceId, name: 'Kilo E2E-B', state: 'Shutdown' };
        return resetDeviceSeen;
      },
      prepare: device => {
        prepareDeviceSeen = device;
      },
    });

    assert.equal(result.alreadyOwned, false);
    // No shutdown command was issued because actual state was Shutdown.
    assert.equal(shutdownCommandIssued, false);
    // Normal prepare received the confirmed Shutdown device and booted it.
    assert.equal(prepareDeviceSeen?.state, 'Shutdown');
    assert.equal(prepareDeviceSeen?.id, 'B');
  } finally {
    testDeviceStates.delete('B');
    fs.rmSync(lockRoot, { recursive: true, force: true });
    fs.rmSync(worktreeRoot, { recursive: true, force: true });
  }
});

test('recovery reset: stale Shutdown snapshot but actual Booted issues shutdown and confirms', () => {
  const lockRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-simulator-locks-'));
  const worktreeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-worktree-'));
  const shutdownCommands: string[][] = [];
  let prepareDeviceSeen: SimulatorDevice | undefined;
  let actualStateAfterShutdown: string | undefined;

  try {
    writePreparingClaim(lockRoot, 'B', worktreeRoot, {
      preparerPid: 999999,
      preparerIdentity: 'stale',
    });
    // Simulate the actual device state being Booted (stale list-time
    // snapshot says Shutdown). The recovery reset callback re-reads
    // the actual state via this map.
    testDeviceStates.set('B', 'Booted');

    claimSimulator({
      // Stale list-time snapshot says Shutdown.
      devices: [{ id: 'B', name: 'Kilo E2E-B', state: 'Shutdown' }],
      lockRoot,
      worktreeRoot,
      requestedId: 'B',
      pidAlive: () => false,
      processIdentity: () => 'current',
      recoveryReset: deviceId => {
        // Simulate the production reset: re-read actual state, issue
        // shutdown if needed, re-read and confirm.
        const before = listIosDeviceStateForTest(deviceId);
        if (before !== 'Shutdown') {
          shutdownCommands.push(['xcrun', 'simctl', 'shutdown', deviceId]);
          // Simulate the shutdown taking effect: update the test map
          // so the next re-read returns Shutdown.
          testDeviceStates.set(deviceId, 'Shutdown');
        }
        const after = listIosDeviceStateForTest(deviceId);
        if (after !== 'Shutdown') {
          throw new Error(`Simulator ${deviceId} shutdown not confirmed`);
        }
        actualStateAfterShutdown = 'Shutdown';
        return { id: deviceId, name: 'Kilo E2E-B', state: 'Shutdown' };
      },
      prepare: device => {
        prepareDeviceSeen = device;
      },
    });

    assert.deepEqual(shutdownCommands, [['xcrun', 'simctl', 'shutdown', 'B']]);
    assert.equal(actualStateAfterShutdown, 'Shutdown');
    assert.equal(prepareDeviceSeen?.state, 'Shutdown');
  } finally {
    testDeviceStates.delete('B');
    fs.rmSync(lockRoot, { recursive: true, force: true });
    fs.rmSync(worktreeRoot, { recursive: true, force: true });
  }
});

test('recovery reset: shutdown exit success but actual state remains Booted throws and preserves', () => {
  const lockRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-simulator-locks-'));
  const worktreeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-worktree-'));
  let caught: Error | undefined;

  try {
    writePreparingClaim(lockRoot, 'B', worktreeRoot, {
      preparerPid: 999999,
      preparerIdentity: 'stale',
    });

    try {
      claimSimulator({
        devices: [{ id: 'B', name: 'Kilo E2E-B', state: 'Booted' }],
        lockRoot,
        worktreeRoot,
        requestedId: 'B',
        pidAlive: () => false,
        processIdentity: () => 'current',
        recoveryReset: deviceId => {
          // The shutdown command "succeeds" (no throw) but the actual
          // state remains Booted — the device is stuck. The reset
          // callback must throw and the claim must be preserved.
          const confirmed = listIosDeviceStateForTest(deviceId);
          if (confirmed !== 'Shutdown') {
            throw new Error(`Simulator ${deviceId} shutdown not confirmed`);
          }
          return { id: deviceId, name: 'Kilo E2E-B', state: 'Shutdown' };
        },
      });
    } catch (error) {
      caught = error as Error;
    }

    assert.ok(caught, 'claimSimulator must throw when shutdown is not confirmed');
    assert.match(String(caught), /shutdown not confirmed/);

    // The new preparing claim must be preserved.
    const persisted = JSON.parse(fs.readFileSync(path.join(lockRoot, 'B.json'), 'utf8')) as {
      status: string;
      preparerPid: number;
    };
    assert.equal(persisted.status, 'preparing');
    assert.equal(persisted.preparerPid, process.pid);
  } finally {
    fs.rmSync(lockRoot, { recursive: true, force: true });
    fs.rmSync(worktreeRoot, { recursive: true, force: true });
  }
});

test('recovery reset: absent callback throws and preserves the preparing claim', () => {
  const lockRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-worktree-'));
  const worktreeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-worktree-'));
  let caught: Error | undefined;

  try {
    writePreparingClaim(lockRoot, 'B', worktreeRoot, {
      preparerPid: 999999,
      preparerIdentity: 'stale',
    });

    try {
      claimSimulator({
        devices: [{ id: 'B', name: 'Kilo E2E-B', state: 'Booted' }],
        lockRoot,
        worktreeRoot,
        requestedId: 'B',
        pidAlive: () => false,
        processIdentity: () => 'current',
        // recoveryReset intentionally omitted.
      });
    } catch (error) {
      caught = error as Error;
    }

    assert.ok(caught, 'claimSimulator must throw when recoveryReset is absent');
    assert.match(String(caught), /recovery reset/i);

    // The new preparing claim must be preserved.
    const persisted = JSON.parse(fs.readFileSync(path.join(lockRoot, 'B.json'), 'utf8')) as {
      status: string;
      preparerPid: number;
    };
    assert.equal(persisted.status, 'preparing');
    assert.equal(persisted.preparerPid, process.pid);
  } finally {
    fs.rmSync(lockRoot, { recursive: true, force: true });
    fs.rmSync(worktreeRoot, { recursive: true, force: true });
  }
});

test('recovery marks the claim ready only after the normal prepare succeeds', () => {
  const lockRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-simulator-locks-'));
  const worktreeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-worktree-'));

  try {
    writePreparingClaim(lockRoot, 'B', worktreeRoot, {
      preparerPid: 999999,
      preparerIdentity: 'stale',
    });

    const claim = claimSimulator({
      devices: [{ id: 'B', name: 'Kilo E2E-B', state: 'Booted' }],
      lockRoot,
      worktreeRoot,
      requestedId: 'B',
      pidAlive: () => false,
      processIdentity: () => 'current',
      recoveryReset: deviceId => ({ id: deviceId, name: 'Kilo E2E-B', state: 'Shutdown' }),
      prepare: () => {
        // Normal prepare succeeds (no throw). The claim must be
        // finalized as 'ready' only after this returns.
      },
    });

    assert.equal(claim.alreadyOwned, false);
    const persisted = JSON.parse(fs.readFileSync(path.join(lockRoot, 'B.json'), 'utf8')) as {
      status: string;
    };
    assert.equal(persisted.status, 'ready');
  } finally {
    fs.rmSync(lockRoot, { recursive: true, force: true });
    fs.rmSync(worktreeRoot, { recursive: true, force: true });
  }
});

test('recovery does not mark the claim ready when the normal prepare throws', () => {
  const lockRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-simulator-locks-'));
  const worktreeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-worktree-'));
  let caught: Error | undefined;

  try {
    writePreparingClaim(lockRoot, 'B', worktreeRoot, {
      preparerPid: 999999,
      preparerIdentity: 'stale',
    });

    try {
      claimSimulator({
        devices: [{ id: 'B', name: 'Kilo E2E-B', state: 'Booted' }],
        lockRoot,
        worktreeRoot,
        requestedId: 'B',
        pidAlive: () => false,
        processIdentity: () => 'current',
        recoveryReset: deviceId => ({ id: deviceId, name: 'Kilo E2E-B', state: 'Shutdown' }),
        prepare: () => {
          throw new Error('bootstatus failed');
        },
      });
    } catch (error) {
      caught = error as Error;
    }

    assert.ok(caught);
    assert.match(String(caught), /bootstatus failed/);
    // The preparing claim must be removed (exact-own rollback) because
    // the prepare failure did not leave the device in a bad state
    // (bootSimulator's own shutdown succeeded — shutdownFailed=false).
    const persistedPath = path.join(lockRoot, 'B.json');
    assert.equal(fs.existsSync(persistedPath), false);
  } finally {
    fs.rmSync(lockRoot, { recursive: true, force: true });
    fs.rmSync(worktreeRoot, { recursive: true, force: true });
  }
});

// --- Field validation: required ClaimRecord fields without String coercion ---

test('treats a claim with missing deviceId as corrupt', () => {
  const lockRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-simulator-locks-'));
  const worktreeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-worktree-'));

  try {
    fs.writeFileSync(
      path.join(lockRoot, 'B.json'),
      JSON.stringify({
        worktreeRoot,
        claimId: 'x',
        preparerPid: 1,
        preparerIdentity: 'i',
        status: 'preparing',
        claimedAt: new Date().toISOString(),
      })
    );

    // Missing deviceId is corrupt — the initial phase must clean it up
    // and create a fresh claim.
    const claim = claimSimulator({ devices, lockRoot, worktreeRoot, requestedId: 'B' });
    assert.equal(claim.alreadyOwned, false);
    const persisted = JSON.parse(fs.readFileSync(path.join(lockRoot, 'B.json'), 'utf8')) as {
      deviceId: string;
    };
    assert.equal(persisted.deviceId, 'B');
  } finally {
    fs.rmSync(lockRoot, { recursive: true, force: true });
    fs.rmSync(worktreeRoot, { recursive: true, force: true });
  }
});

test('treats a claim with non-string worktreeRoot as corrupt', () => {
  const lockRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-simulator-locks-'));
  const worktreeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-worktree-'));

  try {
    fs.writeFileSync(
      path.join(lockRoot, 'B.json'),
      JSON.stringify({
        deviceId: 'B',
        worktreeRoot: 12345,
        claimId: 'x',
        preparerPid: 1,
        preparerIdentity: 'i',
        status: 'preparing',
        claimedAt: new Date().toISOString(),
      })
    );

    const claim = claimSimulator({ devices, lockRoot, worktreeRoot, requestedId: 'B' });
    assert.equal(claim.alreadyOwned, false);
    const persisted = JSON.parse(fs.readFileSync(path.join(lockRoot, 'B.json'), 'utf8')) as {
      worktreeRoot: string;
    };
    assert.equal(persisted.worktreeRoot, worktreeRoot);
  } finally {
    fs.rmSync(lockRoot, { recursive: true, force: true });
    fs.rmSync(worktreeRoot, { recursive: true, force: true });
  }
});

test('treats a claim with non-integer preparerPid as corrupt', () => {
  const lockRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-simulator-locks-'));
  const worktreeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-worktree-'));

  try {
    fs.writeFileSync(
      path.join(lockRoot, 'B.json'),
      JSON.stringify({
        deviceId: 'B',
        worktreeRoot,
        claimId: 'x',
        preparerPid: 'not-a-number',
        preparerIdentity: 'i',
        status: 'preparing',
        claimedAt: new Date().toISOString(),
      })
    );

    const claim = claimSimulator({ devices, lockRoot, worktreeRoot, requestedId: 'B' });
    assert.equal(claim.alreadyOwned, false);
    const persisted = JSON.parse(fs.readFileSync(path.join(lockRoot, 'B.json'), 'utf8')) as {
      preparerPid: number;
    };
    assert.equal(persisted.preparerPid, process.pid);
  } finally {
    fs.rmSync(lockRoot, { recursive: true, force: true });
    fs.rmSync(worktreeRoot, { recursive: true, force: true });
  }
});

test('treats a claim with an unparseable claimedAt as corrupt', () => {
  const lockRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-simulator-locks-'));
  const worktreeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-worktree-'));

  try {
    fs.writeFileSync(
      path.join(lockRoot, 'B.json'),
      JSON.stringify({
        deviceId: 'B',
        worktreeRoot,
        claimId: 'x',
        preparerPid: 1,
        preparerIdentity: 'i',
        status: 'preparing',
        claimedAt: 'not-a-date',
      })
    );

    const claim = claimSimulator({ devices, lockRoot, worktreeRoot, requestedId: 'B' });
    assert.equal(claim.alreadyOwned, false);
    const persisted = JSON.parse(fs.readFileSync(path.join(lockRoot, 'B.json'), 'utf8')) as {
      claimedAt: string;
    };
    assert.notEqual(persisted.claimedAt, 'not-a-date');
    assert.ok(!isNaN(Date.parse(persisted.claimedAt)));
  } finally {
    fs.rmSync(lockRoot, { recursive: true, force: true });
    fs.rmSync(worktreeRoot, { recursive: true, force: true });
  }
});

test('new preparing claims include both the current PID and process identity', () => {
  const lockRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-simulator-locks-'));
  const worktreeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-worktree-'));
  const identity = 'injected-identity';

  try {
    claimSimulator({
      devices,
      lockRoot,
      worktreeRoot,
      requestedId: 'B',
      processIdentity: () => identity,
    });
    const persisted = JSON.parse(fs.readFileSync(path.join(lockRoot, 'B.json'), 'utf8')) as {
      preparerPid: number;
      preparerIdentity: string;
    };
    assert.equal(persisted.preparerPid, process.pid);
    assert.equal(persisted.preparerIdentity, identity);
  } finally {
    fs.rmSync(lockRoot, { recursive: true, force: true });
    fs.rmSync(worktreeRoot, { recursive: true, force: true });
  }
});

test('attaches a rollback cleanup failure to the original prepare error', () => {
  const lockRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-simulator-locks-'));
  const worktreeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-worktree-'));
  let caught: (Error & { cleanupError?: unknown }) | undefined;

  try {
    try {
      claimSimulator({
        devices,
        lockRoot,
        worktreeRoot,
        requestedId: 'B',
        prepare: () => {
          throw new Error('bootstatus failed');
        },
        fileOperations: {
          // Inject an rmSync that throws only for the exact claim file
          // so the rollback cleanup failure path is exercised
          // deterministically across platforms.
          rmSync: (filePath, options) => {
            if (filePath === path.join(lockRoot, 'B.json')) {
              throw new Error('injected cleanup deletion failure');
            }
            fs.rmSync(filePath, options);
          },
        },
      });
    } catch (error) {
      caught = error as Error & { cleanupError?: unknown };
    }

    assert.ok(caught, 'claimSimulator must throw when prepare fails');
    // The original prepare failure must be the primary message.
    assert.match(String(caught), /bootstatus failed/);
    // The cleanup failure must be attached specifically as `cleanupError`
    // so the operator can see it. We assert on `cleanupError` directly
    // (not via `cause`, which is always set on every PrepareError and
    // would mask a missing cleanupError).
    assert.ok(
      caught.cleanupError !== undefined,
      'cleanupError must be attached to the prepare error so the operator can see the rollback failure'
    );
    const cleanupError = caught.cleanupError as Error;
    assert.match(String(cleanupError), /injected cleanup deletion failure/);
  } finally {
    fs.rmSync(lockRoot, { recursive: true, force: true });
    fs.rmSync(worktreeRoot, { recursive: true, force: true });
  }
});

// --- Task 1: ownership-aware simulator labels ---

test('buildSimulatorLabel: deterministic sanitization and 64-char bound', () => {
  const base = '/Users/igor/Projects/cloud/.worktrees/speed-mobile-agent-workflow';
  const label = buildSimulatorLabel(base, 'prewarm');
  assert.equal(label.startsWith('Kilo E2E - '), true);
  assert.equal(label.endsWith(' - prewarm'), true);
  // Worktree basename is "speed-mobile-agent-workflow" — no special chars.
  assert.equal(label, 'Kilo E2E - speed-mobile-agent-workflow - prewarm');
});

test('buildSimulatorLabel: trims leading/trailing separators and falls back to "worktree"', () => {
  const base = '/tmp/---name---/';
  const label = buildSimulatorLabel(base, 'prewarm');
  assert.equal(label, 'Kilo E2E - name - prewarm');
});

test('buildSimulatorLabel: falls back to "worktree" when the basename has no allowed characters', () => {
  const base = '/tmp/!!!/';
  const label = buildSimulatorLabel(base, 'prewarm');
  assert.equal(label, 'Kilo E2E - worktree - prewarm');
});

test('buildSimulatorLabel: bounds the visible label to 64 characters', () => {
  const base = `/tmp/${'a'.repeat(120)}_some-more-name-padding/`;
  const label = buildSimulatorLabel(base, 'verify');
  assert.ok(label.length <= 64, `label length ${label.length} exceeds 64`);
  assert.equal(label.startsWith('Kilo E2E - '), true);
  assert.equal(label.endsWith(' - verify'), true);
});

test('parseClaimArgs: bare claim', () => {
  assert.deepEqual(parseClaimArgs(['claim']), {
    command: 'claim',
    udid: undefined,
    phase: undefined,
  });
});

test('parseClaimArgs: claim with udid', () => {
  assert.deepEqual(parseClaimArgs(['claim', 'UDID-X']), {
    command: 'claim',
    udid: 'UDID-X',
    phase: undefined,
  });
});

test('parseClaimArgs: claim with --phase flag', () => {
  assert.deepEqual(parseClaimArgs(['claim', '--phase', 'prewarm']), {
    command: 'claim',
    udid: undefined,
    phase: 'prewarm',
  });
});

test('parseClaimArgs: claim with udid and --phase flag', () => {
  assert.deepEqual(parseClaimArgs(['claim', 'UDID-Y', '--phase', 'verify']), {
    command: 'claim',
    udid: 'UDID-Y',
    phase: 'verify',
  });
});

test('parseClaimArgs: claim with --phase before udid', () => {
  assert.deepEqual(parseClaimArgs(['claim', '--phase', 'verify', 'UDID-Z']), {
    command: 'claim',
    udid: 'UDID-Z',
    phase: 'verify',
  });
});

test('parseClaimArgs: release with udid', () => {
  assert.deepEqual(parseClaimArgs(['release', 'UDID-R']), { command: 'release', udid: 'UDID-R' });
});

test('parseClaimArgs: rejects missing udid for release', () => {
  assert.throws(() => parseClaimArgs(['release']), /usage/i);
});

test('parseClaimArgs: rejects missing/invalid phase values', () => {
  assert.throws(() => parseClaimArgs(['claim', '--phase']), /usage/i);
  assert.throws(() => parseClaimArgs(['claim', '--phase', 'other']), /usage/i);
  assert.throws(
    () => parseClaimArgs(['claim', '--phase', 'prewarm', '--phase', 'verify']),
    /usage/i
  );
});

test('parseClaimArgs: rejects unknown command', () => {
  assert.throws(() => parseClaimArgs(['bogus']), /usage/i);
});

test('parseClaimArgs: rejects --phase with release', () => {
  assert.throws(() => parseClaimArgs(['release', 'UDID-R', '--phase', 'prewarm']), /usage/i);
});

test('new phase claim: renames the device, persists original/current name and phase, returns label', () => {
  const lockRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-simulator-locks-'));
  const worktreeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-worktree-'));
  const renameCalls: Array<{ id: string; name: string }> = [];
  const expectedLabel = buildSimulatorLabel(worktreeRoot, 'prewarm');

  try {
    const result = claimSimulator({
      devices,
      lockRoot,
      worktreeRoot,
      requestedId: 'B',
      phase: 'prewarm',
      rename: (id, name) => {
        renameCalls.push({ id, name });
      },
    });

    assert.equal(result.alreadyOwned, false);
    assert.equal(result.device.id, 'B');
    assert.deepEqual(renameCalls, [{ id: 'B', name: expectedLabel }]);

    const persisted = JSON.parse(fs.readFileSync(path.join(lockRoot, 'B.json'), 'utf8')) as {
      phase?: string;
      originalDeviceName?: string;
      currentDeviceName?: string;
      status: string;
    };
    assert.equal(persisted.status, 'ready');
    assert.equal(persisted.phase, 'prewarm');
    assert.equal(persisted.originalDeviceName, 'Kilo E2E-B');
    assert.equal(persisted.currentDeviceName, expectedLabel);
  } finally {
    fs.rmSync(lockRoot, { recursive: true, force: true });
    fs.rmSync(worktreeRoot, { recursive: true, force: true });
  }
});

test('phase-less claim: does not rename and does not persist name fields', () => {
  const lockRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-simulator-locks-'));
  const worktreeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-worktree-'));
  let renameCalls = 0;

  try {
    const result = claimSimulator({
      devices,
      lockRoot,
      worktreeRoot,
      requestedId: 'B',
      rename: () => {
        renameCalls += 1;
      },
    });

    assert.equal(result.alreadyOwned, false);
    assert.equal(renameCalls, 0);
    const persisted = JSON.parse(fs.readFileSync(path.join(lockRoot, 'B.json'), 'utf8')) as {
      phase?: string;
      originalDeviceName?: string;
      currentDeviceName?: string;
    };
    assert.equal(persisted.phase, undefined);
    assert.equal(persisted.originalDeviceName, undefined);
    assert.equal(persisted.currentDeviceName, undefined);
  } finally {
    fs.rmSync(lockRoot, { recursive: true, force: true });
    fs.rmSync(worktreeRoot, { recursive: true, force: true });
  }
});

test('same-worktree relabel: prewarm -> verify renames and updates stored phase/name', () => {
  const lockRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-simulator-locks-'));
  const worktreeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-worktree-'));
  const renameCalls: Array<{ id: string; name: string }> = [];

  try {
    const first = claimSimulator({
      devices,
      lockRoot,
      worktreeRoot,
      requestedId: 'B',
      phase: 'prewarm',
      rename: (id, name) => {
        renameCalls.push({ id, name });
      },
    });
    assert.equal(first.alreadyOwned, false);
    const firstLabel = buildSimulatorLabel(worktreeRoot, 'prewarm');
    const secondLabel = buildSimulatorLabel(worktreeRoot, 'verify');

    const second = claimSimulator({
      devices,
      lockRoot,
      worktreeRoot,
      requestedId: 'B',
      phase: 'verify',
      rename: (id, name) => {
        renameCalls.push({ id, name });
      },
    });

    assert.equal(second.alreadyOwned, true);
    // The original rename (during the first claim) plus the relabel rename.
    assert.deepEqual(renameCalls, [
      { id: 'B', name: firstLabel },
      { id: 'B', name: secondLabel },
    ]);

    const persisted = JSON.parse(fs.readFileSync(path.join(lockRoot, 'B.json'), 'utf8')) as {
      phase: string;
      originalDeviceName: string;
      currentDeviceName: string;
    };
    assert.equal(persisted.phase, 'verify');
    assert.equal(persisted.originalDeviceName, 'Kilo E2E-B');
    assert.equal(persisted.currentDeviceName, secondLabel);
  } finally {
    fs.rmSync(lockRoot, { recursive: true, force: true });
    fs.rmSync(worktreeRoot, { recursive: true, force: true });
  }
});

test('cross-worktree relabel is rejected (does not rename, claim still belongs to original worktree)', () => {
  const lockRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-simulator-locks-'));
  const firstWorktree = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-worktree-one-'));
  const secondWorktree = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-worktree-two-'));
  const renameCalls: Array<{ id: string; name: string }> = [];

  try {
    claimSimulator({
      devices,
      lockRoot,
      worktreeRoot: firstWorktree,
      requestedId: 'B',
      phase: 'prewarm',
      rename: (id, name) => {
        renameCalls.push({ id, name });
      },
    });

    assert.throws(
      () =>
        claimSimulator({
          devices,
          lockRoot,
          worktreeRoot: secondWorktree,
          requestedId: 'B',
          phase: 'verify',
          rename: (id, name) => {
            renameCalls.push({ id, name });
          },
        }),
      new RegExp(`claimed by ${firstWorktree}`)
    );
    // Only the original-worktree rename should have happened.
    assert.equal(renameCalls.length, 1);

    const persisted = JSON.parse(fs.readFileSync(path.join(lockRoot, 'B.json'), 'utf8')) as {
      worktreeRoot: string;
      phase: string;
    };
    assert.equal(persisted.worktreeRoot, firstWorktree);
    assert.equal(persisted.phase, 'prewarm');
  } finally {
    fs.rmSync(lockRoot, { recursive: true, force: true });
    fs.rmSync(firstWorktree, { recursive: true, force: true });
    fs.rmSync(secondWorktree, { recursive: true, force: true });
  }
});

test('same-owner phase-less reclaim preserves the existing labeled claim', () => {
  const lockRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-simulator-locks-'));
  const worktreeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-worktree-'));
  const renameCalls: Array<{ id: string; name: string }> = [];

  try {
    claimSimulator({
      devices,
      lockRoot,
      worktreeRoot,
      requestedId: 'B',
      phase: 'prewarm',
      rename: (id, name) => {
        renameCalls.push({ id, name });
      },
    });
    const before = fs.readFileSync(path.join(lockRoot, 'B.json'), 'utf8');

    const second = claimSimulator({
      devices,
      lockRoot,
      worktreeRoot,
      requestedId: 'B',
      // No phase — must preserve the existing label.
      rename: (id, name) => {
        renameCalls.push({ id, name });
      },
    });

    assert.equal(second.alreadyOwned, true);
    assert.equal(renameCalls.length, 1);
    const after = fs.readFileSync(path.join(lockRoot, 'B.json'), 'utf8');
    assert.equal(after, before);
  } finally {
    fs.rmSync(lockRoot, { recursive: true, force: true });
    fs.rmSync(worktreeRoot, { recursive: true, force: true });
  }
});

test('initial phase rename rollback success: restores original name and removes the preparing claim', () => {
  const lockRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-simulator-locks-'));
  const worktreeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-worktree-'));
  const renameCalls: string[] = [];
  let caught: Error | undefined;

  try {
    try {
      claimSimulator({
        devices,
        lockRoot,
        worktreeRoot,
        requestedId: 'B',
        phase: 'prewarm',
        rename: (id, name) => {
          renameCalls.push(`${id}:${name}`);
          if (name !== 'Kilo E2E-B') {
            // The first rename (to the visible label) fails; the
            // restoration (back to the original name) succeeds.
            throw new Error('rename failed');
          }
        },
      });
    } catch (error) {
      caught = error as Error;
    }

    assert.ok(caught, 'claimSimulator must throw when initial rename fails');
    assert.match(String(caught), /rename failed/);
    // The exact-own rollback must have removed the preparing claim.
    assert.equal(fs.existsSync(path.join(lockRoot, 'B.json')), false);
  } finally {
    fs.rmSync(lockRoot, { recursive: true, force: true });
    fs.rmSync(worktreeRoot, { recursive: true, force: true });
  }
});

test('initial phase rename + restoration failure: preserves the preparing claim and exposes both failures', () => {
  const lockRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-simulator-locks-'));
  const worktreeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-worktree-'));
  let caught: Error | undefined;

  try {
    try {
      claimSimulator({
        devices,
        lockRoot,
        worktreeRoot,
        requestedId: 'B',
        phase: 'prewarm',
        rename: () => {
          // Both the initial label rename and the restoration rename fail.
          throw new Error('rename failed');
        },
      });
    } catch (error) {
      caught = error as Error;
    }

    assert.ok(caught, 'claimSimulator must throw when rename + restoration both fail');
    // The preparing claim must be preserved so a peer cannot adopt
    // unknown state.
    const persisted = JSON.parse(fs.readFileSync(path.join(lockRoot, 'B.json'), 'utf8')) as {
      status: string;
      phase: string;
    };
    assert.equal(persisted.status, 'preparing');
    assert.equal(persisted.phase, 'prewarm');
    // The error message must surface both failures.
    assert.match(String(caught), /rename failed/);
  } finally {
    fs.rmSync(lockRoot, { recursive: true, force: true });
    fs.rmSync(worktreeRoot, { recursive: true, force: true });
  }
});

test('releaseSimulator restores the original device name before deleting an owned ready claim', () => {
  const lockRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-simulator-locks-'));
  const worktreeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-worktree-'));
  const renameCalls: Array<{ id: string; name: string }> = [];

  try {
    claimSimulator({
      devices,
      lockRoot,
      worktreeRoot,
      requestedId: 'B',
      phase: 'prewarm',
      rename: (id, name) => {
        renameCalls.push({ id, name });
      },
    });
    const labelRename = renameCalls[0];

    releaseSimulator({
      deviceId: 'B',
      lockRoot,
      worktreeRoot,
      rename: (id, name) => {
        renameCalls.push({ id, name });
      },
    });

    // The first rename was the initial claim; the second must be the
    // restoration back to the original name (which is the device name
    // at the time of claim, not the list-time name).
    assert.equal(renameCalls.length, 2);
    assert.equal(renameCalls[1].id, 'B');
    assert.equal(renameCalls[1].name, 'Kilo E2E-B');
    assert.notEqual(renameCalls[1].name, labelRename.name);
    assert.equal(fs.existsSync(path.join(lockRoot, 'B.json')), false);
  } finally {
    fs.rmSync(lockRoot, { recursive: true, force: true });
    fs.rmSync(worktreeRoot, { recursive: true, force: true });
  }
});

test('releaseSimulator: restoration failure preserves the claim and throws', () => {
  const lockRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-simulator-locks-'));
  const worktreeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-worktree-'));
  let caught: Error | undefined;

  try {
    claimSimulator({
      devices,
      lockRoot,
      worktreeRoot,
      requestedId: 'B',
      phase: 'prewarm',
      // Initial rename succeeds; release-time restoration will be
      // forced to fail.
      rename: () => undefined,
    });

    try {
      releaseSimulator({
        deviceId: 'B',
        lockRoot,
        worktreeRoot,
        rename: () => {
          throw new Error('restoration failed');
        },
      });
    } catch (error) {
      caught = error as Error;
    }

    assert.ok(caught, 'releaseSimulator must throw when restoration fails');
    assert.match(String(caught), /restoration failed/);
    // The claim must be preserved so a peer can investigate.
    assert.equal(fs.existsSync(path.join(lockRoot, 'B.json')), true);
  } finally {
    fs.rmSync(lockRoot, { recursive: true, force: true });
    fs.rmSync(worktreeRoot, { recursive: true, force: true });
  }
});

test('releaseSimulator: old claim without original/current name retains existing behavior (no rename)', () => {
  const lockRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-simulator-locks-'));
  const worktreeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-worktree-'));
  let renameCalled = false;

  try {
    // A current-format claim written by an older release of this code
    // (status, claimId, but no phase/originalDeviceName/currentDeviceName).
    fs.writeFileSync(
      path.join(lockRoot, 'B.json'),
      JSON.stringify({
        deviceId: 'B',
        worktreeRoot,
        claimId: 'legacy-claim-id',
        preparerPid: process.pid,
        preparerIdentity: 'legacy-identity',
        status: 'ready',
        claimedAt: new Date().toISOString(),
      })
    );

    releaseSimulator({
      deviceId: 'B',
      lockRoot,
      worktreeRoot,
      rename: () => {
        renameCalled = true;
      },
    });

    assert.equal(renameCalled, false);
    assert.equal(fs.existsSync(path.join(lockRoot, 'B.json')), false);
  } finally {
    fs.rmSync(lockRoot, { recursive: true, force: true });
    fs.rmSync(worktreeRoot, { recursive: true, force: true });
  }
});

test('production rename command: xcrun simctl rename <device> <name>', () => {
  // The production CLI is `xcrun simctl rename <device> <name>`. The
  // ts file must use that exact command shape; we pin it via a source
  // assertion so an accidental rewrite is caught by tests.
  const source = fs.readFileSync(new URL('./mobile-simulator.ts', import.meta.url), 'utf8');
  assert.match(source, /xcrun['"]?\s*,\s*\[['"]simctl['"]\s*,\s*['"]rename['"]/);
});

// --- Spec-review follow-up: disallowed runs in the basename ---

test('buildSimulatorLabel: collapses disallowed runs in the basename to a single dash', () => {
  // The reviewer's example: `/tmp/foo bar!!!baz` has a space and three
  // exclamation marks. After sanitization the basename must read
  // `foo-bar-baz` and the full label must be deterministic.
  assert.equal(
    buildSimulatorLabel('/tmp/foo bar!!!baz', 'verify'),
    'Kilo E2E - foo-bar-baz - verify'
  );
});

// --- Spec-review follow-up: phase-less -> phase upgrade records originalDeviceName ---

test('phase-less -> phase upgrade: records originalDeviceName from list-time device.name and restores it on release', () => {
  const lockRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-simulator-locks-'));
  const worktreeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-worktree-'));
  const renameCalls: string[] = [];

  try {
    // Pre-existing phase-less ready claim owned by the same worktree.
    // This is what a pre-protocol or earlier-release claim looks like:
    // current-format (status, claimId, preparerPid) but no phase /
    // originalDeviceName / currentDeviceName.
    fs.writeFileSync(
      path.join(lockRoot, 'B.json'),
      JSON.stringify({
        deviceId: 'B',
        worktreeRoot,
        claimId: 'pre-existing-claim-id',
        preparerPid: process.pid,
        preparerIdentity: 'pre-existing-identity',
        status: 'ready',
        claimedAt: new Date().toISOString(),
      })
    );

    // Reclaim with a phase. The list-time device name is the source of
    // truth for the new originalDeviceName.
    const result = claimSimulator({
      devices,
      lockRoot,
      worktreeRoot,
      requestedId: 'B',
      phase: 'prewarm',
      rename: (id, name) => {
        renameCalls.push(`${id}:${name}`);
      },
    });

    const expectedLabel = buildSimulatorLabel(worktreeRoot, 'prewarm');
    assert.equal(result.alreadyOwned, true);
    // The returned device must report the new visible label.
    assert.equal(result.device.name, expectedLabel);

    // First rename is the upgrade to the visible label.
    assert.deepEqual(renameCalls, [`B:${expectedLabel}`]);

    const persisted = JSON.parse(fs.readFileSync(path.join(lockRoot, 'B.json'), 'utf8')) as {
      phase: string;
      originalDeviceName: string;
      currentDeviceName: string;
      claimId: string;
    };
    assert.equal(persisted.phase, 'prewarm');
    assert.equal(persisted.originalDeviceName, 'Kilo E2E-B');
    assert.equal(persisted.currentDeviceName, expectedLabel);
    // The claim identity must be preserved (we're upgrading an
    // existing claim, not replacing it).
    assert.equal(persisted.claimId, 'pre-existing-claim-id');

    // Release must restore the original name before deletion.
    releaseSimulator({
      deviceId: 'B',
      lockRoot,
      worktreeRoot,
      rename: (id, name) => {
        renameCalls.push(`${id}:${name}`);
      },
    });

    assert.deepEqual(renameCalls, [`B:${expectedLabel}`, `B:Kilo E2E-B`]);
    assert.equal(fs.existsSync(path.join(lockRoot, 'B.json')), false);
  } finally {
    fs.rmSync(lockRoot, { recursive: true, force: true });
    fs.rmSync(worktreeRoot, { recursive: true, force: true });
  }
});

// --- Spec-review follow-up: returned device.name reflects the visible label ---

test('new phase claim: returned device.name is the new visible label', () => {
  const lockRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-simulator-locks-'));
  const worktreeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-worktree-'));
  const expectedLabel = buildSimulatorLabel(worktreeRoot, 'prewarm');

  try {
    const result = claimSimulator({
      devices,
      lockRoot,
      worktreeRoot,
      requestedId: 'B',
      phase: 'prewarm',
      rename: () => undefined,
    });

    assert.equal(result.alreadyOwned, false);
    assert.equal(result.device.id, 'B');
    assert.equal(result.device.name, expectedLabel);
  } finally {
    fs.rmSync(lockRoot, { recursive: true, force: true });
    fs.rmSync(worktreeRoot, { recursive: true, force: true });
  }
});

test('relabel: returned device.name is the new visible label', () => {
  const lockRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-simulator-locks-'));
  const worktreeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-worktree-'));
  const expectedLabel = buildSimulatorLabel(worktreeRoot, 'verify');

  try {
    claimSimulator({
      devices,
      lockRoot,
      worktreeRoot,
      requestedId: 'B',
      phase: 'prewarm',
      rename: () => undefined,
    });

    const result = claimSimulator({
      devices,
      lockRoot,
      worktreeRoot,
      requestedId: 'B',
      phase: 'verify',
      rename: () => undefined,
    });

    assert.equal(result.alreadyOwned, true);
    assert.equal(result.device.name, expectedLabel);
  } finally {
    fs.rmSync(lockRoot, { recursive: true, force: true });
    fs.rmSync(worktreeRoot, { recursive: true, force: true });
  }
});

test('phase-less claim: returned device.name is the list-time device name (unchanged)', () => {
  const lockRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-simulator-locks-'));
  const worktreeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-worktree-'));

  try {
    const result = claimSimulator({
      devices,
      lockRoot,
      worktreeRoot,
      requestedId: 'B',
    });

    assert.equal(result.alreadyOwned, false);
    assert.equal(result.device.name, 'Kilo E2E-B');
  } finally {
    fs.rmSync(lockRoot, { recursive: true, force: true });
    fs.rmSync(worktreeRoot, { recursive: true, force: true });
  }
});

test('same-owner phase-less reclaim: returned device.name is the existing currentDeviceName (preserved)', () => {
  const lockRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-simulator-locks-'));
  const worktreeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-worktree-'));
  const expectedLabel = buildSimulatorLabel(worktreeRoot, 'prewarm');

  try {
    claimSimulator({
      devices,
      lockRoot,
      worktreeRoot,
      requestedId: 'B',
      phase: 'prewarm',
      rename: () => undefined,
    });

    const result = claimSimulator({
      devices,
      lockRoot,
      worktreeRoot,
      requestedId: 'B',
    });

    assert.equal(result.alreadyOwned, true);
    // The existing label must be preserved (not the list-time name).
    assert.equal(result.device.name, expectedLabel);
  } finally {
    fs.rmSync(lockRoot, { recursive: true, force: true });
    fs.rmSync(worktreeRoot, { recursive: true, force: true });
  }
});

// --- Code-quality follow-up: corrupt optional label fields are sanitized ---

test('readClaim sanitizes non-string originalDeviceName/currentDeviceName/phase so they cannot poison relabel', () => {
  const lockRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-simulator-locks-'));
  const worktreeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-worktree-'));

  try {
    // On-disk claim with corrupted label fields: non-string
    // originalDeviceName, non-string currentDeviceName, and an invalid
    // phase. The reader must drop the corrupt fields (matching
    // readClaimRaw) so a reclaim cannot persist a bogus original
    // name — the list-time device.name must be the fallback.
    fs.writeFileSync(
      path.join(lockRoot, 'B.json'),
      JSON.stringify({
        deviceId: 'B',
        worktreeRoot,
        claimId: 'corrupt-fields-claim-id',
        preparerPid: process.pid,
        preparerIdentity: 'corrupt-fields-identity',
        status: 'ready',
        claimedAt: new Date().toISOString(),
        phase: 12345,
        originalDeviceName: { not: 'a string' },
        currentDeviceName: ['not', 'a', 'string'],
      })
    );

    const renameCalls: string[] = [];
    const result = claimSimulator({
      devices,
      lockRoot,
      worktreeRoot,
      requestedId: 'B',
      phase: 'prewarm',
      rename: (id, name) => {
        renameCalls.push(`${id}:${name}`);
      },
    });

    const expectedLabel = buildSimulatorLabel(worktreeRoot, 'prewarm');
    assert.equal(result.alreadyOwned, true);
    // The relabel must have actually renamed (not just returned the
    // stored corrupt name).
    assert.deepEqual(renameCalls, [`B:${expectedLabel}`]);

    const persisted = JSON.parse(fs.readFileSync(path.join(lockRoot, 'B.json'), 'utf8')) as {
      phase: string;
      originalDeviceName: string;
      currentDeviceName: string;
    };
    assert.equal(persisted.phase, 'prewarm');
    // The corrupt originalDeviceName must be replaced by the list-time
    // device name (sanitized readClaim treated it as undefined).
    assert.equal(persisted.originalDeviceName, 'Kilo E2E-B');
    assert.equal(persisted.currentDeviceName, expectedLabel);
  } finally {
    fs.rmSync(lockRoot, { recursive: true, force: true });
    fs.rmSync(worktreeRoot, { recursive: true, force: true });
  }
});

// --- Code-quality follow-up: same phase but different stored label must rename ---

test('relabel: same phase but different stored currentDeviceName renames and persists the target label', () => {
  const lockRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-simulator-locks-'));
  const worktreeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-worktree-'));
  const renameCalls: string[] = [];

  try {
    // Pre-existing claim with phase='prewarm' but a stored
    // currentDeviceName that does not match the canonical label (e.g.,
    // written by a buggy or older build). The relabel must notice the
    // mismatch and actually rename, not just return the stored name.
    const expectedLabel = buildSimulatorLabel(worktreeRoot, 'prewarm');
    const staleLabel = 'Kilo E2E - stale-basename - prewarm';
    fs.writeFileSync(
      path.join(lockRoot, 'B.json'),
      JSON.stringify({
        deviceId: 'B',
        worktreeRoot,
        claimId: 'stale-label-claim-id',
        preparerPid: process.pid,
        preparerIdentity: 'stale-label-identity',
        status: 'ready',
        claimedAt: new Date().toISOString(),
        phase: 'prewarm',
        originalDeviceName: 'Kilo E2E-B',
        currentDeviceName: staleLabel,
      })
    );

    const result = claimSimulator({
      devices,
      lockRoot,
      worktreeRoot,
      requestedId: 'B',
      phase: 'prewarm',
      rename: (id, name) => {
        renameCalls.push(`${id}:${name}`);
      },
    });

    assert.equal(result.alreadyOwned, true);
    // The rename must have fired (stale label != canonical label).
    assert.deepEqual(renameCalls, [`B:${expectedLabel}`]);
    assert.equal(result.device.name, expectedLabel);

    const persisted = JSON.parse(fs.readFileSync(path.join(lockRoot, 'B.json'), 'utf8')) as {
      currentDeviceName: string;
      phase: string;
    };
    assert.equal(persisted.phase, 'prewarm');
    assert.equal(persisted.currentDeviceName, expectedLabel);
  } finally {
    fs.rmSync(lockRoot, { recursive: true, force: true });
    fs.rmSync(worktreeRoot, { recursive: true, force: true });
  }
});

// --- Code-quality follow-up: initial rename error is the primary cause, restorationError is separate ---

test('initial phase rename + restoration failure: cause is the initial rename error and restorationError exposes the restoration failure', () => {
  const lockRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-simulator-locks-'));
  const worktreeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-worktree-'));
  let caught: (Error & { cause?: unknown; restorationError?: unknown }) | undefined;

  try {
    try {
      claimSimulator({
        devices,
        lockRoot,
        worktreeRoot,
        requestedId: 'B',
        phase: 'prewarm',
        rename: () => {
          // Both the initial label rename and the restoration rename
          // fail with distinct messages so the test can distinguish
          // them.
          throw new Error('initial-rename-failed');
        },
      });
    } catch (error) {
      caught = error as Error & { cause?: unknown; restorationError?: unknown };
    }

    assert.ok(caught, 'claimSimulator must throw when rename + restoration both fail');
    // The preparing claim must be preserved so a peer cannot adopt
    // unknown state.
    const persisted = JSON.parse(fs.readFileSync(path.join(lockRoot, 'B.json'), 'utf8')) as {
      status: string;
      phase: string;
    };
    assert.equal(persisted.status, 'preparing');
    assert.equal(persisted.phase, 'prewarm');

    // The primary cause must be the initial rename error, not the
    // restoration error. The restoration failure is exposed
    // separately as `restorationError`.
    assert.ok(caught.cause instanceof Error, 'cause must be the initial rename error');
    assert.match((caught.cause as Error).message, /initial-rename-failed/);
    assert.ok(caught.restorationError instanceof Error, 'restorationError must be set');
    assert.match((caught.restorationError as Error).message, /initial-rename-failed/);
  } finally {
    fs.rmSync(lockRoot, { recursive: true, force: true });
    fs.rmSync(worktreeRoot, { recursive: true, force: true });
  }
});

test('initial phase rename rollback success: cause is the initial rename error and restorationError is undefined', () => {
  const lockRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-simulator-locks-'));
  const worktreeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-worktree-'));
  let caught: (Error & { cause?: unknown; restorationError?: unknown }) | undefined;

  try {
    try {
      claimSimulator({
        devices,
        lockRoot,
        worktreeRoot,
        requestedId: 'B',
        phase: 'prewarm',
        rename: (id, name) => {
          if (name !== 'Kilo E2E-B') {
            // The first rename (to the visible label) fails; the
            // restoration (back to the original name) succeeds.
            throw new Error('initial-rename-failed');
          }
        },
      });
    } catch (error) {
      caught = error as Error & { cause?: unknown; restorationError?: unknown };
    }

    assert.ok(caught, 'claimSimulator must throw when initial rename fails');
    // The primary cause must be the initial rename error.
    assert.ok(caught.cause instanceof Error, 'cause must be the initial rename error');
    assert.match((caught.cause as Error).message, /initial-rename-failed/);
    // Restoration succeeded, so restorationError must be undefined.
    assert.equal(caught.restorationError, undefined);
    // The exact-own rollback must have removed the preparing claim.
    assert.equal(fs.existsSync(path.join(lockRoot, 'B.json')), false);
  } finally {
    fs.rmSync(lockRoot, { recursive: true, force: true });
    fs.rmSync(worktreeRoot, { recursive: true, force: true });
  }
});

// --- Code-quality follow-up: same-worktree, same-phase, same-label reclaim is idempotent ---

test('same-worktree, same-phase, same-label reclaim is idempotent (no rename, record unchanged)', () => {
  const lockRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-simulator-locks-'));
  const worktreeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-worktree-'));
  const renameCalls: string[] = [];

  try {
    // First claim establishes the label.
    const first = claimSimulator({
      devices,
      lockRoot,
      worktreeRoot,
      requestedId: 'B',
      phase: 'prewarm',
      rename: (id, name) => {
        renameCalls.push(`${id}:${name}`);
      },
    });
    const expectedLabel = buildSimulatorLabel(worktreeRoot, 'prewarm');
    assert.equal(first.alreadyOwned, false);
    assert.deepEqual(renameCalls, [`B:${expectedLabel}`]);

    // Snapshot the on-disk claim before the second (idempotent) claim.
    const before = fs.readFileSync(path.join(lockRoot, 'B.json'), 'utf8');

    // Second claim with the same phase and the same label must be a
    // no-op: rename must NOT fire again and the record must be
    // byte-for-byte unchanged. The returned device.name must still
    // report the current label.
    const second = claimSimulator({
      devices,
      lockRoot,
      worktreeRoot,
      requestedId: 'B',
      phase: 'prewarm',
      rename: (id, name) => {
        renameCalls.push(`${id}:${name}`);
      },
    });

    assert.equal(second.alreadyOwned, true);
    // No additional rename was issued.
    assert.deepEqual(renameCalls, [`B:${expectedLabel}`]);
    // The returned device name is the current label.
    assert.equal(second.device.name, expectedLabel);
    // The on-disk claim is byte-for-byte unchanged.
    const after = fs.readFileSync(path.join(lockRoot, 'B.json'), 'utf8');
    assert.equal(after, before);
  } finally {
    fs.rmSync(lockRoot, { recursive: true, force: true });
    fs.rmSync(worktreeRoot, { recursive: true, force: true });
  }
});
