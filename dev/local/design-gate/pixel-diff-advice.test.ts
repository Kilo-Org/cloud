import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

import { PNG } from 'pngjs';

import {
  containedPath,
  pngSize,
  runPixelDiffAdvisory,
  type PixelComparator,
  type PixelDiffRevision,
} from './pixel-diff-advice';
import type { PixelDiffReport } from '../pixel-diff/compare';

/** A flat opaque image, with an optional black rectangle painted into it. */
function image(
  width: number,
  height: number,
  rect?: { x: number; y: number; width: number; height: number }
): Buffer {
  const png = new PNG({ width, height });
  png.data.fill(255);
  if (rect !== undefined) {
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

/**
 * A header-only PNG: enough for the size pre-check and for the receipt's digest.
 * The comparator is injected in every test here, so the pixels are never decoded.
 */
function pngBytes(width: number, height: number): Buffer {
  const header = Buffer.alloc(24);
  header.writeUInt32BE(0x89504e47, 0);
  header.writeUInt32BE(0x0d0a1a0a, 4);
  header.writeUInt32BE(13, 8);
  header.write('IHDR', 12, 'latin1');
  header.writeUInt32BE(width, 16);
  header.writeUInt32BE(height, 20);
  return header;
}

function dumpBytes(options: {
  pixelRatio?: number;
  windowHeight?: number;
  top?: number;
  bottom?: number;
  safeAreaKnown?: boolean;
}): Buffer {
  return Buffer.from(
    JSON.stringify({
      version: 1,
      env: {
        pixelRatio: options.pixelRatio ?? 2,
        window: { width: 400, height: options.windowHeight ?? 400 },
        safeArea: { top: options.top ?? 10, left: 0, right: 0, bottom: options.bottom ?? 5 },
        ...(options.safeAreaKnown === undefined ? {} : { safeAreaKnown: options.safeAreaKnown }),
      },
      nodes: [{ parent: -1, tag: 'View', rect: [0, 0, 400, 400] }],
    })
  );
}

const CONFIG = {
  id: 'base',
  dark: false,
  rtl: false,
  compact: false,
  landscape: false,
  fontMax: false,
};

type RunDir = {
  dir: string;
  revision: PixelDiffRevision;
  write: (relative: string, bytes: Buffer) => void;
};

function runDir(
  root: string,
  name: string,
  options: {
    cell?: string;
    target?: string;
    config?: unknown;
    screenshot?: { width: number; height: number };
    dump?: Parameters<typeof dumpBytes>[0];
    bind?: 'both' | 'none' | 'screenshot-only';
  } = {}
): RunDir {
  const dir = path.join(root, name);
  fs.mkdirSync(path.join(dir, 'cells'), { recursive: true });
  const cell = options.cell ?? 'base';
  const target = options.target ?? 'card';
  const screenshot = options.screenshot ?? { width: 400, height: 400 };
  const ratio = options.dump?.pixelRatio ?? 2;
  fs.writeFileSync(path.join(dir, 'cells.json'), '{}');
  fs.writeFileSync(
    path.join(dir, 'cells', `${cell}.${target}.png`),
    pngBytes(screenshot.width, screenshot.height)
  );
  fs.writeFileSync(
    path.join(dir, 'cells', `${cell}.${target}.json`),
    // The dump's window must describe the capture, or no chrome split is claimed.
    dumpBytes({ windowHeight: screenshot.height / ratio, ...options.dump })
  );
  const artifacts = ['cells.json'];
  if (options.bind !== 'none') {
    artifacts.push(`cells/${cell}.${target}.png`);
    if (options.bind !== 'screenshot-only') artifacts.push(`cells/${cell}.${target}.json`);
  }
  return {
    dir,
    revision: {
      dir,
      artifacts: artifacts.map(relative => ({
        path: relative,
        sha256: createHash('sha256')
          .update(fs.readFileSync(path.join(dir, relative)))
          .digest('hex'),
      })),
      cells: [
        {
          id: cell,
          config: options.config ?? CONFIG,
          screens: [
            {
              target,
              dump: `cells/${cell}.${target}.json`,
              screenshot: `cells/${cell}.${target}.png`,
            },
          ],
        },
      ],
      readiness: [],
    },
    write: (relative, bytes) => {
      fs.writeFileSync(path.join(dir, relative), bytes);
    },
  };
}

/**
 * Adds a receipt-bound target to a run, the way a real capture lists one: a PNG,
 * its dump, both digests in the receipt, and the screen under its cell.
 */
function bindScreen(run: RunDir, cell: string, target: string): void {
  const png = `cells/${cell}.${target}.png`;
  const dump = `cells/${cell}.${target}.json`;
  fs.writeFileSync(path.join(run.dir, png), pngBytes(400, 400));
  // The dump's window must describe the capture, exactly as `runDir` writes it.
  fs.writeFileSync(path.join(run.dir, dump), dumpBytes({ windowHeight: 200 }));
  for (const relative of [png, dump]) {
    run.revision.artifacts = [
      ...run.revision.artifacts,
      {
        path: relative,
        sha256: createHash('sha256')
          .update(fs.readFileSync(path.join(run.dir, relative)))
          .digest('hex'),
      },
    ];
  }
  const screen = { target, dump, screenshot: png };
  const existing = run.revision.cells.find(entry => entry.id === cell);
  run.revision.cells =
    existing === undefined
      ? [...run.revision.cells, { id: cell, config: CONFIG, screens: [screen] }]
      : run.revision.cells.map(entry =>
          entry.id === cell ? { ...entry, screens: [...entry.screens, screen] } : entry
        );
}

function report(options: Partial<PixelDiffReport> = {}): PixelDiffReport {
  return {
    width: 400,
    height: 400,
    changedPixels: 0,
    changedPercent: 0,
    changed: false,
    regions: [],
    regionsTruncated: false,
    artifacts: { comparison: 'comparison.png' },
    ...options,
  };
}

function stub(
  implementation: (input: {
    out: string;
    before: Buffer;
    after: Buffer;
  }) => Promise<PixelDiffReport>
) {
  const calls: {
    out: string;
    before: Buffer;
    after: Buffer;
    scale?: number;
    explainShift?: boolean;
    chrome?: { top: number; bottom: number };
  }[] = [];
  const compare: PixelComparator = async input => {
    calls.push(input);
    return implementation(input);
  };
  return { compare, calls };
}

function rootDir(t: TestContext): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'design-gate-pixel-diff-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('an opted-in comparison writes an advisory report per matched receipt-bound cell', async t => {
  const root = rootDir(t);
  const out = path.join(root, 'comparison');
  fs.mkdirSync(out);
  const base = runDir(root, 'base-run');
  const head = runDir(root, 'head-run', { screenshot: { width: 400, height: 400 } });
  const { compare, calls } = stub(async input => {
    fs.mkdirSync(input.out, { recursive: true });
    fs.writeFileSync(path.join(input.out, 'comparison.png'), 'png');
    return report({ changed: true, changedPixels: 672, changedPercent: 0.42 });
  });
  const summary = await runPixelDiffAdvisory({
    out,
    base: base.revision,
    head: head.revision,
    explainShift: false,
    compare,
  });
  assert.equal(summary.status, 'compared');
  assert.equal(summary.advisory, true);
  assert.equal(summary.report, 'pixel-diff.json');
  assert.equal(summary.cells.length, 1);
  const cell = summary.cells[0];
  assert.equal(cell.status, 'changed');
  assert.equal(cell.changedPixels, 672);
  assert.equal(cell.artifacts?.comparison, 'pixel-diff/base/card/comparison.png');
  // The comparator saw the receipt-bound bytes and the dump's pixel ratio.
  assert.equal(calls.length, 1);
  assert.equal(calls[0].scale, 2);
  assert.deepEqual(calls[0].chrome, { top: 20, bottom: 10 });
  assert.deepEqual(calls[0].before, fs.readFileSync(path.join(base.dir, 'cells/base.card.png')));
  const written = JSON.parse(fs.readFileSync(path.join(out, 'pixel-diff.json'), 'utf8'));
  assert.equal(written.advisory, true);
  assert.equal(written.status, 'compared');
});

