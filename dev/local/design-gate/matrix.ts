import type { ProbeEnv } from './tree';

export type Platform = 'android' | 'ios';
export type MatrixName = 'base' | 'standard' | 'full';
export type CellId = 'base' | 'dark' | 'compact' | 'landscape' | 'rtl' | 'rtl-compact';

export type CellConfig = Readonly<{
  id: CellId;
  dark: boolean;
  rtl: boolean;
  compact: boolean;
  landscape: boolean;
}>;

export const MATRIX_NAMES: readonly MatrixName[] = ['base', 'standard', 'full'];
export const COMPACT_WIDTH_DP = 360;
const COMPACT_HEIGHT_DP = 640;
const WIDTH_TOLERANCE_DP = 2;
export const TAP_TARGET = { min: 28, touch: 44 } as const;
const RTL_LANGUAGES: Record<string, true> = { ar: true, fa: true, he: true, iw: true, ur: true };

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

export function matrixCells(platform: Platform, matrix: MatrixName): CellConfig[] {
  return PRESETS[platform][matrix].map(cell);
}

export function compactSize(densityDpi: number): string {
  const scale = densityDpi / 160;
  return `${Math.round(COMPACT_WIDTH_DP * scale)}x${Math.round(COMPACT_HEIGHT_DP * scale)}`;
}

export function mirrorReference(config: CellConfig): CellId {
  return config.compact ? 'compact' : 'base';
}

export function expectedWidth(
  config: CellConfig,
  baseWindow: ProbeEnv['window'] | undefined
): number | undefined {
  if (config.compact) return COMPACT_WIDTH_DP;
  if (baseWindow === undefined) return undefined;
  return config.landscape ? baseWindow.height : baseWindow.width;
}

export function envMismatches(
  config: CellConfig,
  env: ProbeEnv,
  baseWindow: ProbeEnv['window'] | undefined,
  language?: string
): string[] {
  const mismatches: string[] = [];
  const scheme = config.dark ? 'dark' : 'light';
  if (env.colorScheme !== scheme)
    mismatches.push(`colorScheme ${env.colorScheme}, expected ${scheme}`);
  if (env.isRTL !== config.rtl) mismatches.push(`isRTL ${env.isRTL}, expected ${config.rtl}`);
  if (env.fontScale !== 1) mismatches.push(`fontScale ${env.fontScale}, expected 1`);
  if (language !== undefined && env.language !== language) {
    mismatches.push(`language ${env.language}, expected ${language}`);
  }
  const width = expectedWidth(config, baseWindow);
  if (width !== undefined && Math.abs(env.window.width - width) > WIDTH_TOLERANCE_DP) {
    mismatches.push(`window width ${env.window.width} dp, expected ${width} dp`);
  }
  return mismatches;
}
