// Adapted from imuratalpay/ui-diff (MIT) at
// 3075b4c8bbbf1a352404829f84f64c26cba291e5, skills/ui-diff/src/diff.ts.
// Only the comparator path is taken: fixed-coordinate pixel comparison, region grouping,
// focus cropping and the before/after/diff composite. Capture, publishing, masking and the
// alignment-driven count are not part of this module. See LICENSE-UI-DIFF in this directory.
import pixelmatch from 'pixelmatch';
import type { PNG } from 'pngjs';

import { shiftedBlocks, type RowBlock } from './align';
import {
  clampBox,
  COLORS,
  composeRow,
  crop,
  fadeToGray,
  fillRect,
  fitWithinBox,
  intersects,
  strokeRect,
  unionBox,
  type Box,
} from './image';

/** Matching threshold for pixelmatch: the maximum OKLab HyAB distance two pixels may differ by. */
export const THRESHOLD = 0.1;

/**
 * Most changed regions a comparison reports. Past this, further disjoint regions are counted
 * but not boxed, and `regionsTruncated` says so; the changed pixel count stays exact.
 */
export const MAX_REGIONS = 200;

/** A fixed-coordinate comparison of two same-sized PNGs. */
export type DiffOutcome = {
  width: number;
  height: number;
  changedPixels: number;
  /** Up to `MAX_REGIONS` boxes, largest first. */
  regions: Box[];
  /** True when more than `MAX_REGIONS` disjoint regions changed; `regions` is then partial. */
  regionsTruncated: boolean;
  /** One byte per pixel: 1 where the comparison found a changed pixel. */
  mask: Uint8Array;
  /** Faded "after" image with changed pixels highlighted and regions outlined. */
  diffImage: PNG;
};

function area(box: Box): number {
  return box.width * box.height;
}

/**
 * Merges boxes that touch or sit within `gap` px of each other, transitively, keeping at most
 * `cap` regions.
 *
 * The all-pairs version is quadratic in the number of components, which a noisy capture makes
 * visible: a page of thousands of disjoint changed cells spends its whole budget proving that
 * far-apart boxes do not touch. Grouping here is size ordered (largest region first) and the
 * working set is capped, so each incoming box is tested against at most `cap` regions — linear
 * in the component count for a fixed cap. Each box absorbs every region it reaches, and the
 * union then absorbs whatever it now reaches, so the nearby merge is complete within the cap.
 *
 * A box that reaches no region while the cap is full is dropped from the boxes and reported
 * through `truncated`. The changed pixel count is unaffected either way: it comes from the pixel
 * comparison, and the boxes only explain where those pixels are.
 */
function mergeBoxes(
  input: Box[],
  gap: number,
  cap: number
): { regions: Box[]; truncated: boolean } {
  const boxes = input.slice().sort((left, right) => area(right) - area(left));
  const regions: Box[] = [];
  let truncated = false;
  for (const box of boxes) {
    let merged = box;
    for (;;) {
      const index = regions.findIndex(region => intersects(merged, region, gap));
      if (index < 0) break;
      merged = unionBox(regions[index], merged);
      regions.splice(index, 1);
    }
    if (regions.length >= cap) {
      truncated = true;
      continue;
    }
    regions.push(merged);
  }
  return { regions, truncated };
}

/**
 * Groups changed pixels into rectangles: a coarse grid, 8-connected components, then proximity
 * merging capped at `cap` boxes.
 */
function findRegions(
  mask: Uint8Array,
  width: number,
  height: number,
  cell: number,
  gap: number,
  cap: number
): { regions: Box[]; truncated: boolean } {
  const cols = Math.ceil(width / cell);
  const rows = Math.ceil(height / cell);
  const hot = new Uint8Array(cols * rows);
  for (let y = 0; y < height; y++) {
    const rowOffset = ((y / cell) | 0) * cols;
    const base = y * width;
    for (let x = 0; x < width; x++) if (mask[base + x]) hot[rowOffset + ((x / cell) | 0)] = 1;
  }
  const seen = new Uint8Array(cols * rows);
  const boxes: Box[] = [];
  const stack: number[] = [];
  for (let start = 0; start < hot.length; start++) {
    if (!hot[start] || seen[start]) continue;
    let minC = cols;
    let maxC = -1;
    let minR = rows;
    let maxR = -1;
    stack.push(start);
    seen[start] = 1;
    while (stack.length > 0) {
      const idx = stack.pop() as number;
      const r = (idx / cols) | 0;
      const c = idx - r * cols;
      if (c < minC) minC = c;
      if (c > maxC) maxC = c;
      if (r < minR) minR = r;
      if (r > maxR) maxR = r;
      for (let dr = -1; dr <= 1; dr++) {
        const nr = r + dr;
        if (nr < 0 || nr >= rows) continue;
        for (let dc = -1; dc <= 1; dc++) {
          const nc = c + dc;
          if (nc < 0 || nc >= cols) continue;
          const n = nr * cols + nc;
          if (hot[n] && !seen[n]) {
            seen[n] = 1;
            stack.push(n);
          }
        }
      }
    }
    boxes.push(
      clampBox(
        {
          x: minC * cell,
          y: minR * cell,
          width: (maxC - minC + 1) * cell,
          height: (maxR - minR + 1) * cell,
        },
        width,
        height
      )
    );
  }
  const merged = mergeBoxes(boxes, gap, cap);
  return {
    regions: merged.regions.sort((left, right) => area(right) - area(left)),
    truncated: merged.truncated,
  };
}

