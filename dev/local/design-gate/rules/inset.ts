import { finding, type Finding } from '../findings';
import { bottom, right, type LayoutTree, type Rect } from '../tree';
import {
  INSET_ASYMMETRY_RATIO,
  INSET_MAX_HEIGHT_SHARE,
  INSET_MIN_ASYMMETRY_DP,
  INSET_MIN_GAP_DP,
  INSET_MIN_WIDTH_SHARE,
} from './thresholds';

const fmt = (value: number) => `${Math.round(value * 10) / 10} dp`;

function union(rects: readonly Rect[]): Rect {
  const x = Math.min(...rects.map(rect => rect[0]));
  const y = Math.min(...rects.map(rect => rect[1]));
  return [x, y, Math.max(...rects.map(right)) - x, Math.max(...rects.map(bottom)) - y];
}

function asymmetry(start: number, end: number, size: number): number | undefined {
  if (start <= INSET_MIN_GAP_DP || end <= INSET_MIN_GAP_DP) return undefined;
  const difference = Math.abs(start - end);
  return difference > Math.max(INSET_MIN_ASYMMETRY_DP, INSET_ASYMMETRY_RATIO * size)
    ? difference
    : undefined;
}

export function checkInsetAsymmetry(tree: LayoutTree): Finding[] {
  const findings: Finding[] = [];
  const maxHeight = tree.env.window.height * INSET_MAX_HEIGHT_SHARE;
  for (const node of tree.nodes) {
    if (!node.hasContainer || node.isControl || node.scroll.x || node.scroll.y) continue;
    const [x, y, width, height] = node.rect;
    if (height > maxHeight) continue;
    const children = node.children.filter(child => !child.absolute);
    if (children.length === 0) continue;
    const content = union(children.map(child => child.rect));
    const { safeArea, window } = tree.env;
    const top = Math.max(0, content[1] - y - (y <= 1 ? safeArea.top : 0));
    const bottomGap = Math.max(
      0,
      bottom(node.rect) -
        bottom(content) -
        (bottom(node.rect) >= window.height - 1 ? safeArea.bottom : 0)
    );
    const left = content[0] - x;
    const rightGap = right(node.rect) - right(content);
    const vertical = asymmetry(top, bottomGap, height);
    const horizontal =
      content[2] >= INSET_MIN_WIDTH_SHARE * width ? asymmetry(left, rightGap, width) : undefined;
    const report = (measured: number, gaps: string) =>
      findings.push(
        finding({
          rule: 'inset-asymmetry',
          severity: 'warning',
          element: node.ref,
          related: children.map(child => child.ref),
          measured,
          expected: 'matching insets on opposite sides',
          unit: 'dp',
          message: `${node.path} has ${gaps}; balance the padding or center the content.`,
        })
      );
    if (vertical !== undefined)
      report(vertical, `top gap ${fmt(top)} vs bottom gap ${fmt(bottomGap)}`);
    if (horizontal !== undefined)
      report(horizontal, `left gap ${fmt(left)} vs right gap ${fmt(rightGap)}`);
  }
  return findings;
}
