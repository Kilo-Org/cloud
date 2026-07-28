import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  bootSimulator,
  buildSimulatorLabel,
  claimSimulator,
  listIosDevices,
  parseClaimArgs,
  releaseSimulator,
  releaseWorktreeSimulators,
  type SimulatorDevice,
} from './mobile-simulator';

type ExecCall = { command: string; args: readonly string[]; options: unknown };

function recordingExec(behavior?: (call: ExecCall) => Error | undefined) {
  const calls: ExecCall[] = [];
  const exec = (command: string, args: readonly string[], options: unknown): Buffer => {
    const call: ExecCall = { command, args, options };
    calls.push(call);
    const error = behavior?.(call);
    if (error) throw error;
    return Buffer.from('');
  };
  return { exec, calls };
}

function recordingRename(behavior?: (deviceId: string, name: string) => void) {
  const calls: Array<{ deviceId: string; name: string }> = [];
  const rename = (deviceId: string, name: string): void => {
    calls.push({ deviceId, name });
    behavior?.(deviceId, name);
  };
  return { rename, calls };
}

function recordingShutdown() {
  const calls: string[] = [];
  return { shutdown: (deviceId: string): void => void calls.push(deviceId), calls };
}

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

const IPHONE_TYPE = 'com.apple.CoreSimulator.SimDeviceType.iPhone-16';

function device(overrides: Partial<SimulatorDevice> = {}): SimulatorDevice {
  return {
    id: 'UDID-1',
    name: 'iPhone 16',
    state: 'Shutdown',
    deviceTypeIdentifier: IPHONE_TYPE,
    ...overrides,
  };
}

function readRecord(lockRoot: string, deviceId: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(lockRoot, `${deviceId}.json`), 'utf8'));
}

// ── parseClaimArgs ───────────────────────────────────────────────────

test('parseClaimArgs accepts claim, claim <udid>, and release <udid>', () => {
  assert.deepEqual(parseClaimArgs(['claim']), { command: 'claim', udid: undefined });
  assert.deepEqual(parseClaimArgs(['claim', 'UDID-1']), { command: 'claim', udid: 'UDID-1' });
  assert.deepEqual(parseClaimArgs(['release', 'UDID-1']), { command: 'release', udid: 'UDID-1' });
});

test('parseClaimArgs rejects unknown commands, extra args, and a missing release udid', () => {
  assert.throws(() => parseClaimArgs(['steal', 'UDID-1']), /Usage: claim/);
  assert.throws(() => parseClaimArgs(['claim', 'UDID-1', 'UDID-2']), /Usage: claim/);
  assert.throws(() => parseClaimArgs(['release']), /Usage: release <udid>/);
  assert.throws(() => parseClaimArgs(['release', 'UDID-1', 'extra']), /Usage: release <udid>/);
});

// ── buildSimulatorLabel ──────────────────────────────────────────────

test('buildSimulatorLabel derives a sanitized worktree label', () => {
  assert.equal(buildSimulatorLabel('/tmp/worktrees/my-feature'), 'Kilo E2E - my-feature');
  assert.equal(buildSimulatorLabel('/tmp/worktrees/a b!c'), 'Kilo E2E - a-b-c');
  assert.equal(buildSimulatorLabel('/tmp/worktrees/---'), 'Kilo E2E - worktree');
});

test('buildSimulatorLabel is bounded to 64 characters', () => {
  const label = buildSimulatorLabel(`/tmp/${'x'.repeat(200)}`);
  assert.ok(label.length <= 64);
  assert.ok(label.startsWith('Kilo E2E - x'));
});

// ── claimSimulator ───────────────────────────────────────────────────