/**
 * Compares two same-sized PNGs at fixed coordinates. Every pixel whose colour differs beyond
 * `THRESHOLD` counts once; anti-aliased pixels are excluded, as upstream does.
 *
 * Reject unequal dimensions even when the caller does not use the PNG pair wrapper.
 */
export function diffPngs(before: PNG, after: PNG, scale: number): DiffOutcome {
  if (before.width !== after.width || before.height !== after.height) {
    const sizes = `${before.width}x${before.height} and ${after.width}x${after.height}`;
    throw new Error(`diffPngs needs same-sized images, got ${sizes}`);
  }
  const width = before.width;
  const height = before.height;
  const overlay = new Uint8Array(width * height * 4);
  const changedPixels = pixelmatch(before.data, after.data, overlay, width, height, {
    threshold: THRESHOLD,
    includeAA: false,
    diffMask: true,
    diffColor: [255, 0, 0],
  });
  const mask = new Uint8Array(width * height);
  for (let i = 0; i < mask.length; i++) mask[i] = overlay[i * 4 + 3] > 0 ? 1 : 0;

  const cell = Math.max(1, Math.round(8 * scale));
  const gap = Math.max(1, Math.round(24 * scale));
  const grouped =
    changedPixels === 0
      ? { regions: [] as Box[], truncated: false }
      : findRegions(mask, width, height, cell, gap, MAX_REGIONS);

  const diffImage = fadeToGray(after, 0.28);
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue;
    const offset = i * 4;
    diffImage.data[offset] = COLORS.highlight[0];
    diffImage.data[offset + 1] = COLORS.highlight[1];
    diffImage.data[offset + 2] = COLORS.highlight[2];
    diffImage.data[offset + 3] = 255;
  }
  const stroke = Math.max(1, Math.round(2 * scale));
  for (const region of grouped.regions) strokeRect(diffImage, region, COLORS.highlight, stroke);
  return {
    width,
    height,
    changedPixels,
    regions: grouped.regions,
    regionsTruncated: grouped.truncated,
    mask,
    diffImage,
  };
}

/** Marks vertically moved content on the left edge of the diff panel. Decoration only. */
export function markShiftedRuns(diffImage: PNG, blocks: RowBlock[], scale: number): void {
  const bandWidth = Math.max(3, Math.round(3 * scale));
  for (const block of blocks) {
    fillRect(
      diffImage,
      clampBox(
        { x: 0, y: block.afterY, width: bandWidth, height: block.height },
        diffImage.width,
        diffImage.height
      ),
      COLORS.shift
    );
  }
}

/**
 * Picks up to `max` crop boxes around the largest changed regions, padded and grown to a
 * readable minimum size. Returns [] when the change covers most of the page anyway.
 */
export function focusBoxes(
  regions: Box[],
  width: number,
  height: number,
  opts: { max: number; padding: number; scale: number }
): Box[] {
  if (opts.max === 0 || regions.length === 0) return [];
  const minW = Math.min(width, Math.round(420 * opts.scale));
  const minH = Math.min(height, Math.round(220 * opts.scale));
  const grown = regions.map(region => {
    let box = {
      x: region.x - opts.padding,
      y: region.y - opts.padding,
      width: region.width + 2 * opts.padding,
      height: region.height + 2 * opts.padding,
    };
    if (box.width < minW) box = { ...box, x: box.x - (minW - box.width) / 2, width: minW };
    if (box.height < minH) box = { ...box, y: box.y - (minH - box.height) / 2, height: minH };
    if (box.x < 0) box.x = 0;
    if (box.y < 0) box.y = 0;
    if (box.x + box.width > width) box.x = Math.max(0, width - box.width);
    if (box.y + box.height > height) box.y = Math.max(0, height - box.height);
    return clampBox(box, width, height);
  });
  // At most MAX_REGIONS arrive here; cap at their count so nothing is dropped.
  const merged = mergeBoxes(grown, 0, grown.length).regions.sort(
    (left, right) => area(right) - area(left)
  );
  const picked = merged.slice(0, opts.max);
  if (picked.length === 1 && area(picked[0]) > 0.7 * width * height) return [];
  return picked;
}

export type ComparePanels = {
  before: PNG;
  after: PNG;
  diffImage: PNG;
};

/**
 * Places before, after and diff side by side, optionally around one crop box.
 *
 * The panels are shrunk to the output budget BEFORE the composite is allocated, so a tall
 * page cannot build a full-resolution triptych on the way to a bounded artifact. The report's
 * coordinates stay in original pixels; only the review image is scaled.
 */
export function composeCompare(
  panels: ComparePanels,
  labels: { before: string; after: string; diff: string },
  opts: { box?: Box; maxSide: number }
): PNG {
  const cut = (image: PNG) => (opts.box ? crop(image, opts.box) : image);
  const panelsIn = [cut(panels.before), cut(panels.after), cut(panels.diffImage)];
  // Room for the gaps, the outer padding and the label header, at any compose scale.
  const overhead = Math.round(opts.maxSide * 0.06);
  const budgetWidth = Math.max(1, Math.floor((opts.maxSide - overhead) / panelsIn.length));
  const budgetHeight = Math.max(1, opts.maxSide - overhead);
  const [before, after, diffImage] = panelsIn.map(image =>
    fitWithinBox(image, budgetWidth, budgetHeight)
  );
  return composeRow([
    { image: before, label: labels.before, accent: COLORS.before },
    { image: after, label: labels.after, accent: COLORS.after },
    { image: diffImage, label: labels.diff, accent: COLORS.diff },
  ]);
}

export { shiftedBlocks };