test('pixel diff evidence lives in its own subdirectory, never beside comparison.json', async t => {
  const root = rootDir(t);
  const out = path.join(root, 'comparison');
  fs.mkdirSync(out);
  fs.writeFileSync(path.join(out, 'comparison.json'), '{"status":"comparable"}');
  const base = runDir(root, 'base-run');
  const head = runDir(root, 'head-run');
  const { compare } = stub(async input => {
    fs.mkdirSync(input.out, { recursive: true });
    return report();
  });
  await runPixelDiffAdvisory({
    out,
    base: base.revision,
    head: head.revision,
    explainShift: false,
    compare,
  });
  assert.deepEqual(fs.readdirSync(out).sort(), [
    'comparison.json',
    'pixel-diff',
    'pixel-diff.json',
  ]);
  assert.equal(
    fs.readFileSync(path.join(out, 'comparison.json'), 'utf8'),
    '{"status":"comparable"}'
  );
});

test('an unchanged pair reports a real zero, not an empty diff', async t => {
  const root = rootDir(t);
  const out = path.join(root, 'comparison');
  fs.mkdirSync(out);
  const base = runDir(root, 'base-run');
  const head = runDir(root, 'head-run');
  const { compare } = stub(async input => {
    fs.mkdirSync(input.out, { recursive: true });
    return report();
  });
  const summary = await runPixelDiffAdvisory({
    out,
    base: base.revision,
    head: head.revision,
    explainShift: false,
    compare,
  });
  assert.equal(summary.cells[0].status, 'unchanged');
  assert.equal(summary.cells[0].changedPixels, 0);
  assert.equal(summary.reasons.length, 0);
});

test('a changed artifact byte is inconclusive instead of compared silently', async t => {
  const root = rootDir(t);
  const out = path.join(root, 'comparison');
  fs.mkdirSync(out);
  const base = runDir(root, 'base-run');
  const head = runDir(root, 'head-run');
  // Different bytes are swapped in after the receipt recorded the digest, without
  // rewriting the receipt: the screenshot no longer matches what was captured.
  head.write('cells/base.card.png', pngBytes(400, 401));
  const { compare, calls } = stub(async input => {
    fs.mkdirSync(input.out, { recursive: true });
    return report();
  });
  const summary = await runPixelDiffAdvisory({
    out,
    base: base.revision,
    head: head.revision,
    explainShift: false,
    compare,
  });
  assert.equal(summary.status, 'inconclusive');
  assert.equal(summary.cells[0].status, 'inconclusive');
  assert.match(summary.cells[0].reason ?? '', /changed since the receipt/);
  assert.deepEqual(summary.reasons, ['no cell of this pair could be compared']);
  assert.equal(calls.length, 0, 'unverified bytes never reach the comparator');
});

