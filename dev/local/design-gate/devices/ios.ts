import fs from 'node:fs';
import path from 'node:path';

import { InfraError, type Device, type Exec, type Spawn } from '../capture';
import type { CellConfig } from '../matrix';

export type Simulator = { udid: string; name: string };

export function parseBootedSimulators(json: string): Simulator[] {
  const parsed: unknown = JSON.parse(json);
  const devices =
    typeof parsed === 'object' && parsed !== null && 'devices' in parsed
      ? parsed.devices
      : undefined;
  if (typeof devices !== 'object' || devices === null) return [];
  return Object.values(devices).flatMap((runtime: unknown) =>
    Array.isArray(runtime)
      ? runtime.flatMap((entry: unknown) => {
          if (typeof entry !== 'object' || entry === null) return [];
          const { udid, name, state } = entry as Record<string, unknown>;
          return typeof udid === 'string' && typeof name === 'string' && state === 'Booted'
            ? [{ udid, name }]
            : [];
        })
      : []
  );
}

export function resolveSimulator(exec: Exec, requested: string | undefined): Simulator {
  const booted = parseBootedSimulators(
    exec('xcrun', ['simctl', 'list', 'devices', 'booted', '-j']).toString()
  );
  if (requested !== undefined) {
    const match = booted.find(
      simulator => simulator.udid === requested || simulator.name === requested
    );
    if (match === undefined) throw new InfraError(`Simulator ${requested} is not booted`);
    return match;
  }
  const [only] = booted;
  if (booted.length === 1 && only !== undefined) return only;
  if (booted.length === 0) throw new InfraError('No booted iOS simulator');
  throw new InfraError(
    `Several simulators are booted (${booted.map(simulator => simulator.udid).join(', ')}); pass --device <udid>`
  );
}

export function createIosDevice(options: {
  exec: Exec;
  spawn: Spawn;
  simulator: Simulator;
}): Device {
  const { exec, spawn, simulator } = options;
  const simctl = (...args: string[]) =>
    exec('xcrun', ['simctl', ...args])
      .toString()
      .trim();
  const initialAppearance = simctl('ui', simulator.udid, 'appearance');
  let appearance = initialAppearance;
  const setAppearance = (value: string) => {
    if (appearance === value || value === 'unsupported') return;
    simctl('ui', simulator.udid, 'appearance', value);
    appearance = value;
  };

  return {
    platform: 'ios',
    id: simulator.udid,
    names: [simulator.name],
    apply: (config: CellConfig) => setAppearance(config.dark ? 'dark' : 'light'),
    restore: () => setAppearance(initialAppearance),
    screenshot: file => {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      simctl('io', simulator.udid, 'screenshot', file);
    },
    record: file => {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const recorder = spawn('xcrun', [
        'simctl',
        'io',
        simulator.udid,
        'recordVideo',
        '--codec',
        'h264',
        '--force',
        file,
      ]);
      return {
        stop: async () => {
          recorder.signal('SIGINT');
          await recorder.exited;
        },
      };
    },
  };
}
