import { finding, type Finding } from '../findings';
import { ancestors, right, type LayoutNode, type LayoutTree } from '../tree';
import { TOLERANCE_DP } from './thresholds';

function insideHorizontalScroll(node: LayoutNode): boolean {
  return ancestors(node).some(ancestor => ancestor.scroll.x);
}

const centerX = (node: LayoutNode) => node.rect[0] + node.rect[2] / 2;
const round = (value: number) => Math.round(value * 10) / 10;

function rowOrder(
  container: LayoutNode,
  mirrored: LayoutNode,
  rtlByPath: ReadonlyMap<string, LayoutNode>
): Finding | undefined {
  const direction = container.probe.style?.flexDirection;
  if (direction !== 'row' && direction !== 'row-reverse') return undefined;
  const pairs = container.children.flatMap(child => {
    const match = rtlByPath.get(child.structuralPath);
    return !child.absolute && match?.parent === mirrored && !match.absolute
      ? [{ child, match }]
      : [];
  });
  if (pairs.length < 2) return undefined;
  const ltrOrder = [...pairs]
    .sort((a, b) => centerX(a.child) - centerX(b.child))
    .map(pair => pair.child.structuralPath);
  const rtlOrder = [...pairs]
    .sort((a, b) => centerX(a.match) - centerX(b.match))
    .map(pair => pair.child.structuralPath);
  const misplaced = ltrOrder.filter((path, i) => path !== rtlOrder[rtlOrder.length - 1 - i]).length;
  if (misplaced === 0) return undefined;
  return finding({
    rule: 'rtl-mirror',
    severity: 'warning',
    element: mirrored.ref,
    related: pairs.map(pair => pair.match.ref),
    measured: misplaced / pairs.length,
    expected: 'children in reversed left-to-right order',
    unit: 'ratio',
    message: `Children of row ${mirrored.path} keep their LTR order in RTL; lay the row out with start/end so it mirrors.`,
  });
}

function edgeAnchor(node: LayoutNode, mirrored: LayoutNode): Finding | undefined {
  const parent = node.parent;
  const mirroredParent = mirrored.parent;
  if (!parent || !mirroredParent) return undefined;
  const ltrStart = node.rect[0] - parent.rect[0];
  const ltrEnd = right(parent.rect) - right(node.rect);
  const rtlStart = right(mirroredParent.rect) - right(mirrored.rect);
  const rtlEnd = mirrored.rect[0] - mirroredParent.rect[0];
  const measured = Math.min(Math.abs(ltrStart - rtlStart), Math.abs(ltrEnd - rtlEnd));
  if (measured <= TOLERANCE_DP) return undefined;
  return finding({
    rule: 'rtl-mirror',
    severity: 'warning',
    element: mirrored.ref,
    related: [node.ref],
    measured,
    expected: `start or end inset mirrored within ${TOLERANCE_DP} dp`,
    unit: 'dp',
    message: `Absolute ${mirrored.path} is not mirrored in RTL: start inset ${round(ltrStart)} dp in LTR vs ${round(rtlStart)} dp in RTL; position it with start/end instead of left/right.`,
  });
}

export function checkMirror(ltr: LayoutTree, rtl: LayoutTree): Finding[] {
  const rtlByPath = new Map(rtl.nodes.map(node => [node.structuralPath, node]));
  const findings: Finding[] = [];
  for (const node of ltr.nodes) {
    const mirrored = rtlByPath.get(node.structuralPath);
    if (!mirrored || insideHorizontalScroll(node) || insideHorizontalScroll(mirrored)) continue;
    const order = rowOrder(node, mirrored, rtlByPath);
    if (order) findings.push(order);
    const parentMatched =
      node.parent && mirrored.parent?.structuralPath === node.parent.structuralPath;
    if (node.absolute && mirrored.absolute && parentMatched) {
      const anchor = edgeAnchor(node, mirrored);
      if (anchor) findings.push(anchor);
    }
  }
  return findings;
}