test('an artifact the receipt never bound is inconclusive', async t => {
  const root = rootDir(t);
  const out = path.join(root, 'comparison');
  fs.mkdirSync(out);
  const base = runDir(root, 'base-run', { bind: 'screenshot-only' });
  const head = runDir(root, 'head-run', { bind: 'screenshot-only' });
  const { compare, calls } = stub(async input => {
    fs.mkdirSync(input.out, { recursive: true });
    return report();
  });
  const summary = await runPixelDiffAdvisory({
    out,
    base: base.revision,
    head: head.revision,
    explainShift: false,
    compare,
  });
  assert.equal(summary.cells[0].status, 'inconclusive');
  assert.match(summary.cells[0].reason ?? '', /bound no cells\/base\.card\.json/);
  assert.equal(calls.length, 0);
});

test('unequal screenshot dimensions are inconclusive before any decode', async t => {
  const root = rootDir(t);
  const out = path.join(root, 'comparison');
  fs.mkdirSync(out);
  const base = runDir(root, 'base-run');
  const head = runDir(root, 'head-run', { screenshot: { width: 401, height: 400 } });
  const { compare, calls } = stub(async input => {
    fs.mkdirSync(input.out, { recursive: true });
    return report();
  });
  const summary = await runPixelDiffAdvisory({
    out,
    base: base.revision,
    head: head.revision,
    explainShift: false,
    compare,
  });
  assert.equal(summary.cells[0].status, 'inconclusive');
  assert.match(summary.cells[0].reason ?? '', /dimensions differ \(400x400 and 401x400\)/);
  assert.equal(calls.length, 0);
});

test('a screenshot that is not a PNG is inconclusive', async t => {
  const root = rootDir(t);
  const out = path.join(root, 'comparison');
  fs.mkdirSync(out);
  const base = runDir(root, 'base-run');
  const head = runDir(root, 'head-run');
  const notPng = Buffer.from('synthetic-image');
  head.write('cells/base.card.png', notPng);
  head.revision.artifacts = head.revision.artifacts.map(artifact =>
    artifact.path.endsWith('.png')
      ? { ...artifact, sha256: createHash('sha256').update(notPng).digest('hex') }
      : artifact
  );
  const { compare } = stub(async input => {
    fs.mkdirSync(input.out, { recursive: true });
    return report();
  });
  const summary = await runPixelDiffAdvisory({
    out,
    base: base.revision,
    head: head.revision,
    explainShift: false,
    compare,
  });
  assert.equal(summary.cells[0].status, 'inconclusive');
  assert.match(summary.cells[0].reason ?? '', /not a PNG/);
});

test('an unavailable cell leaves a successful sibling compared', async t => {
  const root = rootDir(t);
  const out = path.join(root, 'comparison');
  fs.mkdirSync(out);
  const base = runDir(root, 'base-run');
  const head = runDir(root, 'head-run');
  // A second cell only the base captured: its entry is inconclusive, the first is not.
  const second = path.join(base.dir, 'cells', 'dark.card.png');
  fs.writeFileSync(second, pngBytes(400, 400));
  fs.writeFileSync(path.join(base.dir, 'cells', 'dark.card.json'), dumpBytes({}));
  base.revision.artifacts = [
    ...base.revision.artifacts,
    {
      path: 'cells/dark.card.png',
      sha256: createHash('sha256').update(fs.readFileSync(second)).digest('hex'),
    },
    {
      path: 'cells/dark.card.json',
      sha256: createHash('sha256')
        .update(fs.readFileSync(path.join(base.dir, 'cells', 'dark.card.json')))
        .digest('hex'),
    },
  ];
  base.revision.cells = [
    ...base.revision.cells,
    {
      id: 'dark',
      config: { ...CONFIG, dark: true },
      screens: [
        { target: 'card', dump: 'cells/dark.card.json', screenshot: 'cells/dark.card.png' },
      ],
    },
  ];
  const { compare } = stub(async input => {
    fs.mkdirSync(input.out, { recursive: true });
    return report();
  });
  const summary = await runPixelDiffAdvisory({
    out,
    base: base.revision,
    head: head.revision,
    explainShift: false,
    compare,
  });
  assert.equal(summary.status, 'compared');
  const byCell = new Map(summary.cells.map(cell => [cell.cell, cell]));
  assert.equal(byCell.get('base')?.status, 'unchanged');
  assert.equal(byCell.get('dark')?.status, 'inconclusive');
  assert.match(byCell.get('dark')?.reason ?? '', /head run captured no such cell/);
});

test('a cell the pair already reported unready is not compared', async t => {
  const root = rootDir(t);
  const out = path.join(root, 'comparison');
  fs.mkdirSync(out);
  const base = runDir(root, 'base-run');
  const head = runDir(root, 'head-run');
  head.revision.readiness = [
    'base/card: target not ready or screen identity differs (/login, (auth)/login)',
  ];
  const { compare, calls } = stub(async input => {
    fs.mkdirSync(input.out, { recursive: true });
    return report();
  });
  const summary = await runPixelDiffAdvisory({
    out,
    base: base.revision,
    head: head.revision,
    explainShift: false,
    compare,
  });
  assert.equal(summary.cells[0].status, 'inconclusive');
  // The pair's own reason is carried through verbatim, so a reader sees why.
  assert.match(
    summary.cells[0].reason ?? '',
    /target not ready or screen identity differs \(\/login, \(auth\)\/login\)/
  );
  assert.equal(calls.length, 0);
});

