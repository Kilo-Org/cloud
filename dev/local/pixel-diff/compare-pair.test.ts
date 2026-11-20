// Observable CLI edges of compare-pair: exit codes, the report contract, and
// what is (not) left on disk. Image behavior itself is covered by compare.test.ts.
import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { PNG } from 'pngjs';

import {
  EXIT_INCONCLUSIVE,
  EXIT_OK,
  EXIT_USAGE,
  main,
  REPORT_FILE,
  USAGE,
  type ComparePairReport,
} from './compare-pair';

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

/** A page whose content block moved down by 40 px, for the shift explanation. */
function movedPage(): { before: Buffer; after: Buffer } {
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
  return { before: page(40), after: page(80) };
}

type CliResult = { code: number; stdout: string[]; stderr: string[] };

async function cli(args: string[]): Promise<CliResult> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await main(args, {
    log: line => stdout.push(line),
    warn: line => stderr.push(line),
  });
  return { code, stdout, stderr };
}

async function withRoot(body: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pixel-diff-cli-'));
  try {
    await body(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function readReport(out: string): Promise<ComparePairReport> {
  return JSON.parse(await readFile(path.join(out, REPORT_FILE), 'utf8')) as ComparePairReport;
}

/** Writes a pair into `root` and returns both absolute paths. */
async function writePair(
  root: string,
  before: Buffer,
  after: Buffer
): Promise<{ before: string; after: string }> {
  const paths = { before: path.join(root, 'before.png'), after: path.join(root, 'after.png') };
  await writeFile(paths.before, before);
  await writeFile(paths.after, after);
  return paths;
}

void test('an unchanged pair writes a compared report and exits 0', async () => {
  await withRoot(async root => {
    const shot = image(120, 80, { x: 10, y: 10, width: 20, height: 10 });
    const { before, after } = await writePair(root, shot, shot);
    const out = path.join(root, 'out');

    const result = await cli(['--before', before, '--after', after, '--out', out]);

    assert.equal(result.code, EXIT_OK);
    assert.deepEqual(result.stderr, []);
    assert.deepEqual(result.stdout, [
      `pixel-diff: unchanged 0/${120 * 80} px`,
      `pixel-diff: report ${path.join(out, REPORT_FILE)}`,
    ]);

    const report = await readReport(out);
    assert.equal(report.status, 'compared');
    assert.equal(report.changed, false);
    assert.equal(report.changedPixels, 0);
    assert.equal(report.changedPercent, 0);
    assert.deepEqual(report.regions, []);
    assert.deepEqual(report.artifacts, { comparison: 'comparison.png' });
    assert.equal(report.width, 120);
    assert.equal(report.height, 80);
    assert.ok((await stat(path.join(out, 'comparison.png'))).size > 0);
    await assert.rejects(stat(path.join(out, 'focus.png')), /ENOENT/);
    assert.deepEqual((await readdir(root)).sort(), ['after.png', 'before.png', 'out']);
  });
});

void test('a changed pair exits 0 and reports both artifacts', async () => {
  await withRoot(async root => {
    const { before, after } = await writePair(
      root,
      image(900, 700),
      image(900, 700, { x: 40, y: 30, width: 24, height: 12 })
    );
    const out = path.join(root, 'out');

    const result = await cli(['--before', before, '--after', after, '--out', out]);

    assert.equal(result.code, EXIT_OK);
    assert.equal(result.stdout[0], `pixel-diff: changed 288/${900 * 700} px (0.0457%)`);
    const report = await readReport(out);
    assert.equal(report.status, 'compared');
    assert.equal(report.changed, true);
    assert.equal(report.changedPixels, 288);
    assert.deepEqual(report.artifacts, { comparison: 'comparison.png', focus: 'focus.png' });
    assert.ok((await stat(path.join(out, 'focus.png'))).size > 0);
  });
});

void test('an existing --out is refused without touching its contents', async () => {
  await withRoot(async root => {
    const { before, after } = await writePair(root, image(60, 40), image(60, 40));
    const occupied = path.join(root, 'occupied');
    await mkdir(occupied);
    await writeFile(path.join(occupied, 'stale.txt'), 'previous run');

    const result = await cli(['--before', before, '--after', after, '--out', occupied]);

    assert.equal(result.code, EXIT_INCONCLUSIVE);
    assert.match(result.stdout[0], /^pixel-diff: inconclusive: .*already exists; pass a new --out/);
    assert.deepEqual(await readdir(occupied), ['stale.txt']);
    await assert.rejects(stat(path.join(occupied, REPORT_FILE)), /ENOENT/);

    // An empty directory is refused too, so a caller cannot silently reuse a cell.
    const empty = path.join(root, 'empty');
    await mkdir(empty);
    const second = await cli(['--before', before, '--after', after, '--out', empty]);
    assert.equal(second.code, EXIT_INCONCLUSIVE);
    assert.deepEqual(await readdir(empty), []);
    assert.deepEqual((await readdir(root)).sort(), [
      'after.png',
      'before.png',
      'empty',
      'occupied',
    ]);
  });
});

void test('an unreadable input is inconclusive and writes nothing', async () => {
  await withRoot(async root => {
    const { after } = await writePair(root, image(20, 20), image(20, 20));
    const out = path.join(root, 'out');

    const result = await cli([
      '--before',
      path.join(root, 'missing.png'),
      '--after',
      after,
      '--out',
      out,
    ]);

    assert.equal(result.code, EXIT_INCONCLUSIVE);
    assert.match(
      result.stdout[0],
      /^pixel-diff: inconclusive: ENOENT: no such file or directory, open '.*missing\.png'$/
    );
    await assert.rejects(lstat(out), /ENOENT/);
    assert.deepEqual((await readdir(root)).sort(), ['after.png', 'before.png']);
  });
});

void test('a non-PNG input is inconclusive and leaves no partial artifacts', async () => {
  await withRoot(async root => {
    const garbage = Buffer.from('definitely not a png');
    const { before, after } = await writePair(root, garbage, garbage);
    const out = path.join(root, 'out');

    const result = await cli(['--before', before, '--after', after, '--out', out]);

    assert.equal(result.code, EXIT_INCONCLUSIVE);
    assert.equal(result.stdout[0], 'pixel-diff: inconclusive (decode): before is not a PNG');
    await assert.rejects(lstat(out), /ENOENT/);
    assert.deepEqual((await readdir(root)).sort(), ['after.png', 'before.png']);
  });
});

void test('a size mismatch is inconclusive instead of a padded comparison', async () => {
  await withRoot(async root => {
    const { before, after } = await writePair(root, image(30, 30), image(30, 31));
    const out = path.join(root, 'out');

    const result = await cli(['--before', before, '--after', after, '--out', out]);

    assert.equal(result.code, EXIT_INCONCLUSIVE);
    assert.match(result.stdout[0], /^pixel-diff: inconclusive \(size-mismatch\): before is 30x30/);
    await assert.rejects(lstat(out), /ENOENT/);
  });
});

void test('a filesystem failure is inconclusive, never unchanged', async () => {
  await withRoot(async root => {
    const { before, after } = await writePair(root, image(30, 30), image(30, 30));
    const blocker = path.join(root, 'blocker');
    await writeFile(blocker, 'a file where a directory is needed');

    const result = await cli([
      '--before',
      before,
      '--after',
      after,
      '--out',
      path.join(blocker, 'out'),
    ]);

    assert.equal(result.code, EXIT_INCONCLUSIVE);
    assert.match(result.stdout[0], /^pixel-diff: inconclusive: (EEXIST|ENOTDIR):/);
    assert.equal((await stat(blocker)).isFile(), true);
    assert.deepEqual((await readdir(root)).sort(), ['after.png', 'before.png', 'blocker']);
  });
});

void test('--explain-shift reaches the comparator', async () => {
  await withRoot(async root => {
    const page = movedPage();
    const { before, after } = await writePair(root, page.before, page.after);
    const out = path.join(root, 'out');

    const result = await cli([
      '--before',
      before,
      '--after',
      after,
      '--out',
      out,
      '--explain-shift',
    ]);

    assert.equal(result.code, EXIT_OK);
    assert.match(result.stdout[0], /^pixel-diff: changed \d+\//);
    const report = await readReport(out);
    assert.ok(report.shift, 'moved rows are explained');
    assert.ok(
      report.shift.blocks.some(block => block.dy === 40),
      JSON.stringify(report.shift.blocks)
    );
  });
});

void test('bad flags are usage errors with exit 64 and no writes', async () => {
  await withRoot(async root => {
    const { before, after } = await writePair(root, image(20, 20), image(20, 20));
    const out = path.join(root, 'out');

    const missing = await cli(['--before', before, '--out', out]);
    assert.equal(missing.code, EXIT_USAGE);
    assert.deepEqual(missing.stdout, []);
    assert.deepEqual(missing.stderr, [
      'pixel-diff: --before, --after and --out are required',
      USAGE,
    ]);

    const badScale = await cli([
      '--before',
      before,
      '--after',
      after,
      '--out',
      out,
      '--scale',
      '0.1',
    ]);
    assert.equal(badScale.code, EXIT_USAGE);
    assert.match(badScale.stderr[0], /^pixel-diff: --scale must be a device pixel ratio/);

    const unknown = await cli(['--before', before, '--after', after, '--out', out, '--bogus']);
    assert.equal(unknown.code, EXIT_USAGE);
    assert.match(unknown.stderr[0], /^pixel-diff: .*--bogus/);

    await assert.rejects(lstat(out), /ENOENT/);
    assert.deepEqual((await readdir(root)).sort(), ['after.png', 'before.png']);
  });
});

void test('--help prints usage and exits 0', async () => {
  await withRoot(async root => {
    const result = await cli(['--help']);

    assert.equal(result.code, EXIT_OK);
    assert.deepEqual(result.stdout, [USAGE]);
    assert.deepEqual(result.stderr, []);
    assert.deepEqual(await readdir(root), []);
  });
});