test('claim boots, labels, and records a free device', () => {
  const lockRoot = tempDir('sim-claims-');
  const worktreeRoot = tempDir('worktree-');
  const { rename, calls: renames } = recordingRename();
  const prepared: string[] = [];

  const result = claimSimulator({
    devices: [device()],
    lockRoot,
    worktreeRoot,
    rename,
    prepare: d => {
      prepared.push(d.id);
      return true;
    },
  });

  assert.equal(result.alreadyOwned, false);
  assert.equal(result.device.name, buildSimulatorLabel(worktreeRoot));
  assert.deepEqual(prepared, ['UDID-1']);
  assert.deepEqual(renames, [{ deviceId: 'UDID-1', name: buildSimulatorLabel(worktreeRoot) }]);
  const record = readRecord(lockRoot, 'UDID-1');
  assert.equal(record.worktreeRoot, worktreeRoot);
  assert.equal(record.originalDeviceName, 'iPhone 16');
  assert.equal(record.currentDeviceName, buildSimulatorLabel(worktreeRoot));
  assert.equal(record.bootedByClaim, true);
  assert.ok(!Number.isNaN(Date.parse(record.claimedAt as string)));
});

test('claim records that it did not boot a device it adopted already running', () => {
  const lockRoot = tempDir('sim-claims-');
  const worktreeRoot = tempDir('worktree-');
  const { rename } = recordingRename();

  claimSimulator({
    devices: [device({ state: 'Booted' })],
    lockRoot,
    worktreeRoot,
    rename,
    // Mirrors `bootSimulator`, which returns false for a device it found
    // already booted.
    prepare: () => false,
  });

  assert.equal(readRecord(lockRoot, 'UDID-1').bootedByClaim, false);
});

test('claim only auto-selects iPhone simulators and prefers shutdown devices', () => {
  const lockRoot = tempDir('sim-claims-');
  const worktreeRoot = tempDir('worktree-');
  const { rename } = recordingRename();

  const result = claimSimulator({
    devices: [
      device({ id: 'IPAD', deviceTypeIdentifier: 'com.apple.CoreSimulator.SimDeviceType.iPad' }),
      device({ id: 'BOOTED', state: 'Booted' }),
      device({ id: 'FREE' }),
    ],
    lockRoot,
    worktreeRoot,
    rename,
    prepare: () => {},
  });

  assert.equal(result.device.id, 'FREE');
});

test('claim skips a device owned by a live worktree and throws for an explicit udid', () => {
  const lockRoot = tempDir('sim-claims-');
  const mine = tempDir('worktree-');
  const theirs = tempDir('worktree-');
  fs.writeFileSync(
    path.join(lockRoot, 'TAKEN.json'),
    JSON.stringify({ deviceId: 'TAKEN', worktreeRoot: theirs })
  );
  const { rename } = recordingRename();

  const result = claimSimulator({
    devices: [device({ id: 'TAKEN' }), device({ id: 'FREE' })],
    lockRoot,
    worktreeRoot: mine,
    rename,
    prepare: () => {},
  });
  assert.equal(result.device.id, 'FREE');

  assert.throws(
    () =>
      claimSimulator({
        devices: [device({ id: 'TAKEN' })],
        lockRoot,
        worktreeRoot: mine,
        requestedId: 'TAKEN',
        rename,
        prepare: () => {},
      }),
    new RegExp(`Simulator TAKEN is claimed by ${theirs}`)
  );
});

test('claim reclaims a device whose owning worktree no longer exists', () => {
  const lockRoot = tempDir('sim-claims-');
  const worktreeRoot = tempDir('worktree-');
  fs.writeFileSync(
    path.join(lockRoot, 'UDID-1.json'),
    JSON.stringify({ deviceId: 'UDID-1', worktreeRoot: '/nonexistent/worktree-gone' })
  );
  const { rename } = recordingRename();

  const result = claimSimulator({
    devices: [device()],
    lockRoot,
    worktreeRoot,
    rename,
    prepare: () => {},
  });

  assert.equal(result.alreadyOwned, false);
  assert.equal(readRecord(lockRoot, 'UDID-1').worktreeRoot, worktreeRoot);
});

test('claim discards a malformed claim record and claims fresh', () => {
  const lockRoot = tempDir('sim-claims-');
  const worktreeRoot = tempDir('worktree-');
  fs.writeFileSync(path.join(lockRoot, 'UDID-1.json'), 'not json');
  const { rename } = recordingRename();

  const result = claimSimulator({
    devices: [device()],
    lockRoot,
    worktreeRoot,
    rename,
    prepare: () => {},
  });

  assert.equal(result.alreadyOwned, false);
  assert.equal(readRecord(lockRoot, 'UDID-1').worktreeRoot, worktreeRoot);
});

