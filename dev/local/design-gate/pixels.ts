import type { Exec } from './capture';
import type { Rect } from './findings';
import { INK_DISTANCE } from './rules/thresholds';

export type Rgba = { width: number; height: number; data: Uint8Array };

export function readRgba(pngPath: string, exec: Exec): Rgba {
  const size = exec('ffprobe', [
    '-v',
    'error',
    '-select_streams',
    'v:0',
    '-show_entries',
    'stream=width,height',
    '-of',
    'csv=p=0:s=x',
    pngPath,
  ])
    .toString()
    .trim();
  const match = /^(\d+)x(\d+)$/.exec(size);
  if (!match) throw new Error(`ffprobe returned an unexpected size for ${pngPath}: ${size}`);
  const width = Number(match[1]);
  const height = Number(match[2]);
  const raw = exec('ffmpeg', [
    '-v',
    'error',
    '-i',
    pngPath,
    '-f',
    'rawvideo',
    '-pix_fmt',
    'rgba',
    '-',
  ]);
  if (raw.length !== width * height * 4) {
    throw new Error(
      `ffmpeg returned ${raw.length} bytes for a ${width}x${height} image: ${pngPath}`
    );
  }
  return { width, height, data: new Uint8Array(raw.buffer, raw.byteOffset, raw.length) };
}

export type InkBox = { bounds: Rect; box: Rect; background: number; coverage: number };

function colorAt(image: Rgba, x: number, y: number): number {
  const offset = (y * image.width + x) * 4;
  return (image.data[offset] << 16) | (image.data[offset + 1] << 8) | image.data[offset + 2];
}

function distance(a: number, b: number): number {
  const dr = ((a >> 16) & 255) - ((b >> 16) & 255);
  const dg = ((a >> 8) & 255) - ((b >> 8) & 255);
  const db = (a & 255) - (b & 255);
  return Math.sqrt(dr * dr + dg * dg + db * db);
}

/**
 * Ink bounding box inside `rectPx` shrunk by `insetPx`. Background is the most common color of the
 * 1 px ring just inside the shrunk box; ink is every pixel farther than INK_DISTANCE from it.
 * Corner squares of `cornerPx` are ignored so rounded corners do not count as ink.
 * Returns undefined when the shrunk box is empty or has no ink.
 */
export function inkBox(
  image: Rgba,
  rectPx: Rect,
  insetPx: number,
  cornerPx = 0
): InkBox | undefined {
  const x0 = Math.max(0, Math.round(rectPx[0] + insetPx));
  const y0 = Math.max(0, Math.round(rectPx[1] + insetPx));
  const x1 = Math.min(image.width, Math.round(rectPx[0] + rectPx[2] - insetPx));
  const y1 = Math.min(image.height, Math.round(rectPx[1] + rectPx[3] - insetPx));
  if (x1 - x0 < 3 || y1 - y0 < 3) return undefined;

  const counts = new Map<number, number>();
  const count = (x: number, y: number) => {
    const color = colorAt(image, x, y);
    counts.set(color, (counts.get(color) ?? 0) + 1);
  };
  for (let x = x0; x < x1; x++) {
    count(x, y0);
    count(x, y1 - 1);
  }
  for (let y = y0 + 1; y < y1 - 1; y++) {
    count(x0, y);
    count(x1 - 1, y);
  }
  let background = 0;
  let best = -1;
  for (const [color, n] of counts) {
    if (n > best) {
      best = n;
      background = color;
    }
  }

  const corner = Math.max(0, Math.round(cornerPx - insetPx));
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let ink = 0;
  let area = 0;
  for (let y = y0; y < y1; y++) {
    const inCornerRow = y < y0 + corner || y >= y1 - corner;
    for (let x = x0; x < x1; x++) {
      if (inCornerRow && (x < x0 + corner || x >= x1 - corner)) continue;
      area++;
      if (distance(colorAt(image, x, y), background) <= INK_DISTANCE) continue;
      ink++;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }
  if (ink === 0) return undefined;
  return {
    bounds: [x0, y0, x1 - x0, y1 - y0],
    box: [minX, minY, maxX - minX + 1, maxY - minY + 1],
    background,
    coverage: ink / area,
  };
}
