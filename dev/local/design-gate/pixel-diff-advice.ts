import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { comparePngPair, type PixelDiffReport } from '../pixel-diff/compare';

/**
 * The advisory pixel-diff pass behind `compare --pixel-diff`.
 *
 * It runs after the comparison's own provenance, dump, environment and
 * readiness checks, reads only the captures those checks already bound, and
 * writes its evidence beside the comparison instead of inside it. Nothing here
 * can change a comparison's status, findings or exit code: an unavailable,
 * corrupt or partial pair becomes an explicit `inconclusive` entry with a
 * reason, never an empty diff that reads as "no change".
 */

/** A capture artifact the receipt bound: the run-relative path and its digest. */
export type ReceiptArtifact = { path: string; sha256: string };

/** One revision's receipt-bound run, reduced to what the advisory pass reads. */
export type PixelDiffRevision = {
  /** The capture run directory the receipt belongs to. */
  dir: string;
  artifacts: readonly ReceiptArtifact[];
  cells: readonly {
    id: string;
    config: unknown;
    screens: readonly { target: string; dump: string; screenshot: string }[];
  }[];
  /**
   * Readiness failures already reported by the pair, in `targetReadiness`'s own
   * shapes: `<cell>/<target>: reason` for one screen, `<cell>: reason` for a
   * coverage failure of the whole cell, and a bare reason for the whole run.
   */
  readiness: readonly string[];
};

/** The comparator contract shared with the standalone module; tests inject a stub. */
export type PixelComparator = (input: {
  before: Buffer;
  after: Buffer;
  out: string;
  scale?: number;
  explainShift?: boolean;
  chrome?: { top: number; bottom: number };
}) => Promise<PixelDiffReport>;

export type PixelDiffCellResult = {
  cell: string;
  target: string;
  status: 'changed' | 'unchanged' | 'inconclusive';
  /** Why this cell has no pixel result; present exactly when the status is inconclusive. */
  reason?: string;
  width?: number;
  height?: number;
  changedPixels?: number;
  changedPercent?: number;
  regions?: PixelDiffReport['regions'];
  regionsTruncated?: boolean;
  shift?: PixelDiffReport['shift'];
  chrome?: PixelDiffReport['chrome'];
  /** Explanations about the evidence itself, e.g. why no chrome split is claimed. */
  notes?: string[];
  /** Paths relative to the comparison directory; absent when nothing was written. */
  artifacts?: { comparison: string; focus?: string };
};

export type PixelDiffSummary = {
  version: 1;
  /** This evidence never decides a gate result; the gate's own findings do. */
  advisory: true;
  status: 'compared' | 'inconclusive';
  explainShift: boolean;
  cells: PixelDiffCellResult[];
  reasons: string[];
  /** The written report, relative to the comparison directory. */
  report?: string;
};

export type PixelDiffAdvisoryOptions = {
  /** The comparison directory, already created and owned by `compareProof`. */
  out: string;
  base: PixelDiffRevision;
  head: PixelDiffRevision;
  explainShift: boolean;
  /**
   * Reasons the comparison itself already called the pair inconclusive (device
   * environments differ, matrix cells differ, restoration failed). A pixel diff
   * over two runs the gate refused to compare would read as a clean result.
   */
  pairReasons?: readonly string[];
  /** Defaults to the pinned comparator; tests inject their own. */
  compare?: PixelComparator;
};

/** A per-cell reason a pixel comparison cannot be made; never a fabricated zero. */
class Unavailable extends Error {
  override name = 'PixelDiffUnavailable';
}

/** A caught failure's message, the one form every advisory reason uses. */
function failureText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * A PNG's intrinsic size from its header, so an unequal pair is refused before
 * any decoder runs. Returns undefined for bytes that are not a PNG.
 */
export function pngSize(bytes: Buffer): { width: number; height: number } | undefined {
  if (bytes.length < 24) return undefined;
  if (bytes.readUInt32BE(0) !== 0x89504e47) return undefined;
  if (bytes.readUInt32BE(4) !== 0x0d0a1a0a) return undefined;
  if (bytes.toString('latin1', 12, 16) !== 'IHDR') return undefined;
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (width === 0 || height === 0) return undefined;
  return { width, height };
}

