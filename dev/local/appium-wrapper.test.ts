import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const { portsFor, slugFor } = await import('../../apps/mobile/e2e/wdio/ports.js');

test('appium port assignment is deterministic and block-shaped', () => {
  const first = portsFor('A1B2C3D4-0000-0000-0000-000000000000');
  assert.deepEqual(first, portsFor('A1B2C3D4-0000-0000-0000-000000000000'));

  // Server, WDA, and system ports stay inside the device's own block of 10,
  // in valid unprivileged-port territory; the wrapper bumps whole blocks when
  // one is occupied, so hash collisions never cross-talk.
  assert.equal(first.wda, first.server + 1);
  assert.equal(first.system, first.server + 2);
  assert.ok(first.server >= 4730 && first.server <= 9730);
  assert.ok(first.system < first.server + 10);
});

test('appium device slug is filesystem- and tmux-safe', () => {
  assert.equal(slugFor('A1B2C3D4-0000-0000-0000-000000000000'), 'A1B2C3D4-0000-0000-0000-000000000000');
  assert.equal(slugFor('emulator-5554'), 'emulator-5554');
  assert.equal(slugFor('192.168.1.10:5555'), '192-168-1-10-5555');
});

test('appium wrapper rejects a missing device and unknown commands', () => {
  const noArgs = spawnSync('apps/mobile/e2e/appium.sh', [], { encoding: 'utf8' });
  assert.notEqual(noArgs.status, 0);
  assert.match(noArgs.stderr, /usage: appium\.sh/);

  const unknown = spawnSync('apps/mobile/e2e/appium.sh', ['some-device', 'bogus'], {
    encoding: 'utf8',
  });
  assert.notEqual(unknown.status, 0);
  assert.match(unknown.stderr, /usage: appium\.sh/);
});
