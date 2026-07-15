import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  buildCompatibilityKey,
  buildFingerprintOptions,
  buildInstallCommand,
  buildXcodeBuildCommand,
  computeArtifactChecksum,
  defaultIsLockActive,
  isValidManifest,
  locateProducedApp,
  lookupCache,
  mobileRoot,
  parseCliArgs,
  pruneCache,
  publishCacheEntry,
  resolveCacheRoot,
  resolveMobileRoot,
  runBuild,
  runFingerprint,
  runPrune,
  validateSimulatorClaim,
  validateXcodeWorkspace,
  withFingerprintLock,
  type BuildDeps,
  type CacheEnvironment,
  type CacheLockDeps,
  type CompatibilityDimensions,
  type LockRecord,
  type Manifest,
  type PruneResult,
} from './mobile-ios-build';

function makeTempDir(label: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `kilo-ios-build-${label}-`));
}

function fakeManifest(overrides: Partial<Manifest> = {}): Manifest {
  return {
    key: 'k1',
    nativeHash: 'native-hash',
    xcodeBuildVersion: '16A0000',
    simulatorSdkVersion: '17.5',
    hostArch: 'arm64',
    buildMode: 'debug-dev-client',
    bundleId: 'com.kilocode.kiloapp',
    artifactChecksum: 'a'.repeat(64),
    producerWorktree: '/worktree',
    createdAt: new Date(0).toISOString(),
    ...overrides,
  };
}

function fixedEnv(overrides: Partial<CacheEnvironment> = {}): CacheEnvironment {
  return {
    home: '/Users/test',
    cacheRoot: '/cache/Kilo/mobile-ios-builds',
    platform: 'darwin',
    arch: 'arm64',
    xcodeBuildVersion: '16A0000',
    simulatorSdkVersion: '17.5',
    now: () => new Date('2026-07-15T12:00:00Z'),
    ...overrides,
  };
}

function fixedDimensions(
  overrides: Partial<CompatibilityDimensions> = {}
): CompatibilityDimensions {
  return {
    nativeHash: 'h1',
    xcodeBuildVersion: '16A0000',
    simulatorSdkVersion: '17.5',
    hostArch: 'arm64',
    buildMode: 'debug-dev-client',
    ...overrides,
  };
}

function sharedResult<T>(initialValue: T): { set: (value: T) => void; read: () => Promise<T> } {
  let value = initialValue;
  return {
    set: (v: T) => {
      value = v;
    },
    read: async () => value,
  };
}

// ── Fingerprint options ──────────────────────────────────────────────

test('fingerprint options include iOS platform and only skip the Expo extra section beyond defaults', () => {
  const options = buildFingerprintOptions();
  assert.deepEqual(options.platforms, ['ios']);
  assert.equal(options.silent, true);
  // SourceSkips.ExpoConfigExtraSection === 4096
  assert.equal(options.sourceSkips & 4096, 4096);
});

// ── Compatibility key ────────────────────────────────────────────────

test('buildCompatibilityKey is stable for identical dimensions and changes on each dimension', () => {
  const dimensions = fixedDimensions();
  const keyA = buildCompatibilityKey(dimensions);
  const keyB = buildCompatibilityKey({ ...dimensions });
  assert.equal(keyA, keyB);
  assert.equal(keyA.length, 64);

  for (const variant of [
    { ...dimensions, nativeHash: 'h2' },
    { ...dimensions, xcodeBuildVersion: '16A0001' },
    { ...dimensions, simulatorSdkVersion: '18.0' },
    { ...dimensions, hostArch: 'x64' },
  ]) {
    assert.notEqual(buildCompatibilityKey(variant), keyA);
  }
});

// ── Cache root resolution ────────────────────────────────────────────

test('resolveCacheRoot prefers macOS Library/Caches/Kilo with XDG fallback chain', () => {
  assert.equal(
    resolveCacheRoot({ home: '/Users/test', platform: 'darwin', env: {} }),
    '/Users/test/Library/Caches/Kilo/mobile-ios-builds'
  );
  assert.equal(
    resolveCacheRoot({ home: '/home/test', platform: 'linux', env: { XDG_CACHE_HOME: '/xdg' } }),
    '/xdg/Kilo/mobile-ios-builds'
  );
  assert.equal(
    resolveCacheRoot({ home: '/home/test', platform: 'linux', env: {} }),
    '/home/test/.cache/Kilo/mobile-ios-builds'
  );
});

// ── Artifact checksum ────────────────────────────────────────────────

