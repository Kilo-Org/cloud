// Public comparison entry point for prepared UI screenshot pairs.
//
// The comparison core is adapted from imuratalpay/ui-diff (MIT) at
// 3075b4c8bbbf1a352404829f84f64c26cba291e5; see LICENSE-UI-DIFF in this directory.
// Only the comparator is taken: no capture, no publisher, no network, no masking.
//
// Contract:
//  - `changedPixels`, `changed`, `changedPercent` and `regions` always come from the
//    fixed-coordinate comparison. The optional row-shift explanation never replaces them.
//  - `chrome` bands are physical-pixel heights measured from the image edges. Their counts are
//    reported separately and mask nothing.
//  - A failed comparison throws `PixelDiffError`; it never returns a zeroed report, so a caller
//    can mark its cell inconclusive instead of trusting a fabricated "unchanged".
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { PNG } from 'pngjs';

import { alignRows, shiftedBlocks } from './align';
import { composeCompare, diffPngs, focusBoxes, markShiftedRuns } from './diff';
import { decodePng, encodePng } from './image';

/** A recorded region of changed pixels, in physical pixels, relative to the image origin. */
export type PixelBox = { x: number; y: number; width: number; height: number };

/** One already-decoded image plus the buffers kept for the composite. */
export type PixelDiffReport = {
  /** Physical-pixel size of the compared images. Both inputs must agree. */
  width: number;
  height: number;
  /** Fixed-coordinate changed pixel count. */
  changedPixels: number;
  /** `changedPixels` as a percentage of the image area, 0..100. */
  changedPercent: number;
  changed: boolean;
  /** Changed regions, largest first, in physical pixels. */
  regions: PixelBox[];
  /** Artifact file names relative to `out`; the comparison composite is always written. */
  artifacts: { comparison: string; focus?: string };
  /** Vertical movement explanation, present only when `explainShift` found moved rows. */
  shift?: {
    blocks: { beforeY: number; afterY: number; height: number; dy: number }[];
    removedRows: number;
  };
  /** Changed pixels inside the requested top and bottom chrome bands. */
  chrome?: {
    top: { height: number; changedPixels: number };
    bottom: { height: number; changedPixels: number };
  };
};

export type PixelDiffErrorCode = 'decode' | 'size-mismatch' | 'limit' | 'write';

export class PixelDiffError extends Error {
  readonly code: PixelDiffErrorCode;

  constructor(code: PixelDiffErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'PixelDiffError';
    this.code = code;
  }
}

/** Hard bounds that keep a hostile or accidental screenshot from exhausting memory. */
export const LIMITS = {
  /** Longest accepted input side, physical pixels. */
  maxInputSide: 8192,
  /** Largest accepted input area, physical pixels. */
  maxInputPixels: 20_000_000,
  /** Longest output-composite side, physical pixels. */
  maxOutputSide: 2400,
  /** Smallest accepted device pixel ratio. */
  minScale: 0.5,
  /** Largest accepted device pixel ratio. */
  maxScale: 8,
} as const;

export type ComparePngPairInput = {
  before: Buffer;
  after: Buffer;
  /** Unique caller-owned output directory; created recursively when missing. */
  out: string;
  /** Device pixel ratio. Widens region grouping and the focus crop; never changes counts. */
  scale?: number;
  /** Explain vertical movement by matching rows. The fixed-coordinate count is unaffected. */
  explainShift?: boolean;
  /**
   * Physical-pixel heights of the top and bottom system chrome, counted separately.
   * Bands are measured from the image edges and mask nothing, so they must not overlap:
   * a pair whose `top + bottom` exceeds the image height counts the shared rows twice.
   */
  chrome?: { top: number; bottom: number };
};

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Reads the IHDR size without inflating the image, so an oversized PNG is refused before decoding. */
function readPngSize(buffer: Buffer, side: 'before' | 'after'): { width: number; height: number } {
  if (
    buffer.length < 24 ||
    !buffer.subarray(0, 8).equals(PNG_SIGNATURE) ||
    buffer.toString('latin1', 12, 16) !== 'IHDR'
  ) {
    throw new PixelDiffError('decode', `${side} is not a PNG`);
  }
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  if (width === 0 || height === 0)
    throw new PixelDiffError('decode', `${side} declares an empty image`);
  if (
    width > LIMITS.maxInputSide ||
    height > LIMITS.maxInputSide ||
    width * height > LIMITS.maxInputPixels
  ) {
    throw new PixelDiffError(
      'limit',
      `${side} is ${width}x${height}, above the ${LIMITS.maxInputSide} px side / ${LIMITS.maxInputPixels} px area limit`
    );
  }
  return { width, height };
}