test('same-worktree reclaim is idempotent: no boot, no rename when the label is current', () => {
  const lockRoot = tempDir('sim-claims-');
  const worktreeRoot = tempDir('worktree-');
  const { rename, calls: renames } = recordingRename();
  const prepared: string[] = [];
  const args = {
    devices: [device()],
    lockRoot,
    worktreeRoot,
    rename,
    prepare: (d: SimulatorDevice) => {
      prepared.push(d.id);
    },
  };

  claimSimulator(args);
  const again = claimSimulator(args);

  assert.equal(again.alreadyOwned, true);
  assert.equal(again.device.name, buildSimulatorLabel(worktreeRoot));
  assert.equal(prepared.length, 1);
  assert.equal(renames.length, 1);
});

test('same-worktree reclaim reapplies a stale label and preserves the original name', () => {
  const lockRoot = tempDir('sim-claims-');
  const worktreeRoot = tempDir('worktree-');
  fs.writeFileSync(
    path.join(lockRoot, 'UDID-1.json'),
    JSON.stringify({
      deviceId: 'UDID-1',
      worktreeRoot,
      originalDeviceName: 'iPhone 16',
      currentDeviceName: 'Kilo E2E - stale-label',
    })
  );
  const { rename, calls: renames } = recordingRename();

  const result = claimSimulator({
    devices: [device({ name: 'Kilo E2E - stale-label' })],
    lockRoot,
    worktreeRoot,
    rename,
    prepare: () => {},
  });

  assert.equal(result.alreadyOwned, true);
  assert.deepEqual(renames, [{ deviceId: 'UDID-1', name: buildSimulatorLabel(worktreeRoot) }]);
  const record = readRecord(lockRoot, 'UDID-1');
  assert.equal(record.currentDeviceName, buildSimulatorLabel(worktreeRoot));
  assert.equal(record.originalDeviceName, 'iPhone 16');
});

test('a claim whose process died before labeling is relabeled on reclaim', () => {
  const lockRoot = tempDir('sim-claims-');
  const worktreeRoot = tempDir('worktree-');
  // Fresh claims are written without label fields; the label is applied
  // after prepare. A crash in between leaves exactly this record.
  fs.writeFileSync(
    path.join(lockRoot, 'UDID-1.json'),
    JSON.stringify({ deviceId: 'UDID-1', worktreeRoot, claimedAt: new Date().toISOString() })
  );
  const { rename, calls: renames } = recordingRename();

  const result = claimSimulator({
    devices: [device()],
    lockRoot,
    worktreeRoot,
    rename,
    prepare: () => {},
  });

  assert.equal(result.alreadyOwned, true);
  assert.equal(renames.length, 1);
  const record = readRecord(lockRoot, 'UDID-1');
  assert.equal(record.currentDeviceName, buildSimulatorLabel(worktreeRoot));
  assert.equal(record.originalDeviceName, 'iPhone 16');
});

test('a prepare failure removes the claim so the device is not left reserved', () => {
  const lockRoot = tempDir('sim-claims-');
  const worktreeRoot = tempDir('worktree-');
  const { rename } = recordingRename();

  assert.throws(
    () =>
      claimSimulator({
        devices: [device()],
        lockRoot,
        worktreeRoot,
        requestedId: 'UDID-1',
        rename,
        prepare: () => {
          throw new Error('boot failed');
        },
      }),
    /boot failed/
  );
  assert.equal(fs.existsSync(path.join(lockRoot, 'UDID-1.json')), false);
});

test('a rename failure removes the claim and surfaces the error', () => {
  const lockRoot = tempDir('sim-claims-');
  const worktreeRoot = tempDir('worktree-');
  const { rename } = recordingRename(() => {
    throw new Error('rename failed');
  });

  assert.throws(
    () =>
      claimSimulator({
        devices: [device()],
        lockRoot,
        worktreeRoot,
        requestedId: 'UDID-1',
        rename,
        prepare: () => {},
      }),
    /rename failed/
  );
  assert.equal(fs.existsSync(path.join(lockRoot, 'UDID-1.json')), false);
});

