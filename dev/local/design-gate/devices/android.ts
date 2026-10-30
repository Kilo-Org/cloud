import fs from 'node:fs';
import path from 'node:path';

import { InfraError, type Device, type Exec, type Spawn } from '../capture';
import { compactSize, type CellConfig } from '../matrix';

const REMOTE_VIDEO = '/sdcard/design-gate-motion.mp4';
const REMOTE_UI_XML = '/sdcard/design-gate-ui.xml';

type WmValue = { physical: string; override?: string };

type AndroidState = {
  night: string;
  sizeOverride: string | undefined;
  accelerometerRotation: string;
  userRotation: string;
};

export function parseAdbDevices(output: string): string[] {
  return output
    .split('\n')
    .map(line => line.trim().split(/\s+/))
    .filter(fields => fields.length >= 2 && fields[1] === 'device')
    .map(fields => fields[0] ?? '');
}

export function parseWmValue(output: string): WmValue {
  const physical = /Physical \w+:\s*(\S+)/.exec(output)?.[1];
  if (physical === undefined) throw new InfraError(`Unexpected wm output: ${output.trim()}`);
  return { physical, override: /Override \w+:\s*(\S+)/.exec(output)?.[1] };
}

export function parseNightMode(output: string): string {
  const mode = /Night mode:\s*(\S+)/.exec(output)?.[1];
  if (mode === undefined) throw new InfraError(`Unexpected uimode output: ${output.trim()}`);
  return mode;
}

export function resolveSerial(exec: Exec, requested: string | undefined): string {
  const serials = parseAdbDevices(exec('adb', ['devices']).toString());
  if (requested !== undefined) {
    if (!serials.includes(requested)) throw new InfraError(`adb device ${requested} is not online`);
    return requested;
  }
  if (serials.length === 1 && serials[0] !== undefined) return serials[0];
  if (serials.length === 0) throw new InfraError('No online adb device');
  throw new InfraError(
    `Several adb devices are online (${serials.join(', ')}); pass --device <serial>`
  );
}

export function createAndroidDevice(options: { exec: Exec; spawn: Spawn; serial: string }): Device {
  const { exec, spawn, serial } = options;
  const adb = (args: readonly string[]) => exec('adb', ['-s', serial, ...args]);
  const shell = (...args: string[]) =>
    adb(['shell', ...args])
      .toString()
      .trim();
  const optionalShell = (...args: string[]) => optional(() => shell(...args));
  const putSetting = (key: string, value: string) => {
    if (value === 'null') shell('settings', 'delete', 'system', key);
    else shell('settings', 'put', 'system', key, value);
  };

  const density = parseWmValue(shell('wm', 'density'));
  const densityDpi = Number(density.override ?? density.physical);
  const initial: AndroidState = {
    night: parseNightMode(shell('cmd', 'uimode', 'night')),
    sizeOverride: parseWmValue(shell('wm', 'size')).override,
    accelerometerRotation: shell('settings', 'get', 'system', 'accelerometer_rotation'),
    userRotation: shell('settings', 'get', 'system', 'user_rotation'),
  };
  const current: AndroidState = { ...initial };

  const setNight = (night: string) => {
    if (current.night === night) return;
    shell('cmd', 'uimode', 'night', night);
    current.night = night;
  };
  const setSize = (size: string | undefined) => {
    if (current.sizeOverride === size) return;
    shell('wm', 'size', size ?? 'reset');
    current.sizeOverride = size;
  };
  const setRotation = (accelerometerRotation: string, userRotation: string) => {
    if (current.accelerometerRotation !== accelerometerRotation) {
      putSetting('accelerometer_rotation', accelerometerRotation);
      current.accelerometerRotation = accelerometerRotation;
    }
    if (current.userRotation !== userRotation) {
      putSetting('user_rotation', userRotation);
      current.userRotation = userRotation;
    }
  };

  const names = [
    shell('getprop', 'ro.product.model'),
    optionalShell('getprop', 'ro.product.name'),
    optional(() => adb(['emu', 'avd', 'name']).toString().split('\n')[0]?.trim() ?? ''),
  ].filter(name => name.length > 0);

  return {
    platform: 'android',
    id: serial,
    names,
    apply: (config: CellConfig) => {
      setNight(config.dark ? 'yes' : 'no');
      setSize(config.compact ? compactSize(densityDpi) : initial.sizeOverride);
      if (config.landscape) setRotation('0', '1');
      else setRotation(initial.accelerometerRotation, initial.userRotation);
    },
    restore: () => {
      const errors: unknown[] = [];
      for (const step of [
        () => setNight(initial.night),
        () => setSize(initial.sizeOverride),
        () => setRotation(initial.accelerometerRotation, initial.userRotation),
      ]) {
        try {
          step();
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length > 0)
        throw new AggregateError(errors, `Android restore failed on ${serial}`);
    },
    screenshot: file => {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, adb(['exec-out', 'screencap', '-p']));
    },
    record: (file, seconds) => {
      const recorder = spawn('adb', [
        '-s',
        serial,
        'shell',
        'screenrecord',
        '--bit-rate',
        '8000000',
        '--time-limit',
        String(seconds),
        REMOTE_VIDEO,
      ]);
      return {
        stop: async () => {
          await recorder.exited;
          fs.mkdirSync(path.dirname(file), { recursive: true });
          adb(['pull', REMOTE_VIDEO, file]);
          optionalShell('rm', '-f', REMOTE_VIDEO);
        },
      };
    },
    tap: (xPx, yPx) => {
      shell('input', 'tap', String(Math.round(xPx)), String(Math.round(yPx)));
    },
    uiSnapshot: () => {
      shell('uiautomator', 'dump', REMOTE_UI_XML);
      const xml = adb(['exec-out', 'cat', REMOTE_UI_XML]).toString();
      optionalShell('rm', '-f', REMOTE_UI_XML);
      const fontScale = Number(shell('settings', 'get', 'system', 'font_scale'));
      return {
        xml,
        densityDpi,
        fontScale: Number.isFinite(fontScale) && fontScale > 0 ? fontScale : 1,
        colorScheme: current.night === 'yes' ? 'dark' : 'light',
        language: shell('getprop', 'persist.sys.locale') || 'en-US',
        osVersion: shell('getprop', 'ro.build.version.release'),
      };
    },
  };
}

function optional(read: () => string): string {
  try {
    return read();
  } catch {
    return '';
  }
}