test('cells captured under different configurations are not compared', async t => {
  const root = rootDir(t);
  const out = path.join(root, 'comparison');
  fs.mkdirSync(out);
  const base = runDir(root, 'base-run');
  const head = runDir(root, 'head-run', { config: { ...CONFIG, dark: true } });
  const { compare, calls } = stub(async input => {
    fs.mkdirSync(input.out, { recursive: true });
    return report();
  });
  const summary = await runPixelDiffAdvisory({
    out,
    base: base.revision,
    head: head.revision,
    explainShift: false,
    compare,
  });
  assert.equal(summary.cells[0].status, 'inconclusive');
  assert.match(summary.cells[0].reason ?? '', /different configurations/);
  assert.equal(calls.length, 0);
});

test('a comparator failure is inconclusive and leaves no half-written cell', async t => {
  const root = rootDir(t);
  const out = path.join(root, 'comparison');
  fs.mkdirSync(out);
  const base = runDir(root, 'base-run');
  const head = runDir(root, 'head-run');
  const { compare } = stub(async input => {
    fs.mkdirSync(input.out, { recursive: true });
    fs.writeFileSync(path.join(input.out, 'comparison.png'), 'partial');
    throw new Error('decode failed');
  });
  const summary = await runPixelDiffAdvisory({
    out,
    base: base.revision,
    head: head.revision,
    explainShift: false,
    compare,
  });
  assert.equal(summary.status, 'inconclusive');
  assert.match(summary.cells[0].reason ?? '', /decode failed/);
  assert.equal(fs.existsSync(path.join(out, 'pixel-diff', 'base', 'card')), false);
});

test('the same cell is never compared twice into one comparison', async t => {
  const root = rootDir(t);
  const out = path.join(root, 'comparison');
  fs.mkdirSync(out);
  fs.mkdirSync(path.join(out, 'pixel-diff', 'base', 'card'), { recursive: true });
  const base = runDir(root, 'base-run');
  const head = runDir(root, 'head-run');
  const { compare, calls } = stub(async input => {
    fs.mkdirSync(input.out, { recursive: true });
    return report();
  });
  const summary = await runPixelDiffAdvisory({
    out,
    base: base.revision,
    head: head.revision,
    explainShift: false,
    compare,
  });
  assert.equal(summary.cells[0].status, 'inconclusive');
  assert.match(summary.cells[0].reason ?? '', /already exists/);
  assert.equal(calls.length, 0);
});

test('a cell or target name that cannot name a directory is inconclusive', async t => {
  const root = rootDir(t);
  const out = path.join(root, 'comparison');
  fs.mkdirSync(out);
  const base = runDir(root, 'base-run', { target: '../../escape' });
  const head = runDir(root, 'head-run', { target: '../../escape' });
  const { compare, calls } = stub(async input => {
    fs.mkdirSync(input.out, { recursive: true });
    return report();
  });
  const summary = await runPixelDiffAdvisory({
    out,
    base: base.revision,
    head: head.revision,
    explainShift: false,
    compare,
  });
  assert.equal(summary.cells[0].status, 'inconclusive');
  assert.match(summary.cells[0].reason ?? '', /cannot name an artifact path/);
  assert.equal(calls.length, 0);
});

test('an artifact path outside the run directory is refused', async t => {
  const root = rootDir(t);
  const dir = path.join(root, 'run');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(root, 'outside.txt'), 'outside');
  assert.throws(() => containedPath(dir, '../outside.txt'), /escapes its run directory/);
});

test('an unknown safe area claims no chrome split but still compares', async t => {
  const root = rootDir(t);
  const out = path.join(root, 'comparison');
  fs.mkdirSync(out);
  const base = runDir(root, 'base-run', { dump: { safeAreaKnown: false } });
  const head = runDir(root, 'head-run', { dump: { safeAreaKnown: false } });
  const { compare, calls } = stub(async input => {
    fs.mkdirSync(input.out, { recursive: true });
    return report();
  });
  const summary = await runPixelDiffAdvisory({
    out,
    base: base.revision,
    head: head.revision,
    explainShift: false,
    compare,
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].chrome, undefined);
  assert.equal(summary.cells[0].status, 'unchanged');
  assert.match(summary.cells[0].notes?.[0] ?? '', /no system chrome split is claimed/);
});

test('a capture that does not match the dump window claims no chrome split', async t => {
  const root = rootDir(t);
  const out = path.join(root, 'comparison');
  fs.mkdirSync(out);
  // The dump says a 300 dp window at ratio 2 (600 px) but the capture is 400 px.
  const base = runDir(root, 'base-run', { dump: { windowHeight: 300 } });
  const head = runDir(root, 'head-run', { dump: { windowHeight: 300 } });
  const { compare, calls } = stub(async input => {
    fs.mkdirSync(input.out, { recursive: true });
    return report();
  });
  const summary = await runPixelDiffAdvisory({
    out,
    base: base.revision,
    head: head.revision,
    explainShift: false,
    compare,
  });
  assert.equal(calls[0].chrome, undefined);
  assert.match(summary.cells[0].notes?.[0] ?? '', /describe a 600 px window/);
});