test('claim throws when no unclaimed simulator is available', () => {
  const lockRoot = tempDir('sim-claims-');
  const mine = tempDir('worktree-');
  const theirs = tempDir('worktree-');
  fs.writeFileSync(
    path.join(lockRoot, 'TAKEN.json'),
    JSON.stringify({ deviceId: 'TAKEN', worktreeRoot: theirs })
  );
  const { rename } = recordingRename();

  assert.throws(
    () =>
      claimSimulator({
        devices: [device({ id: 'TAKEN' })],
        lockRoot,
        worktreeRoot: mine,
        rename,
        prepare: () => {},
      }),
    /No unclaimed iOS simulator is available/
  );
});

// ── bootSimulator ────────────────────────────────────────────────────

test('bootSimulator skips an already booted device and disclaims the boot', () => {
  const { exec, calls } = recordingExec();
  const booted = bootSimulator(device({ state: 'Booted' }), exec, () => ({
    stdout: '',
    stderr: '',
    status: 0,
  }));
  assert.equal(calls.length, 0);
  assert.equal(booted, false);
});

test('bootSimulator boots and waits for bootstatus', () => {
  const { exec, calls } = recordingExec();
  const statusCalls: string[] = [];
  const booted = bootSimulator(device(), exec, (_command, args) => {
    statusCalls.push(args.join(' '));
    return { stdout: 'Status=0, isTerminal=YES', stderr: '', status: 0 };
  });
  assert.equal(booted, true);
  assert.deepEqual(
    calls.map(call => call.args.join(' ')),
    ['simctl boot UDID-1']
  );
  assert.deepEqual(statusCalls, ['simctl bootstatus UDID-1 -b']);
});

test('bootSimulator shuts the device back down on a terminal bootstatus failure', () => {
  const { exec, calls } = recordingExec();
  assert.throws(
    () =>
      bootSimulator(device(), exec, () => ({
        stdout: 'Status=3, isTerminal=YES\nData Migration Failed',
        stderr: '',
        status: 0,
      })),
    /terminal failure/
  );
  assert.deepEqual(
    calls.map(call => call.args.join(' ')),
    ['simctl boot UDID-1', 'simctl shutdown UDID-1']
  );
});

test('bootSimulator flags the error when the recovery shutdown also fails', () => {
  const { exec } = recordingExec(call =>
    call.args[1] === 'shutdown' ? new Error('shutdown failed') : undefined
  );
  try {
    bootSimulator(device(), exec, () => ({
      stdout: 'Status=3, isTerminal=YES',
      stderr: '',
      status: 0,
    }));
    assert.fail('expected bootSimulator to throw');
  } catch (error) {
    assert.equal((error as Error & { deviceMayBeRunning?: boolean }).deviceMayBeRunning, true);
  }
});

test('a prepare failure with a possibly running device keeps the claim reserved', () => {
  const lockRoot = tempDir('sim-claims-');
  const worktreeRoot = tempDir('worktree-');
  const { rename } = recordingRename();

  assert.throws(
    () =>
      claimSimulator({
        devices: [device()],
        lockRoot,
        worktreeRoot,
        requestedId: 'UDID-1',
        rename,
        prepare: () => {
          const error = new Error('boot failed, shutdown failed') as Error & {
            deviceMayBeRunning?: boolean;
          };
          error.deviceMayBeRunning = true;
          throw error;
        },
      }),
    /boot failed/
  );
  assert.equal(fs.existsSync(path.join(lockRoot, 'UDID-1.json')), true);
  assert.equal(readRecord(lockRoot, 'UDID-1').worktreeRoot, worktreeRoot);
});

test('bootSimulator does not shut down a device whose boot never started', () => {
  const { exec, calls } = recordingExec(call =>
    call.args[1] === 'boot' ? new Error('boot exec failed') : undefined
  );
  assert.throws(
    () => bootSimulator(device(), exec, () => ({ stdout: '', stderr: '', status: 0 })),
    /boot exec failed/
  );
  assert.deepEqual(
    calls.map(call => call.args.join(' ')),
    ['simctl boot UDID-1']
  );
});

