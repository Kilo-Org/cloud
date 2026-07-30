import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  androidEmulatorSession,
  claimAndroidDevice,
  commandMatchesRecordedEmulator,
  findAvailableEmulatorPort,
  isValidEmulatorRecord,
  parseEmulatorStartArgs,
  processOwnsListeningPort,
  readGradleWrapperVersion,
  releaseAndroidDevice,
  releaseWorktreeAndroidDevices,
  resolveAndroidEnvironment,
  signalProcessIfPresent,
} from './mobile-android';

test('allocates the first free even emulator console port', () => {
  const occupied = new Set([5554, 5556]);
  assert.equal(
    findAvailableEmulatorPort(port => occupied.has(port)),
    5558
  );
});

test('recognizes the qemu process image that replaces the emulator launcher', () => {
  const emulator = '/opt/android/emulator/emulator';
  const command =
    '/opt/android/emulator/qemu/darwin-aarch64/qemu-system-aarch64-headless -avd Pixel_9 -port 5554';
  assert.equal(commandMatchesRecordedEmulator(command, emulator, 'Pixel_9', 5554), true);
  assert.equal(commandMatchesRecordedEmulator(command, emulator, 'Pixel_8', 5554), false);
  assert.equal(commandMatchesRecordedEmulator(command, emulator, 'Pixel_9', 5556), false);
  assert.equal(commandMatchesRecordedEmulator(command, emulator, 'Pixel', 5554), false);
  assert.equal(
    commandMatchesRecordedEmulator(
      command.replace('-port 5554', '-port 55546'),
      emulator,
      'Pixel_9',
      5554
    ),
    false
  );
});

test('records an emulator only when its process owns the console port', () => {
  assert.equal(
    processOwnsListeningPort(5554, 123, () => [123]),
    true
  );
  assert.equal(
    processOwnsListeningPort(5554, 123, () => [456]),
    false
  );
});

test('sanitizes Android emulator tmux targets derived from worktree names', () => {
  assert.equal(androidEmulatorSession('/tmp/cloud-4.2'), 'kilo-e2e-android-cloud-4_2');
  assert.equal(androidEmulatorSession('/tmp/foo:bar[dev]'), 'kilo-e2e-android-foo_bar_dev_');
});

test('accepts only the exact wrapper-owned emulator record', () => {
  const worktreeRoot = '/tmp/cloud-4.2';
  const session = androidEmulatorSession(worktreeRoot);
  const record = {
    avd: 'Pixel_9',
    gpu: 'host',
    log: '/tmp/emulator.log',
    pid: 123,
    pidFile: path.join(os.tmpdir(), `${session}.pid`),
    port: 5554,
    serial: 'emulator-5554',
    session,
    worktreeRoot,
  };
  assert.equal(isValidEmulatorRecord(record, worktreeRoot), true);
  assert.equal(isValidEmulatorRecord({ ...record, port: 5556 }, worktreeRoot), false);
  assert.equal(
    isValidEmulatorRecord({ ...record, worktreeRoot: '/tmp/foreign' }, worktreeRoot),
    false
  );
});

test('rejects emulator-start when the flag appears where the AVD name belongs', () => {
  assert.throws(() => parseEmulatorStartArgs(['--gpu', 'host', 'Pixel_9']), /Usage:/);
  assert.deepEqual(parseEmulatorStartArgs(['Pixel_9', '--gpu', 'host']), {
    avd: 'Pixel_9',
    gpu: 'host',
    wait: false,
  });
  assert.deepEqual(parseEmulatorStartArgs(['Pixel_9', '--gpu', 'host', '--wait']), {
    avd: 'Pixel_9',
    gpu: 'host',
    wait: true,
  });
});

test('treats a process that disappears before its signal as stopped', () => {
  const gone = Object.assign(new Error('gone'), { code: 'ESRCH' });
  assert.doesNotThrow(() =>
    signalProcessIfPresent(123, 'SIGTERM', () => {
      throw gone;
    })
  );
  assert.throws(
    () =>
      signalProcessIfPresent(123, 'SIGTERM', () => {
        throw Object.assign(new Error('denied'), { code: 'EPERM' });
      }),
    /denied/
  );
});

