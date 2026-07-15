import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  buildAndroidCompatibilityKey,
  buildAndroidFingerprintOptions,
  buildAndroidInstallCommand,
  pruneAndroidCache,
  runAndroidBuild,
  validateAndroidBuildClaim,
  type AndroidBuildDeps,
} from './mobile-android-build';

const PACKAGE_ID = 'com.kilocode.kiloapp';

function temp(name: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `kilo-${name}-`));
}

function writeClaim(root: string, serial: string, worktreeRoot: string, status = 'ready'): void {
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(
    path.join(root, `${serial}.json`),
    JSON.stringify({
      serial,
      worktreeRoot,
      status,
      claimId: 'claim-1',
      claimedAt: new Date().toISOString(),
    })
  );
}

function compatibility() {
  return {
    nativeHash: 'native',
    gradleVersion: '8.14.3',
    javaVersion: '17.0.12',
    androidSdkIdentity: 'android-36/build-tools-36.0.0',
    hostArch: 'arm64',
    buildMode: 'debug-dev-client' as const,
  };
}

function deps(overrides: Partial<AndroidBuildDeps> = {}): AndroidBuildDeps {
  return {
    cacheRoot: temp('android-cache'),
    claimRoot: temp('android-claims'),
    worktreeRoot: temp('android-worktree'),
    mobileRoot: '/mobile',
    fingerprint: async () => 'native',
    compatibility: () => {
      const { nativeHash: _nativeHash, buildMode: _buildMode, ...toolchain } = compatibility();
      return toolchain;
    },
    withNativeBuildSlot: run => run(),
    build: async staging => {
      const apk = path.join(staging, 'app-debug.apk');
      fs.writeFileSync(apk, 'apk');
      return apk;
    },
    readPackageId: () => PACKAGE_ID,
    install: () => undefined,
    now: () => new Date('2026-07-15T12:00:00.000Z'),
    ...overrides,
  };
}

test('Android fingerprint skips only Expo extra beyond defaults', () => {
  const options = buildAndroidFingerprintOptions();
  assert.deepEqual(options.platforms, ['android']);
  assert.equal(options.silent, true);
  assert.notEqual(options.sourceSkips, 0);
});

test('Android compatibility key changes for every native toolchain dimension', () => {
  const base = compatibility();
  const key = buildAndroidCompatibilityKey(base);
  for (const changed of [
    { ...base, nativeHash: 'other' },
    { ...base, gradleVersion: '8.15' },
    { ...base, javaVersion: '17.0.13' },
    { ...base, androidSdkIdentity: 'android-36/build-tools-36.0.1' },
    { ...base, hostArch: 'x64' },
  ]) {
    assert.notEqual(buildAndroidCompatibilityKey(changed), key);
  }
});

test('validates only a ready Android claim owned by the current worktree', () => {
  const root = temp('android-claims');
  const worktree = temp('android-worktree');
  writeClaim(root, 'emulator-1', worktree);
  validateAndroidBuildClaim('emulator-1', worktree, root);

  writeClaim(root, 'emulator-2', worktree, 'preparing');
  assert.throws(() => validateAndroidBuildClaim('emulator-2', worktree, root), /not ready/);
  assert.throws(() => validateAndroidBuildClaim('emulator-1', '/other', root), /claimed by/);
});

test('uses adb install -r for the claimed Android device', () => {
  assert.deepEqual(buildAndroidInstallCommand('/sdk/adb', 'emulator-1', '/cache/Kilo.apk'), {
    command: '/sdk/adb',
    args: ['-s', 'emulator-1', 'install', '-r', '/cache/Kilo.apk'],
  });
});

test('Android cache hit installs without entering the native build slot', async () => {
  const d = deps();
  const serial = 'emulator-hit';
  writeClaim(d.claimRoot, serial, d.worktreeRoot);
  const key = buildAndroidCompatibilityKey(compatibility());
  const entry = path.join(d.cacheRoot, 'entries', key);
  fs.mkdirSync(entry, { recursive: true });
  const apk = path.join(entry, 'Kilo.apk');
  fs.writeFileSync(apk, 'cached-apk');
  const checksum = createHash('sha256').update('cached-apk').digest('hex');
  fs.writeFileSync(
    path.join(entry, 'manifest.json'),
    JSON.stringify({
      key,
      ...compatibility(),
      packageId: PACKAGE_ID,
      artifactChecksum: checksum,
      producerWorktree: '/main',
      createdAt: '2026-07-15T12:00:00.000Z',
    })
  );
  let slots = 0;
  let builds = 0;
  let packageReads = 0;
  const installed: string[] = [];
  d.withNativeBuildSlot = async run => {
    slots += 1;
    return run();
  };
  d.build = async staging => {
    builds += 1;
    return path.join(staging, 'app-debug.apk');
  };
  d.readPackageId = () => {
    packageReads += 1;
    return PACKAGE_ID;
  };
  d.install = (_serial, value) => installed.push(value);

  await runAndroidBuild(serial, d);

  assert.equal(slots, 0);
  assert.equal(builds, 0);
  assert.equal(packageReads, 1);
  assert.deepEqual(installed, [apk]);
});