// ── releaseSimulator ─────────────────────────────────────────────────

test('release restores the original name and removes the claim', () => {
  const lockRoot = tempDir('sim-claims-');
  const worktreeRoot = tempDir('worktree-');
  fs.writeFileSync(
    path.join(lockRoot, 'UDID-1.json'),
    JSON.stringify({
      deviceId: 'UDID-1',
      worktreeRoot,
      originalDeviceName: 'iPhone 16',
      currentDeviceName: buildSimulatorLabel(worktreeRoot),
    })
  );
  const { rename, calls: renames } = recordingRename();

  releaseSimulator({ deviceId: 'UDID-1', lockRoot, worktreeRoot, rename });

  assert.deepEqual(renames, [{ deviceId: 'UDID-1', name: 'iPhone 16' }]);
  assert.equal(fs.existsSync(path.join(lockRoot, 'UDID-1.json')), false);
});

test('release is idempotent when no claim exists', () => {
  const lockRoot = tempDir('sim-claims-');
  const worktreeRoot = tempDir('worktree-');
  const { rename, calls: renames } = recordingRename();
  releaseSimulator({ deviceId: 'UDID-1', lockRoot, worktreeRoot, rename });
  assert.equal(renames.length, 0);
});

test('release refuses a claim owned by another worktree', () => {
  const lockRoot = tempDir('sim-claims-');
  const mine = tempDir('worktree-');
  fs.writeFileSync(
    path.join(lockRoot, 'UDID-1.json'),
    JSON.stringify({ deviceId: 'UDID-1', worktreeRoot: '/some/other/worktree' })
  );
  const { rename } = recordingRename();

  assert.throws(
    () => releaseSimulator({ deviceId: 'UDID-1', lockRoot, worktreeRoot: mine, rename }),
    /is claimed by \/some\/other\/worktree/
  );
  assert.equal(fs.existsSync(path.join(lockRoot, 'UDID-1.json')), true);
});

test('release preserves and reports a corrupt claim instead of deleting it', () => {
  const lockRoot = tempDir('sim-claims-');
  const worktreeRoot = tempDir('worktree-');
  fs.writeFileSync(path.join(lockRoot, 'UDID-1.json'), 'not json');
  const { rename } = recordingRename();

  assert.throws(
    () => releaseSimulator({ deviceId: 'UDID-1', lockRoot, worktreeRoot, rename }),
    /corrupt/
  );
  assert.equal(fs.existsSync(path.join(lockRoot, 'UDID-1.json')), true);
});

test('release without a stored original name skips the rename', () => {
  const lockRoot = tempDir('sim-claims-');
  const worktreeRoot = tempDir('worktree-');
  fs.writeFileSync(
    path.join(lockRoot, 'UDID-1.json'),
    JSON.stringify({ deviceId: 'UDID-1', worktreeRoot })
  );
  const { rename, calls: renames } = recordingRename();

  releaseSimulator({ deviceId: 'UDID-1', lockRoot, worktreeRoot, rename });

  assert.equal(renames.length, 0);
  assert.equal(fs.existsSync(path.join(lockRoot, 'UDID-1.json')), false);
});

test('release powers off a device its own claim booted', () => {
  const lockRoot = tempDir('sim-claims-');
  const worktreeRoot = tempDir('worktree-');
  fs.writeFileSync(
    path.join(lockRoot, 'UDID-1.json'),
    JSON.stringify({ deviceId: 'UDID-1', worktreeRoot, bootedByClaim: true })
  );
  const { rename } = recordingRename();
  const { shutdown, calls: shutdowns } = recordingShutdown();

  releaseSimulator({ deviceId: 'UDID-1', lockRoot, worktreeRoot, rename, shutdown });

  assert.deepEqual(shutdowns, ['UDID-1']);
  assert.equal(fs.existsSync(path.join(lockRoot, 'UDID-1.json')), false);
});

