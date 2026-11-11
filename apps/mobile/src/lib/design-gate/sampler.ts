/**
 * In-app screen-state sampling for the design gate. The runner's inspector round trip can
 * take half a second through a tunnel, which hides a shift that happens soon after a
 * screen opens; sampling on the JS thread keeps a steady interval regardless.
 * Consecutive identical states collapse, retaining the latest dump. State is not proof of paint.
 */

import { paintSignature, type PaintState } from './paint-state';

export type Sample<T> = Readonly<{ t: number; repeat: number; dump: T }>;

/**
 * Retention is bounded by weight, not only by count. A dump of a full screen costs
 * far more than a counter implies, so a long capture grew past the app's own heap and
 * the dev client stopped on an out-of-memory error while a matrix cell sampled a busy
 * screen. Both limits are enforced, oldest first, so a capture keeps the newest
 * layouts that fit the budget.
 *
 * The count is therefore an upper bound and nothing promises it: a screen with large
 * dumps keeps fewer than `MAX_SAMPLES` layouts, and truncation is reported whenever
 * either limit evicts.
 */
const MAX_SAMPLES = 400;
const MAX_RETAINED_CHARS = 4_000_000;

/**
 * The paint signature is the dump's own serialized text, so its length tracks what
 * the retained dump costs. It is measured once per tick, which the signature
 * already computes.
 */
export function createSampler<T extends PaintState>(snapshot: () => T) {
  let samples: Sample<T>[] = [];
  // Weight of the sample at the same index, kept beside it so the wire shape of a
  // sample does not grow a runner-only field.
  let weights: number[] = [];
  let retainedChars = 0;
  let stopTimers: (() => void) | undefined = undefined;
  let truncated = false;

  const stop = (): readonly Sample<T>[] => {
    stopTimers?.();
    stopTimers = undefined;
    const taken = samples;
    samples = [];
    weights = [];
    retainedChars = 0;
    return taken;
  };

  const start = (intervalMs: number, maxMs: number) => {
    stop();
    truncated = false;
    let last = '';
    const overBudget = () =>
      samples.length > 1 && (samples.length > MAX_SAMPLES || retainedChars > MAX_RETAINED_CHARS);
    const evictOldest = () => {
      samples.shift();
      retainedChars -= weights.shift() ?? 0;
      truncated = true;
    };
    const tick = () => {
      const dump = snapshot();
      const key = paintSignature(dump);
      const count = samples.length;
      if (count > 0 && key === last) {
        // The identical state replaces the tail, so its weight is the tail's.
        retainedChars += key.length - (weights[count - 1] ?? 0);
        weights[count - 1] = key.length;
        const previous = samples[count - 1] as Sample<T>;
        samples[count - 1] = { t: previous.t, repeat: previous.repeat + 1, dump };
        return;
      }
      last = key;
      samples.push({ t: Date.now(), repeat: 1, dump });
      weights.push(key.length);
      retainedChars += key.length;
      // Keep the newest layouts so a late transition survives; the evicted head is reported.
      while (overBudget()) {
        evictOldest();
      }
    };
    tick();
    const interval = setInterval(tick, intervalMs);
    // A runner that dies mid-run must not leave the app sampling forever.
    const deadline = setTimeout(() => {
      clearInterval(interval);
    }, maxMs);
    stopTimers = () => {
      clearInterval(interval);
      clearTimeout(deadline);
    };
  };

  return { start, stop, truncated: () => truncated };
}
