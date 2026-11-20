import type { ProbeEnv } from './tree';

export type Platform = 'android' | 'ios';
export type MatrixName = 'base' | 'standard' | 'full';
export type CellId = 'base' | 'dark' | 'compact' | 'landscape' | 'rtl' | 'rtl-compact' | 'font-max';

export type CellConfig = Readonly<{
  id: CellId;
  dark: boolean;
  rtl: boolean;
  compact: boolean;
  landscape: boolean;
  /** The platform's largest text size: Android font scale, iOS Dynamic Type. */
  fontMax: boolean;
}>;

export const CELL_IDS: readonly CellId[] = [
  'base',
  'dark',
  'compact',
  'landscape',
  'rtl',
  'rtl-compact',
  'font-max',
];

export const MATRIX_NAMES: readonly MatrixName[] = ['base', 'standard', 'full'];
export const COMPACT_WIDTH_DP = 360;
const COMPACT_HEIGHT_DP = 640;
const WIDTH_TOLERANCE_DP = 2;
export const TAP_TARGET = { min: 28, touch: 44 } as const;
// Every right-to-left language the mobile app ships (`RTL_LANGUAGES` in
// `apps/mobile/src/i18n/languages.ts`), plus `iw`, the legacy tag a device may
// still report for Hebrew. A language missing here reads as left-to-right, which
// breaks two consumers: `runMatrix` skips the left-to-right fallback for a run
// whose baseline app language is that language, so every left-to-right cell
// reports `env-mismatch` instead of measuring, and `scan --source uiautomator`
// labels that language's screenshots left-to-right.
const RTL_LANGUAGES: Record<string, true> = {
  ar: true,
  ckb: true,
  fa: true,
  he: true,
  iw: true,
  ps: true,
  ur: true,
};

export function isRtlLanguage(language: string): boolean {
  return RTL_LANGUAGES[language.toLowerCase().split(/[-_]/)[0] ?? ''] === true;
}

function cell(id: CellId): CellConfig {
  return {
    id,
    dark: id === 'dark',
    rtl: id === 'rtl' || id === 'rtl-compact',
    compact: id === 'compact' || id === 'rtl-compact',
    landscape: id === 'landscape',
    fontMax: id === 'font-max',
  };
}

const PRESETS: Record<Platform, Record<MatrixName, readonly CellId[]>> = {
  android: {
    base: ['base'],
    standard: ['base', 'dark', 'compact', 'rtl'],
    full: ['base', 'dark', 'compact', 'rtl', 'landscape', 'rtl-compact'],
  },
  ios: {
    base: ['base'],
    standard: ['base', 'dark', 'rtl'],
    full: ['base', 'dark', 'rtl'],
  },
};

/**
 * The widest window `--cell compact` accepts on iOS. An iPhone simulator's
 * display has one mode, so `simctl io screenConfig geometry` cannot shrink it
 * the way Android's `wm size` can; the compact cell is instead a *device*
 * choice, run on an SE/mini simulator, and the cell asserts the device really
 * is one. 380 dp clears the 375 pt SE and mini widths and refuses a 402 pt
 * iPhone 17 Pro.
 */
export const IOS_COMPACT_MAX_WIDTH_DP = 380;

/**
 * Device types a run may use for `--cell compact` on iOS (see
 * `IOS_COMPACT_MAX_WIDTH_DP`).
 */
export const IOS_COMPACT_DEVICE_TYPES: readonly string[] = [
  'com.apple.CoreSimulator.SimDeviceType.iPhone-SE-3rd-generation',
  'com.apple.CoreSimulator.SimDeviceType.iPhone-SE--2nd-generation-',
  'com.apple.CoreSimulator.SimDeviceType.iPhone-SE',
  'com.apple.CoreSimulator.SimDeviceType.iPhone-13-mini',
  'com.apple.CoreSimulator.SimDeviceType.iPhone-12-mini',
];

/**
 * Cells a run may add to its matrix with `--cell`, opt-in only: no preset holds
 * `font-max`, `compact` or `landscape`, so the default matrices keep font scale
 * at 1 and the portrait window of one device.
 *
 * iOS runs both cells, with a device-side difference from Android: landscape
 * rotates the simulator itself (`devicectl device orientation`, the BackBoard
 * path the Device ▸ Rotate Left menu drives) and fails when the display did not
 * flip, and compact is a smaller *device type* rather than a window size,
 * because an iPhone simulator's display has a single mode.
 */