function decode(buffer: Buffer, side: 'before' | 'after'): PNG {
  try {
    return decodePng(buffer);
  } catch (error) {
    throw new PixelDiffError('decode', `${side} PNG could not be decoded`, { cause: error });
  }
}

function chromeBand(mask: Uint8Array, width: number, startRow: number, rows: number): number {
  let changed = 0;
  for (let index = startRow * width; index < (startRow + rows) * width; index++)
    changed += mask[index];
  return changed;
}

/**
 * Compares two prepared screenshots and writes the review artifacts.
 *
 * The comparison composite (`comparison.png`) is always written. At most one bounded focus
 * crop (`focus.png`) is added, and only when a small changed region makes a crop useful.
 */
export async function comparePngPair(input: ComparePngPairInput): Promise<PixelDiffReport> {
  const scale = input.scale ?? 1;
  if (!Number.isFinite(scale) || scale < LIMITS.minScale || scale > LIMITS.maxScale) {
    throw new PixelDiffError(
      'limit',
      `scale must be a device pixel ratio between ${LIMITS.minScale} and ${LIMITS.maxScale}, got ${scale}`
    );
  }

  const beforeSize = readPngSize(input.before, 'before');
  const afterSize = readPngSize(input.after, 'after');
  if (beforeSize.width !== afterSize.width || beforeSize.height !== afterSize.height) {
    throw new PixelDiffError(
      'size-mismatch',
      `before is ${beforeSize.width}x${beforeSize.height}, after is ${afterSize.width}x${afterSize.height}`
    );
  }

  const before = decode(input.before, 'before');
  const after = decode(input.after, 'after');
  const comparison = diffPngs(before, after, scale);

  let shift: PixelDiffReport['shift'];
  if (input.explainShift) {
    const alignment = alignRows(before, after);
    const blocks = shiftedBlocks(alignment.blocks, Math.max(4, Math.round(4 * scale)));
    const removedRows = alignment.removed.reduce((total, gap) => total + gap.rows, 0);
    if (blocks.length > 0) shift = { blocks, removedRows };
    markShiftedRuns(comparison.diffImage, blocks, scale);
  }

  const labels = { before: 'before', after: 'after', diff: 'diff' };
  const panels = { before, after, diffImage: comparison.diffImage };
  const maxSide = LIMITS.maxOutputSide;
  const composite = composeCompare(panels, labels, { maxSide });

  const focusRegion = focusBoxes(comparison.regions, before.width, before.height, {
    max: 1,
    padding: Math.round(32 * scale),
    scale,
  })[0];

  try {
    await mkdir(input.out, { recursive: true });
    await writeFile(path.join(input.out, 'comparison.png'), encodePng(composite));
    if (focusRegion) {
      const focus = composeCompare(panels, labels, { box: focusRegion, maxSide });
      await writeFile(path.join(input.out, 'focus.png'), encodePng(focus));
    }
  } catch (error) {
    throw new PixelDiffError('write', `could not write artifacts under ${input.out}`, {
      cause: error,
    });
  }

  const report: PixelDiffReport = {
    width: before.width,
    height: before.height,
    changedPixels: comparison.changedPixels,
    changedPercent: (comparison.changedPixels / (before.width * before.height)) * 100,
    changed: comparison.changedPixels > 0,
    regions: comparison.regions,
    artifacts: focusRegion
      ? { comparison: 'comparison.png', focus: 'focus.png' }
      : { comparison: 'comparison.png' },
  };
  if (shift) report.shift = shift;
  if (input.chrome) {
    const top = Math.min(Math.max(0, Math.round(input.chrome.top)), before.height);
    const bottom = Math.min(Math.max(0, Math.round(input.chrome.bottom)), before.height);
    report.chrome = {
      top: { height: top, changedPixels: chromeBand(comparison.mask, before.width, 0, top) },
      bottom: {
        height: bottom,
        changedPixels: chromeBand(comparison.mask, before.width, before.height - bottom, bottom),
      },
    };
  }
  return report;
}
