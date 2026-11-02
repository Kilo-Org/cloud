import { finding, type Finding } from '../findings';
import {
  ancestors,
  bottom,
  contains,
  contentBox,
  intersection,
  layoutRect,
  right,
  type LayoutNode,
  type LayoutTree,
  type Rect,
} from '../tree';
import {
  ROUNDING_DP,
  ROW_CHILD_MAX_HEIGHT_DP,
  ROW_MAX_HEIGHT_DP,
  SINGLE_LINE_MAX_HEIGHT_DP,
  TOLERANCE_DP,
} from './thresholds';

const fmt = (value: number) => `${Math.round(value * 10) / 10} dp`;

function overflowBeyond(rect: Rect, box: Rect, axes: { x: boolean; y: boolean }): number {
  const x = axes.x ? Math.max(box[0] - rect[0], right(rect) - right(box)) : 0;
  const y = axes.y ? Math.max(box[1] - rect[1], bottom(rect) - bottom(box)) : 0;
  return Math.max(x, y, 0);
}

function nearestScroll(node: LayoutNode): LayoutNode | undefined {
  return ancestors(node).find(ancestor => ancestor.scroll.x || ancestor.scroll.y);
}

function hasFlaggedContainer(node: LayoutNode, flagged: ReadonlySet<LayoutNode>): boolean {
  return ancestors(node).some(
    ancestor => flagged.has(ancestor) && contains(ancestor.rect, node.rect, TOLERANCE_DP)
  );
}

export function checkClipped(tree: LayoutTree): Finding[] {
  const findings: Finding[] = [];
  const flagged = new Set<LayoutNode>();
  for (const node of tree.nodes) {
    const { parent } = node;
    if (!parent) continue;
    // A node's own transform moves its descendants and never its own frame, so
    // a natively presented formSheet reports its screen at the window origin
    // and its content translated by the detent. Overflow is only a visual cut
    // when both boxes are measured in the transform-free space.
    const box = layoutRect(node);
    let measured = 0;
    let against: LayoutNode | undefined;
    const clipper = ancestors(node).find(ancestor => ancestor.clips);
    if (clipper) {
      const clipperBox = node.absolute
        ? layoutRect(clipper)
        : contentBox(clipper, tree.env.isRTL, layoutRect(clipper));
      const amount = overflowBeyond(box, clipperBox, {
        x: !clipper.scroll.x,
        y: !clipper.scroll.y,
      });
      if (amount > measured) {
        measured = amount;
        against = clipper;
      }
    }
    if (!node.absolute && node.paints) {
      const amount = overflowBeyond(box, contentBox(parent, tree.env.isRTL, layoutRect(parent)), {
        x: !parent.scroll.x,
        y: !parent.scroll.y,
      });
      if (amount > measured) {
        measured = amount;
        against = parent;
      }
    }
    if (!against || measured <= TOLERANCE_DP || hasFlaggedContainer(node, flagged)) continue;
    flagged.add(node);
    const clippedBy = against === clipper ? 'clipping ancestor' : 'parent';
    findings.push(
      finding({
        rule: 'clipped',
        severity: node.hasText ? 'error' : 'warning',
        element: node.ref,
        related: [against.ref],
        measured,
        expected: `≤ ${TOLERANCE_DP} dp`,
        unit: 'dp',
        message: `${node.path} extends ${fmt(measured)} beyond the content box of its ${clippedBy} ${against.path}; constrain its size or let the container grow.`,
      })
    );
  }
  return findings;
}

export function checkCutOff(tree: LayoutTree): Finding[] {
  const findings: Finding[] = [];
  const flagged = new Set<LayoutNode>();
  const width = tree.env.window.width;
  for (const node of tree.nodes) {
    const measured = Math.max(-node.rect[0], right(node.rect) - width);
    if (measured <= TOLERANCE_DP) continue;
    const chain = ancestors(node);
    if (chain.some(ancestor => ancestor.scroll.x || flagged.has(ancestor))) continue;
    flagged.add(node);
    findings.push(
      finding({
        rule: 'cut-off',
        severity: 'error',
        element: node.ref,
        measured,
        expected: `within window width ${width} dp`,
        unit: 'dp',
        message: `${node.path} extends ${fmt(measured)} past the screen edge; make it shrink or wrap to the window width.`,
      })
    );
  }
  return findings;
}