test('skips a partial Android SDK root when a later root has all required tools', () => {
  const env = resolveAndroidEnvironment({
    home: '/Users/test',
    path: '/usr/bin:/bin',
    existingPaths: new Set([
      '/Users/test/Library/Android/sdk/platform-tools/adb',
      '/opt/homebrew/share/android-commandlinetools/platform-tools/adb',
      '/opt/homebrew/share/android-commandlinetools/emulator/emulator',
      '/Library/Java/JavaVirtualMachines/temurin-17.jdk/Contents/Home/bin/java',
    ]),
    javaMajor: () => 17,
  });

  assert.equal(env.sdkRoot, '/opt/homebrew/share/android-commandlinetools');
  assert.equal(env.adb, '/opt/homebrew/share/android-commandlinetools/platform-tools/adb');
  assert.equal(env.emulator, '/opt/homebrew/share/android-commandlinetools/emulator/emulator');
});

test('serializes stale Android claim replacement with concurrent claim attempts', () => {
  const serial = `test-${process.pid}-${Date.now()}`;
  const claimRoot = path.join(os.tmpdir(), 'kilo-mobile-android-claims');
  const filePath = path.join(claimRoot, `${serial}.json`);
  const staleWorktree = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-stale-worktree-'));
  const firstWorktree = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-worktree-one-'));
  const secondWorktree = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-worktree-two-'));
  fs.mkdirSync(claimRoot, { recursive: true });
  fs.writeFileSync(
    filePath,
    JSON.stringify({ serial, worktreeRoot: staleWorktree, claimedAt: new Date().toISOString() })
  );
  fs.rmSync(staleWorktree, { recursive: true });
  let attemptedConcurrentClaim = false;

  try {
    const claim = claimAndroidDevice(serial, firstWorktree, 'boot-id-of-live-emulator', {
      fileOperations: {
        readFileSync: (candidate, encoding) => {
          const value = fs.readFileSync(candidate, encoding);
          if (candidate === filePath && !attemptedConcurrentClaim) {
            attemptedConcurrentClaim = true;
            assert.throws(
              () => claimAndroidDevice(serial, secondWorktree, 'boot-id-of-live-emulator'),
              /claim is being updated concurrently/
            );
          }
          return value;
        },
      },
    });

    assert.equal(attemptedConcurrentClaim, true);
    assert.equal(claim.worktreeRoot, firstWorktree);
    assert.equal(JSON.parse(fs.readFileSync(filePath, 'utf8')).worktreeRoot, firstWorktree);
  } finally {
    fs.rmSync(filePath, { force: true });
    fs.rmSync(`${filePath}.lock`, { force: true });
    fs.rmSync(firstWorktree, { recursive: true, force: true });
    fs.rmSync(secondWorktree, { recursive: true, force: true });
  }
});

test('reclaims a serial whose emulator instance is gone, even from a live worktree', () => {
  const serial = `test-recycled-${process.pid}-${Date.now()}`;
  const deadInstanceWorktree = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-worktree-dead-'));
  const worktreeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-worktree-live-'));
  const filePath = path.join(os.tmpdir(), 'kilo-mobile-android-claims', `${serial}.json`);

  try {
    claimAndroidDevice(serial, deadInstanceWorktree, 'boot-id-of-dead-emulator');

    // Same serial, new emulator instance: the old claim names a worktree that
    // still exists, so only the boot id can tell the port was recycled.
    const claim = claimAndroidDevice(serial, worktreeRoot, 'boot-id-of-live-emulator');

    assert.equal(claim.worktreeRoot, worktreeRoot);
    assert.equal(claim.bootId, 'boot-id-of-live-emulator');
    assert.equal(JSON.parse(fs.readFileSync(filePath, 'utf8')).worktreeRoot, worktreeRoot);
  } finally {
    fs.rmSync(filePath, { force: true });
    fs.rmSync(`${filePath}.lock`, { recursive: true, force: true });
    fs.rmSync(deadInstanceWorktree, { recursive: true, force: true });
    fs.rmSync(worktreeRoot, { recursive: true, force: true });
  }
});

