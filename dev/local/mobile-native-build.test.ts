import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { hashRootNativeInputs, withNativeBuildSemaphore } from './mobile-native-build';

test('serializes native producers across different platform builds', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-native-build-'));
  let active = 0;
  let maxActive = 0;
  let releaseFirst: (() => void) | undefined;
  const firstMayFinish = new Promise<void>(resolve => {
    releaseFirst = resolve;
  });
  let firstStarted: (() => void) | undefined;
  const firstDidStart = new Promise<void>(resolve => {
    firstStarted = resolve;
  });

  const run = async (wait: Promise<void>) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    firstStarted?.();
    firstStarted = undefined;
    await wait;
    active -= 1;
  };

  const first = withNativeBuildSemaphore({
    root,
    pollIntervalMs: 5,
    run: () => run(firstMayFinish),
  });
  await firstDidStart;
  const second = withNativeBuildSemaphore({
    root,
    pollIntervalMs: 5,
    run: () => run(Promise.resolve()),
  });

  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(active, 1);
  releaseFirst?.();
  await Promise.all([first, second]);
  assert.equal(maxActive, 1);
});

test('recovers an abandoned native producer lock', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-native-build-'));
  const lockPath = path.join(root, 'native-build.lock');
  fs.writeFileSync(
    lockPath,
    JSON.stringify({
      pid: 99_999,
      identity: 'dead',
      token: 'stale',
      startedAt: new Date().toISOString(),
    })
  );

  let ran = false;
  await withNativeBuildSemaphore({
    root,
    pidAlive: () => false,
    processIdentity: () => undefined,
    pollIntervalMs: 1,
    run: async () => {
      ran = true;
    },
  });

  assert.equal(ran, true);
  assert.equal(fs.existsSync(lockPath), false);
});

test('recovers an abandoned legacy directory-shaped native producer lock', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-native-build-'));
  const lockPath = path.join(root, 'native-build.lock');
  fs.mkdirSync(lockPath);
  fs.writeFileSync(
    path.join(lockPath, 'owner.json'),
    JSON.stringify({
      pid: 99_999,
      identity: 'dead',
      token: 'legacy-stale',
      startedAt: new Date().toISOString(),
    })
  );

  let ran = false;
  await withNativeBuildSemaphore({
    root,
    pidAlive: () => false,
    processIdentity: () => undefined,
    pollIntervalMs: 1,
    run: async () => {
      ran = true;
    },
  });

  assert.equal(ran, true);
  assert.equal(fs.existsSync(lockPath), false);
});

test('does not release a native lock replaced by another owner', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-native-build-'));
  const lockPath = path.join(root, 'native-build.lock');

  await assert.rejects(
    withNativeBuildSemaphore({
      root,
      run: async () => {
        fs.rmSync(lockPath, { force: true });
        fs.writeFileSync(
          lockPath,
          JSON.stringify({
            pid: process.pid,
            identity: 'replacement',
            token: 'replacement',
            startedAt: new Date().toISOString(),
          })
        );
        throw new Error('producer failed');
      },
    }),
    /producer failed/
  );

  assert.equal(JSON.parse(fs.readFileSync(lockPath, 'utf8')).token, 'replacement');
});

test('publishes owner metadata before exposing the canonical native lock', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-native-build-'));
  const originalLinkSync = fs.linkSync;
  let second: Promise<void> | undefined;
  let active = 0;
  let maxActive = 0;
  let intercepted = false;

  fs.linkSync = ((existingPath, newPath) => {
    if (!intercepted && path.basename(String(newPath)) === 'native-build.lock') {
      intercepted = true;
      second = withNativeBuildSemaphore({
        root,
        pollIntervalMs: 1,
        run: async () => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          await new Promise(resolve => setTimeout(resolve, 10));
          active -= 1;
        },
      });
    }
    return originalLinkSync(existingPath, newPath);
  }) as typeof fs.linkSync;

  try {
    await withNativeBuildSemaphore({
      root,
      pollIntervalMs: 1,
      run: async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise(resolve => setTimeout(resolve, 10));
        active -= 1;
      },
    });
    await second;
    assert.equal(maxActive, 1);
  } finally {
    fs.linkSync = originalLinkSync;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function writeRootNativeInputs(root: string): void {
  fs.mkdirSync(path.join(root, 'patches'), { recursive: true });
  fs.writeFileSync(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - apps/*\n');
  fs.writeFileSync(path.join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
  fs.writeFileSync(path.join(root, 'patches', 'react-native.patch'), 'original patch');
}

test('root native inputs hash is stable when nothing changes', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-root-inputs-'));
  writeRootNativeInputs(root);
  assert.equal(hashRootNativeInputs(root), hashRootNativeInputs(root));
  fs.rmSync(root, { recursive: true, force: true });
});

test('root native inputs hash changes with patch, workspace, and lockfile edits', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-root-inputs-'));
  writeRootNativeInputs(root);
  const seen = [hashRootNativeInputs(root)];
  const mutations: (() => void)[] = [
    () => fs.writeFileSync(path.join(root, 'patches', 'react-native.patch'), 'edited patch'),
    () => fs.writeFileSync(path.join(root, 'patches', 'expo-server-sdk.patch'), 'new patch'),
    () => fs.writeFileSync(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - services/*\n'),
    () => fs.writeFileSync(path.join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 10\n'),
  ];
  for (const mutate of mutations) {
    mutate();
    const next = hashRootNativeInputs(root);
    assert.equal(seen.includes(next), false);
    seen.push(next);
  }
  fs.rmSync(root, { recursive: true, force: true });
});

test('enforces the wait timeout before reclaiming an incomplete lock', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-native-build-'));
  fs.writeFileSync(path.join(root, 'native-build.lock'), '{');
  let ran = false;

  await assert.rejects(
    withNativeBuildSemaphore({
      root,
      waitTimeoutMs: 0,
      run: async () => {
        ran = true;
      },
    }),
    /Timed out waiting for native build producer/
  );
  assert.equal(ran, false);
  assert.equal(fs.existsSync(path.join(root, 'native-build.lock')), true);
  fs.rmSync(root, { recursive: true, force: true });
});