function intersects(a: Rect, b: Rect): boolean {
  const overlap = intersection(a, b);
  return overlap[2] > TOLERANCE_DP && overlap[3] > TOLERANCE_DP;
}

export function checkTouchOverlap(tree: LayoutTree): Finding[] {
  const findings: Finding[] = [];
  const pressables = tree.nodes.filter(node => node.pressable);
  for (let i = 0; i < pressables.length; i++) {
    for (let j = i + 1; j < pressables.length; j++) {
      const a = pressables[i];
      const b = pressables[j];
      if (nearestScroll(a) !== nearestScroll(b)) continue;
      if (!intersects(a.visibleRect, b.visibleRect)) continue;
      if (contains(a.rect, b.rect, TOLERANCE_DP) || contains(b.rect, a.rect, TOLERANCE_DP))
        continue;
      const overlap = intersection(a.visibleRect, b.visibleRect);
      findings.push(
        finding({
          rule: 'touch-overlap',
          severity: 'error',
          element: b.ref,
          related: [a.ref],
          measured: Math.min(overlap[2], overlap[3]),
          expected: `≤ ${TOLERANCE_DP} dp`,
          unit: 'dp',
          message: `Touch areas of ${b.path} and ${a.path} overlap by ${fmt(overlap[2])} × ${fmt(overlap[3])}; separate them so each tap is unambiguous.`,
        })
      );
    }
  }
  return findings;
}

export function checkOverlap(tree: LayoutTree): Finding[] {
  const findings: Finding[] = [];
  for (const node of tree.nodes) {
    const siblings = node.children.filter(
      child => !child.absolute && (child.hasText || child.pressable)
    );
    for (let i = 0; i < siblings.length; i++) {
      for (let j = i + 1; j < siblings.length; j++) {
        const a = siblings[i];
        const b = siblings[j];
        if (a.pressable && b.pressable) continue;
        if (!intersects(a.rect, b.rect)) continue;
        if (contains(a.rect, b.rect, TOLERANCE_DP) || contains(b.rect, a.rect, TOLERANCE_DP))
          continue;
        const overlap = intersection(a.rect, b.rect);
        findings.push(
          finding({
            rule: 'overlap',
            severity: 'error',
            element: b.ref,
            related: [a.ref],
            measured: Math.min(overlap[2], overlap[3]),
            expected: `≤ ${TOLERANCE_DP} dp`,
            unit: 'dp',
            message: `${b.path} overlaps its sibling ${a.path} by ${fmt(overlap[2])} × ${fmt(overlap[3])}; fix the spacing or sizing so they do not collide.`,
          })
        );
      }
    }
  }
  return findings;
}

// A block of stacked text lines (a title over a subtitle) or one wrapped line: a first-line
// alignment there is a layout choice, not a centering defect.
function isMultiLine(node: LayoutNode): boolean {
  const texts: LayoutNode[] = [];
  const pending = [node];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    if (next.isText) texts.push(next);
    pending.push(...next.children);
  }
  return texts.some(
    (text, index) =>
      text.rect[3] > SINGLE_LINE_MAX_HEIGHT_DP ||
      texts
        .slice(index + 1)
        .some(other => other.rect[1] >= bottom(text.rect) || text.rect[1] >= bottom(other.rect))
  );
}

export function checkRowAlignment(tree: LayoutTree): Finding[] {
  const findings: Finding[] = [];
  for (const node of tree.nodes) {
    const style = node.probe.style;
    if (style?.flexDirection !== 'row' && style?.flexDirection !== 'row-reverse') continue;
    if (style.alignItems === 'baseline' || node.rect[3] > ROW_MAX_HEIGHT_DP) continue;
    if (style.flexWrap === 'wrap' || style.flexWrap === 'wrap-reverse') continue;
    const items = node.children.filter(
      child => !child.absolute && child.rect[3] <= ROW_CHILD_MAX_HEIGHT_DP && !isMultiLine(child)
    );
    if (items.length < 2) continue;
    const center = (child: LayoutNode) => child.rect[1] + child.rect[3] / 2;
    const sorted = [...items].sort((a, b) => center(a) - center(b));
    const low = sorted[0];
    const high = sorted[sorted.length - 1];
    const measured = center(high) - center(low);
    if (measured <= TOLERANCE_DP) continue;
    findings.push(
      finding({
        rule: 'row-misaligned',
        severity: 'error',
        element: node.ref,
        related: [low.ref, high.ref],
        measured,
        expected: `vertical centers within ${TOLERANCE_DP} dp`,
        unit: 'dp',
        message: `Children of row ${node.path} are ${fmt(measured)} apart vertically (${low.path} vs ${high.path}); center them with items-center.`,
      })
    );
  }
  return findings;
}

