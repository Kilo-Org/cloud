/**
 * In-app screen-state sampling for the design gate. The runner's inspector round trip can
 * take half a second through a tunnel, which hides a shift that happens soon after a
 * screen opens; sampling on the JS thread keeps a steady interval regardless.
 * Consecutive identical states collapse, retaining the latest dump. State is not proof of paint.
 */

type Layout = Readonly<{
  env: Readonly<{ route: string; screen?: string }>;
  nodes: readonly Readonly<{
    rect: readonly number[];
    layoutRect?: readonly number[];
    parent?: number;
    tag?: string;
    text?: string;
    label?: string;
    testID?: string;
    role?: string;
    screenState?: number;
    style?: Readonly<Record<string, string | number>>;
  }>[];
}>;

export type Sample<T> = Readonly<{ t: number; repeat: number; dump: T }>;

const MAX_SAMPLES = 400;

/** Includes focused screen and paint inputs even when every frame stays fixed. */
export function paintSignature(dump: Layout): string {
  return JSON.stringify([
    dump.env.route,
    dump.env.screen,
    dump.nodes.map(node => [
      node.parent,
      node.tag,
      node.rect,
      node.layoutRect,
      node.text,
      node.label,
      node.testID,
      node.role,
      node.screenState,
      Object.entries(node.style ?? {}).sort(([left], [right]) => left.localeCompare(right)),
    ]),
  ]);
}

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
      const key = paintSignature(dump);
      const previous = samples.at(-1);
      if (previous !== undefined && key === last) {
        samples[samples.length - 1] = { t: previous.t, repeat: previous.repeat + 1, dump };
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
