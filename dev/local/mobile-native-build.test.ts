import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { withNativeBuildSemaphore } from './mobile-native-build';

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
  const lockDir = path.join(root, 'native-build.lock');
  fs.mkdirSync(lockDir, { recursive: true });
  fs.writeFileSync(
    path.join(lockDir, 'owner.json'),
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
  assert.equal(fs.existsSync(lockDir), false);
});

test('does not release a native lock replaced by another owner', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-native-build-'));
  const lockDir = path.join(root, 'native-build.lock');

  await assert.rejects(
    withNativeBuildSemaphore({
      root,
      run: async () => {
        fs.rmSync(lockDir, { recursive: true, force: true });
        fs.mkdirSync(lockDir, { recursive: true });
        fs.writeFileSync(
          path.join(lockDir, 'owner.json'),
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

  assert.equal(
    JSON.parse(fs.readFileSync(path.join(lockDir, 'owner.json'), 'utf8')).token,
    'replacement'
  );
});
