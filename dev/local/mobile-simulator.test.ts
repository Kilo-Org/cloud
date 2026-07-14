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