test('reclaims a serial from a legacy claim that predates boot ids', () => {
  const serial = `test-legacy-${process.pid}-${Date.now()}`;
  const otherWorktree = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-worktree-other-'));
  const worktreeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-worktree-live-'));
  const filePath = path.join(os.tmpdir(), 'kilo-mobile-android-claims', `${serial}.json`);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(
    filePath,
    JSON.stringify({
      serial,
      worktreeRoot: otherWorktree,
      claimedAt: new Date().toISOString(),
      claimId: 'legacy',
      status: 'ready',
    })
  );

  try {
    const claim = claimAndroidDevice(serial, worktreeRoot, 'boot-id-of-live-emulator');
    assert.equal(claim.worktreeRoot, worktreeRoot);
  } finally {
    fs.rmSync(filePath, { force: true });
    fs.rmSync(`${filePath}.lock`, { recursive: true, force: true });
    fs.rmSync(otherWorktree, { recursive: true, force: true });
    fs.rmSync(worktreeRoot, { recursive: true, force: true });
  }
});

test('refreshes an own claim when the emulator instance changed', () => {
  const serial = `test-reboot-${process.pid}-${Date.now()}`;
  const worktreeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-worktree-'));
  const filePath = path.join(os.tmpdir(), 'kilo-mobile-android-claims', `${serial}.json`);

  try {
    const first = claimAndroidDevice(serial, worktreeRoot, 'boot-id-one');
    const second = claimAndroidDevice(serial, worktreeRoot, 'boot-id-one');
    assert.equal(second.claimId, first.claimId);

    const rebooted = claimAndroidDevice(serial, worktreeRoot, 'boot-id-two');
    assert.equal(rebooted.bootId, 'boot-id-two');
    assert.equal(JSON.parse(fs.readFileSync(filePath, 'utf8')).bootId, 'boot-id-two');
  } finally {
    fs.rmSync(filePath, { force: true });
    fs.rmSync(`${filePath}.lock`, { recursive: true, force: true });
    fs.rmSync(worktreeRoot, { recursive: true, force: true });
  }
});

test('preserves an active Android claim owned by another worktree', () => {
  const serial = `test-active-${process.pid}-${Date.now()}`;
  const firstWorktree = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-worktree-one-'));
  const secondWorktree = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-worktree-two-'));
  const bootId = 'boot-id-of-live-emulator';

  try {
    claimAndroidDevice(serial, firstWorktree, bootId);

    assert.throws(
      () => claimAndroidDevice(serial, secondWorktree, bootId),
      new RegExp(`claimed by ${firstWorktree}`)
    );
    assert.throws(
      () => releaseAndroidDevice(serial, secondWorktree),
      new RegExp(`claimed by ${firstWorktree}`)
    );

    releaseAndroidDevice(serial, firstWorktree);
  } finally {
    const filePath = path.join(os.tmpdir(), 'kilo-mobile-android-claims', `${serial}.json`);
    fs.rmSync(filePath, { force: true });
    fs.rmSync(`${filePath}.lock`, { force: true });
    fs.rmSync(firstWorktree, { recursive: true, force: true });
    fs.rmSync(secondWorktree, { recursive: true, force: true });
  }
});

test('recovers an orphaned Android claim mutation lock', () => {
  const serial = `test-orphaned-${process.pid}-${Date.now()}`;
  const worktreeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-worktree-'));
  const filePath = path.join(os.tmpdir(), 'kilo-mobile-android-claims', `${serial}.json`);
  const mutationLockPath = `${filePath}.lock`;
  fs.mkdirSync(mutationLockPath, { recursive: true });
  const settledTime = new Date(Date.now() - 6000);
  fs.utimesSync(mutationLockPath, settledTime, settledTime);

  try {
    const claim = claimAndroidDevice(serial, worktreeRoot, 'boot-id-of-live-emulator');
    assert.equal(claim.worktreeRoot, worktreeRoot);
    releaseAndroidDevice(serial, worktreeRoot);
  } finally {
    fs.rmSync(filePath, { force: true });
    fs.rmSync(mutationLockPath, { recursive: true, force: true });
    fs.rmSync(worktreeRoot, { recursive: true, force: true });
  }
});

