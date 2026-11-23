// Standalone CLI over the prepared-pair comparator in ./compare.
//
// It captures nothing and publishes nothing: both PNGs must already exist. The
// output directory is created exclusively and holds comparison.png, an optional
// focus.png and, written last, pixel-diff.json, so a present report marks a
// complete cell. A failure removes the directory this call created.
//
// Exit codes:
//   0  compared (changed and unchanged alike)
//   2  inconclusive: the pair was not compared or written, with the reason
//   64 usage error: bad or missing flags
import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { comparePngPair, LIMITS, PixelDiffError, type PixelDiffReport } from './compare';

/** Report file name inside `--out`; it always sits beside the PNG artifacts. */
export const REPORT_FILE = 'pixel-diff.json';

export const EXIT_OK = 0;
export const EXIT_INCONCLUSIVE = 2;
export const EXIT_USAGE = 64;

export const USAGE = `Usage:
  pnpm dev:pixel-diff --before <png> --after <png> --out <new-dir> [options]

Compare two prepared screenshots with the pixel comparator and write
comparison.png, an optional focus.png and pixel-diff.json into a new directory.
It captures nothing: both PNGs must already exist.

Options:
  --before <png>    Pre-change screenshot (PNG, physical pixels)
  --after <png>     Post-change screenshot at the same size
  --out <new-dir>   Output directory; must not exist yet
  --scale <n>       Device pixel ratio between ${LIMITS.minScale} and ${LIMITS.maxScale} (default 1)
  --explain-shift   Explain vertical movement; the fixed-coordinate count is unchanged
  -h, --help        Show this message

Exit codes:
  0   compared (changed and unchanged alike)
  2   inconclusive: the pair was not compared or written; see the reason
  64  usage error: bad or missing flags`;

type ComparePairArgs = {
  before: string;
  after: string;
  out: string;
  scale?: number;
  explainShift: boolean;
};

/** The JSON document `pixel-diff.json` holds: the comparator outcome plus its status. */
export type ComparePairReport = PixelDiffReport & { status: 'compared' };

type ComparePairIo = {
  log: (line: string) => void;
  warn: (line: string) => void;
};

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Parses and validates the flags; `--help` is handled by the caller. */
function parsePairArgs(argv: string[]): ComparePairArgs {
  const {
    values: { before, after, out, scale: rawScale, 'explain-shift': explainShift },
  } = parseArgs({
    args: argv,
    strict: true,
    allowPositionals: false,
    options: {
      before: { type: 'string' },
      after: { type: 'string' },
      out: { type: 'string' },
      scale: { type: 'string' },
      'explain-shift': { type: 'boolean' },
    },
  });

  if (before === undefined || after === undefined || out === undefined)
    throw new Error('--before, --after and --out are required');
  const scale = rawScale === undefined ? undefined : Number(rawScale);
  if (
    scale !== undefined &&
    (!Number.isFinite(scale) || scale < LIMITS.minScale || scale > LIMITS.maxScale)
  )
    throw new Error(
      `--scale must be a device pixel ratio between ${LIMITS.minScale} and ` +
        `${LIMITS.maxScale}, got ${rawScale}`
    );
  return {
    before,
    after,
    out,
    explainShift: explainShift === true,
    ...(scale === undefined ? {} : { scale }),
  };
}

/** Runs the CLI and returns its exit code; flags and files are the only inputs. */
export async function main(
  argv: string[],
  io: ComparePairIo = { log: console.log, warn: console.error }
): Promise<number> {
  if (argv.includes('--help') || argv.includes('-h')) {
    io.log(USAGE);
    return EXIT_OK;
  }

  let args: ComparePairArgs;
  try {
    args = parsePairArgs(argv);
  } catch (error) {
    io.warn(`pixel-diff: ${messageOf(error)}`);
    io.warn(USAGE);
    return EXIT_USAGE;
  }

  const out = path.resolve(args.out);
  let report: PixelDiffReport;
  let owned: { dev: number; ino: number } | undefined;
  try {
    const before = await readFile(args.before);
    const after = await readFile(args.after);
    await mkdir(path.dirname(out), { recursive: true });
    try {
      await mkdir(out);
      owned = await lstat(out);
    } catch (error) {
      // An existing file, directory or symlink is refused instead of written into.
      if ((error as NodeJS.ErrnoException).code === 'EEXIST')
        throw new Error(`${out} already exists; pass a new --out`);
      throw error;
    }
    report = await comparePngPair({
      before,
      after,
      out,
      ...(args.scale === undefined ? {} : { scale: args.scale }),
      explainShift: args.explainShift,
    });
    const document: ComparePairReport = { status: 'compared', ...report };
    const temporary = path.join(out, `.${REPORT_FILE}.tmp`);
    await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, { flag: 'wx' });
    await rename(temporary, path.join(out, REPORT_FILE));
  } catch (error) {
    // Only the directory this call created is removed; a refused `--out` is left alone.
    if (owned !== undefined) {
      const current = await lstat(out).catch(() => undefined);
      if (current?.isDirectory() && current.dev === owned.dev && current.ino === owned.ino) {
        await rm(out, { recursive: true, force: true }).catch(() => {});
      }
    }
    const code = error instanceof PixelDiffError ? ` (${error.code})` : '';
    io.log(`pixel-diff: inconclusive${code}: ${messageOf(error)}`);
    return EXIT_INCONCLUSIVE;
  }

  const area = report.width * report.height;
  const percent = report.changedPercent.toFixed(4);
  io.log(
    report.changed
      ? `pixel-diff: changed ${report.changedPixels}/${area} px (${percent}%)`
      : `pixel-diff: unchanged 0/${area} px`
  );
  io.log(`pixel-diff: report ${path.join(out, REPORT_FILE)}`);
  return EXIT_OK;
}

const isMain =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(import.meta.filename);
if (isMain) {
  process.exitCode = await main(process.argv.slice(2));
}
