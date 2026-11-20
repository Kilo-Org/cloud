import fs from 'node:fs';
import path from 'node:path';

import { InfraError, type Device, type Exec, type Spawn } from '../capture';
import { IOS_COMPACT_MAX_WIDTH_DP, type CellConfig } from '../matrix';

/** The largest Dynamic Type size `simctl ui <udid> content_size` accepts. */
export const IOS_MAX_CONTENT_SIZE = 'accessibility-extra-extra-extra-large';

// A rotation request reaches the framebuffer a frame or two later, and the
// display reads `Ambiguous` while it flips. The whole cycle measured under a
// second; the budget covers a loaded host without turning a refused rotation
// into a long stall.
const ROTATE_TIMEOUT_MS = 8_000;
const ROTATE_POLL_MS = 250;

/** `Atomics.wait` on a throwaway cell: a sleep the device adapter can use synchronously. */
function waitSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** The two UI orientations a gate cell asks for; `pud` is not a cell. */
export type DisplayOrientation = 'portrait' | 'portraitUpsideDown' | 'landscapeLeft' | 'landscapeRight';

export type IosDisplay = {
  /** Point size of the primary display, from its pixel size and UI scale. */
  widthPt: number;
  heightPt: number;
  /** `UI Orientation` of the primary display, which is what the framebuffer shows. */
  orientation: DisplayOrientation | 'unknown';
};

/**
 * Read the primary (LCD) display from `simctl io <udid> enumerate`. The block
 * looks like:
 *
 *     (1) LCD:
 *         Screen Type: Integrated
 *         Pixel Size: {1206, 2622}
 *         Preferred UI Scale: 3
 *         UI Orientation: Portrait
 *
 * `UI Orientation` is the framebuffer's own orientation, not the requested
 * interface orientation: it stays `Portrait` on a device whose guest refused
 * the rotation, which is exactly the case a landscape cell has to refuse.
 */
export function parseDisplay(enumerate: string): IosDisplay {
  const block = /\(\d+\)\s+LCD:([\s\S]*?)(?=\(\d+\)\s+\w+:|$)/.exec(enumerate)?.[1];
  if (block === undefined) throw new InfraError('simctl io enumerate lists no LCD display');
  const pixels = /Pixel Size:\s*\{(\d+),\s*(\d+)\}/.exec(block);
  const scale = /Preferred UI Scale:\s*(\d+(?:\.\d+)?)/.exec(block);
  const raw = /UI Orientation:\s*([\w ]+)/.exec(block)?.[1]?.replace(/\s+/g, '');
  if (pixels === undefined || scale === undefined || raw === undefined) {
    throw new InfraError(`simctl io enumerate LCD block is incomplete: ${block.trim()}`);
  }
  const divisor = Number(scale[1]);
  if (!(divisor > 0)) throw new InfraError(`simctl io enumerate reports UI scale ${scale[1]}`);
  return {
    widthPt: Number(pixels[1]) / divisor,
    heightPt: Number(pixels[2]) / divisor,
    orientation: ORIENTATIONS[raw.toLowerCase()] ?? 'unknown',
  };
}

/** `UI Orientation` spellings, normalized. `Ambiguous` is mid-flip. */
const ORIENTATIONS: Record<string, DisplayOrientation> = {
  portrait: 'portrait',
  portraitupsidedown: 'portraitUpsideDown',
  landscapeleft: 'landscapeLeft',
  landscaperight: 'landscapeRight',
};

/** Whether the display is showing a landscape window. */
export function isLandscape(display: IosDisplay): boolean {
  return display.orientation === 'landscapeLeft' || display.orientation === 'landscapeRight';
}