test('creates an explicit ready Android claim', () => {
  const serial = `test-ready-${process.pid}-${Date.now()}`;
  const worktreeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-worktree-'));
  const filePath = path.join(os.tmpdir(), 'kilo-mobile-android-claims', `${serial}.json`);

  try {
    const claim = claimAndroidDevice(serial, worktreeRoot, 'boot-id-of-live-emulator');
    assert.equal(claim.status, 'ready');
    assert.equal(typeof claim.claimId, 'string');
    assert.ok(claim.claimId.length > 0);
    assert.equal(JSON.parse(fs.readFileSync(filePath, 'utf8')).status, 'ready');
  } finally {
    fs.rmSync(filePath, { force: true });
    fs.rmSync(`${filePath}.lock`, { recursive: true, force: true });
    fs.rmSync(worktreeRoot, { recursive: true, force: true });
  }
});

test('releases every Android claim owned by one worktree and preserves foreign claims', () => {
  const worktreeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-worktree-own-'));
  const foreignWorktree = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-worktree-foreign-'));
  const ownSerials = [`test-own-a-${process.pid}`, `test-own-b-${process.pid}`];
  const foreignSerial = `test-foreign-${process.pid}`;
  try {
    for (const serial of ownSerials) claimAndroidDevice(serial, worktreeRoot, `boot-${serial}`);
    claimAndroidDevice(foreignSerial, foreignWorktree, `boot-${foreignSerial}`);

    assert.deepEqual(releaseWorktreeAndroidDevices(worktreeRoot).sort(), ownSerials.sort());
    const claimRoot = path.join(os.tmpdir(), 'kilo-mobile-android-claims');
    for (const serial of ownSerials)
      assert.equal(fs.existsSync(path.join(claimRoot, `${serial}.json`)), false);
    assert.equal(fs.existsSync(path.join(claimRoot, `${foreignSerial}.json`)), true);
  } finally {
    const claimRoot = path.join(os.tmpdir(), 'kilo-mobile-android-claims');
    for (const serial of [...ownSerials, foreignSerial]) {
      fs.rmSync(path.join(claimRoot, `${serial}.json`), { force: true });
      fs.rmSync(path.join(claimRoot, `${serial}.json.lock`), { recursive: true, force: true });
    }
    fs.rmSync(worktreeRoot, { recursive: true, force: true });
    fs.rmSync(foreignWorktree, { recursive: true, force: true });
  }
});

test('upgrades a same-worktree legacy Android claim to ready', () => {
  const serial = `test-upgrade-${process.pid}-${Date.now()}`;
  const worktreeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-worktree-'));
  const filePath = path.join(os.tmpdir(), 'kilo-mobile-android-claims', `${serial}.json`);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(
    filePath,
    JSON.stringify({ serial, worktreeRoot, claimedAt: new Date().toISOString() })
  );

  try {
    const claim = claimAndroidDevice(serial, worktreeRoot, 'boot-id-of-live-emulator');
    assert.equal(claim.status, 'ready');
    assert.equal(JSON.parse(fs.readFileSync(filePath, 'utf8')).status, 'ready');
  } finally {
    fs.rmSync(filePath, { force: true });
    fs.rmSync(`${filePath}.lock`, { recursive: true, force: true });
    fs.rmSync(worktreeRoot, { recursive: true, force: true });
  }
});

test('reads the Gradle version from the worktree wrapper properties without launching Gradle', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-android-project-'));
  const wrapper = path.join(root, 'gradle/wrapper');
  fs.mkdirSync(wrapper, { recursive: true });
  fs.writeFileSync(
    path.join(wrapper, 'gradle-wrapper.properties'),
    'distributionUrl=https\\://services.gradle.org/distributions/gradle-8.14.3-bin.zip\n'
  );

  assert.equal(readGradleWrapperVersion(root), '8.14.3');
});
