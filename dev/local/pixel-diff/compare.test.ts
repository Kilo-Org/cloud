import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { PNG } from 'pngjs';

import { comparePngPair, LIMITS, PixelDiffError } from './compare';

/** A flat image with an optional solid rectangle painted into it. */
function image(
  width: number,
  height: number,
  rect?: { x: number; y: number; width: number; height: number }
): Buffer {
  const png = new PNG({ width, height });
  png.data.fill(255);
  if (rect) {
    for (let y = rect.y; y < rect.y + rect.height; y++) {
      for (let x = rect.x; x < rect.x + rect.width; x++) {
        const offset = (y * width + x) * 4;
        png.data[offset] = 0;
        png.data[offset + 1] = 0;
        png.data[offset + 2] = 0;
      }
    }
  }
  return PNG.sync.write(png, { colorType: 6 });
}

async function withOut(run: (out: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pixel-diff-'));
  try {
    await run(path.join(root, 'nested', 'cell'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

void test('a byte-identical pair reports nothing changed and keeps only the comparison PNG', async () => {
  await withOut(async out => {
    const shot = image(120, 80, { x: 10, y: 10, width: 20, height: 10 });
    const report = await comparePngPair({ before: shot, after: shot, out });
    assert.equal(report.changed, false);
    assert.equal(report.changedPixels, 0);
    assert.equal(report.changedPercent, 0);
    assert.deepEqual(report.regions, []);
    assert.deepEqual(report.artifacts, { comparison: 'comparison.png' });
    assert.equal(report.shift, undefined);
    assert.equal(report.width, 120);
    assert.equal(report.height, 80);
    assert.ok((await stat(path.join(out, 'comparison.png'))).size > 0);
    await assert.rejects(stat(path.join(out, 'focus.png')), /ENOENT/);
  });
});

void test('a known patch is counted exactly, boxed, and gets one focus crop', async () => {
  await withOut(async out => {
    const before = image(900, 700);
    const after = image(900, 700, { x: 40, y: 30, width: 24, height: 12 });
    const report = await comparePngPair({ before, after, out });
    assert.equal(report.changed, true);
    assert.equal(report.changedPixels, 24 * 12);
    assert.ok(Math.abs(report.changedPercent - (24 * 12 * 100) / (900 * 700)) < 1e-9);
    assert.equal(report.regions.length, 1);
    const [region] = report.regions;
    assert.ok(
      region.x <= 40 && region.y <= 30,
      `region starts at or before the patch: ${JSON.stringify(region)}`
    );
    assert.ok(region.x + region.width >= 64 && region.y + region.height >= 42);
    assert.deepEqual(report.artifacts, { comparison: 'comparison.png', focus: 'focus.png' });
    await assert.rejects(stat(path.join(out, 'nope.png')), /ENOENT/);
    assert.ok((await readFile(path.join(out, 'focus.png'))).length > 0);
  });
});

void test('chrome bands are counted separately and mask nothing', async () => {
  await withOut(async out => {
    const before = image(100, 100);
    const after = image(100, 100, { x: 10, y: 2, width: 5, height: 4 });
    const report = await comparePngPair({
      before,
      after,
      out,
      chrome: { top: 20, bottom: 10 },
    });
    assert.equal(report.changedPixels, 20);
    assert.equal(report.regions[0].y, 0);
    assert.deepEqual(report.chrome, {
      top: { height: 20, changedPixels: 20 },
      bottom: { height: 10, changedPixels: 0 },
    });
  });
});

void test('shift explanation reports moved rows without changing the canonical count', async () => {
  await withOut(async out => {
    // A page whose content block moves down 40 px, the way a taller hero pushes sections below.
    // Each content row carries a unique marker so row alignment has real anchors.
    const width = 160;
    const height = 240;
    const content = (row: number) => {
      const png = new PNG({ width, height });
      png.data.fill(255);
      const markerX = 10 + (row % 140);
      for (let x = 0; x < width; x++) {
        if ((x * 7 + row * 13) % 23 >= 3) continue;
        const offset = (row * width + x) * 4;
        png.data[offset] = 0;
        png.data[offset + 1] = 0;
        png.data[offset + 2] = 0;
      }
      for (let x = markerX; x < markerX + 4; x++) {
        const offset = (row * width + x) * 4;
        png.data[offset] = 0;
        png.data[offset + 1] = 0;
        png.data[offset + 2] = 0;
      }
      return png;
    };
    const page = (top: number) => {
      const png = new PNG({ width, height });
      png.data.fill(255);
      for (let row = 0; row < 160; row++) {
        const line = content(row);
        const target = top + row;
        line.data.copy(png.data, target * width * 4, row * width * 4, (row + 1) * width * 4);
      }
      return PNG.sync.write(png, { colorType: 6 });
    };
    const before = page(40);
    const after = page(80);
    const plain = await comparePngPair({ before, after, out: path.join(out, 'plain') });
    const explained = await comparePngPair({
      before,
      after,
      out: path.join(out, 'explained'),
      explainShift: true,
    });
    assert.ok(plain.changedPixels > 0);
    assert.equal(explained.changedPixels, plain.changedPixels);
    assert.deepEqual(explained.regions, plain.regions);
    assert.ok(explained.shift, 'moved rows are reported');
    assert.ok(
      explained.shift.blocks.some(block => block.dy === 40),
      JSON.stringify(explained.shift.blocks)
    );
    assert.equal(plain.shift, undefined);
  });
});

void test('unequal dimensions throw a size-mismatch instead of comparing padded images', async () => {
  await withOut(async out => {
    await assert.rejects(
      comparePngPair({ before: image(10, 10), after: image(10, 11), out }),
      (error: unknown) => error instanceof PixelDiffError && error.code === 'size-mismatch'
    );
  });
});

void test('an oversized PNG is refused from its header before decoding', async () => {
  await withOut(async out => {
    const header = image(4, 4).subarray(0, 33);
    const oversized = Buffer.from(header);
    oversized.writeUInt32BE(LIMITS.maxInputSide + 1, 16);
    await assert.rejects(
      comparePngPair({ before: oversized, after: oversized, out }),
      (error: unknown) => error instanceof PixelDiffError && error.code === 'limit'
    );
  });
});

void test('undecodable input throws a decode error rather than reporting unchanged', async () => {
  await withOut(async out => {
    const broken = Buffer.from('not a png at all, definitely');
    await assert.rejects(
      comparePngPair({ before: broken, after: broken, out }),
      (error: unknown) => error instanceof PixelDiffError && error.code === 'decode'
    );
  });
});

void test('a device pixel ratio outside the supported range is refused', async () => {
  await withOut(async out => {
    const shot = image(20, 20);
    for (const scale of [0, 0.1, LIMITS.minScale - 0.01, LIMITS.maxScale + 0.01, Number.NaN]) {
      await assert.rejects(
        comparePngPair({ before: shot, after: shot, out: path.join(out, String(scale)), scale }),
        (error: unknown) => error instanceof PixelDiffError && error.code === 'limit',
        `scale ${scale} is refused`
      );
    }
  });
});

void test('a tall capture keeps every coordinate but bounds the written comparison image', async () => {
  await withOut(async out => {
    const width = 1200;
    const height = 3200;
    const before = image(width, height);
    const after = image(width, height, { x: 600, y: 2400, width: 40, height: 20 });
    const report = await comparePngPair({ before, after, out });
    assert.equal(report.width, width);
    assert.equal(report.height, height);
    assert.equal(report.changedPixels, 40 * 20);
    const [region] = report.regions;
    assert.ok(
      region.x <= 600 &&
        region.y <= 2400 &&
        region.x + region.width >= 640 &&
        region.y + region.height >= 2420,
      `region covers the patch: ${JSON.stringify(region)}`
    );
    const written = PNG.sync.read(await readFile(path.join(out, 'comparison.png')));
    assert.ok(
      written.width <= LIMITS.maxOutputSide && written.height <= LIMITS.maxOutputSide,
      `composite is ${written.width}x${written.height}, above the ${LIMITS.maxOutputSide} px bound`
    );
  });
});