test('chrome bands are the union of both dumps in physical pixels, never a mask', async t => {
  const root = rootDir(t);
  const out = path.join(root, 'comparison');
  fs.mkdirSync(out);
  const base = runDir(root, 'base-run', { dump: { top: 10, bottom: 5 } });
  const head = runDir(root, 'head-run', { dump: { top: 12, bottom: 4 } });
  const { compare, calls } = stub(async input => {
    fs.mkdirSync(input.out, { recursive: true });
    return report({
      chrome: {
        top: { height: 24, changedPixels: 3 },
        bottom: { height: 10, changedPixels: 0 },
      },
    });
  });
  const summary = await runPixelDiffAdvisory({
    out,
    base: base.revision,
    head: head.revision,
    explainShift: false,
    compare,
  });
  // 2x ratio: 10/12 dp top -> 24 px union, 5/4 dp bottom -> 10 px union.
  assert.deepEqual(calls[0].chrome, { top: 24, bottom: 10 });
  // The full changed count is reported as given; the band counts stay separate.
  assert.deepEqual(summary.cells[0].chrome, {
    top: { height: 24, changedPixels: 3 },
    bottom: { height: 10, changedPixels: 0 },
  });
});

test('explainShift is forwarded only when the caller asked for it', async t => {
  const root = rootDir(t);
  const base = runDir(root, 'base-run');
  const head = runDir(root, 'head-run');
  for (const explainShift of [false, true]) {
    const out = path.join(root, `comparison-${explainShift}`);
    fs.mkdirSync(out);
    const { compare, calls } = stub(async input => {
      fs.mkdirSync(input.out, { recursive: true });
      return report();
    });
    await runPixelDiffAdvisory({
      out,
      base: base.revision,
      head: head.revision,
      explainShift,
      compare,
    });
    assert.equal(calls[0].explainShift, explainShift);
  }
});

test('a report whose dimensions differ from the pair is inconclusive', async t => {
  const root = rootDir(t);
  const out = path.join(root, 'comparison');
  fs.mkdirSync(out);
  const base = runDir(root, 'base-run');
  const head = runDir(root, 'head-run');
  const { compare } = stub(async input => {
    fs.mkdirSync(input.out, { recursive: true });
    return report({ width: 200, height: 400 });
  });
  const summary = await runPixelDiffAdvisory({
    out,
    base: base.revision,
    head: head.revision,
    explainShift: false,
    compare,
  });
  assert.equal(summary.cells[0].status, 'inconclusive');
  assert.match(summary.cells[0].reason ?? '', /reported 200x400 for a 400x400 pair/);
});

test('a comparator artifact path that escapes the cell is inconclusive', async t => {
  const root = rootDir(t);
  const out = path.join(root, 'comparison');
  fs.mkdirSync(out);
  const base = runDir(root, 'base-run');
  const head = runDir(root, 'head-run');
  const { compare } = stub(async input => {
    fs.mkdirSync(input.out, { recursive: true });
    return report({ artifacts: { comparison: '../comparison.png' } });
  });
  const summary = await runPixelDiffAdvisory({
    out,
    base: base.revision,
    head: head.revision,
    explainShift: false,
    compare,
  });
  assert.equal(summary.cells[0].status, 'inconclusive');
  assert.match(summary.cells[0].reason ?? '', /unsafe artifact path/);
  assert.equal(
    fs.existsSync(path.join(out, 'pixel-diff', 'base', 'card', 'comparison.png')),
    false
  );
});

test('a pair with no shared cell states that nothing could be compared', async t => {
  const root = rootDir(t);
  const out = path.join(root, 'comparison');
  fs.mkdirSync(out);
  const base = runDir(root, 'base-run', { cell: 'base' });
  const head = runDir(root, 'head-run', { cell: 'dark' });
  const { compare, calls } = stub(async input => {
    fs.mkdirSync(input.out, { recursive: true });
    return report();
  });
  const summary = await runPixelDiffAdvisory({
    out,
    base: base.revision,
    head: head.revision,
    explainShift: false,
    compare,
  });
  assert.equal(summary.status, 'inconclusive');
  assert.deepEqual(summary.reasons, ['no cell of this pair could be compared']);
  assert.deepEqual(
    summary.cells.map(cell => cell.status),
    ['inconclusive', 'inconclusive']
  );
  assert.equal(calls.length, 0);
});

test('a comparison with no captures at all is inconclusive, never an empty success', async t => {
  const root = rootDir(t);
  const out = path.join(root, 'comparison');
  fs.mkdirSync(out);
  const base = runDir(root, 'base-run');
  const head = runDir(root, 'head-run');
  base.revision.cells = [];
  head.revision.cells = [];
  const { compare, calls } = stub(async input => {
    fs.mkdirSync(input.out, { recursive: true });
    return report();
  });
  const summary = await runPixelDiffAdvisory({
    out,
    base: base.revision,
    head: head.revision,
    explainShift: false,
    compare,
  });
  assert.equal(summary.status, 'inconclusive');
  assert.equal(summary.cells.length, 0);
  assert.deepEqual(summary.reasons, ['no cell of this pair could be compared']);
  assert.equal(calls.length, 0);
});

test('a report that cannot be written still returns the inconclusive summary', async t => {
  const root = rootDir(t);
  const out = path.join(root, 'comparison');
  fs.mkdirSync(out);
  // A stale temporary file blocks the exclusive write the report uses.
  fs.writeFileSync(path.join(out, '.pixel-diff.json.tmp'), 'occupied');
  const base = runDir(root, 'base-run');
  const head = runDir(root, 'head-run');
  const { compare } = stub(async input => {
    fs.mkdirSync(input.out, { recursive: true });
    return report();
  });
  const summary = await runPixelDiffAdvisory({
    out,
    base: base.revision,
    head: head.revision,
    explainShift: false,
    compare,
  });
  assert.equal(summary.status, 'inconclusive');
  assert.equal(summary.report, undefined);
  assert.ok(summary.reasons.some(reason => /could not be written/.test(reason)));
});