/** Resolves a run-relative artifact, refusing anything outside the run directory. */
export function containedPath(dir: string, relative: string): string {
  const root = fs.realpathSync(dir);
  const resolved = fs.realpathSync(path.resolve(root, relative));
  if (!resolved.startsWith(`${root}${path.sep}`)) {
    throw new Unavailable(`artifact escapes its run directory: ${relative}`);
  }
  return resolved;
}

/**
 * Reads an artifact and hashes the exact bytes it returns, so the digest that
 * authorises a comparison is the digest of the buffer the comparator receives.
 */
function readBoundBytes(revision: PixelDiffRevision, relative: string): Buffer {
  const recorded = revision.artifacts.find(artifact => artifact.path === relative);
  if (recorded === undefined) throw new Unavailable(`the receipt bound no ${relative}`);
  const bytes = fs.readFileSync(containedPath(revision.dir, relative));
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (sha256 !== recorded.sha256) {
    throw new Unavailable(`the bytes of ${relative} changed since the receipt`);
  }
  return bytes;
}

type DumpEnv = {
  pixelRatio: number;
  window: { height: number };
  safeArea: { top: number; bottom: number };
  safeAreaKnown?: boolean;
};

function dumpEnv(bytes: Buffer, relative: string): DumpEnv {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new Unavailable(`${relative} is not a readable capture dump`);
  }
  const env = (parsed as { env?: Partial<DumpEnv> } | null)?.env;
  const pixelRatio = env?.pixelRatio;
  const safeArea = env?.safeArea;
  const windowHeight = env?.window?.height;
  if (
    typeof pixelRatio !== 'number' ||
    !Number.isFinite(pixelRatio) ||
    pixelRatio <= 0 ||
    typeof windowHeight !== 'number' ||
    !Number.isFinite(windowHeight) ||
    windowHeight <= 0 ||
    typeof safeArea?.top !== 'number' ||
    typeof safeArea?.bottom !== 'number' ||
    !Number.isFinite(safeArea.top) ||
    !Number.isFinite(safeArea.bottom)
  ) {
    throw new Unavailable(`${relative} carries no pixel ratio, window and safe-area insets`);
  }
  return {
    pixelRatio,
    window: { height: windowHeight },
    safeArea: { top: safeArea.top, bottom: safeArea.bottom },
    ...(env?.safeAreaKnown === undefined ? {} : { safeAreaKnown: env.safeAreaKnown }),
  };
}

/**
 * The physical-pixel bands the two dumps place the system chrome in. Both
 * insets are reported, never masked, and the band covers the union so a capture
 * whose inset grew keeps the whole status bar inside it.
 *
 * A band is only reported when the dump's window covers exactly the captured
 * image: clipping or padding the capture would shift every band by the same
 * amount, and a band that lands on the wrong rows is worse than none.
 */
function chromeBands(
  base: DumpEnv,
  head: DumpEnv,
  height: number
): { chrome?: { top: number; bottom: number }; note?: string } {
  if (base.pixelRatio !== head.pixelRatio) {
    throw new Unavailable(
      `the device pixel ratios differ (${base.pixelRatio} and ${head.pixelRatio})`
    );
  }
  // An unknown inset is not an inset of zero: the band would silently claim a
  // system bar area that was never measured, so the split is left out instead.
  if (base.safeAreaKnown === false || head.safeAreaKnown === false) {
    return {
      note: 'the dumps do not report measured safe-area insets, so no system chrome split is claimed',
    };
  }
  const ratio = base.pixelRatio;
  const windowPx = Math.round(Math.max(base.window.height, head.window.height) * ratio);
  if (windowPx !== height) {
    return {
      note: `the captured image is ${height} px tall but the dumps describe a ${windowPx} px window, so no system chrome split is claimed`,
    };
  }
  const top = Math.round(Math.max(base.safeArea.top, head.safeArea.top) * ratio);
  const bottom = Math.round(Math.max(base.safeArea.bottom, head.safeArea.bottom) * ratio);
  if (!Number.isFinite(top) || !Number.isFinite(bottom) || top < 0 || bottom < 0) {
    throw new Unavailable('the safe-area insets are not usable physical heights');
  }
  if (top + bottom >= height) {
    throw new Unavailable(
      `the reported chrome bands (${top}+${bottom} px) do not fit a ${height} px capture`
    );
  }
  return top === 0 && bottom === 0 ? {} : { chrome: { top, bottom } };
}