test('release leaves a device that was already booted before the claim running', () => {
  const lockRoot = tempDir('sim-claims-');
  const worktreeRoot = tempDir('worktree-');
  fs.writeFileSync(
    path.join(lockRoot, 'UDID-1.json'),
    JSON.stringify({ deviceId: 'UDID-1', worktreeRoot, bootedByClaim: false })
  );
  const { rename } = recordingRename();
  const { shutdown, calls: shutdowns } = recordingShutdown();

  releaseSimulator({ deviceId: 'UDID-1', lockRoot, worktreeRoot, rename, shutdown });

  assert.deepEqual(shutdowns, []);
  assert.equal(fs.existsSync(path.join(lockRoot, 'UDID-1.json')), false);
});

test('release keeps the claim when the shutdown fails', () => {
  const lockRoot = tempDir('sim-claims-');
  const worktreeRoot = tempDir('worktree-');
  fs.writeFileSync(
    path.join(lockRoot, 'UDID-1.json'),
    JSON.stringify({ deviceId: 'UDID-1', worktreeRoot, bootedByClaim: true })
  );
  const { rename } = recordingRename();

  assert.throws(
    () =>
      releaseSimulator({
        deviceId: 'UDID-1',
        lockRoot,
        worktreeRoot,
        rename,
        shutdown: () => {
          throw new Error('shutdown failed');
        },
      }),
    /shutdown failed/
  );
  assert.equal(fs.existsSync(path.join(lockRoot, 'UDID-1.json')), true);
});

// ── releaseWorktreeSimulators ────────────────────────────────────────

test('release-all powers off every device this worktree booted and skips foreign claims', () => {
  const lockRoot = tempDir('sim-claims-');
  const mine = tempDir('worktree-');
  const theirs = tempDir('worktree-');
  const claim = (deviceId: string, worktreeRoot: string, bootedByClaim: boolean) =>
    fs.writeFileSync(
      path.join(lockRoot, `${deviceId}.json`),
      JSON.stringify({ deviceId, worktreeRoot, bootedByClaim })
    );
  claim('MINE-BOOTED', mine, true);
  claim('MINE-ADOPTED', mine, false);
  claim('THEIRS', theirs, true);
  fs.writeFileSync(path.join(lockRoot, 'not-a-claim.txt'), 'ignored');
  const { rename } = recordingRename();
  const { shutdown, calls: shutdowns } = recordingShutdown();

  const released = releaseWorktreeSimulators({ lockRoot, worktreeRoot: mine, rename, shutdown });

  assert.deepEqual(released.sort(), ['MINE-ADOPTED', 'MINE-BOOTED']);
  assert.deepEqual(shutdowns, ['MINE-BOOTED']);
  assert.equal(fs.existsSync(path.join(lockRoot, 'MINE-BOOTED.json')), false);
  assert.equal(fs.existsSync(path.join(lockRoot, 'MINE-ADOPTED.json')), false);
  assert.equal(fs.existsSync(path.join(lockRoot, 'THEIRS.json')), true);
});

test('release-all is a no-op when the claim directory does not exist', () => {
  const worktreeRoot = tempDir('worktree-');
  const { shutdown, calls: shutdowns } = recordingShutdown();
  assert.deepEqual(
    releaseWorktreeSimulators({
      lockRoot: path.join(worktreeRoot, 'missing'),
      worktreeRoot,
      shutdown,
    }),
    []
  );
  assert.deepEqual(shutdowns, []);
});

// ── listIosDevices ───────────────────────────────────────────────────

test('listIosDevices flattens iOS runtimes and drops malformed entries', () => {
  const payload = {
    devices: {
      'com.apple.CoreSimulator.SimRuntime.iOS-26-0': [
        { udid: 'A', name: 'iPhone 16', state: 'Shutdown', deviceTypeIdentifier: IPHONE_TYPE },
        { udid: '', name: 'broken', state: 'Shutdown' },
        { name: 'no-udid', state: 'Shutdown' },
      ],
      'com.apple.CoreSimulator.SimRuntime.watchOS-11-0': [
        { udid: 'W', name: 'Watch', state: 'Shutdown' },
      ],
    },
  };
  const devices = listIosDevices(() => Buffer.from(JSON.stringify(payload)));
  assert.deepEqual(devices, [
    { id: 'A', name: 'iPhone 16', state: 'Shutdown', deviceTypeIdentifier: IPHONE_TYPE },
  ]);
});