/** Whether the display is showing an upright portrait window. */
export function isPortrait(display: IosDisplay): boolean {
  return display.orientation === 'portrait';
}

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
  /** Test seam: how long a rotation may take to reach the display. */
  rotateTimeoutMs?: number;
}): Device {
  const { exec, spawn, simulator, rotateTimeoutMs = ROTATE_TIMEOUT_MS } = options;
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
  // Read lazily: only a run with the font-max cell changes Dynamic Type, and
  // the restore puts back exactly the size it found.
  let initialContentSize: string | undefined;
  let contentSize: string | undefined;
  const setContentSize = (value: string) => {
    if (contentSize === value || value === 'unsupported') return;
    simctl('ui', simulator.udid, 'content_size', value);
    contentSize = value;
  };
  // The display's own report, read fresh: a rotation that only the request
  // accepted is not a rotation the screenshots show.
  const display = (): IosDisplay =>
    parseDisplay(exec('xcrun', ['simctl', 'io', simulator.udid, 'enumerate']).toString());
  // Read lazily, like Dynamic Type: only a run with the landscape cell rotates,
  // and its restore puts back the orientation it found.
  let initialOrientation: DisplayOrientation | 'unknown' | undefined;
  let orientation: DisplayOrientation | undefined;
  /**
   * Ask BackBoard to show `target` and require the display to follow.
   *
   * `devicectl device orientation` is the BackBoard orientation path the
   * Simulator's Device ▸ Rotate Left menu drives; `simctl` has no rotation
   * command of its own. The command reports success whenever the request was
   * accepted, so its return is never evidence: the display's own
   * `UI Orientation` decides, and a rotation the framebuffer did not take is an
   * infrastructure failure rather than a cell measured in the wrong window.
   *
   * The framebuffer follows a frame or two late, so the check polls, and
   * `Ambiguous` means the display is mid-flip: both count as "not yet" up to the
   * deadline and as failure at it.
   */
  const setOrientation = (target: DisplayOrientation) => {
    if (orientation === target) return;
    if (initialOrientation === undefined) initialOrientation = display().orientation;
    exec('xcrun', [
      'devicectl',
      'device',
      'orientation',
      'set',
      '--device',
      simulator.udid,
      target,
    ]);
    const deadline = Date.now() + rotateTimeoutMs;
    // Compare by axis, not by side: a `landscapeLeft` request reaches the
    // display as `Landscape Right` (measured on an iPhone 17 Pro, iOS 26.5 —
    // BackBoard and the display name the two ends of one rotation differently),
    // and a 180° flip is not what any cell asks for.
    const wanted = target === 'portrait' ? isPortrait : isLandscape;
    let after = display();
    while (!wanted(after)) {
      if (Date.now() > deadline) {
        throw new InfraError(
          `rotation to ${target} did not reach the display of ${simulator.udid}: ` +
            `UI Orientation reads ${after.orientation} after ${rotateTimeoutMs} ms ` +
            `(${Math.round(after.widthPt)}x${Math.round(after.heightPt)} pt)`
        );
      }
      waitSync(ROTATE_POLL_MS);
      after = display();
    }
    orientation = target;
  };
  /**
   * The compact cell needs a small *device*: an iPhone simulator's display has
   * one mode, so it cannot be shrunk the way `wm size` shrinks Android. Refuse
   * before measuring rather than reporting a 402 pt phone as a 360 dp cell.
   */
  const requireCompactDevice = () => {
    const size = display();
    if (size.widthPt > IOS_COMPACT_MAX_WIDTH_DP) {
      throw new InfraError(
        `the compact cell needs a simulator at most ${IOS_COMPACT_MAX_WIDTH_DP} pt wide; ` +
          `${simulator.udid} is ${size.widthPt}x${size.heightPt} pt (use an iPhone SE or mini)`
      );
    }
  };

  return {
    platform: 'ios',
    id: simulator.udid,
    names: [simulator.name],
    apply: (config: CellConfig) => {
      if (config.compact) requireCompactDevice();
      // Rotate first so a device that cannot rotate fails the cell before any
      // other state is mutated. A portrait cell only rotates back when this run
      // rotated: the base/dark/rtl cells never touch the display, so a run
      // without the landscape cell issues no rotation at all.
      if (config.landscape) setOrientation('landscapeLeft');
      else if (orientation !== undefined) setOrientation('portrait');
      setAppearance(config.dark ? 'dark' : 'light');
      if (config.fontMax) {
        initialContentSize ??= simctl('ui', simulator.udid, 'content_size');
        if (initialContentSize === 'unsupported') {
          throw new InfraError(
            `simctl ui ${simulator.udid} content_size is unsupported; the font-max cell cannot run`
          );
        }
        contentSize ??= initialContentSize;
        setContentSize(IOS_MAX_CONTENT_SIZE);
      } else if (initialContentSize !== undefined) {
        setContentSize(initialContentSize);
      }
    },
    // Each step restores on its own, so a failed appearance restore still puts
    // Dynamic Type and the display orientation back.
    restore: () => {
      const errors: unknown[] = [];
      for (const step of [
        () => {
          if (initialOrientation !== undefined && initialOrientation !== 'unknown') {
            setOrientation(initialOrientation);
          }
        },
        () => setAppearance(initialAppearance),
        () => {
          if (initialContentSize !== undefined) setContentSize(initialContentSize);
        },
      ]) {
        try {
          step();
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length > 0) {
        throw new AggregateError(errors, `iOS restore failed on ${simulator.udid}`);
      }
    },
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