/** A cell/target name that can name a directory under the comparison output. */
function safeSegment(name: string, kind: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)) {
    throw new Unavailable(`the ${kind} name ${JSON.stringify(name)} cannot name an artifact path`);
  }
  return name;
}

/**
 * The readiness failures a revision reported, split by what they can block.
 *
 * `targetReadiness` names three scopes:
 *
 * - `<cell>/<target>: reason` blocks that one screen; its siblings, in that cell
 *   and in every other cell, keep their comparison.
 * - `<cell>: reason` is a coverage failure (the cell's targets differ from the
 *   manifest, or a target it never captured), so every target of that cell is
 *   blocked while unrelated cells keep their comparison.
 * - a reason with no cell at all ("Duplicate matrix cells", "Findings are
 *   outside the prepared target matrix") describes the run, so it blocks every
 *   cell of that run.
 *
 * An entry whose scope cannot be read is treated as run-level: the pass never
 * infers a valid readiness from a key it did not recognise.
 */
type ReadinessBlocks = {
  run: string[];
  cells: Map<string, string>;
  targets: Map<string, string>;
};

/** The scopes of one revision's readiness list, keyed the way it names them. */
function readinessReasons(readiness: readonly string[]): ReadinessBlocks {
  const blocks: ReadinessBlocks = { run: [], cells: new Map(), targets: new Map() };
  for (const entry of readiness) {
    const separator = entry.indexOf(': ');
    const scope = separator < 0 ? '' : entry.slice(0, separator);
    const reason = separator < 0 ? entry : entry.slice(separator + 2);
    const slash = scope.indexOf('/');
    // A cell id never contains a slash, so a `/` marks a `<cell>/<target>` scope.
    if (slash < 0) {
      if (scope === '') blocks.run.push(entry);
      else blocks.cells.set(scope, reason);
      continue;
    }
    const cell = scope.slice(0, slash);
    const target = scope.slice(slash + 1);
    if (cell === '' || target === '' || target.includes('/')) {
      blocks.run.push(entry);
      continue;
    }
    blocks.targets.set(scope, reason);
  }
  return blocks;
}

/**
 * One reason a cell cannot be compared for, most specific first: the target's
 * own block, then a coverage failure of its cell. Run-level failures are
 * handled before this runs, since they block every cell. Callers use it also for
 * a screen only one run captured, where a readiness failure naming that screen
 * explains the gap better than the bare "no such cell" text. The sibling
 * targets of a per-target block keep their comparison.
 */
function blockedReason(
  base: ReadinessBlocks,
  head: ReadinessBlocks,
  cell: string,
  target: string
): string | undefined {
  return (
    base.targets.get(`${cell}/${target}`) ??
    head.targets.get(`${cell}/${target}`) ??
    base.cells.get(cell) ??
    head.cells.get(cell)
  );
}

function artifactSuffix(report: PixelDiffReport): { comparison: string; focus?: string } {
  const comparison = report.artifacts?.comparison;
  if (typeof comparison !== 'string' || comparison.length === 0) {
    throw new Unavailable('the comparator returned no comparison image');
  }
  for (const relative of [comparison, report.artifacts.focus]) {
    if (relative === undefined) continue;
    if (path.isAbsolute(relative) || relative.split(path.sep).includes('..')) {
      throw new Unavailable(`the comparator returned an unsafe artifact path: ${relative}`);
    }
  }
  const focus = report.artifacts.focus;
  return { comparison, ...(focus === undefined ? {} : { focus }) };
}

/** A directory the advisory pass created itself, identified by inode. */
type DirectoryIdentity = { dev: number; ino: number };

/**
 * A path this pass may write into: a real directory, never a symbolic link. A
 * link on the way would send the artifacts outside the comparison directory and
 * make the cleanup below delete something the comparison never wrote.
 */
function realDirectory(dir: string): void {
  const stat = fs.lstatSync(dir);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Unavailable(`${dir} is not a real directory this pass can own`);
  }
}