test('Android cache miss builds once, publishes, then reuses the APK', async () => {
  const d = deps();
  const serial = 'emulator-miss';
  writeClaim(d.claimRoot, serial, d.worktreeRoot);
  let slots = 0;
  let builds = 0;
  const installed: string[] = [];
  d.withNativeBuildSlot = async run => {
    slots += 1;
    return run();
  };
  d.build = async staging => {
    builds += 1;
    const apk = path.join(staging, 'app-debug.apk');
    fs.writeFileSync(apk, 'built-apk');
    return apk;
  };
  d.install = (_serial, apk) => installed.push(apk);

  await runAndroidBuild(serial, d);
  await runAndroidBuild(serial, d);

  assert.equal(slots, 1);
  assert.equal(builds, 1);
  assert.equal(installed.length, 2);
  assert.equal(installed[0], installed[1]);
});

test('Android cache hit with the wrong actual package id rebuilds before install', async () => {
  const d = deps();
  const serial = 'emulator-package';
  writeClaim(d.claimRoot, serial, d.worktreeRoot);
  const key = buildAndroidCompatibilityKey(compatibility());
  const entry = path.join(d.cacheRoot, 'entries', key);
  fs.mkdirSync(entry, { recursive: true });
  const apk = path.join(entry, 'Kilo.apk');
  fs.writeFileSync(apk, 'wrong-package');
  fs.writeFileSync(
    path.join(entry, 'manifest.json'),
    JSON.stringify({
      key,
      ...compatibility(),
      packageId: PACKAGE_ID,
      artifactChecksum: createHash('sha256').update('wrong-package').digest('hex'),
      producerWorktree: '/main',
      createdAt: '2026-07-15T12:00:00.000Z',
    })
  );
  let builds = 0;
  d.readPackageId = candidate =>
    candidate === apk && builds === 0 ? 'com.example.wrong' : PACKAGE_ID;
  d.build = async staging => {
    builds += 1;
    const output = path.join(staging, 'app-debug.apk');
    fs.writeFileSync(output, 'correct-package');
    return output;
  };

  await runAndroidBuild(serial, d);

  assert.equal(builds, 1);
});

test('Android build validates claim before fingerprinting or entering build slot', async () => {
  const d = deps();
  let fingerprinted = false;
  let slotted = false;
  d.fingerprint = async () => {
    fingerprinted = true;
    return 'native';
  };
  d.withNativeBuildSlot = async run => {
    slotted = true;
    return run();
  };

  await assert.rejects(runAndroidBuild('missing', d), /not claimed/);
  assert.equal(fingerprinted, false);
  assert.equal(slotted, false);
});

test('Android build rejects an APK symlink that escapes cache-local staging', async () => {
  const d = deps();
  const serial = 'emulator-symlink';
  writeClaim(d.claimRoot, serial, d.worktreeRoot);
  const outside = path.join(temp('outside-apk'), 'outside.apk');
  fs.writeFileSync(outside, 'outside');
  d.build = async staging => {
    const link = path.join(staging, 'app-debug.apk');
    fs.symlinkSync(outside, link);
    return link;
  };

  await assert.rejects(runAndroidBuild(serial, d), /invalid APK path/);
});

test('prunes expired Android cache entries but keeps recent entries', () => {
  const root = temp('android-prune');
  const entries = path.join(root, 'entries');
  fs.mkdirSync(path.join(entries, 'old'), { recursive: true });
  fs.mkdirSync(path.join(entries, 'recent'), { recursive: true });
  fs.writeFileSync(
    path.join(entries, 'old', 'manifest.json'),
    JSON.stringify({ createdAt: '2026-06-01T00:00:00.000Z' })
  );
  fs.writeFileSync(
    path.join(entries, 'recent', 'manifest.json'),
    JSON.stringify({ createdAt: '2026-07-14T00:00:00.000Z' })
  );

  const result = pruneAndroidCache(root, new Date('2026-07-15T12:00:00.000Z'));

  assert.deepEqual(result.removed, ['old']);
  assert.deepEqual(result.kept, ['recent']);
  assert.equal(fs.existsSync(path.join(entries, 'old')), false);
});