test('a pair the gate already called inconclusive is never diffed per cell', async t => {
  const root = rootDir(t);
  const out = path.join(root, 'comparison');
  fs.mkdirSync(out);
  const base = runDir(root, 'base-run');
  const head = runDir(root, 'head-run');
  const { compare, calls } = stub(async input => {
    fs.mkdirSync(input.out, { recursive: true });
    return report();
  });
  const summary = await runPixelDiffAdvisory({
    out,
    base: base.revision,
    head: head.revision,
    explainShift: false,
    pairReasons: ['Captured device environments differ'],
    compare,
  });
  assert.equal(summary.status, 'inconclusive');
  assert.equal(calls.length, 0);
  assert.equal(summary.cells[0].status, 'inconclusive');
  assert.match(
    summary.cells[0].reason ?? '',
    /comparison already called this pair inconclusive: Captured device environments differ/
  );
});

test('a pair-wide inconclusive names base-only cells and targets as well as head ones', async t => {
  const root = rootDir(t);
  const out = path.join(root, 'comparison');
  fs.mkdirSync(out);
  const base = runDir(root, 'base-run');
  const head = runDir(root, 'head-run');
  // `base/card` is shared, but each side also captures a distinct target, and a
  // cell exists only on one side: a head-only listing would drop three of them.
  bindScreen(base, 'base', 'sheet');
  bindScreen(base, 'dark', 'card');
  bindScreen(head, 'base', 'dialog');
  bindScreen(head, 'light', 'card');
  const { compare, calls } = stub(async input => {
    fs.mkdirSync(input.out, { recursive: true });
    return report({ changed: true, changedPixels: 5, changedPercent: 0.01 });
  });
  const summary = await runPixelDiffAdvisory({
    out,
    base: base.revision,
    head: head.revision,
    explainShift: false,
    pairReasons: ['Captured device environments differ', 'Matrix cells/configuration differ'],
    compare,
  });
  assert.equal(summary.status, 'inconclusive');
  assert.equal(calls.length, 0, 'a pair the gate refused is never diffed');
  const keys = summary.cells.map(cell => `${cell.cell}/${cell.target}`).sort();
  assert.deepEqual(keys, ['base/card', 'base/dialog', 'base/sheet', 'dark/card', 'light/card']);
  const reason =
    'the comparison already called this pair inconclusive: Captured device environments differ; Matrix cells/configuration differ';
  for (const cell of summary.cells) {
    assert.equal(cell.status, 'inconclusive');
    assert.equal(cell.reason, reason);
    assert.equal(cell.artifacts, undefined);
  }
});

test('a cell directory that is a symbolic link is refused and never written through', async t => {
  const root = rootDir(t);
  const out = path.join(root, 'comparison');
  fs.mkdirSync(out);
  // A link where the cell directory belongs must not receive artifacts.
  const outside = path.join(root, 'outside');
  fs.mkdirSync(outside);
  fs.mkdirSync(path.join(out, 'pixel-diff', 'base'), { recursive: true });
  fs.symlinkSync(outside, path.join(out, 'pixel-diff', 'base', 'card'));
  const base = runDir(root, 'base-run');
  const head = runDir(root, 'head-run');
  const { compare, calls } = stub(async input => {
    fs.mkdirSync(input.out, { recursive: true });
    return report();
  });
  const summary = await runPixelDiffAdvisory({
    out,
    base: base.revision,
    head: head.revision,
    explainShift: false,
    compare,
  });
  assert.equal(summary.cells[0].status, 'inconclusive');
  assert.match(summary.cells[0].reason ?? '', /already exists|not a real directory/);
  assert.equal(calls.length, 0, 'nothing is written through a link');
  assert.deepEqual(fs.readdirSync(outside), [], 'the link target stays untouched');
  assert.ok(fs.lstatSync(path.join(out, 'pixel-diff', 'base', 'card')).isSymbolicLink());
});

test('a symlinked parent directory is refused instead of followed', async t => {
  const root = rootDir(t);
  const out = path.join(root, 'comparison');
  fs.mkdirSync(out);
  const outside = path.join(root, 'outside');
  fs.mkdirSync(outside);
  // `pixel-diff` itself is a link out of the comparison directory.
  fs.symlinkSync(outside, path.join(out, 'pixel-diff'));
  const base = runDir(root, 'base-run');
  const head = runDir(root, 'head-run');
  const { compare, calls } = stub(async input => {
    fs.mkdirSync(input.out, { recursive: true });
    return report();
  });
  const summary = await runPixelDiffAdvisory({
    out,
    base: base.revision,
    head: head.revision,
    explainShift: false,
    compare,
  });
  assert.equal(summary.cells[0].status, 'inconclusive');
  assert.match(summary.cells[0].reason ?? '', /not a real directory/);
  assert.equal(calls.length, 0);
  assert.deepEqual(fs.readdirSync(outside), []);
});