export function checkTouchTargets(tree: LayoutTree): Finding[] {
  const findings: Finding[] = [];
  const { min, touch } = tree.env.tapTarget;
  const minFloor = min - ROUNDING_DP;
  const touchFloor = touch - ROUNDING_DP;
  const pressables = tree.nodes.filter(node => node.pressable);
  const size = (node: LayoutNode) => {
    const slop = node.probe.hitSlop;
    return {
      width: node.rect[2],
      height: node.rect[3],
      touchWidth: node.rect[2] + (slop ? slop.left + slop.right : 0),
      touchHeight: node.rect[3] + (slop ? slop.top + slop.bottom : 0),
    };
  };
  const meets = (node: LayoutNode) => {
    const s = size(node);
    return (
      s.width >= minFloor &&
      s.height >= minFloor &&
      s.touchWidth >= touchFloor &&
      s.touchHeight >= touchFloor
    );
  };
  for (const node of pressables) {
    const s = size(node);
    const covered = pressables.some(
      other =>
        other !== node &&
        other.rect[2] * other.rect[3] > node.rect[2] * node.rect[3] &&
        contains(other.rect, node.rect, 0) &&
        meets(other)
    );
    if (covered) continue;
    if (s.width < minFloor || s.height < minFloor) {
      const measured = Math.min(s.width, s.height);
      findings.push(
        finding({
          rule: 'touch-target',
          severity:
            tree.env.source === undefined || tree.env.source === 'probe' ? 'error' : 'warning',
          element: node.ref,
          measured,
          expected: `≥ ${min} dp`,
          unit: 'dp',
          message: `${node.path} is ${fmt(s.width)} × ${fmt(s.height)}, below the ${min} dp minimum; enlarge the pressable itself.`,
        })
      );
    } else if (s.touchWidth < touchFloor || s.touchHeight < touchFloor) {
      findings.push(
        finding({
          rule: 'touch-target',
          severity: 'warning',
          element: node.ref,
          measured: Math.min(s.touchWidth, s.touchHeight),
          expected: `≥ ${touch} dp including hitSlop`,
          unit: 'dp',
          message: `${node.path} has a ${fmt(s.touchWidth)} × ${fmt(s.touchHeight)} touch area; add hitSlop or padding to reach ${touch} dp.`,
        })
      );
    }
  }
  return findings;
}

export function checkSafeArea(tree: LayoutTree): Finding[] {
  if (tree.env.safeAreaKnown === false) return [];
  const findings: Finding[] = [];
  const flagged = new Set<LayoutNode>();
  const { safeArea, window } = tree.env;
  for (const node of tree.nodes) {
    if (!node.isText && !node.isTextInput && !node.pressable) continue;
    if (ancestors(node).some(ancestor => ancestor.scroll.y)) continue;
    const rect = node.visibleRect;
    const top = safeArea.top > 0 ? Math.min(bottom(rect), safeArea.top) - Math.max(rect[1], 0) : 0;
    const bandStart = window.height - safeArea.bottom;
    const bottomOverlap =
      safeArea.bottom > 0
        ? Math.min(bottom(rect), window.height) - Math.max(rect[1], bandStart)
        : 0;
    const measured = Math.max(top, bottomOverlap);
    if (measured <= TOLERANCE_DP || ancestors(node).some(ancestor => flagged.has(ancestor)))
      continue;
    flagged.add(node);
    const edge = top >= bottomOverlap ? 'top' : 'bottom';
    findings.push(
      finding({
        rule: 'safe-area',
        severity: 'error',
        element: node.ref,
        measured,
        expected: `outside the ${edge} safe-area inset (${edge === 'top' ? safeArea.top : safeArea.bottom} dp)`,
        unit: 'dp',
        message: `${node.path} reaches ${fmt(measured)} into the ${edge} system inset; pad the screen with the safe-area inset.`,
      })
    );
  }
  return findings;
}
