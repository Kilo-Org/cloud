import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { matrixCells } from '../matrix';
import { createIosDevice, parseBootedSimulators, resolveSimulator } from './ios';

const LIST = JSON.stringify({
  devices: {
    'com.apple.CoreSimulator.SimRuntime.iOS-26-0': [
      { udid: 'A', name: 'iPhone 17', state: 'Booted' },
      { udid: 'B', name: 'iPhone SE', state: 'Shutdown' },
    ],
    'com.apple.CoreSimulator.SimRuntime.iOS-18-0': [{ udid: 'C', name: 'iPad', state: 'Booted' }],
  },
});

test('parseBootedSimulators and resolveSimulator', () => {
  assert.deepEqual(parseBootedSimulators(LIST), [
    { udid: 'A', name: 'iPhone 17' },
    { udid: 'C', name: 'iPad' },
  ]);
  const exec = () => Buffer.from(LIST);
  assert.throws(() => resolveSimulator(exec, undefined), /pass --device/);
  assert.deepEqual(resolveSimulator(exec, 'iPad'), { udid: 'C', name: 'iPad' });
  assert.throws(() => resolveSimulator(exec, 'Z'), /not booted/);
});

test('ios cells toggle appearance and restore it; recording stops with SIGINT', async () => {
  const commands: string[] = [];
  const signals: string[] = [];
  const device = createIosDevice({
    exec: (command, args) => {
      commands.push([command, ...args].join(' '));
      return Buffer.from(args.join(' ') === 'simctl ui A appearance' ? 'light\n' : '');
    },
    spawn: (command, args) => {
      commands.push([command, ...args].join(' '));
      return { signal: signal => signals.push(signal), exited: Promise.resolve(0) };
    },
    simulator: { udid: 'A', name: 'iPhone 17' },
  });
  const cells = matrixCells('ios', 'standard');
  for (const cell of cells) device.apply(cell);
  const dark = cells[1];
  assert.ok(dark);
  device.apply(dark);
  device.restore();
  const video = path.join(os.tmpdir(), 'design-gate-ios-test', 'm.mp4');
  await device.record(video, 3).stop();
  assert.deepEqual(commands, [
    'xcrun simctl ui A appearance',
    'xcrun simctl ui A appearance dark',
    'xcrun simctl ui A appearance light',
    'xcrun simctl ui A appearance dark',
    'xcrun simctl ui A appearance light',
    `xcrun simctl io A recordVideo --codec h264 --force ${video}`,
  ]);
});

test('ios font-max restores Dynamic Type even when the appearance restore fails', () => {
  const commands: string[] = [];
  const device = createIosDevice({
    exec: (_command, args) => {
      const line = args.join(' ');
      commands.push(line);
      if (line === 'simctl ui A appearance') return Buffer.from('dark\n');
      if (line === 'simctl ui A content_size') return Buffer.from('large\n');
      if (line === 'simctl ui A appearance dark') throw new Error('simctl failed');
      return Buffer.from('');
    },
    spawn: () => ({ signal: () => undefined, exited: Promise.resolve(0) }),
    simulator: { udid: 'A', name: 'iPhone 17' },
  });
  const [fontMax] = matrixCells('ios', 'base', ['font-max']).filter(cell => cell.fontMax);
  assert.ok(fontMax);
  device.apply(fontMax);
  assert.throws(() => device.restore(), /iOS restore failed on A/);
  assert.deepEqual(commands.slice(-2), [
    'simctl ui A appearance dark',
    'simctl ui A content_size large',
  ]);
});

test('ios font-max on a runtime without content_size fails as infrastructure', () => {
  const device = createIosDevice({
    exec: (_command, args) =>
      Buffer.from(args.join(' ') === 'simctl ui A content_size' ? 'unsupported\n' : 'light\n'),
    spawn: () => ({ signal: () => undefined, exited: Promise.resolve(0) }),
    simulator: { udid: 'A', name: 'iPhone 17' },
  });
  const [fontMax] = matrixCells('ios', 'base', ['font-max']).filter(cell => cell.fontMax);
  assert.ok(fontMax);
  assert.throws(() => device.apply(fontMax), /content_size is unsupported/);
  device.restore();
});
