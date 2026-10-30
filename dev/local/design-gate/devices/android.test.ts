import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { matrixCells } from '../matrix';
import {
  createAndroidDevice,
  parseAdbDevices,
  parseNightMode,
  parseWmValue,
  resolveSerial,
} from './android';

test('adb and wm output parsing', () => {
  assert.deepEqual(
    parseAdbDevices('List of devices attached\nemulator-5554\tdevice\nemulator-5556\toffline\n\n'),
    ['emulator-5554']
  );
  assert.deepEqual(parseWmValue('Physical size: 1080x2400\n'), {
    physical: '1080x2400',
    override: undefined,
  });
  assert.deepEqual(parseWmValue('Physical density: 420\nOverride density: 480\n'), {
    physical: '420',
    override: '480',
  });
  assert.equal(parseNightMode('Night mode: no\n'), 'no');
  assert.throws(() => parseWmValue('error'), /Unexpected wm output/);
});

test('resolveSerial requires --device when several devices are online', () => {
  const exec = () => Buffer.from('List of devices attached\na\tdevice\nb\tdevice\n');
  assert.throws(() => resolveSerial(exec, undefined), /pass --device/);
  assert.equal(resolveSerial(exec, 'b'), 'b');
  assert.throws(() => resolveSerial(exec, 'c'), /not online/);
  assert.equal(
    resolveSerial(() => Buffer.from('a\tdevice\n'), undefined),
    'a'
  );
});

function fakeAdb(responses: Record<string, string>) {
  const commands: string[] = [];
  const exec = (command: string, args: readonly string[]) => {
    const line = [command, ...args].join(' ');
    commands.push(line);
    const key = args.slice(2).join(' ');
    if (key === 'emu avd name') throw new Error('not an emulator');
    return Buffer.from(responses[key] ?? '');
  };
  return { exec, commands };
}

test('android cells apply wm size, rotation, night mode and restore only what changed', () => {
  const { exec, commands } = fakeAdb({
    'shell wm density': 'Physical density: 420\n',
    'shell wm size': 'Physical size: 1080x2400\n',
    'shell cmd uimode night': 'Night mode: no\n',
    'shell settings get system accelerometer_rotation': '1\n',
    'shell settings get system user_rotation': '0\n',
    'shell getprop ro.product.model': 'sdk_gphone64_arm64\n',
  });
  const device = createAndroidDevice({
    exec,
    spawn: () => ({ signal: () => undefined, exited: Promise.resolve(0) }),
    serial: 'emulator-5554',
  });
  assert.deepEqual(device.names, ['sdk_gphone64_arm64']);
  const setup = commands.length;
  for (const cell of matrixCells('android', 'full')) device.apply(cell);
  device.restore();
  assert.deepEqual(
    commands.slice(setup).map(line => line.replace('adb -s emulator-5554 shell ', '')),
    [
      'cmd uimode night yes',
      'cmd uimode night no',
      'wm size 945x1680',
      'wm size reset',
      'settings put system accelerometer_rotation 0',
      'settings put system user_rotation 1',
      'wm size 945x1680',
      'settings put system accelerometer_rotation 1',
      'settings put system user_rotation 0',
      'wm size reset',
    ]
  );
});

test('android tap, landscape and null-setting restore commands', () => {
  const { exec, commands } = fakeAdb({
    'shell wm density': 'Physical density: 160\n',
    'shell wm size': 'Physical size: 360x640\nOverride size: 300x600\n',
    'shell cmd uimode night': 'Night mode: yes\n',
    'shell settings get system accelerometer_rotation': '0\n',
    'shell settings get system user_rotation': 'null\n',
  });
  const device = createAndroidDevice({
    exec,
    spawn: () => ({ signal: () => undefined, exited: Promise.resolve(0) }),
    serial: 's',
  });
  const setup = commands.length;
  device.tap?.(10.4, 20.6);
  const [landscape] = matrixCells('android', 'full').filter(cell => cell.landscape);
  assert.ok(landscape);
  device.apply(landscape);
  device.restore();
  assert.deepEqual(commands.slice(setup), [
    'adb -s s shell input tap 10 21',
    'adb -s s shell cmd uimode night no',
    'adb -s s shell settings put system user_rotation 1',
    'adb -s s shell cmd uimode night yes',
    'adb -s s shell settings delete system user_rotation',
  ]);
});

test('recording stop signals only its remote PID, is idempotent, and cleans up after pull failure', async () => {
  const exited = Promise.withResolvers<number | null>();
  const calls: string[][] = [];
  const responses: Record<string, string> = {
    'shell wm density': 'Physical density: 420',
    'shell wm size': 'Physical size: 1080x2400',
    'shell cmd uimode night': 'Night mode: no',
  };
  const device = createAndroidDevice({
    serial: 'owned-device',
    exec: (binary, args) => {
      calls.push([binary, ...args]);
      if (args[2] === 'pull') throw new Error('pull failed');
      if (args[3]?.startsWith('touch ')) exited.resolve(0);
      return Buffer.from(responses[args.slice(2).join(' ')] ?? '');
    },
    spawn: (binary, args) => {
      calls.push([binary, ...args]);
      return {
        signal: () => assert.fail('must signal the remote PID, not adb'),
        exited: exited.promise,
      };
    },
  });
  const recording = device.record(
    path.join(os.tmpdir(), 'design-gate-recorder-test', 'video.mp4'),
    180
  );
  const first = recording.stop();
  assert.equal(recording.stop(), first);
  await assert.rejects(first, /pull failed/);
  const start = calls.find(call => call[4]?.includes('screenrecord --bit-rate'));
  const stop = calls.find(call => call[4]?.startsWith('touch '));
  assert.ok(start && stop);
  const video = start[4]?.match(/\/sdcard\/design-gate-motion-[a-f0-9-]+\.mp4/)?.[0];
  assert.ok(video);
  assert.ok(stop[4]?.includes(video));
  assert.ok(stop[4]?.includes('/proc/$pid/cmdline'));
  assert.ok(stop[4]?.includes('kill -INT "$pid"'));
  assert.equal(calls.filter(call => call[4]?.startsWith('touch ')).length, 1);
  const cleanup = calls.at(-1);
  assert.deepEqual(cleanup?.slice(0, 6), ['adb', '-s', 'owned-device', 'shell', 'rm', '-f']);
  assert.ok(cleanup?.includes(video));
});
