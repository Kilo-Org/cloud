// Adapted from imuratalpay/ui-diff (MIT) at
// 3075b4c8bbbf1a352404829f84f64c26cba291e5, skills/ui-diff/src/image.ts.
// Capture, publishing and the text renderer's original callers are not taken; only the
// image helpers the comparison needs. See LICENSE-UI-DIFF in this directory.
import { PNG } from 'pngjs';

import { drawText, fitText, GLYPH_HEIGHT } from './font';

export type RGBA = [number, number, number, number];

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function decodePng(buffer: Buffer): PNG {
  return PNG.sync.read(buffer);
}

export function encodePng(png: PNG): Buffer {
  return PNG.sync.write(png, { colorType: 6, deflateLevel: 6 });
}

export function createImage(width: number, height: number, fill: RGBA): PNG {
  const png = new PNG({
    width: Math.max(1, Math.round(width)),
    height: Math.max(1, Math.round(height)),
  });
  const { data } = png;
  for (let i = 0; i < data.length; i += 4) {
    data[i] = fill[0];
    data[i + 1] = fill[1];
    data[i + 2] = fill[2];
    data[i + 3] = fill[3];
  }
  return png;
}

/** Copies a region of `src` into `dst` at (dx, dy), clipped to both images. */
export function blit(
  src: PNG,
  dst: PNG,
  dx: number,
  dy: number,
  sx = 0,
  sy = 0,
  w = src.width - sx,
  h = src.height - sy
): void {
  let x0 = Math.round(sx);
  let y0 = Math.round(sy);
  let tx = Math.round(dx);
  let ty = Math.round(dy);
  const x1 = Math.min(x0 + Math.round(w), src.width);
  const y1 = Math.min(y0 + Math.round(h), src.height);
  if (x0 < 0) {
    tx -= x0;
    x0 = 0;
  }
  if (y0 < 0) {
    ty -= y0;
    y0 = 0;
  }
  if (tx < 0) {
    x0 -= tx;
    tx = 0;
  }
  if (ty < 0) {
    y0 -= ty;
    ty = 0;
  }
  const width = Math.min(x1 - x0, dst.width - tx);
  const height = Math.min(y1 - y0, dst.height - ty);
  if (width <= 0 || height <= 0) return;
  for (let row = 0; row < height; row++) {
    const s = ((y0 + row) * src.width + x0) * 4;
    const d = ((ty + row) * dst.width + tx) * 4;
    src.data.copy(dst.data, d, s, s + width * 4);
  }
}

export function clampBox(box: Box, width: number, height: number): Box {
  const x = Math.max(0, Math.min(width, Math.round(box.x)));
  const y = Math.max(0, Math.min(height, Math.round(box.y)));
  const right = Math.max(x, Math.min(width, Math.round(box.x + box.width)));
  const bottom = Math.max(y, Math.min(height, Math.round(box.y + box.height)));
  return { x, y, width: right - x, height: bottom - y };
}

export function unionBox(a: Box, b: Box): Box {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return {
    x,
    y,
    width: Math.max(a.x + a.width, b.x + b.width) - x,
    height: Math.max(a.y + a.height, b.y + b.height) - y,
  };
}

export function intersects(a: Box, b: Box, margin = 0): boolean {
  return (
    a.x - margin < b.x + b.width &&
    b.x - margin < a.x + a.width &&
    a.y - margin < b.y + b.height &&
    b.y - margin < a.y + a.height
  );
}

export function crop(src: PNG, box: Box): PNG {
  const out = createImage(box.width, box.height, COLORS.pad);
  blit(src, out, 0, 0, box.x, box.y, box.width, box.height);
  return out;
}

export function fillRect(png: PNG, box: Box, color: RGBA): void {
  const b = clampBox(box, png.width, png.height);
  const alpha = color[3] / 255;
  for (let y = b.y; y < b.y + b.height; y++) {
    for (let x = b.x; x < b.x + b.width; x++) {
      const i = (y * png.width + x) * 4;
      png.data[i] = Math.round(color[0] * alpha + png.data[i] * (1 - alpha));
      png.data[i + 1] = Math.round(color[1] * alpha + png.data[i + 1] * (1 - alpha));
      png.data[i + 2] = Math.round(color[2] * alpha + png.data[i + 2] * (1 - alpha));
      png.data[i + 3] = 255;
    }
  }
}

export function strokeRect(png: PNG, box: Box, color: RGBA, thickness: number): void {
  const t = Math.max(1, Math.round(thickness));
  fillRect(png, { x: box.x - t, y: box.y - t, width: box.width + 2 * t, height: t }, color);
  fillRect(
    png,
    { x: box.x - t, y: box.y + box.height, width: box.width + 2 * t, height: t },
    color
  );
  fillRect(png, { x: box.x, y: box.y, width: t, height: box.height }, color);
  fillRect(png, { x: box.x + box.width, y: box.y, width: t, height: box.height }, color);
}