test('a failed cell cleanup leaves a directory it did not create in place', async t => {
  const root = rootDir(t);
  const out = path.join(root, 'comparison');
  fs.mkdirSync(out);
  const base = runDir(root, 'base-run');
  const head = runDir(root, 'head-run');
  // The comparator moves the claimed directory aside and puts its own in place,
  // so the original inode stays allocated and the replacement provably differs.
  const { compare } = stub(async input => {
    fs.renameSync(input.out, `${input.out}.displaced`);
    fs.mkdirSync(input.out);
    fs.writeFileSync(path.join(input.out, 'someone-elses.png'), 'not ours');
    throw new Error('comparator failed after replacing the directory');
  });
  const summary = await runPixelDiffAdvisory({
    out,
    base: base.revision,
    head: head.revision,
    explainShift: false,
    compare,
  });
  assert.equal(summary.cells[0].status, 'inconclusive');
  // The replacement directory is not the one this pass created, so it survives.
  assert.equal(
    fs.readFileSync(path.join(out, 'pixel-diff', 'base', 'card', 'someone-elses.png'), 'utf8'),
    'not ours'
  );
});

test('a head overlay blocks only its cell and a real sibling still compares', async t => {
  const root = rootDir(t);
  const out = path.join(root, 'comparison');
  fs.mkdirSync(out);
  const base = runDir(root, 'base-run');
  const head = runDir(root, 'head-run');
  // A second, clean cell that the overlay never touched.
  const shot = image(400, 400, { x: 10, y: 10, width: 20, height: 10 });
  for (const run of [base, head]) {
    fs.writeFileSync(path.join(run.dir, 'cells', 'dark.card.png'), shot);
    fs.writeFileSync(path.join(run.dir, 'cells', 'dark.card.json'), dumpBytes({}));
    run.revision.artifacts = [
      ...run.revision.artifacts,
      ...['cells/dark.card.png', 'cells/dark.card.json'].map(relative => ({
        path: relative,
        sha256: createHash('sha256')
          .update(fs.readFileSync(path.join(run.dir, relative)))
          .digest('hex'),
      })),
    ];
    run.revision.cells = [
      ...run.revision.cells,
      {
        id: 'dark',
        config: { ...CONFIG, dark: true },
        screens: [
          { target: 'card', dump: 'cells/dark.card.json', screenshot: 'cells/dark.card.png' },
        ],
      },
    ];
  }
  // The comparison hands the advisory pass the overlay cell as unready, exactly
  // the way `compareProof` now does for a head `dev-overlay` error.
  head.revision.readiness = ['base/card: a LogBox overlay painted this screen'];
  const summary = await runPixelDiffAdvisory({
    out,
    base: base.revision,
    head: head.revision,
    explainShift: false,
  });
  const byCell = new Map(summary.cells.map(cell => [cell.cell, cell]));
  // The overlaid cell is explicitly inconclusive for the overlay itself.
  assert.equal(byCell.get('base')?.status, 'inconclusive');
  assert.match(byCell.get('base')?.reason ?? '', /a LogBox overlay painted this screen/);
  // The sibling is a real comparison, so the report is not wholly inconclusive.
  assert.equal(byCell.get('dark')?.status, 'unchanged');
  assert.equal(byCell.get('dark')?.changedPixels, 0);
  assert.equal(summary.status, 'compared');
});

test('a run-wide readiness failure blocks every cell; a cell-wide one keeps siblings', async t => {
  const root = rootDir(t);
  const out = path.join(root, 'comparison');
  fs.mkdirSync(out);
  const base = runDir(root, 'base-run');
  const head = runDir(root, 'head-run');
  // A second cell the coverage failure never names, so it stays comparable.
  bindScreen(base, 'dark', 'card');
  bindScreen(head, 'dark', 'card');
  const { compare, calls } = stub(async input => {
    fs.mkdirSync(input.out, { recursive: true });
    return report();
  });
  // `targetReadiness` reports a cell-wide coverage failure without a target, and
  // a run-level one (duplicate matrix cells) with no cell at all. Neither names
  // `<cell>/<target>`, and neither may be silently ignored.
  head.revision.readiness = ['base: target coverage differs from manifest'];
  const coverage = await runPixelDiffAdvisory({
    out,
    base: base.revision,
    head: head.revision,
    explainShift: false,
    compare,
  });
  const byCell = new Map(coverage.cells.map(cell => [cell.cell, cell]));
  assert.equal(byCell.get('base')?.status, 'inconclusive');
  assert.match(byCell.get('base')?.reason ?? '', /target coverage differs from manifest/);
  // The sibling cell keeps its real comparison.
  assert.equal(byCell.get('dark')?.status, 'unchanged');
  assert.equal(coverage.status, 'compared');
  assert.equal(calls.length, 1);

  const out2 = path.join(root, 'comparison-2');
  fs.mkdirSync(out2);
  head.revision.readiness = ['Duplicate matrix cells'];
  const runWide = await runPixelDiffAdvisory({
    out: out2,
    base: base.revision,
    head: head.revision,
    explainShift: false,
    compare,
  });
  // Nothing about the run can be trusted, so no cell is compared.
  assert.equal(runWide.status, 'inconclusive');
  assert.deepEqual(
    runWide.cells.map(cell => cell.status),
    ['inconclusive', 'inconclusive']
  );
  for (const cell of runWide.cells) {
    assert.match(
      cell.reason ?? '',
      /readiness failure covering every cell.*Duplicate matrix cells/
    );
  }
  assert.equal(calls.length, 1);
  assert.equal(fs.existsSync(path.join(out2, 'pixel-diff')), false);
});