/**
 * Claims `out/pixel-diff/<cell>/<target>` for one cell.
 *
 * The two parents are created when missing and must be real directories; the
 * leaf is created exclusively, so an existing file, directory or symbolic link
 * is refused instead of written into and later removed. Returns the leaf's
 * identity so a cleanup can prove it is still the directory this pass made.
 */
function claimCellDir(
  out: string,
  cell: string,
  target: string
): { dir: string; identity: DirectoryIdentity } {
  let parent = out;
  for (const segment of ['pixel-diff', cell]) {
    parent = path.join(parent, segment);
    if (fs.existsSync(parent)) {
      realDirectory(parent);
      continue;
    }
    try {
      fs.mkdirSync(parent);
    } catch (error) {
      // A dangling symbolic link is invisible to `existsSync` but still refuses
      // the create, so the refusal is re-read rather than reported as a crash.
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      realDirectory(parent);
    }
  }
  const dir = path.join(parent, target);
  try {
    fs.mkdirSync(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Unavailable('a pixel diff for this cell already exists');
    }
    throw error;
  }
  const stat = fs.lstatSync(dir);
  return { dir, identity: { dev: stat.dev, ino: stat.ino } };
}

/**
 * Removes a failed cell's directory only when it is still the one this pass
 * created. A path that became a link or another directory is left in place: an
 * advisory pass never deletes evidence it cannot prove it wrote.
 */
function releaseCellDir(dir: string, identity: DirectoryIdentity): void {
  let current: fs.Stats;
  try {
    current = fs.lstatSync(dir);
  } catch {
    return;
  }
  if (
    !current.isDirectory() ||
    current.isSymbolicLink() ||
    current.dev !== identity.dev ||
    current.ino !== identity.ino
  ) {
    return;
  }
  fs.rmSync(dir, { recursive: true, force: true });
}

async function diffCell(args: {
  options: PixelDiffAdvisoryOptions;
  base: PixelDiffRevision;
  head: PixelDiffRevision;
  cell: string;
  target: string;
  baseScreen: { target: string; dump: string; screenshot: string };
  headScreen: { target: string; dump: string; screenshot: string };
}): Promise<PixelDiffCellResult> {
  const { options, cell, target } = args;
  const comparison = options.compare ?? comparePngPair;
  const baseBytes = readBoundBytes(args.base, args.baseScreen.screenshot);
  const headBytes = readBoundBytes(args.head, args.headScreen.screenshot);
  const baseSize = pngSize(baseBytes);
  const headSize = pngSize(headBytes);
  if (baseSize === undefined || headSize === undefined) {
    throw new Unavailable('a captured screenshot is not a PNG');
  }
  if (baseSize.width !== headSize.width || baseSize.height !== headSize.height) {
    const before = `${baseSize.width}x${baseSize.height}`;
    const after = `${headSize.width}x${headSize.height}`;
    throw new Unavailable(
      `the screenshot dimensions differ (${before} and ${after}); a native pair must be captured at one window size`
    );
  }
  const baseEnv = dumpEnv(readBoundBytes(args.base, args.baseScreen.dump), args.baseScreen.dump);
  const headEnv = dumpEnv(readBoundBytes(args.head, args.headScreen.dump), args.headScreen.dump);
  const bands = chromeBands(baseEnv, headEnv, baseSize.height);
  // Both segments are validated once, then the claim refuses an occupied path
  // and returns the directory to write into, so the comparator never creates
  // the leaf itself.
  const cellSegment = safeSegment(cell, 'cell');
  const targetSegment = safeSegment(target, 'target');
  const owned = claimCellDir(options.out, cellSegment, targetSegment);
  const cellDir = owned.dir;
  let report: PixelDiffReport;
  let suffix: { comparison: string; focus?: string };
  try {
    report = await comparison({
      before: baseBytes,
      after: headBytes,
      out: cellDir,
      scale: baseEnv.pixelRatio,
      explainShift: options.explainShift,
      ...(bands.chrome === undefined ? {} : { chrome: bands.chrome }),
    });
    if (report.width !== baseSize.width || report.height !== baseSize.height) {
      throw new Unavailable(
        `the comparator reported ${report.width}x${report.height} for a ${baseSize.width}x${baseSize.height} pair`
      );
    }
    suffix = artifactSuffix(report);
  } catch (error) {
    // A failed comparison leaves no half-written cell artifacts behind, and the
    // cleanup only ever removes the directory this pass created itself.
    releaseCellDir(owned.dir, owned.identity);
    throw error;
  }
  const prefix = path.posix.join('pixel-diff', cell, target);
  const artifacts = {
    comparison: path.posix.join(prefix, suffix.comparison),
    ...(suffix.focus === undefined ? {} : { focus: path.posix.join(prefix, suffix.focus) }),
  };
  return {
    cell,
    target,
    status: report.changed ? 'changed' : 'unchanged',
    width: report.width,
    height: report.height,
    changedPixels: report.changedPixels,
    changedPercent: report.changedPercent,
    regions: report.regions,
    regionsTruncated: report.regionsTruncated,
    ...(report.shift === undefined ? {} : { shift: report.shift }),
    ...(report.chrome === undefined ? {} : { chrome: report.chrome }),
    ...(bands.note === undefined ? {} : { notes: [bands.note] }),
    artifacts,
  };
}