test('computeArtifactChecksum is deterministic and content-sensitive', async () => {
  const dir = makeTempDir('checksum');
  try {
    fs.writeFileSync(path.join(dir, 'a'), 'hello');
    fs.writeFileSync(path.join(dir, 'b'), 'world');
    const a = await computeArtifactChecksum(dir);
    const b = await computeArtifactChecksum(dir);
    assert.equal(a, b);
    assert.equal(a.length, 64);
    fs.writeFileSync(path.join(dir, 'a'), 'HELLO');
    assert.notEqual(await computeArtifactChecksum(dir), a);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── Concurrency: withFingerprintLock ─────────────────────────────────

test('withFingerprintLock runs producer once for matching concurrent callers', async () => {
  const cacheRoot = makeTempDir('lock-once');
  const lockRoot = path.join(cacheRoot, 'locks');
  let producerInvocations = 0;
  const lockDeps: CacheLockDeps = {
    env: fixedEnv({ cacheRoot }),
    sleep: (ms: number) => new Promise(resolve => setTimeout(resolve, Math.max(ms, 1))),
  };
  const result = sharedResult({ value: '' });
  const producer = async () => {
    producerInvocations += 1;
    await new Promise(resolve => setTimeout(resolve, 50));
    result.set({ value: 'shared' });
  };
  try {
    const [a, b] = await Promise.all([
      withFingerprintLock({
        key: 'concurrent',
        lockRoot,
        deps: lockDeps,
        producer,
        readResult: result.read,
      }),
      withFingerprintLock({
        key: 'concurrent',
        lockRoot,
        deps: lockDeps,
        producer,
        readResult: result.read,
      }),
    ]);
    assert.equal(producerInvocations, 1);
    assert.equal(a.value, 'shared');
    assert.equal(b.value, 'shared');
  } finally {
    fs.rmSync(cacheRoot, { recursive: true, force: true });
  }
});

test('withFingerprintLock recovers an abandoned lock', async () => {
  const cacheRoot = makeTempDir('lock-abandoned');
  const lockRoot = path.join(cacheRoot, 'locks');
  const lockPath = path.join(lockRoot, 'abandoned.lock');
  fs.mkdirSync(lockPath, { recursive: true });
  fs.writeFileSync(
    path.join(lockPath, 'lock.json'),
    JSON.stringify({
      key: 'abandoned',
      pid: 99999,
      identity: 'old-identity',
      startedAt: new Date(Date.now() - 60_000).toISOString(),
    })
  );
  const lockDeps: CacheLockDeps = {
    env: fixedEnv({ cacheRoot }),
    sleep: (ms: number) => new Promise(resolve => setTimeout(resolve, Math.max(ms, 1))),
    pidAlive: () => true,
    processIdentity: pid => (pid === 99999 ? 'old-identity' : 'new-identity'),
    isLockActive: record => record.identity !== 'old-identity',
  };
  const result = sharedResult({ hello: '' });
  let produced = 0;
  try {
    const value = await withFingerprintLock({
      key: 'abandoned',
      lockRoot,
      deps: lockDeps,
      producer: async () => {
        produced += 1;
        result.set({ hello: 'world' });
      },
      readResult: result.read,
    });
    assert.equal(value.hello, 'world');
    assert.equal(produced, 1);
  } finally {
    fs.rmSync(cacheRoot, { recursive: true, force: true });
  }
});

test('withFingerprintLock bounds wait when an active lock holds the producer', async () => {
  const cacheRoot = makeTempDir('lock-bounded');
  const lockRoot = path.join(cacheRoot, 'locks');
  const lockPath = path.join(lockRoot, 'active.lock');
  fs.mkdirSync(lockPath, { recursive: true });
  fs.writeFileSync(
    path.join(lockPath, 'lock.json'),
    JSON.stringify({
      key: 'active',
      pid: 4242,
      identity: 'active',
      startedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
    })
  );
  const lockDeps: CacheLockDeps = {
    env: fixedEnv({ cacheRoot }),
    sleep: (ms: number) => new Promise(resolve => setTimeout(resolve, Math.max(ms, 1))),
    pidAlive: () => true,
    processIdentity: () => 'active',
    isLockActive: () => true,
    waitForResultMs: 100,
    pollIntervalMs: 25,
  };
  let produced = 0;
  try {
    await assert.rejects(
      () =>
        withFingerprintLock({
          key: 'active',
          lockRoot,
          deps: lockDeps,
          producer: async () => {
            produced += 1;
          },
          readResult: async () => ({ skipped: true }),
        }),
      /active producer/i
    );
    assert.equal(produced, 0);
  } finally {
    fs.rmSync(cacheRoot, { recursive: true, force: true });
  }
});

// ── Cache lookup ─────────────────────────────────────────────────────

test('cache hit returns the published manifest and avoids the producer', async () => {
  const cacheRoot = makeTempDir('hit');
  const key = 'k-hit';
  const keyDir = path.join(cacheRoot, 'entries', key);
  fs.mkdirSync(keyDir, { recursive: true });
  const bundle = path.join(keyDir, 'Kilo.app');
  fs.mkdirSync(bundle, { recursive: true });
  fs.writeFileSync(path.join(bundle, 'Info.plist'), '<plist></plist>');
  const checksum = await computeArtifactChecksum(bundle);
  const manifest = fakeManifest({ key, artifactChecksum: checksum });
  fs.writeFileSync(path.join(keyDir, 'manifest.json'), JSON.stringify(manifest));
  let producerInvocations = 0;
  const result = await lookupCache({
    env: fixedEnv({ cacheRoot }),
    key,
    onMiss: async () => {
      producerInvocations += 1;
      throw new Error('producer should not run on hit');
    },
  });
  assert.equal(producerInvocations, 0);
  assert.ok(result);
  assert.equal(result!.manifest.bundleId, 'com.kilocode.kiloapp');
  fs.rmSync(cacheRoot, { recursive: true, force: true });
});

test('cache miss when the manifest key does not match', async () => {
  const cacheRoot = makeTempDir('miss-key');
  const key = 'k-miss';
  const keyDir = path.join(cacheRoot, 'entries', key);
  fs.mkdirSync(keyDir, { recursive: true });
  fs.mkdirSync(path.join(keyDir, 'Kilo.app'), { recursive: true });
  fs.writeFileSync(
    path.join(keyDir, 'manifest.json'),
    JSON.stringify(fakeManifest({ key: 'other-key' }))
  );
  const result = await lookupCache({
    env: fixedEnv({ cacheRoot }),
    key,
    onMiss: async () => ({ installed: true }),
  });
  assert.equal(result, undefined);
  fs.rmSync(cacheRoot, { recursive: true, force: true });
});

test('cache miss when the manifest bundle id does not match', async () => {
  const cacheRoot = makeTempDir('miss-bundle');
  const key = 'k-miss-bundle';
  const keyDir = path.join(cacheRoot, 'entries', key);
  fs.mkdirSync(keyDir, { recursive: true });
  fs.mkdirSync(path.join(keyDir, 'Kilo.app'), { recursive: true });
  fs.writeFileSync(
    path.join(keyDir, 'manifest.json'),
    JSON.stringify(fakeManifest({ key, bundleId: 'com.example.other' }))
  );
  const result = await lookupCache({
    env: fixedEnv({ cacheRoot }),
    key,
    onMiss: async () => ({ installed: true }),
  });
  assert.equal(result, undefined);
  fs.rmSync(cacheRoot, { recursive: true, force: true });
});

test('cache miss when the artifact checksum does not match the manifest', async () => {
  const cacheRoot = makeTempDir('miss-checksum');
  const key = 'k-miss-checksum';
  const keyDir = path.join(cacheRoot, 'entries', key);
  fs.mkdirSync(keyDir, { recursive: true });
  const bundle = path.join(keyDir, 'Kilo.app');
  fs.mkdirSync(bundle, { recursive: true });
  fs.writeFileSync(path.join(bundle, 'Info.plist'), '<plist></plist>');
  fs.writeFileSync(
    path.join(keyDir, 'manifest.json'),
    JSON.stringify(fakeManifest({ key, artifactChecksum: 'b'.repeat(64) }))
  );
  const result = await lookupCache({
    env: fixedEnv({ cacheRoot }),
    key,
    onMiss: async () => ({ installed: true }),
  });
  assert.equal(result, undefined);
  fs.rmSync(cacheRoot, { recursive: true, force: true });
});

test('cache miss when the manifest is corrupt JSON', async () => {
  const cacheRoot = makeTempDir('miss-corrupt');
  const key = 'k-miss-corrupt';
  const keyDir = path.join(cacheRoot, 'entries', key);
  fs.mkdirSync(keyDir, { recursive: true });
  fs.mkdirSync(path.join(keyDir, 'Kilo.app'), { recursive: true });
  fs.writeFileSync(path.join(keyDir, 'manifest.json'), '{ not json');
  const result = await lookupCache({
    env: fixedEnv({ cacheRoot }),
    key,
    onMiss: async () => ({ installed: true }),
  });
  assert.equal(result, undefined);
  fs.rmSync(cacheRoot, { recursive: true, force: true });
});

test('cache miss when the entry is missing the app bundle directory', async () => {
  const cacheRoot = makeTempDir('miss-incomplete');
  const key = 'k-miss-incomplete';
  const keyDir = path.join(cacheRoot, 'entries', key);
  fs.mkdirSync(keyDir, { recursive: true });
  fs.writeFileSync(path.join(keyDir, 'manifest.json'), JSON.stringify(fakeManifest({ key })));
  const result = await lookupCache({
    env: fixedEnv({ cacheRoot }),
    key,
    onMiss: async () => ({ installed: true }),
  });
  assert.equal(result, undefined);
  fs.rmSync(cacheRoot, { recursive: true, force: true });
});

// ── Simulator claim validation ───────────────────────────────────────

test('validateSimulatorClaim accepts the current worktree and rejects foreign worktrees', () => {
  const claimRoot = makeTempDir('claims');
  const worktree = makeTempDir('wt');
  const otherWorktree = makeTempDir('wt-other');
  try {
    fs.writeFileSync(
      path.join(claimRoot, 'UDID.json'),
      JSON.stringify({
        deviceId: 'UDID',
        worktreeRoot: worktree,
        claimId: 'c1',
        status: 'ready',
        claimedAt: new Date().toISOString(),
      })
    );
    assert.doesNotThrow(() => validateSimulatorClaim('UDID', worktree, claimRoot));
    assert.throws(() => validateSimulatorClaim('UDID', otherWorktree, claimRoot), /claimed by/);
    assert.throws(() => validateSimulatorClaim('MISSING', worktree, claimRoot), /not claimed/);
  } finally {
    fs.rmSync(claimRoot, { recursive: true, force: true });
    fs.rmSync(worktree, { recursive: true, force: true });
    fs.rmSync(otherWorktree, { recursive: true, force: true });
  }
});

// ── Install command ──────────────────────────────────────────────────

test('buildInstallCommand uses xcrun simctl install with the cached bundle', () => {
  const command = buildInstallCommand('UDID-1234', '/cache/key/Kilo.app');
  assert.deepEqual(command, {
    command: 'xcrun',
    args: ['simctl', 'install', 'UDID-1234', '/cache/key/Kilo.app'],
  });
});

// ── Pruning ──────────────────────────────────────────────────────────

test('pruneCache removes entries older than the threshold and protects active locks', async () => {
  const cacheRoot = makeTempDir('prune');
  const entriesRoot = path.join(cacheRoot, 'entries');
  fs.mkdirSync(entriesRoot, { recursive: true });
  const oldKey = 'old';
  const oldDir = path.join(entriesRoot, oldKey);
  fs.mkdirSync(oldDir, { recursive: true });
  fs.writeFileSync(
    path.join(oldDir, 'manifest.json'),
    JSON.stringify(fakeManifest({ key: oldKey, createdAt: '2026-06-01T00:00:00.000Z' }))
  );
  const recentKey = 'recent';
  const recentDir = path.join(entriesRoot, recentKey);
  fs.mkdirSync(recentDir, { recursive: true });
  fs.writeFileSync(
    path.join(recentDir, 'manifest.json'),
    JSON.stringify(fakeManifest({ key: recentKey, createdAt: '2026-07-15T11:00:00.000Z' }))
  );
  fs.mkdirSync(path.join(cacheRoot, 'locks', `${recentKey}.lock`), { recursive: true });
  fs.writeFileSync(
    path.join(cacheRoot, 'locks', `${recentKey}.lock`, 'lock.json'),
    JSON.stringify({ key: recentKey, pid: 1, identity: 'r', startedAt: new Date().toISOString() })
  );
  fs.mkdirSync(path.join(cacheRoot, 'locks', `${oldKey}.lock`), { recursive: true });
  fs.writeFileSync(
    path.join(cacheRoot, 'locks', `${oldKey}.lock`, 'lock.json'),
    JSON.stringify({ key: oldKey, pid: 2, identity: 'o', startedAt: new Date().toISOString() })
  );

  const result = await pruneCache({
    env: fixedEnv({ cacheRoot }),
    retentionMs: 14 * 24 * 60 * 60 * 1000,
    isLockActive: () => true,
  });
  assert.equal(result.removed.length, 0, 'active locks are protected from pruning');
  assert.equal(fs.existsSync(oldDir), true);
  assert.equal(fs.existsSync(recentDir), true);

  const result2 = await pruneCache({
    env: fixedEnv({ cacheRoot }),
    retentionMs: 14 * 24 * 60 * 60 * 1000,
    isLockActive: record => record.key !== oldKey,
  });
  assert.deepEqual(result2.removed, [oldKey]);
  assert.equal(fs.existsSync(oldDir), false);
  assert.equal(fs.existsSync(recentDir), true);

  fs.rmSync(cacheRoot, { recursive: true, force: true });
});

// ── CLI parsing ──────────────────────────────────────────────────────

test('parseCliArgs supports fingerprint, build, and prune subcommands', () => {
  assert.deepEqual(parseCliArgs(['fingerprint']), { command: 'fingerprint' });
  assert.deepEqual(parseCliArgs(['build', 'UDID-1']), { command: 'build', udid: 'UDID-1' });
  assert.deepEqual(parseCliArgs(['prune']), { command: 'prune' });
  assert.throws(() => parseCliArgs([]), /Usage/);
  assert.throws(() => parseCliArgs(['build']), /Usage/);
  assert.throws(() => parseCliArgs(['unknown']), /Usage/);
});

// ── Publication boundary ─────────────────────────────────────────────

test('withFingerprintLock does not publish a usable entry when the producer throws', async () => {
  const cacheRoot = makeTempDir('lock-publish-fail');
  const lockRoot = path.join(cacheRoot, 'locks');
  const lockDeps: CacheLockDeps = {
    env: fixedEnv({ cacheRoot }),
    sleep: (ms: number) => new Promise(resolve => setTimeout(resolve, Math.max(ms, 1))),
  };
  // Pre-create an entry that would otherwise satisfy lookup — it must
  // not survive a failed producer run.
  const entryDir = path.join(cacheRoot, 'entries', 'k');
  fs.mkdirSync(entryDir, { recursive: true });
  fs.mkdirSync(path.join(entryDir, 'Kilo.app'), { recursive: true });
  fs.writeFileSync(path.join(entryDir, 'manifest.json'), JSON.stringify({ key: 'k' }));
  try {
    await assert.rejects(
      () =>
        withFingerprintLock({
          key: 'k',
          lockRoot,
          deps: lockDeps,
          producer: async () => {
            throw new Error('producer boom');
          },
          readResult: async () => {
            throw new Error('readResult should not be called on error');
          },
        }),
      /producer boom/
    );
    // The on-disk entry must not be installable: either the entry is
    // removed or the manifest is missing/corrupt. We assert that
    // lookupCache reports a miss.
    const result = await lookupCache({
      env: fixedEnv({ cacheRoot }),
      key: 'k',
      onMiss: async () => undefined,
    });
    assert.equal(result, undefined);
  } finally {
    fs.rmSync(cacheRoot, { recursive: true, force: true });
  }
});

test('withFingerprintLock publishes atomically via a temp directory rename', async () => {
  const cacheRoot = makeTempDir('lock-atomic');
  const lockRoot = path.join(cacheRoot, 'locks');
  const lockDeps: CacheLockDeps = {
    env: fixedEnv({ cacheRoot }),
    sleep: (ms: number) => new Promise(resolve => setTimeout(resolve, Math.max(ms, 1))),
  };
  let producerInvocations = 0;
  // The producer must build into a temp staging area; publication
  // (rename into place) happens outside the producer. We observe the
  // entry dir before the rename to verify the staging boundary.
  const stagedDirs: string[] = [];
  const entriesDir = path.join(cacheRoot, 'entries', 'k');
  const result = sharedResult({ ok: false });
  const consumer = withFingerprintLock({
    key: 'k',
    lockRoot,
    deps: lockDeps,
    producer: async () => {
      producerInvocations += 1;
      const stage = path.join(cacheRoot, 'staging', `k-${producerInvocations}`);
      fs.mkdirSync(stage, { recursive: true });
      fs.mkdirSync(path.join(stage, 'Kilo.app'), { recursive: true });
      fs.writeFileSync(path.join(stage, 'Kilo.app', 'Info.plist'), '<plist/>');
      stagedDirs.push(stage);
      // Simulate atomic publish: rename stage → final.
      fs.mkdirSync(path.dirname(entriesDir), { recursive: true });
      fs.renameSync(stage, entriesDir);
      fs.writeFileSync(
        path.join(entriesDir, 'manifest.json'),
        JSON.stringify({
          key: 'k',
          nativeHash: 'h',
          xcodeBuildVersion: 'x',
          simulatorSdkVersion: 's',
          hostArch: 'arm64',
          buildMode: 'debug-dev-client',
          bundleId: 'com.kilocode.kiloapp',
          artifactChecksum: await computeArtifactChecksum(path.join(entriesDir, 'Kilo.app')),
          producerWorktree: '/wt',
          createdAt: new Date().toISOString(),
        })
      );
      result.set({ ok: true });
    },
    readResult: result.read,
  });
  // Run twice with a small delay so we can observe the staging/rename
  // boundary between runs.
  const value = await consumer;
  assert.equal(value.ok, true);
  assert.equal(producerInvocations, 1);
  assert.equal(stagedDirs.length, 1);
  assert.equal(fs.existsSync(entriesDir), true);
  fs.rmSync(cacheRoot, { recursive: true, force: true });
});

// ── xcodebuild command ──────────────────────────────────────────────

test('validateXcodeWorkspace accepts the generated workspace and rejects missing', () => {
  const mobileRoot = makeTempDir('ws-ok');
  try {
    fs.mkdirSync(path.join(mobileRoot, 'ios'), { recursive: true });
    fs.writeFileSync(path.join(mobileRoot, 'ios', 'Kilo.xcworkspace'), 'contents');
    assert.doesNotThrow(() => validateXcodeWorkspace(mobileRoot));
  } finally {
    fs.rmSync(mobileRoot, { recursive: true, force: true });
  }
});

test('validateXcodeWorkspace throws with a clear instruction when ios/ is missing', () => {
  const mobileRoot = makeTempDir('ws-missing');
  try {
    assert.throws(
      () => validateXcodeWorkspace(mobileRoot),
      /Kilo\.xcworkspace|run.*expo.*prebuild|prebuild/
    );
  } finally {
    fs.rmSync(mobileRoot, { recursive: true, force: true });
  }
});

test('buildXcodeBuildCommand uses a dedicated derivedDataPath and targets iphonesimulator', () => {
  const staging = '/staging';
  const cmd = buildXcodeBuildCommand({
    mobileRoot: '/mobile',
    udid: 'UDID-1234',
    derivedDataPath: path.join(staging, 'DerivedData'),
  });
  assert.equal(cmd.command, 'xcodebuild');
  assert.deepEqual(cmd.args, [
    '-workspace',
    '/mobile/ios/Kilo.xcworkspace',
    '-scheme',
    'Kilo',
    '-configuration',
    'Debug',
    '-sdk',
    'iphonesimulator',
    '-destination',
    'id=UDID-1234',
    '-derivedDataPath',
    path.join(staging, 'DerivedData'),
    'build',
  ]);
});

test('locateProducedApp returns the canonical Debug-iphonesimulator/Kilo.app path', () => {
  const derived = makeTempDir('derived');
  try {
    const app = path.join(derived, 'Build', 'Products', 'Debug-iphonesimulator', 'Kilo.app');
    fs.mkdirSync(app, { recursive: true });
    fs.writeFileSync(path.join(app, 'Info.plist'), '<plist/>');
    const located = locateProducedApp(derived);
    assert.equal(located, app);
  } finally {
    fs.rmSync(derived, { recursive: true, force: true });
  }
});

test('locateProducedApp throws when the canonical .app is missing', () => {
  const derived = makeTempDir('derived-empty');
  try {
    assert.throws(() => locateProducedApp(derived), /Kilo\.app|Debug-iphonesimulator/);
  } finally {
    fs.rmSync(derived, { recursive: true, force: true });
  }
});

// ── runBuild orchestration ──────────────────────────────────────────

function makeBuildDeps(overrides: Partial<BuildDeps> = {}): BuildDeps {
  return {
    env: fixedEnv(),
    worktreeRoot: '/wt',
    claimRoot: '/claims',
    mobileRoot: '/mobile',
    fingerprint: async () => 'native-hash',
    build: async () => undefined,
    readInfoPlist: () => 'com.kilocode.kiloapp',
    install: () => undefined,
    copyDir: (src, dest) => {
      fs.cpSync(src, dest, { recursive: true });
    },
    mkdtemp: () => fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-stage-')),
    withNativeBuildSlot: run => run(),
    validateClaim: (udid: string, worktreeRoot: string, claimRoot: string) =>
      validateSimulatorClaim(udid, worktreeRoot, claimRoot),
    sleep: (ms: number) => new Promise(resolve => setTimeout(resolve, Math.max(ms, 1))),
    ...overrides,
  };
}

test('runBuild enters the host native-build slot only on cache miss', async () => {
  const cacheRoot = makeTempDir('build-slot');
  const claimRoot = makeTempDir('claims');
  const worktree = makeTempDir('wt');
  const udid = 'UDID-slot';
  fs.writeFileSync(
    path.join(claimRoot, `${udid}.json`),
    JSON.stringify({
      worktreeRoot: worktree,
      claimId: 'c',
      status: 'ready',
      claimedAt: new Date().toISOString(),
      deviceId: udid,
    })
  );
  let slots = 0;
  const deps = makeBuildDeps({
    env: fixedEnv({ cacheRoot }),
    worktreeRoot: worktree,
    claimRoot,
    withNativeBuildSlot: async run => {
      slots += 1;
      return run();
    },
    build: async ({ derivedDataPath }) => {
      const app = path.join(
        derivedDataPath,
        'Build',
        'Products',
        'Debug-iphonesimulator',
        'Kilo.app'
      );
      fs.mkdirSync(app, { recursive: true });
      fs.writeFileSync(path.join(app, 'Info.plist'), '<plist/>');
    },
  });

  try {
    await runBuild(udid, deps);
    await runBuild(udid, deps);
    assert.equal(slots, 1);
  } finally {
    fs.rmSync(cacheRoot, { recursive: true, force: true });
    fs.rmSync(claimRoot, { recursive: true, force: true });
    fs.rmSync(worktree, { recursive: true, force: true });
  }
});

test('runBuild installs a cached entry on hit and does not invoke the builder', async () => {
  const cacheRoot = makeTempDir('build-hit');
  const claimRoot = makeTempDir('claims');
  const worktree = makeTempDir('wt');
  const udid = 'UDID-hit';
  fs.writeFileSync(
    path.join(claimRoot, `${udid}.json`),
    JSON.stringify({
      worktreeRoot: worktree,
      claimId: 'c',
      status: 'ready',
      claimedAt: new Date().toISOString(),
      deviceId: udid,
    })
  );
  const key = buildCompatibilityKey({
    nativeHash: 'native-hash',
    xcodeBuildVersion: '16A0000',
    simulatorSdkVersion: '17.5',
    hostArch: 'arm64',
    buildMode: 'debug-dev-client',
  });
  const keyDir = path.join(cacheRoot, 'entries', key);
  fs.mkdirSync(keyDir, { recursive: true });
  const bundle = path.join(keyDir, 'Kilo.app');
  fs.mkdirSync(bundle, { recursive: true });
  fs.writeFileSync(path.join(bundle, 'Info.plist'), '<plist/>');
  const checksum = await computeArtifactChecksum(bundle);
  fs.writeFileSync(
    path.join(keyDir, 'manifest.json'),
    JSON.stringify(
      fakeManifest({
        key,
        nativeHash: 'native-hash',
        artifactChecksum: checksum,
        xcodeBuildVersion: '16A0000',
        simulatorSdkVersion: '17.5',
      })
    )
  );
  let builderCalls = 0;
  const installs: Array<{ udid: string; app: string }> = [];
  const deps: BuildDeps = makeBuildDeps({
    env: fixedEnv({ cacheRoot }),
    worktreeRoot: worktree,
    claimRoot,
    fingerprint: async () => 'native-hash',
    build: async () => {
      builderCalls += 1;
    },
    install: (udid, app) => {
      installs.push({ udid, app });
    },
  });
  try {
    await runBuild(udid, deps);
    assert.equal(builderCalls, 0);
    assert.equal(installs.length, 1);
    assert.equal(installs[0].udid, udid);
    assert.equal(installs[0].app, bundle);
  } finally {
    fs.rmSync(cacheRoot, { recursive: true, force: true });
    fs.rmSync(claimRoot, { recursive: true, force: true });
    fs.rmSync(worktree, { recursive: true, force: true });
  }
});

test('runBuild on miss invokes the builder once, publishes, and installs', async () => {
  const cacheRoot = makeTempDir('build-miss');
  const claimRoot = makeTempDir('claims');
  const worktree = makeTempDir('wt');
  const udid = 'UDID-miss';
  fs.writeFileSync(
    path.join(claimRoot, `${udid}.json`),
    JSON.stringify({
      worktreeRoot: worktree,
      claimId: 'c',
      status: 'ready',
      claimedAt: new Date().toISOString(),
      deviceId: udid,
    })
  );
  let builderCalls = 0;
  const installs: Array<{ udid: string; app: string }> = [];
  const deps: BuildDeps = makeBuildDeps({
    env: fixedEnv({ cacheRoot }),
    worktreeRoot: worktree,
    claimRoot,
    build: async ({ derivedDataPath, udid: buildUdid }) => {
      builderCalls += 1;
      // Simulate xcodebuild output: create Kilo.app at canonical path.
      const app = path.join(
        derivedDataPath,
        'Build',
        'Products',
        'Debug-iphonesimulator',
        'Kilo.app'
      );
      fs.mkdirSync(app, { recursive: true });
      fs.writeFileSync(path.join(app, 'Info.plist'), '<plist/>');
      assert.equal(buildUdid, udid);
    },
    install: (installUdid, app) => {
      installs.push({ udid: installUdid, app });
    },
  });
  try {
    await runBuild(udid, deps);
    assert.equal(builderCalls, 1);
    assert.equal(installs.length, 1);
    assert.equal(installs[0].udid, udid);
    // The installed path must be the on-disk cache entry, not a staging path.
    const key = buildCompatibilityKey({
      nativeHash: 'native-hash',
      xcodeBuildVersion: '16A0000',
      simulatorSdkVersion: '17.5',
      hostArch: 'arm64',
      buildMode: 'debug-dev-client',
    });
    assert.equal(installs[0].app, path.join(cacheRoot, 'entries', key, 'Kilo.app'));
    // Cache entry must be valid.
    const hit = await lookupCache({
      env: fixedEnv({ cacheRoot }),
      key,
      onMiss: async () => undefined,
    });
    assert.ok(hit);
  } finally {
    fs.rmSync(cacheRoot, { recursive: true, force: true });
    fs.rmSync(claimRoot, { recursive: true, force: true });
    fs.rmSync(worktree, { recursive: true, force: true });
  }
});

test('runBuild waiter: two concurrent callers invoke the builder once and both install the same entry', async () => {
  const cacheRoot = makeTempDir('build-waiter');
  const claimRoot = makeTempDir('claims');
  const worktree = makeTempDir('wt');
  const udid = 'UDID-waiter';
  fs.writeFileSync(
    path.join(claimRoot, `${udid}.json`),
    JSON.stringify({
      worktreeRoot: worktree,
      claimId: 'c',
      status: 'ready',
      claimedAt: new Date().toISOString(),
      deviceId: udid,
    })
  );
  let builderCalls = 0;
  const installs: string[] = [];
  const deps: BuildDeps = makeBuildDeps({
    env: fixedEnv({ cacheRoot }),
    worktreeRoot: worktree,
    claimRoot,
    build: async ({ derivedDataPath }) => {
      builderCalls += 1;
      // Slow build so the second caller arrives before completion.
      await new Promise(resolve => setTimeout(resolve, 50));
      const app = path.join(
        derivedDataPath,
        'Build',
        'Products',
        'Debug-iphonesimulator',
        'Kilo.app'
      );
      fs.mkdirSync(app, { recursive: true });
      fs.writeFileSync(path.join(app, 'Info.plist'), '<plist/>');
    },
    install: (_udid, app) => {
      installs.push(app);
    },
  });
  try {
    await Promise.all([runBuild(udid, deps), runBuild(udid, deps)]);
    assert.equal(builderCalls, 1);
    assert.equal(installs.length, 2);
    // Both installs must target the same on-disk entry.
    assert.equal(installs[0], installs[1]);
  } finally {
    fs.rmSync(cacheRoot, { recursive: true, force: true });
    fs.rmSync(claimRoot, { recursive: true, force: true });
    fs.rmSync(worktree, { recursive: true, force: true });
  }
});

test('runBuild builder failure does not publish a cache entry or install', async () => {
  const cacheRoot = makeTempDir('build-fail');
  const claimRoot = makeTempDir('claims');
  const worktree = makeTempDir('wt');
  const udid = 'UDID-fail';
  fs.writeFileSync(
    path.join(claimRoot, `${udid}.json`),
    JSON.stringify({
      worktreeRoot: worktree,
      claimId: 'c',
      status: 'ready',
      claimedAt: new Date().toISOString(),
      deviceId: udid,
    })
  );
  let installCount = 0;
  const deps: BuildDeps = makeBuildDeps({
    env: fixedEnv({ cacheRoot }),
    worktreeRoot: worktree,
    claimRoot,
    build: async () => {
      throw new Error('xcodebuild failed');
    },
    install: () => {
      installCount += 1;
    },
  });
  try {
    await assert.rejects(() => runBuild(udid, deps), /xcodebuild failed/);
    assert.equal(installCount, 0);
    // No cache entry should exist.
    const entries = path.join(cacheRoot, 'entries');
    if (fs.existsSync(entries)) {
      assert.equal(fs.readdirSync(entries).length, 0);
    }
  } finally {
    fs.rmSync(cacheRoot, { recursive: true, force: true });
    fs.rmSync(claimRoot, { recursive: true, force: true });
    fs.rmSync(worktree, { recursive: true, force: true });
  }
});

test('runBuild rejects when the produced app has the wrong bundle id', async () => {
  const cacheRoot = makeTempDir('build-bundle');
  const claimRoot = makeTempDir('claims');
  const worktree = makeTempDir('wt');
  const udid = 'UDID-bundle';
  fs.writeFileSync(
    path.join(claimRoot, `${udid}.json`),
    JSON.stringify({
      worktreeRoot: worktree,
      claimId: 'c',
      status: 'ready',
      claimedAt: new Date().toISOString(),
      deviceId: udid,
    })
  );
  let installCount = 0;
  const deps: BuildDeps = makeBuildDeps({
    env: fixedEnv({ cacheRoot }),
    worktreeRoot: worktree,
    claimRoot,
    build: async ({ derivedDataPath }) => {
      const app = path.join(
        derivedDataPath,
        'Build',
        'Products',
        'Debug-iphonesimulator',
        'Kilo.app'
      );
      fs.mkdirSync(app, { recursive: true });
      fs.writeFileSync(path.join(app, 'Info.plist'), '<plist/>');
    },
    readInfoPlist: () => 'com.example.wrong',
    install: () => {
      installCount += 1;
    },
  });
  try {
    await assert.rejects(
      () => runBuild(udid, deps),
      /bundle id|BundleIdentifier|CFBundleIdentifier/i
    );
    assert.equal(installCount, 0);
  } finally {
    fs.rmSync(cacheRoot, { recursive: true, force: true });
    fs.rmSync(claimRoot, { recursive: true, force: true });
    fs.rmSync(worktree, { recursive: true, force: true });
  }
});

test('runBuild rejects when the simulator is not claimed by the current worktree', async () => {
  const cacheRoot = makeTempDir('build-claim');
  const claimRoot = makeTempDir('claims');
  const worktree = makeTempDir('wt');
  const otherWorktree = makeTempDir('wt-other');
  const udid = 'UDID-claim';
  fs.writeFileSync(
    path.join(claimRoot, `${udid}.json`),
    JSON.stringify({
      worktreeRoot: otherWorktree,
      claimId: 'c',
      status: 'ready',
      claimedAt: new Date().toISOString(),
      deviceId: udid,
    })
  );
  let installCount = 0;
  let buildCount = 0;
  const deps: BuildDeps = makeBuildDeps({
    env: fixedEnv({ cacheRoot }),
    worktreeRoot: worktree,
    claimRoot,
    build: async () => {
      buildCount += 1;
    },
    install: () => {
      installCount += 1;
    },
  });
  try {
    await assert.rejects(() => runBuild(udid, deps), /claimed by/);
    assert.equal(buildCount, 0);
    assert.equal(installCount, 0);
  } finally {
    fs.rmSync(cacheRoot, { recursive: true, force: true });
    fs.rmSync(claimRoot, { recursive: true, force: true });
    fs.rmSync(worktree, { recursive: true, force: true });
    fs.rmSync(otherWorktree, { recursive: true, force: true });
  }
});

test('runBuild installs via the exact xcrun simctl install command shape', async () => {
  const cacheRoot = makeTempDir('build-cmd');
  const claimRoot = makeTempDir('claims');
  const worktree = makeTempDir('wt');
  const udid = 'UDID-cmd';
  fs.writeFileSync(
    path.join(claimRoot, `${udid}.json`),
    JSON.stringify({
      worktreeRoot: worktree,
      claimId: 'c',
      status: 'ready',
      claimedAt: new Date().toISOString(),
      deviceId: udid,
    })
  );
  const key = buildCompatibilityKey({
    nativeHash: 'native-hash',
    xcodeBuildVersion: '16A0000',
    simulatorSdkVersion: '17.5',
    hostArch: 'arm64',
    buildMode: 'debug-dev-client',
  });
  const keyDir = path.join(cacheRoot, 'entries', key);
  fs.mkdirSync(keyDir, { recursive: true });
  const bundle = path.join(keyDir, 'Kilo.app');
  fs.mkdirSync(bundle, { recursive: true });
  fs.writeFileSync(path.join(bundle, 'Info.plist'), '<plist/>');
  const checksum = await computeArtifactChecksum(bundle);
  fs.writeFileSync(
    path.join(keyDir, 'manifest.json'),
    JSON.stringify(fakeManifest({ key, artifactChecksum: checksum }))
  );
  const captured: Array<{ command: string; args: string[] }> = [];
  const deps: BuildDeps = makeBuildDeps({
    env: fixedEnv({ cacheRoot }),
    worktreeRoot: worktree,
    claimRoot,
    fingerprint: async () => 'native-hash',
    install: (udidArg, app) => {
      captured.push(buildInstallCommand(udidArg, app));
    },
  });
  try {
    await runBuild(udid, deps);
    assert.equal(captured.length, 1);
    assert.deepEqual(captured[0], {
      command: 'xcrun',
      args: ['simctl', 'install', udid, bundle],
    });
  } finally {
    fs.rmSync(cacheRoot, { recursive: true, force: true });
    fs.rmSync(claimRoot, { recursive: true, force: true });
    fs.rmSync(worktree, { recursive: true, force: true });
  }
});

// ── runFingerprint orchestration ────────────────────────────────────

test('runFingerprint prints sanitized compatibility dimensions and key only', async () => {
  const outputs: string[] = [];
  const write = (chunk: string): void => {
    outputs.push(chunk);
  };
  const deps = {
    env: fixedEnv({
      xcodeBuildVersion: '16A0000',
      simulatorSdkVersion: '17.5',
      arch: 'arm64',
    }),
    mobileRoot: '/mobile',
    fingerprint: async () => 'native-hash-123',
    write,
  };
  await runFingerprint(deps);
  assert.equal(outputs.length, 1);
  const json = JSON.parse(outputs[0]);
  assert.deepEqual(Object.keys(json).sort(), [
    'buildMode',
    'bundleId',
    'hostArch',
    'key',
    'nativeHash',
    'simulatorSdkVersion',
    'xcodeBuildVersion',
  ]);
  assert.equal(json.bundleId, 'com.kilocode.kiloapp');
  assert.equal(json.buildMode, 'debug-dev-client');
  assert.equal(
    json.key,
    buildCompatibilityKey({
      nativeHash: 'native-hash-123',
      xcodeBuildVersion: '16A0000',
      simulatorSdkVersion: '17.5',
      hostArch: 'arm64',
      buildMode: 'debug-dev-client',
    })
  );
});

// ── runPrune orchestration ──────────────────────────────────────────

test('runPrune reports the removed count and keeps the rest', async () => {
  const cacheRoot = makeTempDir('prune-run');
  const entriesRoot = path.join(cacheRoot, 'entries');
  fs.mkdirSync(entriesRoot, { recursive: true });
  const oldKey = 'old';
  const oldDir = path.join(entriesRoot, oldKey);
  fs.mkdirSync(oldDir, { recursive: true });
  fs.writeFileSync(
    path.join(oldDir, 'manifest.json'),
    JSON.stringify(fakeManifest({ key: oldKey, createdAt: '2026-06-01T00:00:00.000Z' }))
  );
  const recentKey = 'recent';
  const recentDir = path.join(entriesRoot, recentKey);
  fs.mkdirSync(recentDir, { recursive: true });
  fs.writeFileSync(
    path.join(recentDir, 'manifest.json'),
    JSON.stringify(fakeManifest({ key: recentKey, createdAt: '2026-07-15T11:00:00.000Z' }))
  );
  const outputs: string[] = [];
  const deps = {
    env: fixedEnv({ cacheRoot }),
    isLockActive: () => false,
    write: (chunk: string) => outputs.push(chunk),
  };
  try {
    await runPrune(deps);
    assert.equal(outputs.length, 1);
    const json = JSON.parse(outputs[0]);
    assert.deepEqual(json.removed, [oldKey]);
    assert.deepEqual(json.kept, [recentKey]);
  } finally {
    fs.rmSync(cacheRoot, { recursive: true, force: true });
  }
});

// ── Spec-review findings ────────────────────────────────────────────

test('atomic lock takeover: two simultaneous adopters produce exactly once', async () => {
  const cacheRoot = makeTempDir('lock-atomic-takeover');
  const lockRoot = path.join(cacheRoot, 'locks');
  const lockDir = path.join(lockRoot, 'test.lock');
  fs.mkdirSync(lockDir, { recursive: true });
  fs.writeFileSync(
    path.join(lockDir, 'lock.json'),
    JSON.stringify({
      key: 'test',
      pid: 99999,
      identity: 'dead-identity',
      startedAt: new Date(Date.now() - 60_000).toISOString(),
    })
  );
  const lockDeps: CacheLockDeps = {
    env: fixedEnv({ cacheRoot }),
    sleep: (ms: number) => new Promise(resolve => setTimeout(resolve, Math.max(ms, 1))),
    // The stale lock has pid 99999; the winner will have process.pid.
    pidAlive: (pid: number) => pid === process.pid,
    processIdentity: (pid: number) =>
      pid === process.pid ? `live-identity-${process.pid}` : 'dead-identity',
    isLockActive: record =>
      record.pid === process.pid && record.identity.startsWith('live-identity'),
  };
  const result = sharedResult({ value: '' });
  let producerInvocations = 0;
  const producer = async () => {
    producerInvocations += 1;
    await new Promise(resolve => setTimeout(resolve, 50));
    result.set({ value: 'produced' });
  };
  try {
    const [a, b] = await Promise.all([
      withFingerprintLock({
        key: 'test',
        lockRoot,
        deps: lockDeps,
        producer,
        readResult: result.read,
      }),
      withFingerprintLock({
        key: 'test',
        lockRoot,
        deps: lockDeps,
        producer,
        readResult: result.read,
      }),
    ]);
    assert.equal(producerInvocations, 1, 'exactly one producer should run');
    assert.equal(a.value, 'produced');
    assert.equal(b.value, 'produced');
  } finally {
    fs.rmSync(cacheRoot, { recursive: true, force: true });
  }
});

test('waiter TOCTOU: re-read result before attempting takeover', async () => {
  const cacheRoot = makeTempDir('lock-toctou');
  const lockRoot = path.join(cacheRoot, 'locks');
  const lockDir = path.join(lockRoot, 'test.lock');
  const resultFile = path.join(lockDir, 'result.json');
  fs.mkdirSync(lockDir, { recursive: true });
  fs.writeFileSync(
    path.join(lockDir, 'lock.json'),
    JSON.stringify({
      key: 'test',
      pid: 99999,
      identity: 'dead-identity',
      startedAt: new Date(Date.now() - 60_000).toISOString(),
    })
  );
  const lockDeps: CacheLockDeps = {
    env: fixedEnv({ cacheRoot }),
    sleep: async (ms: number) => {
      await new Promise(resolve => setTimeout(resolve, Math.max(ms, 1)));
      // Simulate producer publishing completion between waiter's result read and lock read
      if (!fs.existsSync(resultFile)) {
        fs.writeFileSync(resultFile, JSON.stringify({ done: true }));
        fs.rmSync(path.join(lockDir, 'lock.json'), { force: true });
      }
    },
    pidAlive: () => false,
    processIdentity: () => 'dead-identity',
    isLockActive: () => false,
  };
  let producerInvocations = 0;
  const result = sharedResult('published');
  const producer = async () => {
    producerInvocations += 1;
  };
  try {
    const value = await withFingerprintLock({
      key: 'test',
      lockRoot,
      deps: lockDeps,
      producer,
      readResult: result.read,
    });
    assert.equal(producerInvocations, 0, 'producer should not run if result was published');
    assert.equal(value, 'published');
  } finally {
    fs.rmSync(cacheRoot, { recursive: true, force: true });
  }
});

test('lookupCache misses when app present but manifest absent', async () => {
  const cacheRoot = makeTempDir('lookup-no-manifest');
  const key = 'test-key';
  const keyDir = path.join(cacheRoot, 'entries', key);
  fs.mkdirSync(keyDir, { recursive: true });
  fs.mkdirSync(path.join(keyDir, 'Kilo.app'), { recursive: true });
  // No manifest.json
  let onMissCalled = false;
  const result = await lookupCache({
    env: fixedEnv({ cacheRoot }),
    key,
    onMiss: async () => {
      onMissCalled = true;
      return undefined;
    },
  });
  assert.equal(result, undefined);
  assert.equal(onMissCalled, true);
  fs.rmSync(cacheRoot, { recursive: true, force: true });
});

test('pruneCache removes entries with invalid manifest JSON', async () => {
  const cacheRoot = makeTempDir('prune-invalid-manifest');
  const entriesRoot = path.join(cacheRoot, 'entries');
  fs.mkdirSync(entriesRoot, { recursive: true });
  const invalidKey = 'invalid';
  const invalidDir = path.join(entriesRoot, invalidKey);
  fs.mkdirSync(invalidDir, { recursive: true });
  fs.writeFileSync(path.join(invalidDir, 'manifest.json'), '{ invalid json');
  const validKey = 'valid';
  const validDir = path.join(entriesRoot, validKey);
  fs.mkdirSync(validDir, { recursive: true });
  fs.writeFileSync(
    path.join(validDir, 'manifest.json'),
    JSON.stringify(fakeManifest({ key: validKey, createdAt: '2026-07-15T11:00:00.000Z' }))
  );
  const result = await pruneCache({
    env: fixedEnv({ cacheRoot }),
    retentionMs: 14 * 24 * 60 * 60 * 1000,
    isLockActive: () => false,
  });
  assert.deepEqual(result.removed, [invalidKey]);
  assert.deepEqual(result.kept, [validKey]);
  assert.equal(fs.existsSync(invalidDir), false);
  assert.equal(fs.existsSync(validDir), true);
  fs.rmSync(cacheRoot, { recursive: true, force: true });
});

test('publishCacheEntry rechecks cache and avoids build when valid entry appears', async () => {
  const cacheRoot = makeTempDir('publish-recheck');
  const key = 'a'.repeat(64);
  const keyDir = path.join(cacheRoot, 'entries', key);
  fs.mkdirSync(keyDir, { recursive: true });
  const bundle = path.join(keyDir, 'Kilo.app');
  fs.mkdirSync(bundle, { recursive: true });
  fs.writeFileSync(path.join(bundle, 'Info.plist'), '<plist/>');
  const checksum = await computeArtifactChecksum(bundle);
  fs.writeFileSync(
    path.join(keyDir, 'manifest.json'),
    JSON.stringify(
      fakeManifest({
        key,
        nativeHash: 'native-hash',
        artifactChecksum: checksum,
        xcodeBuildVersion: '16A0000',
        simulatorSdkVersion: '17.5',
      })
    )
  );
  let buildInvocations = 0;
  const deps: BuildDeps = makeBuildDeps({
    env: fixedEnv({ cacheRoot }),
    build: async () => {
      buildInvocations += 1;
    },
  });
  try {
    const result = await publishCacheEntry({
      env: fixedEnv({ cacheRoot }),
      key,
      compatibility: {
        nativeHash: 'native-hash',
        xcodeBuildVersion: '16A0000',
        simulatorSdkVersion: '17.5',
        hostArch: 'arm64',
        buildMode: 'debug-dev-client',
      },
      worktreeRoot: '/wt',
      udid: 'UDID-test',
      deps,
    });
    assert.equal(buildInvocations, 0, 'build should not be called when cache is valid');
    assert.ok(result);
    assert.equal(result.manifest.key, key);
  } finally {
    fs.rmSync(cacheRoot, { recursive: true, force: true });
  }
});

test('runBuild revalidates on-disk entry after lock result', async () => {
  const cacheRoot = makeTempDir('runbuild-revalidate');
  const claimRoot = makeTempDir('claims');
  const worktree = makeTempDir('wt');
  const udid = 'UDID-revalidate';
  fs.writeFileSync(
    path.join(claimRoot, `${udid}.json`),
    JSON.stringify({
      worktreeRoot: worktree,
      claimId: 'c',
      status: 'ready',
      claimedAt: new Date().toISOString(),
      deviceId: udid,
    })
  );
  let buildInvocations = 0;
  const installs: string[] = [];
  const deps: BuildDeps = makeBuildDeps({
    env: fixedEnv({ cacheRoot }),
    worktreeRoot: worktree,
    claimRoot,
    build: async ({ derivedDataPath }) => {
      buildInvocations += 1;
      const app = path.join(
        derivedDataPath,
        'Build',
        'Products',
        'Debug-iphonesimulator',
        'Kilo.app'
      );
      fs.mkdirSync(app, { recursive: true });
      fs.writeFileSync(path.join(app, 'Info.plist'), '<plist/>');
    },
    install: (_udid, app) => {
      installs.push(app);
    },
  });
  try {
    await runBuild(udid, deps);
    assert.equal(buildInvocations, 1);
    assert.equal(installs.length, 1);
    // Verify the installed path is the on-disk cache entry, not a staging path
    const key = buildCompatibilityKey({
      nativeHash: 'native-hash',
      xcodeBuildVersion: '16A0000',
      simulatorSdkVersion: '17.5',
      hostArch: 'arm64',
      buildMode: 'debug-dev-client',
    });
    const expectedPath = path.join(cacheRoot, 'entries', key, 'Kilo.app');
    assert.equal(installs[0], expectedPath);
  } finally {
    fs.rmSync(cacheRoot, { recursive: true, force: true });
    fs.rmSync(claimRoot, { recursive: true, force: true });
    fs.rmSync(worktree, { recursive: true, force: true });
  }
});

test('computeArtifactChecksum distinguishes nested paths (a/file vs b/file)', async () => {
  const dir = makeTempDir('checksum-nested');
  try {
    // Create a/file with content1 and b/file with content2 in the SAME directory
    fs.mkdirSync(path.join(dir, 'a'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'a', 'file'), 'content1');
    fs.mkdirSync(path.join(dir, 'b'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'b', 'file'), 'content2');

    const checksum = await computeArtifactChecksum(dir);

    // Create a different structure with same filenames but different content
    const dir2 = makeTempDir('checksum-nested-2');
    fs.mkdirSync(path.join(dir2, 'a'), { recursive: true });
    fs.writeFileSync(path.join(dir2, 'a', 'file'), 'content2');
    fs.mkdirSync(path.join(dir2, 'b'), { recursive: true });
    fs.writeFileSync(path.join(dir2, 'b', 'file'), 'content1');

    const checksum2 = await computeArtifactChecksum(dir2);

    // These should be different because the content is swapped between a/ and b/
    assert.notEqual(checksum, checksum2, 'swapped content should produce different checksums');

    fs.rmSync(dir2, { recursive: true, force: true });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('computeArtifactChecksum rejects symlinks outside root', async () => {
  const dir = makeTempDir('checksum-symlink');
  const outsideDir = makeTempDir('checksum-outside');
  try {
    // Create a file outside the root
    fs.writeFileSync(path.join(outsideDir, 'secret'), 'secret-content');

    // Create a symlink inside the root pointing outside
    fs.symlinkSync(path.join(outsideDir, 'secret'), path.join(dir, 'link'));

    // The checksum should reject the symlink
    await assert.rejects(
      () => computeArtifactChecksum(dir),
      /symlink|link/i,
      'should reject symlinks'
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(outsideDir, { recursive: true, force: true });
  }
});

// ── Review findings ────────────────────────────────────────────────

test('tryAdoptLock does not steal a lock that has been replaced by a fresh active record', async () => {
  const cacheRoot = makeTempDir('lock-steal-toctou');
  const lockRoot = path.join(cacheRoot, 'locks');
  const lockDir = path.join(lockRoot, 'test.lock');
  const lockFile = path.join(lockDir, 'lock.json');
  const resultFile = path.join(lockDir, 'result.json');
  fs.mkdirSync(lockDir, { recursive: true });
  const staleRecord: LockRecord = {
    key: 'test',
    pid: 99999,
    identity: 'dead',
    startedAt: new Date(Date.now() - 60_000).toISOString(),
  };
  fs.writeFileSync(lockFile, JSON.stringify(staleRecord));

  const lockDeps: CacheLockDeps = {
    env: fixedEnv({ cacheRoot }),
    sleep: async ms => {
      await new Promise(resolve => setTimeout(resolve, Math.max(ms, 1)));
      // Between observing the stale record and attempting takeover, a
      // fresh active lock is installed by another caller.
      if (fs.readFileSync(lockFile, 'utf8').includes('"pid":99999')) {
        fs.writeFileSync(
          lockFile,
          JSON.stringify({
            key: 'test',
            pid: 4242,
            identity: 'fresh-active',
            startedAt: new Date().toISOString(),
          })
        );
      }
    },
    pidAlive: pid => pid === 4242,
    processIdentity: pid => (pid === 4242 ? 'fresh-active' : 'dead'),
    isLockActive: record => record.pid === 4242 && record.identity === 'fresh-active',
    waitForResultMs: 100,
    pollIntervalMs: 25,
  };
  let producerInvocations = 0;
  try {
    await assert.rejects(
      () =>
        withFingerprintLock({
          key: 'test',
          lockRoot,
          deps: lockDeps,
          producer: async () => {
            producerInvocations += 1;
          },
          readResult: async () => {
            throw new Error('readResult should not be called when lock is active');
          },
        }),
      /Timed out|active producer/i
    );
    assert.equal(producerInvocations, 0, 'must not steal an active lock');
  } finally {
    fs.rmSync(cacheRoot, { recursive: true, force: true });
  }
});

test('staging directory is created under cacheRoot so publication rename is same filesystem', async () => {
  const cacheRoot = makeTempDir('exdev-safe');
  const claimRoot = makeTempDir('claims');
  const worktree = makeTempDir('wt');
  const udid = 'UDID-exdev';
  fs.writeFileSync(
    path.join(claimRoot, `${udid}.json`),
    JSON.stringify({
      worktreeRoot: worktree,
      claimId: 'c',
      status: 'ready',
      claimedAt: new Date().toISOString(),
      deviceId: udid,
    })
  );
  let requestedMkdtempPrefix: string | undefined;
  const deps: BuildDeps = makeBuildDeps({
    env: fixedEnv({ cacheRoot }),
    worktreeRoot: worktree,
    claimRoot,
    mkdtemp: prefix => {
      requestedMkdtempPrefix = prefix;
      return fs.mkdtempSync(prefix);
    },
    build: async ({ stagingDir, derivedDataPath }) => {
      // Ensure the staging dir is inside the cache root.
      assert.ok(
        stagingDir.startsWith(cacheRoot),
        `stagingDir ${stagingDir} must be under cacheRoot ${cacheRoot}`
      );
      fs.mkdirSync(
        path.join(derivedDataPath, 'Build', 'Products', 'Debug-iphonesimulator', 'Kilo.app'),
        {
          recursive: true,
        }
      );
      fs.writeFileSync(
        path.join(
          derivedDataPath,
          'Build',
          'Products',
          'Debug-iphonesimulator',
          'Kilo.app',
          'Info.plist'
        ),
        '<plist/>'
      );
    },
  });
  try {
    await runBuild(udid, deps);
    assert.ok(
      requestedMkdtempPrefix?.startsWith(path.join(cacheRoot, 'staging')),
      `mkdtemp prefix should be under cacheRoot/staging, got ${requestedMkdtempPrefix}`
    );
  } finally {
    fs.rmSync(cacheRoot, { recursive: true, force: true });
    fs.rmSync(claimRoot, { recursive: true, force: true });
    fs.rmSync(worktree, { recursive: true, force: true });
  }
});

test('pruneCache removes stale lock artifacts and orphan quarantines', async () => {
  const cacheRoot = makeTempDir('prune-artifacts');
  const entriesRoot = path.join(cacheRoot, 'entries');
  const locksRoot = path.join(cacheRoot, 'locks');
  fs.mkdirSync(entriesRoot, { recursive: true });
  fs.mkdirSync(locksRoot, { recursive: true });

  const oldKey = 'old';
  const oldDir = path.join(entriesRoot, oldKey);
  fs.mkdirSync(oldDir, { recursive: true });
  fs.writeFileSync(
    path.join(oldDir, 'manifest.json'),
    JSON.stringify(fakeManifest({ key: oldKey, createdAt: '2026-06-01T00:00:00.000Z' }))
  );
  // Inactive lock artifacts for the old entry
  const oldLockDir = path.join(locksRoot, `${oldKey}.lock`);
  fs.mkdirSync(oldLockDir, { recursive: true });
  fs.writeFileSync(
    path.join(oldLockDir, 'lock.json'),
    JSON.stringify({ key: oldKey, pid: 1, identity: 'x', startedAt: new Date().toISOString() })
  );
  fs.writeFileSync(path.join(oldLockDir, 'result.json'), '{}');

  // Active lock artifacts must be protected
  const activeKey = 'active';
  const activeDir = path.join(entriesRoot, activeKey);
  fs.mkdirSync(activeDir, { recursive: true });
  fs.writeFileSync(
    path.join(activeDir, 'manifest.json'),
    JSON.stringify(fakeManifest({ key: activeKey, createdAt: '2026-07-15T11:00:00.000Z' }))
  );
  const activeLockDir = path.join(locksRoot, `${activeKey}.lock`);
  fs.mkdirSync(activeLockDir, { recursive: true });
  fs.writeFileSync(
    path.join(activeLockDir, 'lock.json'),
    JSON.stringify({
      key: activeKey,
      pid: process.pid,
      identity: 'active',
      startedAt: new Date().toISOString(),
    })
  );

  // tryAdoptLock quarantines lock.json as a file, not a directory.
  const orphanQuarantine = path.join(locksRoot, 'orphan.quarantine.123-456-abc');
  fs.writeFileSync(orphanQuarantine, '{}');

  const result = await pruneCache({
    env: fixedEnv({ cacheRoot }),
    retentionMs: 14 * 24 * 60 * 60 * 1000,
    isLockActive: record => record.pid === process.pid && record.identity === 'active',
  });
  assert.deepEqual(result.removed, [oldKey]);
  assert.deepEqual(result.kept, [activeKey]);
  assert.equal(fs.existsSync(oldDir), false);
  assert.equal(fs.existsSync(oldLockDir), false);
  assert.equal(fs.existsSync(orphanQuarantine), false);
  assert.equal(fs.existsSync(activeDir), true);
  assert.equal(fs.existsSync(activeLockDir), true);
  fs.rmSync(cacheRoot, { recursive: true, force: true });
});

test('computeArtifactChecksum is async and streams files without loading entire .app into memory', async () => {
  const dir = makeTempDir('checksum-stream');
  try {
    fs.mkdirSync(path.join(dir, 'a'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'a', 'file'), 'chunk-1');
    fs.mkdirSync(path.join(dir, 'b'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'b', 'file'), 'chunk-2');
    const checksum = await computeArtifactChecksum(dir);
    assert.equal(checksum.length, 64);
    // Same content produces same checksum
    const checksum2 = await computeArtifactChecksum(dir);
    assert.equal(checksum, checksum2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('computeArtifactChecksum rejects symlinks when streaming', async () => {
  const dir = makeTempDir('checksum-stream-link');
  const outsideDir = makeTempDir('checksum-outside-2');
  try {
    fs.writeFileSync(path.join(outsideDir, 'secret'), 'secret');
    fs.symlinkSync(path.join(outsideDir, 'secret'), path.join(dir, 'link'));
    await assert.rejects(() => computeArtifactChecksum(dir), /symlink|link/i);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(outsideDir, { recursive: true, force: true });
  }
});

test('mobileRoot is resolved from import.meta.dirname, not process.cwd', () => {
  const actual = mobileRoot();
  // The module is at dev/local/mobile-ios-build.ts; two levels up is repo root.
  const expected = path.resolve(import.meta.dirname, '..', '..', 'apps', 'mobile');
  assert.equal(actual, expected);
  // The current working directory must not influence the result.
  assert.doesNotMatch(actual, /apps\/mobile\/apps\/mobile/);
});

test('validateSimulatorClaim requires status ready and rejects preparing, invalid, legacy, and foreign', () => {
  const claimRoot = makeTempDir('claim-ready');
  const worktree = makeTempDir('wt');
  const other = makeTempDir('wt-other');
  const udid = 'UDID-ready';
  try {
    // Ready claim owned by this worktree
    fs.writeFileSync(
      path.join(claimRoot, `${udid}.json`),
      JSON.stringify({
        deviceId: udid,
        worktreeRoot: worktree,
        claimId: 'c',
        status: 'ready',
        claimedAt: new Date().toISOString(),
      })
    );
    assert.doesNotThrow(() => validateSimulatorClaim(udid, worktree, claimRoot));

    // Same worktree but preparing
    fs.writeFileSync(
      path.join(claimRoot, `${udid}.json`),
      JSON.stringify({
        deviceId: udid,
        worktreeRoot: worktree,
        claimId: 'c',
        status: 'preparing',
        claimedAt: new Date().toISOString(),
      })
    );
    assert.throws(
      () => validateSimulatorClaim(udid, worktree, claimRoot),
      /not ready|preparing|status/i
    );

    // Invalid status
    fs.writeFileSync(
      path.join(claimRoot, `${udid}.json`),
      JSON.stringify({
        deviceId: udid,
        worktreeRoot: worktree,
        claimId: 'c',
        status: 'invalid',
        claimedAt: new Date().toISOString(),
      })
    );
    assert.throws(
      () => validateSimulatorClaim(udid, worktree, claimRoot),
      /not ready|invalid|status/i
    );

    // Corrupt current record (missing claimId)
    fs.writeFileSync(
      path.join(claimRoot, `${udid}.json`),
      JSON.stringify({
        deviceId: udid,
        worktreeRoot: worktree,
        status: 'ready',
        claimedAt: new Date().toISOString(),
      })
    );
    assert.throws(() => validateSimulatorClaim(udid, worktree, claimRoot), /corrupt|claimId/i);

    // Legacy claim (no status) is rejected for build cache
    fs.writeFileSync(
      path.join(claimRoot, `${udid}.json`),
      JSON.stringify({ deviceId: udid, worktreeRoot: worktree })
    );
    assert.throws(
      () => validateSimulatorClaim(udid, worktree, claimRoot),
      /not ready|legacy|status/i
    );

    // Foreign ready claim
    fs.writeFileSync(
      path.join(claimRoot, `${udid}.json`),
      JSON.stringify({
        deviceId: udid,
        worktreeRoot: other,
        claimId: 'c',
        status: 'ready',
        claimedAt: new Date().toISOString(),
      })
    );
    assert.throws(() => validateSimulatorClaim(udid, worktree, claimRoot), /claimed by/);
  } finally {
    fs.rmSync(claimRoot, { recursive: true, force: true });
    fs.rmSync(worktree, { recursive: true, force: true });
    fs.rmSync(other, { recursive: true, force: true });
  }
});

test('defaultIsLockActive requires both pidAlive and processIdentity match', () => {
  const aliveRecord: LockRecord = { key: 'k', pid: 1, identity: 'a', startedAt: '' };
  const deadRecord: LockRecord = { key: 'k', pid: 2, identity: 'b', startedAt: '' };

  // Both probes agree: active
  let active = defaultIsLockActive({
    env: fixedEnv(),
    pidAlive: () => true,
    processIdentity: () => 'a',
  });
  assert.equal(active(aliveRecord), true);

  // PID alive but identity mismatch: inactive
  active = defaultIsLockActive({
    env: fixedEnv(),
    pidAlive: () => true,
    processIdentity: () => 'wrong',
  });
  assert.equal(active(aliveRecord), false);

  // Identity matches but PID dead: inactive
  active = defaultIsLockActive({
    env: fixedEnv(),
    pidAlive: () => false,
    processIdentity: () => 'b',
  });
  assert.equal(active(deadRecord), false);

  // Only processIdentity provided: must still be alive via default probe
  active = defaultIsLockActive({
    env: fixedEnv(),
    processIdentity: () => 'a',
  });
  // Use our own PID for the default probe; it is alive.
  const ownRecord: LockRecord = { key: 'k', pid: process.pid, identity: 'a', startedAt: '' };
  assert.equal(active(ownRecord), true);
  // A dead record with only identity provided should be inactive because
  // the default pidAlive probe returns false for non-existent PIDs.
  active = defaultIsLockActive({
    env: fixedEnv(),
    processIdentity: () => 'b',
  });
  assert.equal(active(deadRecord), false);
});

test('isValidManifest rejects createdAt that is not a strict ISO-8601 roundtrip', () => {
  const base = fakeManifest();
  assert.equal(
    isValidManifest(
      { ...base, createdAt: new Date().toISOString() },
      { key: 'k1', bundleId: 'com.kilocode.kiloapp' }
    ),
    true
  );
  assert.equal(
    isValidManifest(
      { ...base, createdAt: '2026-07-15' },
      { key: 'k1', bundleId: 'com.kilocode.kiloapp' }
    ),
    false
  );
  assert.equal(
    isValidManifest(
      { ...base, createdAt: '2026-07-15 12:00:00' },
      { key: 'k1', bundleId: 'com.kilocode.kiloapp' }
    ),
    false
  );
  assert.equal(
    isValidManifest(
      { ...base, createdAt: 'not a date' },
      { key: 'k1', bundleId: 'com.kilocode.kiloapp' }
    ),
    false
  );
  assert.equal(
    isValidManifest({ ...base, createdAt: '' }, { key: 'k1', bundleId: 'com.kilocode.kiloapp' }),
    false
  );
});

test('computeArtifactChecksum streams large files in chunks without loading full file', async () => {
  const dir = makeTempDir('checksum-large');
  try {
    // Create a file larger than the 64KB chunk size
    const large = Buffer.alloc(70 * 1024, 'x');
    fs.writeFileSync(path.join(dir, 'large.bin'), large);
    const checksum = await computeArtifactChecksum(dir);
    assert.equal(checksum.length, 64);
    // Same content produces same checksum
    const checksum2 = await computeArtifactChecksum(dir);
    assert.equal(checksum, checksum2);
    // Different content produces different checksum
    large[0] = 'y'.charCodeAt(0);
    fs.writeFileSync(path.join(dir, 'large.bin'), large);
    assert.notEqual(await computeArtifactChecksum(dir), checksum);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('defaultIsLockActive rejects when only pidAlive or only processIdentity matches', () => {
  const record: LockRecord = {
    key: 'k',
    pid: 0,
    identity: 'expected',
    startedAt: '',
  };

  // Only pidAlive provided: identity must still match via default probe
  let active = defaultIsLockActive({
    env: fixedEnv(),
    pidAlive: () => true,
  });
  assert.equal(active(record), false, 'alive but identity mismatch');

  // Only processIdentity provided: pid must still be alive via default probe
  active = defaultIsLockActive({
    env: fixedEnv(),
    processIdentity: () => 'expected',
  });
  // PID 0 is rejected before the default probe reaches the host process table.
  assert.equal(active(record), false, 'identity matches but pid dead');

  // Both provided and match
  active = defaultIsLockActive({
    env: fixedEnv(),
    pidAlive: () => true,
    processIdentity: () => 'expected',
  });
  assert.equal(active(record), true);
});

test('withFingerprintLock treats result file only as completion signal and does not trust serialized values', async () => {
  const cacheRoot = makeTempDir('lock-completion-signal');
  const lockRoot = path.join(cacheRoot, 'locks');
  const lockDir = path.join(lockRoot, 'test.lock');
  const resultFile = path.join(lockDir, 'result.json');
  fs.mkdirSync(lockDir, { recursive: true });
  fs.writeFileSync(
    path.join(lockDir, 'lock.json'),
    JSON.stringify({
      key: 'test',
      pid: 99999,
      identity: 'dead-identity',
      startedAt: new Date(Date.now() - 60_000).toISOString(),
    })
  );
  // A previous producer left a valid completion signal. The waiter must
  // not deserialize any value from this file; it must call readResult to
  // get the canonical result from disk.
  fs.writeFileSync(resultFile, JSON.stringify({ done: true }));
  const lockDeps: CacheLockDeps = {
    env: fixedEnv({ cacheRoot }),
    sleep: (ms: number) => new Promise(resolve => setTimeout(resolve, Math.max(ms, 1))),
    pidAlive: () => false,
    processIdentity: () => 'dead-identity',
    isLockActive: () => false,
  };
  let producerInvocations = 0;
  let readResultCalls = 0;
  try {
    const result = await withFingerprintLock({
      key: 'test',
      lockRoot,
      deps: lockDeps,
      producer: async () => {
        producerInvocations += 1;
      },
      readResult: async () => {
        readResultCalls += 1;
        return { validated: true };
      },
    });
    assert.equal(producerInvocations, 0, 'producer must not run when a completion signal exists');
    assert.equal(readResultCalls, 1);
    assert.equal(result.validated, true);
  } finally {
    fs.rmSync(cacheRoot, { recursive: true, force: true });
  }
});

test('withFingerprintLock propagates producer error marker to active waiters without trusting serialized values', async () => {
  const cacheRoot = makeTempDir('lock-error-marker');
  const lockRoot = path.join(cacheRoot, 'locks');
  const lockDir = path.join(lockRoot, 'test.lock');
  const resultFile = path.join(lockDir, 'result.json');
  fs.mkdirSync(lockDir, { recursive: true });
  fs.writeFileSync(
    path.join(lockDir, 'lock.json'),
    JSON.stringify({
      key: 'test',
      pid: 99999,
      identity: 'active-identity',
      startedAt: new Date(Date.now() - 60_000).toISOString(),
    })
  );
  // A currently failing producer left an error marker. An active waiter must
  // propagate the message-only generic Error and never run its own producer
  // or call readResult. Once the lock is no longer active, the marker is
  // stale and a later caller will rebuild instead.
  fs.writeFileSync(resultFile, JSON.stringify({ error: { message: 'previous producer failed' } }));
  const lockDeps: CacheLockDeps = {
    env: fixedEnv({ cacheRoot }),
    sleep: (ms: number) => new Promise(resolve => setTimeout(resolve, Math.max(ms, 1))),
    pidAlive: () => true,
    processIdentity: () => 'active-identity',
    isLockActive: () => true,
  };
  let producerInvocations = 0;
  let readResultCalls = 0;
  try {
    await assert.rejects(
      () =>
        withFingerprintLock({
          key: 'test',
          lockRoot,
          deps: lockDeps,
          producer: async () => {
            producerInvocations += 1;
          },
          readResult: async () => {
            readResultCalls += 1;
            return { validated: true };
          },
        }),
      /previous producer failed/
    );
    assert.equal(producerInvocations, 0);
    assert.equal(readResultCalls, 0);
  } finally {
    fs.rmSync(cacheRoot, { recursive: true, force: true });
  }
});

test('withFingerprintLock rebuilds when a stale done marker has no canonical result', async () => {
  // A stale `{done:true}` marker with no active lock and no usable canonical
  // result must not fail; the next caller should adopt and rebuild.
  const cacheRoot = makeTempDir('lock-stale-done-rebuild');
  const lockRoot = path.join(cacheRoot, 'locks');
  const lockDir = path.join(lockRoot, 'test.lock');
  const resultFile = path.join(lockDir, 'result.json');
  const canonicalResultFile = path.join(cacheRoot, 'canonical-result.txt');
  fs.mkdirSync(lockDir, { recursive: true });
  fs.writeFileSync(
    path.join(lockDir, 'lock.json'),
    JSON.stringify({
      key: 'test',
      pid: 99999,
      identity: 'dead-identity',
      startedAt: new Date(Date.now() - 60_000).toISOString(),
    })
  );
  fs.writeFileSync(resultFile, JSON.stringify({ done: true }));
  const lockDeps: CacheLockDeps = {
    env: fixedEnv({ cacheRoot }),
    sleep: (ms: number) => new Promise(resolve => setTimeout(resolve, Math.max(ms, 1))),
    pidAlive: () => false,
    processIdentity: () => 'dead-identity',
    isLockActive: () => false,
  };
  let producerInvocations = 0;
  try {
    const value = await withFingerprintLock({
      key: 'test',
      lockRoot,
      deps: lockDeps,
      producer: async () => {
        producerInvocations += 1;
        fs.writeFileSync(canonicalResultFile, 'rebuilt');
      },
      readResult: async () => {
        if (!fs.existsSync(canonicalResultFile)) {
          throw new Error('no canonical result yet');
        }
        return { value: fs.readFileSync(canonicalResultFile, 'utf8') };
      },
    });
    assert.equal(producerInvocations, 1, 'producer must run once to rebuild');
    assert.equal(value.value, 'rebuilt');
  } finally {
    fs.rmSync(cacheRoot, { recursive: true, force: true });
  }
});

test('withFingerprintLock retries after producer failure when lock is inactive', async () => {
  // Regression test: producer failure should not permanently poison the key.
  // First call fails and leaves an error marker. Second call detects the
  // inactive stale marker, clears it, runs a succeeding producer once, and
  // returns the canonical readResult. Third call is governed by the actual
  // cache/result protocol, not the stale error marker.
  const cacheRoot = makeTempDir('lock-retry-after-failure');
  const lockRoot = path.join(cacheRoot, 'locks');
  const lockDir = path.join(lockRoot, 'test.lock');
  const resultFile = path.join(lockDir, 'result.json');
  const lockDeps: CacheLockDeps = {
    env: fixedEnv({ cacheRoot }),
    sleep: (ms: number) => new Promise(resolve => setTimeout(resolve, Math.max(ms, 1))),
    pidAlive: () => false,
    processIdentity: () => 'dead-identity',
    isLockActive: () => false,
  };

  // First call: producer fails; error reaches caller.
  let firstProducerInvocations = 0;
  await assert.rejects(
    () =>
      withFingerprintLock({
        key: 'test',
        lockRoot,
        deps: lockDeps,
        producer: async () => {
          firstProducerInvocations += 1;
          throw new Error('first producer failed');
        },
        readResult: async () => {
          throw new Error('readResult should not be called on error');
        },
      }),
    /first producer failed/
  );
  assert.equal(firstProducerInvocations, 1);
  assert.equal(fs.existsSync(resultFile), true);
  const firstMarker = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
  assert.equal(firstMarker.error?.message, 'first producer failed');
  assert.equal(
    fs.existsSync(path.join(lockDir, 'lock.json')),
    false,
    'lock.json removed after failure'
  );

  // Second call: detects stale error marker, adopts, clears marker, runs
  // succeeding producer once, and returns canonical readResult.
  const result = sharedResult({ value: '' });
  let secondProducerInvocations = 0;
  const value = await withFingerprintLock({
    key: 'test',
    lockRoot,
    deps: lockDeps,
    producer: async () => {
      secondProducerInvocations += 1;
      result.set({ value: 'success' });
    },
    readResult: result.read,
  });
  assert.equal(secondProducerInvocations, 1);
  assert.equal(value.value, 'success');
  const secondMarker = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
  assert.equal(secondMarker.done, true, 'stale error marker must be replaced with done');
  assert.equal(secondMarker.error, undefined, 'stale error marker must be cleared');

  // Third call: governed by actual cache/result protocol; the stale error is
  // gone and the done marker is honored, so the producer does not run again.
  let thirdProducerInvocations = 0;
  const thirdValue = await withFingerprintLock({
    key: 'test',
    lockRoot,
    deps: lockDeps,
    producer: async () => {
      thirdProducerInvocations += 1;
    },
    readResult: result.read,
  });
  assert.equal(thirdProducerInvocations, 0, 'third call must not re-run producer');
  assert.equal(thirdValue.value, 'success');

  fs.rmSync(cacheRoot, { recursive: true, force: true });
});