test('a target neither run captured blocks no sibling and is stated once', async t => {
  const root = rootDir(t);
  const out = path.join(root, 'comparison');
  fs.mkdirSync(out);
  const base = runDir(root, 'base-run');
  const head = runDir(root, 'head-run');
  bindScreen(base, 'dark', 'card');
  bindScreen(head, 'dark', 'card');
  const { compare, calls } = stub(async input => {
    fs.mkdirSync(input.out, { recursive: true });
    return report();
  });
  // The shape a cell the runner never started produces: `targetReadiness` names
  // the skipped target, and neither run has a CellRun for that cell. The other
  // cells are complete captures and must still compare.
  const skip = 'compact/card: target could not be read (InfraError: no debugger page)';
  head.revision.readiness = [skip];
  const summary = await runPixelDiffAdvisory({
    out,
    base: base.revision,
    head: head.revision,
    explainShift: false,
    compare,
  });
  const byCell = new Map(summary.cells.map(cell => [cell.cell, cell]));
  assert.equal(byCell.get('base')?.status, 'unchanged');
  assert.equal(byCell.get('dark')?.status, 'unchanged');
  assert.equal(summary.status, 'compared');
  // One comparison per captured cell: the missing cell blocked neither.
  assert.equal(calls.length, 2);
  // The gap stays visible, and is stated exactly once.
  assert.deepEqual(
    summary.reasons.filter(reason => reason.includes('compact/card')),
    [skip]
  );
});

test('pngSize reads the declared size and refuses non-PNG bytes', () => {
  assert.deepEqual(pngSize(pngBytes(400, 800)), { width: 400, height: 800 });
  assert.equal(pngSize(Buffer.from('synthetic-image')), undefined);
  assert.equal(pngSize(Buffer.alloc(4)), undefined);
});

test('the real comparator writes its artifacts under the cell and reports exact pixels', async t => {
  const root = rootDir(t);
  const out = path.join(root, 'comparison');
  fs.mkdirSync(out);
  const base = runDir(root, 'base-run');
  const head = runDir(root, 'head-run');
  // Real PNG bodies only for this test: a 48x14 patch appears on the head side.
  const before = image(400, 400);
  const after = image(400, 400, { x: 100, y: 120, width: 48, height: 14 });
  base.write('cells/base.card.png', before);
  head.write('cells/base.card.png', after);
  for (const [run, bytes] of [
    [base, before],
    [head, after],
  ] as const) {
    run.revision.artifacts = run.revision.artifacts.map(artifact =>
      artifact.path.endsWith('.png')
        ? { ...artifact, sha256: createHash('sha256').update(bytes).digest('hex') }
        : artifact
    );
  }
  const summary = await runPixelDiffAdvisory({
    out,
    base: base.revision,
    head: head.revision,
    explainShift: false,
  });
  assert.equal(summary.status, 'compared');
  const cell = summary.cells[0];
  assert.equal(cell.status, 'changed');
  assert.equal(cell.changedPixels, 48 * 14);
  assert.deepEqual(cell.regions?.length, 1);
  assert.equal(cell.width, 400);
  assert.equal(cell.height, 400);
  assert.equal(cell.artifacts?.comparison, 'pixel-diff/base/card/comparison.png');
  assert.ok(fs.statSync(path.join(out, cell.artifacts.comparison)).size > 0);
  // The chrome split is counted separately from the full changed count.
  assert.equal(cell.chrome?.top.height, 20);
  assert.equal(cell.chrome?.bottom.height, 10);
  assert.equal(cell.chrome?.top.changedPixels, 0);
});

test('the real comparator reports an identical capture as a zero, not inconclusive', async t => {
  const root = rootDir(t);
  const out = path.join(root, 'comparison');
  fs.mkdirSync(out);
  const base = runDir(root, 'base-run');
  const head = runDir(root, 'head-run');
  const shot = image(400, 400, { x: 10, y: 10, width: 20, height: 10 });
  base.write('cells/base.card.png', shot);
  head.write('cells/base.card.png', shot);
  for (const run of [base, head]) {
    run.revision.artifacts = run.revision.artifacts.map(artifact =>
      artifact.path.endsWith('.png')
        ? { ...artifact, sha256: createHash('sha256').update(shot).digest('hex') }
        : artifact
    );
  }
  const summary = await runPixelDiffAdvisory({
    out,
    base: base.revision,
    head: head.revision,
    explainShift: false,
  });
  assert.equal(summary.status, 'compared');
  assert.equal(summary.cells[0].status, 'unchanged');
  assert.equal(summary.cells[0].changedPixels, 0);
  assert.ok(fs.statSync(path.join(out, 'pixel-diff/base/card/comparison.png')).size > 0);
});

test('the real comparator refuses undecodable bytes as inconclusive', async t => {
  const root = rootDir(t);
  const out = path.join(root, 'comparison');
  fs.mkdirSync(out);
  const base = runDir(root, 'base-run');
  const head = runDir(root, 'head-run');
  // A valid PNG header over garbage: the size pre-check passes, the decoder fails.
  const broken = pngBytes(400, 400);
  base.write('cells/base.card.png', broken);
  head.write('cells/base.card.png', broken);
  for (const run of [base, head]) {
    run.revision.artifacts = run.revision.artifacts.map(artifact =>
      artifact.path.endsWith('.png')
        ? { ...artifact, sha256: createHash('sha256').update(broken).digest('hex') }
        : artifact
    );
  }
  const summary = await runPixelDiffAdvisory({
    out,
    base: base.revision,
    head: head.revision,
    explainShift: false,
  });
  assert.equal(summary.status, 'inconclusive');
  assert.equal(summary.cells[0].status, 'inconclusive');
  assert.match(summary.cells[0].reason ?? '', /could not be decoded/);
  assert.equal(fs.existsSync(path.join(out, 'pixel-diff', 'base', 'card')), false);
});