function inconclusive(cell: string, target: string, reason: string): PixelDiffCellResult {
  return { cell, target, status: 'inconclusive', reason };
}

/**
 * Compares every cell and target both runs captured under one configuration,
 * with valid receipts and no readiness failure. A cell that cannot be compared
 * keeps an explicit inconclusive entry, so the report never reads as an empty
 * diff over screens that were never compared.
 */
async function collect(
  options: PixelDiffAdvisoryOptions
): Promise<{ cells: PixelDiffCellResult[]; reasons: string[] }> {
  const cells: PixelDiffCellResult[] = [];
  const reasons: string[] = [];
  const baseCells = new Map(options.base.cells.map(cell => [cell.id, cell]));
  const headIds = new Set(options.head.cells.map(cell => cell.id));
  // A pair the gate already refused to compare (differing devices, matrix or a
  // failed restore) is not a pair a pixel diff can speak about: every cell would
  // be a comparison across two different captures.
  if (options.pairReasons?.length) {
    const pairReason = `the comparison already called this pair inconclusive: ${options.pairReasons.join('; ')}`;
    const emitted = new Set<string>();
    for (const run of [options.head, options.base]) {
      for (const cell of run.cells) {
        for (const screen of cell.screens) {
          const key = `${cell.id}/${screen.target}`;
          if (emitted.has(key)) continue;
          emitted.add(key);
          cells.push(inconclusive(cell.id, screen.target, pairReason));
        }
      }
    }
    if (cells.length === 0) reasons.push(pairReason);
    return { cells, reasons };
  }
  const scopes = {
    base: readinessReasons(options.base.readiness),
    head: readinessReasons(options.head.readiness),
  };
  // A `<cell>` or `<cell>/<target>` entry naming a cell neither run captured
  // cannot be attached to any comparison, so it is not dropped: the pair has no
  // evidence that cell was ever ready.
  const captured = new Set([...options.base.cells, ...options.head.cells].map(cell => cell.id));
  for (const scope of [scopes.base, scopes.head]) {
    for (const [key, reason] of [...scope.cells.entries(), ...scope.targets.entries()]) {
      if (captured.has(key.split('/')[0])) continue;
      scope.run.push(`${key}: ${reason}`);
      scope.cells.delete(key);
      scope.targets.delete(key);
    }
  }
  // A run-level failure (duplicate matrix cells, findings outside the matrix)
  // means no cell of that run describes its screens, so nothing is compared and
  // every cell says why. A per-cell failure never takes this path: its siblings
  // keep their comparison.
  const runBlocked = [
    ...new Set([
      ...scopes.base.run.map(reason => `base: ${reason}`),
      ...scopes.head.run.map(reason => `head: ${reason}`),
    ]),
  ];
  if (runBlocked.length > 0) {
    const reason = `the run reported a readiness failure covering every cell: ${runBlocked.join('; ')}`;
    const emitted = new Set<string>();
    for (const run of [options.head, options.base]) {
      for (const cell of run.cells) {
        for (const screen of cell.screens) {
          const key = `${cell.id}/${screen.target}`;
          if (emitted.has(key)) continue;
          emitted.add(key);
          cells.push(inconclusive(cell.id, screen.target, reason));
        }
      }
    }
    if (cells.length === 0) reasons.push(reason);
    return { cells, reasons };
  }
  for (const baseCell of options.base.cells) {
    if (headIds.has(baseCell.id)) continue;
    for (const screen of baseCell.screens) {
      // A readiness failure that names this cell is the sharper reason: it says
      // why the head had nothing to compare against, not just that it did not.
      cells.push(
        inconclusive(
          baseCell.id,
          screen.target,
          blockedReason(scopes.base, scopes.head, baseCell.id, screen.target) ??
            'the head run captured no such cell'
        )
      );
    }
  }
  for (const headCell of options.head.cells) {
    const baseCell = baseCells.get(headCell.id);
    for (const headScreen of headCell.screens) {
      if (baseCell === undefined) {
        cells.push(
          inconclusive(
            headCell.id,
            headScreen.target,
            blockedReason(scopes.base, scopes.head, headCell.id, headScreen.target) ??
              'the base run captured no such cell'
          )
        );
        continue;
      }
      const cellBlocked = blockedReason(scopes.base, scopes.head, headCell.id, headScreen.target);
      if (cellBlocked !== undefined) {
        cells.push(inconclusive(headCell.id, headScreen.target, cellBlocked));
        continue;
      }
      if (JSON.stringify(baseCell.config) !== JSON.stringify(headCell.config)) {
        cells.push(
          inconclusive(
            headCell.id,
            headScreen.target,
            'the two runs captured this cell under different configurations'
          )
        );
        continue;
      }
      const baseScreen = baseCell.screens.find(screen => screen.target === headScreen.target);
      if (baseScreen === undefined) {
        cells.push(
          inconclusive(
            headCell.id,
            headScreen.target,
            'the base run captured no such target in this cell'
          )
        );
        continue;
      }
      try {
        cells.push(
          await diffCell({
            options,
            base: options.base,
            head: options.head,
            cell: headCell.id,
            target: headScreen.target,
            baseScreen,
            headScreen,
          })
        );
      } catch (error) {
        cells.push(inconclusive(headCell.id, headScreen.target, failureText(error)));
      }
    }
    const headTargets = new Set(headCell.screens.map(screen => screen.target));
    for (const baseScreen of baseCell?.screens ?? []) {
      if (headTargets.has(baseScreen.target)) continue;
      cells.push(
        inconclusive(
          headCell.id,
          baseScreen.target,
          blockedReason(scopes.base, scopes.head, headCell.id, baseScreen.target) ??
            'the head run captured no such target'
        )
      );
    }
  }
  if (!cells.some(entry => entry.status !== 'inconclusive')) {
    reasons.push('no cell of this pair could be compared');
  }
  return { cells, reasons };
}