export const OPTIONAL_CELLS: Record<Platform, readonly CellId[]> = {
  android: ['base', 'dark', 'compact', 'rtl', 'landscape', 'rtl-compact', 'font-max'],
  ios: ['base', 'dark', 'compact', 'rtl', 'landscape', 'font-max'],
};

/** Throws for a `--cell` the platform cannot run, before any device work. */
export function assertCellsSupported(platform: Platform, extra: readonly CellId[]): void {
  const unsupported = extra.filter(id => !OPTIONAL_CELLS[platform].includes(id));
  if (unsupported.length > 0) {
    throw new Error(
      `${platform} has no ${unsupported.join(', ')} cell; --cell takes ${OPTIONAL_CELLS[platform].join(', ')}`
    );
  }
}

export function matrixCells(
  platform: Platform,
  matrix: MatrixName,
  extra: readonly CellId[] = []
): CellConfig[] {
  assertCellsSupported(platform, extra);
  const ids = [...PRESETS[platform][matrix]];
  for (const id of extra) if (!ids.includes(id)) ids.push(id);
  return ids.map(cell);
}

export function compactSize(densityDpi: number): string {
  const scale = densityDpi / 160;
  return `${Math.round(COMPACT_WIDTH_DP * scale)}x${Math.round(COMPACT_HEIGHT_DP * scale)}`;
}

export function mirrorReference(config: CellConfig): CellId {
  return config.compact ? 'compact' : 'base';
}

/**
 * The window width a cell expects, in dp.
 *
 * Android's compact cell overrides the window to exactly 360 dp. iOS cannot:
 * an iPhone simulator's display has one mode, so compact is a smaller *device*
 * (see `IOS_COMPACT_MAX_WIDTH_DP`) and the expectation is the cap, not a
 * number — the window must fit inside a compact phone. Landscape expects the
 * base window's height as its width on both platforms, because a rotation
 * swaps the two.
 */
export function expectedWidth(
  config: CellConfig,
  baseWindow: ProbeEnv['window'] | undefined,
  platform: Platform = 'android'
): number | undefined {
  if (config.compact) {
    return platform === 'android' ? COMPACT_WIDTH_DP : IOS_COMPACT_MAX_WIDTH_DP;
  }
  if (baseWindow === undefined) return undefined;
  return config.landscape ? baseWindow.height : baseWindow.width;
}

export function envMismatches(
  config: CellConfig,
  env: ProbeEnv,
  baseWindow: ProbeEnv['window'] | undefined,
  language?: string,
  platform: Platform = 'android'
): string[] {
  const mismatches: string[] = [];
  const scheme = config.dark ? 'dark' : 'light';
  if (env.colorScheme !== scheme)
    mismatches.push(`colorScheme ${env.colorScheme}, expected ${scheme}`);
  if (env.isRTL !== config.rtl) mismatches.push(`isRTL ${env.isRTL}, expected ${config.rtl}`);
  if (config.fontMax ? !(env.fontScale > 1) : env.fontScale !== 1) {
    mismatches.push(`fontScale ${env.fontScale}, expected ${config.fontMax ? 'above 1' : 1}`);
  }
  if (language !== undefined && env.language !== language) {
    mismatches.push(`language ${env.language}, expected ${language}`);
  }
  const width = expectedWidth(config, baseWindow, platform);
  if (width !== undefined) {
    // iOS compact has no exact target: any phone at or below the cap is a
    // compact phone, and a bigger one is refused here even though the device
    // adapter already refused it before measuring.
    if (platform === 'ios' && config.compact) {
      if (env.window.width > width) {
        mismatches.push(`window width ${env.window.width} dp, expected at most ${width} dp`);
      }
    } else if (Math.abs(env.window.width - width) > WIDTH_TOLERANCE_DP) {
      mismatches.push(`window width ${env.window.width} dp, expected ${width} dp`);
    }
  }
  return mismatches;
}
