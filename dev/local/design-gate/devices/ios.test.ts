import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { matrixCells } from '../matrix';
import { createIosDevice, parseBootedSimulators, parseDisplay, resolveSimulator } from './ios';

// The display report `simctl io <udid> enumerate` prints for a 402x874 pt phone.
const ENUMERATE_PORTRAIT = `
Port:
    UUID: 32F5DD52-C43F-45C6-B8B5-43149A612E6E
    Class: Display
    Display class: 0
    Default width: 1206
    Default height: 2622
    (1) LCD:
        Screen ID: 1
        Name: LCD
        Screen Type: Integrated
        Pixel Size: {1206, 2622}
        Preferred UI Scale: 3
        UI Orientation: Portrait
    (2) TVOut:
        Screen ID: 2
        Pixel Size: {720, 480}
        UI Orientation: Ambiguous
`;

const ENUMERATE_LANDSCAPE = ENUMERATE_PORTRAIT.replace(
  'UI Orientation: Portrait',
  'UI Orientation: Landscape Right'
);

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
      const line = args.join(' ');
      commands.push([command, ...args].join(' '));
      if (line === 'simctl io A enumerate') return Buffer.from(ENUMERATE_PORTRAIT);
      return Buffer.from(line === 'simctl ui A appearance' ? 'light\n' : '');
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

test('parseDisplay reads the LCD point size and its own UI orientation', () => {
  assert.deepEqual(parseDisplay(ENUMERATE_PORTRAIT), {
    widthPt: 402,
    heightPt: 874,
    orientation: 'portrait',
  });
  assert.deepEqual(parseDisplay(ENUMERATE_LANDSCAPE), {
    widthPt: 402,
    heightPt: 874,
    orientation: 'landscapeRight',
  });
  assert.throws(() => parseDisplay('Port:\n    UUID: X\n'), /lists no LCD display/);
});

/**
 * A device whose display follows the rotation commands it is sent. `flip: false`
 * models a guest that accepts every BackBoard request and never moves its
 * framebuffer — the stuck-simulator case the cell has to refuse.
 */
function flippingDevice(options: { flip?: boolean; compact?: boolean } = {}) {
  const { flip = true, compact = false } = options;
  const commands: string[] = [];
  let landscape = false;
  const device = createIosDevice({
    exec: (command, args) => {
      const line = [command, ...args].join(' ');
      commands.push(line);
      const sub = args.join(' ');
      if (line === 'xcrun simctl io A enumerate') {
        const portrait = compact
          ? ENUMERATE_PORTRAIT.replace('Pixel Size: {1206, 2622}', 'Pixel Size: {750, 1334}')
          : ENUMERATE_PORTRAIT;
        return Buffer.from(landscape ? unfold(portrait) : portrait);
      }
      if (sub.startsWith('devicectl device orientation set')) {
        const target = args[args.length - 1];
        if (flip) landscape = target !== 'portrait';
        return Buffer.from('');
      }
      if (sub === 'simctl ui A appearance') return Buffer.from('light\n');
      return Buffer.from('');
    },
    spawn: () => ({ signal: () => undefined, exited: Promise.resolve(0) }),
    simulator: { udid: 'A', name: 'iPhone 17' },
    rotateTimeoutMs: 600,
  });
  return { device, commands };
}

/** The same report with the LCD showing a landscape window. */
function unfold(enumerate: string): string {
  return enumerate.replace('UI Orientation: Portrait', 'UI Orientation: Landscape Right');
}

test('ios landscape rotates through BackBoard and accepts the flipped display', () => {
  // base reads portrait, the landscape apply reads landscape, and the restore
  // reads portrait again.
  const { device, commands } = flippingDevice();
  const cells = matrixCells('ios', 'standard', ['landscape']);
  const base = cells.find(cell => cell.id === 'base');
  const landscape = cells.find(cell => cell.id === 'landscape');
  assert.ok(base && landscape);
  device.apply(base);
  device.apply(landscape);
  assert.ok(commands.includes('xcrun devicectl device orientation set --device A landscapeLeft'));
  device.restore();
  // The restore puts portrait back, because that is what the run found.
  assert.ok(commands.includes('xcrun devicectl device orientation set --device A portrait'));
});

test('ios landscape throws when the display did not flip', () => {
  // The rotation command is accepted every time; the display keeps reporting
  // portrait, which is the case a stuck simulator produces. The cell must fail
  // rather than measure a portrait window as landscape.
  const { device } = flippingDevice({ flip: false });
  const landscape = matrixCells('ios', 'standard', ['landscape']).find(
    cell => cell.id === 'landscape'
  );
  assert.ok(landscape);
  assert.throws(() => device.apply(landscape), /did not reach the display of A/);
});

test('ios compact on a wide phone fails as infrastructure', () => {
  const { device } = flippingDevice();
  const compact = matrixCells('ios', 'standard', ['compact']).find(cell => cell.id === 'compact');
  assert.ok(compact);
  assert.throws(() => device.apply(compact), /at most 380 pt wide/);
});

test('ios compact accepts an SE-sized device', () => {
  const { device } = flippingDevice({ compact: true });
  const compact = matrixCells('ios', 'standard', ['compact']).find(cell => cell.id === 'compact');
  assert.ok(compact);
  device.apply(compact);
  device.restore();
});
