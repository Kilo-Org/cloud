import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  claimAndroidDevice,
  readGradleWrapperVersion,
  releaseAndroidDevice,
  resolveAndroidEnvironment,
} from './mobile-android';

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
