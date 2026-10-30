import { finding, type Finding } from '../findings';
import type { LayoutNode, LayoutTree, Rect } from '../tree';
import {
  ANIMATED_SHIFT_MIN_MS,
  REST_SAMPLES,
  SHIFT_GROUP_MAX_RELATED,
  SHIFT_GROUP_VECTOR_DP,
  TOLERANCE_DP,
} from './thresholds';

const SAME_RECT_DP = 0.01;

function same(a: Rect, b: Rect): boolean {
  return a.every((value, i) => Math.abs(value - b[i]) <= SAME_RECT_DP);
}

type Shift = {
  from: LayoutNode;
  to: LayoutNode;
  dx: number;
  dy: number;
  delta: number;
  arrival: number;
  elapsed: number;
  animated: boolean;
};

function largestShift(
  byKey: readonly ReadonlyMap<string, LayoutNode>[],
  routes: readonly string[],
  key: string,
  intervalMs: number
) {
  let rest: { node: LayoutNode; sample: number; end: number } | undefined;
  let run = 0;
  let previous: LayoutNode | undefined;
  let worst: Shift | undefined;
  for (let sample = byKey.findIndex(nodes => nodes.has(key)); sample < byKey.length; sample++) {
    const node = byKey[sample].get(key);
    if (!node || routes[sample] !== routes[sample - 1]) {
      rest = undefined;
      previous = undefined;
      run = 0;
    }
    if (!node) continue;
    run = previous && same(previous.rect, node.rect) ? run + 1 : 1;
    previous = node;
    if (rest && same(node.rect, rest.node.rect) && rest.end === sample - 1) rest.end = sample;
    if (run !== REST_SAMPLES) continue;
    if (rest) {
      const [x0, y0, w0, h0] = rest.node.rect;
      const [x1, y1, w1, h1] = node.rect;
      const dx = x1 - x0;
      const dy = y1 - y0;
      const delta = Math.max(Math.abs(dx), Math.abs(dy));
      const resized = Math.abs(w1 - w0) > TOLERANCE_DP || Math.abs(h1 - h0) > TOLERANCE_DP;
      if (!resized && delta > TOLERANCE_DP && (!worst || delta > worst.delta)) {
        const arrival = sample - 1;
        const transitionMs = (arrival - (rest.end + 1)) * intervalMs;
        worst = {
          from: rest.node,
          to: node,
          dx,
          dy,
          delta,
          arrival,
          elapsed: (sample - rest.sample) * intervalMs,
          animated: transitionMs >= ANIMATED_SHIFT_MIN_MS,
        };
      }
    }
    rest = { node, sample, end: sample };
  }
  return worst;
}

function sameCause(a: Shift, b: Shift): boolean {
  return (
    a.arrival === b.arrival &&
    Math.abs(a.dx - b.dx) <= SHIFT_GROUP_VECTOR_DP &&
    Math.abs(a.dy - b.dy) <= SHIFT_GROUP_VECTOR_DP
  );
}

export function checkShift(timeline: readonly LayoutTree[], intervalMs: number): Finding[] {
  const byKey = timeline.map(tree => {
    const textCounts = new Map<string, number>();
    for (const node of tree.nodes) {
      if (node.ref.text !== undefined)
        textCounts.set(node.ref.text, (textCounts.get(node.ref.text) ?? 0) + 1);
    }
    const unique = tree.nodes.flatMap(node => {
      const identified = node.ref.testID !== undefined || node.ref.label !== undefined;
      const text = node.ref.text;
      const ambiguous = !identified && text !== undefined && (textCounts.get(text) ?? 0) > 1;
      return node.key && !ambiguous ? [[node.key, node] as const] : [];
    });
    return new Map(unique);
  });
  const shifts = [...new Set(byKey.flatMap(nodes => [...nodes.keys()]))].flatMap(key => {
    const shift = largestShift(
      byKey,
      timeline.map(tree => tree.env.route),
      key,
      intervalMs
    );
    return shift ? [shift] : [];
  });
  const groups: Shift[][] = [];
  for (const shift of shifts) {
    const group = groups.find(candidate => sameCause(candidate[0], shift));
    if (group) group.push(shift);
    else groups.push([shift]);
  }
  return groups.map(([lead, ...others]) => {
    const animated = [lead, ...others].every(shift => shift.animated);
    const who =
      others.length > 0 ? `${lead.to.path} and ${others.length} more elements` : lead.to.path;
    const moved = `${who} moved ${Math.round(lead.delta * 10) / 10} dp within ${lead.elapsed} ms after settling`;
    return finding({
      rule: 'layout-shift',
      severity: animated ? 'warning' : 'error',
      element: lead.to.ref,
      related:
        others.length > 0
          ? others.slice(0, SHIFT_GROUP_MAX_RELATED).map(shift => shift.to.ref)
          : [lead.from.ref],
      measured: lead.delta,
      expected: `≤ ${TOLERANCE_DP} dp movement after first settling`,
      unit: 'dp',
      message: animated
        ? `${moved} (animated layout shift); reserve the space instead.`
        : `${moved}; reserve the space up front so late content does not push it.`,
    });
  });
}
