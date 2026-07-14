import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { claimSimulator, releaseSimulator, type SimulatorDevice } from './mobile-simulator';

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