/**
 * Runs the advisory pass and writes `pixel-diff.json` beside `comparison.json`.
 * It never throws: a failure becomes an inconclusive summary whose reason names
 * what went wrong, so a comparison keeps the result it already published.
 */
export async function runPixelDiffAdvisory(
  options: PixelDiffAdvisoryOptions
): Promise<PixelDiffSummary> {
  let cells: PixelDiffCellResult[] = [];
  const reasons: string[] = [];
  try {
    const collected = await collect(options);
    cells = collected.cells;
    reasons.push(...collected.reasons);
  } catch (error) {
    reasons.push(`the pixel diff could not run: ${failureText(error)}`);
  }
  const summary: PixelDiffSummary = {
    version: 1,
    advisory: true,
    status: cells.some(entry => entry.status !== 'inconclusive') ? 'compared' : 'inconclusive',
    explainShift: options.explainShift,
    cells,
    reasons,
  };
  try {
    const tmp = path.join(options.out, '.pixel-diff.json.tmp');
    fs.writeFileSync(tmp, `${JSON.stringify(summary, null, 2)}\n`, { flag: 'wx' });
    fs.renameSync(tmp, path.join(options.out, 'pixel-diff.json'));
    return { ...summary, report: 'pixel-diff.json' };
  } catch (error) {
    return {
      ...summary,
      status: 'inconclusive',
      reasons: [...reasons, `the pixel diff report could not be written: ${failureText(error)}`],
    };
  }
}