/** Grayscale copy blended towards white, used as the backdrop of the diff panel. */
export function fadeToGray(src: PNG, keep = 0.3): PNG {
  const out = new PNG({ width: src.width, height: src.height });
  const { data } = src;
  for (let i = 0; i < data.length; i += 4) {
    const alpha = data[i + 3] / 255;
    const lum = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    const v = Math.round(255 - (255 - lum * alpha - 255 * (1 - alpha)) * keep);
    out.data[i] = v;
    out.data[i + 1] = v;
    out.data[i + 2] = v;
    out.data[i + 3] = 255;
  }
  return out;
}

/**
 * Shrinks to an exact size by area averaging, so a downscaled review image keeps thin strokes
 * visible. Every caller bounds an image instead of enlarging it, so growing is not supported.
 */
export function shrinkTo(src: PNG, width: number, height: number): PNG {
  const targetWidth = Math.max(1, Math.min(src.width, Math.round(width)));
  const targetHeight = Math.max(1, Math.min(src.height, Math.round(height)));
  if (targetWidth === src.width && targetHeight === src.height) return src;
  const out = new PNG({ width: targetWidth, height: targetHeight });
  const xRatio = src.width / targetWidth;
  const yRatio = src.height / targetHeight;
  for (let y = 0; y < targetHeight; y++) {
    const y0 = Math.floor(y * yRatio);
    const y1 = Math.max(y0 + 1, Math.min(src.height, Math.floor((y + 1) * yRatio)));
    for (let x = 0; x < targetWidth; x++) {
      const x0 = Math.floor(x * xRatio);
      const x1 = Math.max(x0 + 1, Math.min(src.width, Math.floor((x + 1) * xRatio)));
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let n = 0;
      for (let yy = y0; yy < y1; yy++) {
        let i = (yy * src.width + x0) * 4;
        for (let xx = x0; xx < x1; xx++, i += 4) {
          r += src.data[i];
          g += src.data[i + 1];
          b += src.data[i + 2];
          a += src.data[i + 3];
          n++;
        }
      }
      const o = (y * targetWidth + x) * 4;
      out.data[o] = Math.round(r / n);
      out.data[o + 1] = Math.round(g / n);
      out.data[o + 2] = Math.round(b / n);
      out.data[o + 3] = Math.round(a / n);
    }
  }
  return out;
}

/** Downscales `src` to fit inside both bounds; returns it unchanged when it already fits. */
export function fitWithinBox(src: PNG, maxWidth: number, maxHeight: number): PNG {
  const factor = Math.min(maxWidth / src.width, maxHeight / src.height, 1);
  if (factor >= 1) return src;
  return shrinkTo(
    src,
    Math.max(1, Math.round(src.width * factor)),
    Math.max(1, Math.round(src.height * factor))
  );
}

export interface Panel {
  image: PNG;
  label: string;
  accent: RGBA;
}

export interface ComposeOptions {
  /** Gap between panels, in output pixels; derived from the panel width when omitted. */
  gap?: number;
}

export const COLORS = {
  background: [243, 244, 246, 255] as RGBA,
  before: [75, 85, 99, 255] as RGBA,
  after: [22, 128, 61, 255] as RGBA,
  diff: [190, 24, 93, 255] as RGBA,
  text: [255, 255, 255, 255] as RGBA,
  pad: [229, 231, 235, 255] as RGBA,
  highlight: [255, 0, 128, 255] as RGBA,
  shift: [59, 130, 246, 255] as RGBA,
};

/** Places panels side by side, each under a labelled bar. Callers bound the panels first. */
export function composeRow(panels: Panel[], opts: ComposeOptions = {}): PNG {
  const widest = Math.max(...panels.map(panel => panel.image.width));
  const scale = Math.max(2, Math.min(8, Math.round(widest / 170)));
  const gap = opts.gap ?? Math.max(8, scale * 4);
  const padding = gap;
  const header = GLYPH_HEIGHT * scale + scale * 6;
  const width =
    padding * 2 +
    panels.reduce((sum, panel) => sum + panel.image.width, 0) +
    gap * (panels.length - 1);
  const height = padding * 2 + header + Math.max(...panels.map(panel => panel.image.height));
  const out = createImage(width, height, COLORS.background);
  let x = padding;
  for (const panel of panels) {
    fillRect(out, { x, y: padding, width: panel.image.width, height: header }, panel.accent);
    const label = fitText(panel.label, scale, panel.image.width - scale * 6);
    drawText(out, label, x + scale * 3, padding + scale * 3, scale, COLORS.text);
    blit(panel.image, out, x, padding + header);
    x += panel.image.width + gap;
  }
  return out;
}
