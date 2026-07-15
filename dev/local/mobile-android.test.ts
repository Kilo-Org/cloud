import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  claimAndroidDevice,
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
    const claim = claimAndroidDevice(serial, firstWorktree, {
      fileOperations: {
        readFileSync: (candidate, encoding) => {
          const value = fs.readFileSync(candidate, encoding);
          if (candidate === filePath && !attemptedConcurrentClaim) {
            attemptedConcurrentClaim = true;
            assert.throws(
              () => claimAndroidDevice(serial, secondWorktree),
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

test('preserves an active Android claim owned by another worktree', () => {
  const serial = `test-active-${process.pid}-${Date.now()}`;
  const firstWorktree = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-worktree-one-'));
  const secondWorktree = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-worktree-two-'));

  try {
    claimAndroidDevice(serial, firstWorktree);

    assert.throws(
      () => claimAndroidDevice(serial, secondWorktree),
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
    const claim = claimAndroidDevice(serial, worktreeRoot);
    assert.equal(claim.worktreeRoot, worktreeRoot);
    releaseAndroidDevice(serial, worktreeRoot);
  } finally {
    fs.rmSync(filePath, { force: true });
    fs.rmSync(mutationLockPath, { recursive: true, force: true });
    fs.rmSync(worktreeRoot, { recursive: true, force: true });
  }
});
