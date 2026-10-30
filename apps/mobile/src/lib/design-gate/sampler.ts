/**
 * In-app layout sampling for the design gate. The runner's inspector round trip can
 * take half a second through a tunnel, which hides a shift that happens soon after a
 * screen opens; sampling on the JS thread keeps a steady interval regardless.
 * Consecutive identical layouts collapse into one sample with a repeat count.
 */

type Layout = Readonly<{
  env: Readonly<{ route: string }>;
  nodes: readonly Readonly<{ rect: readonly number[] }>[];
}>;

export type Sample<T> = Readonly<{ t: number; repeat: number; dump: T }>;

const MAX_SAMPLES = 400;

export function createSampler<T extends Layout>(snapshot: () => T) {
  let samples: Sample<T>[] = [];
  let stopTimers: (() => void) | undefined = undefined;
  let truncated = false;

  const stop = (): readonly Sample<T>[] => {
    stopTimers?.();
    stopTimers = undefined;
    const taken = samples;
    samples = [];
    return taken;
  };

  const start = (intervalMs: number, maxMs: number) => {
    stop();
    truncated = false;
    let last = '';
    const tick = () => {
      const dump = snapshot();
      const key = `${dump.env.route}|${dump.nodes.map(node => node.rect.join(',')).join(';')}`;
      const previous = samples.at(-1);
      if (previous !== undefined && key === last) {
        samples[samples.length - 1] = { ...previous, repeat: previous.repeat + 1 };
      } else {
        last = key;
        // Keep the newest layouts so a late transition survives; the evicted head is reported.
        if (samples.length >= MAX_SAMPLES) {
          samples.shift();
          truncated = true;
        }
        samples.push({ t: Date.now(), repeat: 1, dump });
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
