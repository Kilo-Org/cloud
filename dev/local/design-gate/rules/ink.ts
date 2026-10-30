import { finding, type Finding } from '../findings';
import { inkBox, type Rgba } from '../pixels';
import { bottom, right, type LayoutNode, type LayoutTree } from '../tree';
import {
  CONTROL_MAX_HEIGHT_DP,
  INK_ASYMMETRY_RATIO,
  INK_MAX_COVERAGE,
  INK_MIN_ASYMMETRY_DP,
  INK_MIN_COVERAGE,
} from './thresholds';

function candidate(node: LayoutNode): boolean {
  if (node.rect[3] > CONTROL_MAX_HEIGHT_DP) return false;
  if (node.isControl) return node.hasContainer;
  return node.isTextInput && (node.probe.lines ?? 1) === 1;
}

function fullyVisible(node: LayoutNode): boolean {
  return node.visibleRect.every((value, i) => Math.abs(value - node.rect[i]) < 0.01);
}

function numericStyle(node: LayoutNode, key: string): number {
  const value = node.probe.style?.[key];
  return typeof value === 'number' ? value : 0;
}

export function checkInkCentering(tree: LayoutTree, image: Rgba): Finding[] {
  const ratio = tree.env.pixelRatio;
  if (Math.abs(image.width - tree.env.window.width * ratio) > 2) return [];
  const findings: Finding[] = [];
  for (const node of tree.nodes) {
    if (!candidate(node) || !fullyVisible(node)) continue;
    const [x, y, width, height] = node.rect;
    const ink = inkBox(
      image,
      [x * ratio, y * ratio, width * ratio, height * ratio],
      Math.round(numericStyle(node, 'borderWidth') * ratio) + 1,
      numericStyle(node, 'borderRadius') * ratio
    );
    if (!ink || ink.coverage < INK_MIN_COVERAGE || ink.coverage > INK_MAX_COVERAGE) continue;
    const vertical =
      Math.abs(ink.box[1] - ink.bounds[1] - (bottom(ink.bounds) - bottom(ink.box))) / ratio;
    const verticalLimit = Math.max(INK_MIN_ASYMMETRY_DP, INK_ASYMMETRY_RATIO * height);
    const style = node.probe.style;
    const checkHorizontal =
      !node.isTextInput &&
      !node.hasText &&
      (style?.justifyContent === 'center' || style?.alignItems === 'center');
    const horizontal = checkHorizontal
      ? Math.abs(ink.box[0] - ink.bounds[0] - (right(ink.bounds) - right(ink.box))) / ratio
      : 0;
    const horizontalLimit = Math.max(INK_MIN_ASYMMETRY_DP, INK_ASYMMETRY_RATIO * width);
    const verticalOff = vertical > verticalLimit;
    const horizontalOff = horizontal > horizontalLimit;
    if (!verticalOff && !horizontalOff) continue;
    const axis =
      verticalOff && horizontalOff
        ? 'vertically and horizontally'
        : verticalOff
          ? 'vertically'
          : 'horizontally';
    const measured = verticalOff ? vertical : horizontal;
    const limit = verticalOff ? verticalLimit : horizontalLimit;
    findings.push(
      finding({
        rule: 'ink-off-center',
        severity: 'warning',
        element: node.ref,
        measured,
        expected: `gap asymmetry ≤ ${Math.round(limit * 10) / 10} dp`,
        unit: 'dp',
        message: `Visible content of ${node.path} sits ${Math.round(measured * 10) / 10} dp off center ${axis}; balance the padding or alignment.`,
      })
    );
  }
  return findings;
}
