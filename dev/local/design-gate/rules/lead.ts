import { finding, type Finding } from '../findings';
import { bottom, contentBox, layoutRect, type LayoutNode, type LayoutTree } from '../tree';
import { LEADING_GAP_MAX_DP } from './thresholds';

const fmt = (value: number) => `${Math.round(value * 10) / 10} dp`;

/** A content container that places its children away from its top on purpose. */
const DISTRIBUTED = /^(center|flex-end|space-between|space-around|space-evenly)$/;

/** The highest painted node inside `block`, skipping out-of-flow subtrees. */
function topInk(block: LayoutNode): LayoutNode | undefined {
  let best: LayoutNode | undefined = block.paints ? block : undefined;
  const visit = (node: LayoutNode) => {
    for (const child of node.children) {
      if (child.absolute) continue;
      if (child.paints && (!best || layoutRect(child)[1] < layoutRect(best)[1])) best = child;
      visit(child);
    }
  };
  visit(block);
  return best;
}

/**
 * The box that holds the ink low: the innermost ancestor, up to the first block,
 * with more empty space above the ink than the allowance, and more above it
 * than below. A row that centres a line in its frame has the same space on both
 * sides and is ordinary list rhythm; space on one side only is a frame grown
 * past what it draws.
 */
function oneSidedBox(ink: LayoutNode, block: LayoutNode): LayoutNode | undefined {
  const inkTop = layoutRect(ink)[1];
  const inkBottom = bottom(layoutRect(ink));
  for (let box = ink.parent; box; box = box.parent) {
    const rect = layoutRect(box);
    const above = inkTop - rect[1];
    const below = bottom(rect) - inkBottom;
    if (above > LEADING_GAP_MAX_DP && above - below > LEADING_GAP_MAX_DP) return box;
    if (box === block) return undefined;
  }
  return undefined;
}

/**
 * The top of a vertically scrolling screen must start with what it shows. The
 * scroll content's own top padding is the screen's chosen gap below its header.
 * Two things add a hole under the title on top of it: a first block pushed down
 * by a margin, and a box in the first block that holds its content at its
 * bottom, usually a control's touch frame grown to the target size instead of
 * reaching it with `hitSlop`. Both are errors.
 */
export function checkLeadingGap(tree: LayoutTree): Finding[] {
  const findings: Finding[] = [];
  for (const scroll of tree.nodes) {
    if (!scroll.scroll.y || scroll.scroll.x) continue;
    const content = scroll.children.find(child => !child.absolute);
    if (!content) continue;
    const justify = content.probe.style?.justifyContent;
    if (typeof justify === 'string' && DISTRIBUTED.test(justify)) continue;
    const block = content.children.find(child => !child.absolute);
    if (!block) continue;
    const ink = topInk(block);
    if (!ink) continue;
    const start = contentBox(content, tree.env.isRTL, layoutRect(content))[1];
    const margin = layoutRect(block)[1] - start;
    const holder = margin > LEADING_GAP_MAX_DP ? undefined : oneSidedBox(ink, block);
    if (margin <= LEADING_GAP_MAX_DP && !holder) continue;
    const measured = layoutRect(ink)[1] - start;
    const cause = holder
      ? `${holder.path} holds it at the bottom of a taller box; reach a control's touch size with hitSlop instead of a taller box.`
      : `the first block starts ${fmt(margin)} below that padding; drop its top margin.`;
    findings.push(
      finding({
        rule: 'leading-gap',
        severity: 'error',
        element: ink.ref,
        related: [holder?.ref ?? block.ref, scroll.ref],
        measured,
        expected: `≤ ${LEADING_GAP_MAX_DP} dp below the scroll content's top padding`,
        unit: 'dp',
        message: `${ink.path}, the first thing ${scroll.path} shows, starts ${fmt(measured)} below its top padding: ${cause}`,
      })
    );
  }
  return findings;
}
