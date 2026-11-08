import type { Rgba } from './pixels';
import { normalize, type ProbeDump } from './tree';

export const CAPTURE_ALIGNMENT_BUDGET_MS = 2_000;

export type TimedTree = {
  startedMs: number;
  completedMs: number;
  dump?: ProbeDump;
  error?: string;
};

export type CaptureAlignment = {
  status: 'bracketed' | 'mismatch' | 'inconclusive';
  reason: string;
  budgetMs: number;
  before: TimedTree;
  screenshot: { startedMs: number; completedMs: number };
  after: TimedTree;
  pixels: 'uniform' | 'nonuniform' | 'unavailable';
  expectedText: boolean;
};

/** Probe agreement brackets a capture; it cannot certify that native pixels painted the tree. */
export function captureAlignment(
  before: TimedTree,
  screenshot: CaptureAlignment['screenshot'],
  after: TimedTree,
  signature: (dump: ProbeDump) => string,
  observation: Pick<CaptureAlignment, 'pixels' | 'expectedText'>
): CaptureAlignment {
  const evidence: CaptureAlignment = {
    status: 'inconclusive',
    reason: 'A bracketing tree read failed; screenshot and tree correspondence is unknown.',
    budgetMs: CAPTURE_ALIGNMENT_BUDGET_MS,
    before,
    screenshot,
    after,
    pixels: observation.pixels,
    expectedText: observation.expectedText,
  };
  if (before.dump === undefined || after.dump === undefined) return evidence;
  if (signature(before.dump) !== signature(after.dump)) {
    evidence.status = 'mismatch';
    evidence.reason =
      'Screen state changed across the screenshot; pixel-to-tree rules are inconclusive.';
    return evidence;
  }
  const times = [
    before.startedMs,
    before.completedMs,
    screenshot.startedMs,
    screenshot.completedMs,
    after.startedMs,
    after.completedMs,
  ];
  if (
    times.some((time, index) => !Number.isFinite(time) || (index > 0 && time < times[index - 1])) ||
    after.completedMs - before.startedMs > CAPTURE_ALIGNMENT_BUDGET_MS
  ) {
    evidence.reason = 'Tree/screenshot timing exceeded the bounded alignment window.';
    return evidence;
  }
  if (observation.pixels === 'unavailable') {
    evidence.reason =
      'Screenshot dimensions or opaque pixel data could not be aligned to the viewport.';
    return evidence;
  }
  evidence.status = 'bracketed';
  evidence.reason =
    'Matching probe states bracket the screenshot; actual target paint is not certified.';
  return evidence;
}

/** Uniform pixels are retained as an observation, not proof that an arbitrary empty screen is wrong. */
export function screenshotObservation(
  dump: ProbeDump,
  image: Rgba
): Pick<CaptureAlignment, 'pixels' | 'expectedText'> {
  const expectedText = normalize(dump).nodes.some(
    node => node.hasText && (node.probe.text?.trim().length ?? 0) > 0
  );
  const observation: Pick<CaptureAlignment, 'pixels' | 'expectedText'> = {
    pixels: 'unavailable',
    expectedText,
  };
  const scale = dump.env.pixelRatio;
  if (
    image.width !== Math.round(dump.env.window.width * scale) ||
    image.height !== Math.round(dump.env.window.height * scale) ||
    image.data.length !== image.width * image.height * 4
  )
    return observation;
  const x0 = Math.max(0, Math.ceil(dump.env.safeArea.left * scale));
  const y0 = Math.max(0, Math.ceil(dump.env.safeArea.top * scale));
  const x1 = Math.min(
    image.width,
    Math.floor((dump.env.window.width - dump.env.safeArea.right) * scale)
  );
  const y1 = Math.min(
    image.height,
    Math.floor((dump.env.window.height - dump.env.safeArea.bottom) * scale)
  );
  if (x1 <= x0 || y1 <= y0) return observation;
  const first = (y0 * image.width + x0) * 4;
  let uniform = true;
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const offset = (y * image.width + x) * 4;
      if (image.data[offset + 3] !== 255) return observation;
      if (
        image.data[offset] !== image.data[first] ||
        image.data[offset + 1] !== image.data[first + 1] ||
        image.data[offset + 2] !== image.data[first + 2]
      )
        uniform = false;
    }
  }
  observation.pixels = uniform ? 'uniform' : 'nonuniform';
  return observation;
}
