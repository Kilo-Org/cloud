import { finding, type Finding } from '../findings';
import {
  bottom,
  contentBox,
  layoutRect,
  type LayoutNode,
  type LayoutTree,
  type ProbeEnv,
  type Rect,
} from '../tree';
import { LEADING_GAP_MAX_DP, TOLERANCE_DP } from './thresholds';

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
  if (ink === block) return undefined;
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
 * Whether another vertical scroller inside this scroll places the ink.
 *
 * The screen's own scroller is not the only one a dump reports: the app mounts
 * one ScrollView around the whole window, and a data state, a transcript or a
 * long form nests its own scroller inside it. The outer scroller then shows, as
 * its first block, the wrapper that holds the inner one, and the first ink it
 * can paint belongs to the inner scroller's content: the outer scroll's top
 * padding has nothing to do with how far down that ink sits, and a gap it reads
 * is the inner body's placement. The inner scroller is measured on its own, so
 * this rule leaves the ink to it.
 *
 * Only a scroller this rule measures receives the handoff: the axis test is the
 * one `checkLeadingGap` makes, so a horizontal or unclassified list (a platform
 * dump reports both axes for a class it cannot classify) never takes the ink
 * away from a scroller that would have reported it.
 *
 * The walk stops at the first block, so a body whose own first block is a
 * scroller keeps its margin measured here; the handoff covers ink the block
 * holds below itself.
 *
 * The handoff applies only when this scroller's own first block starts at its
 * content top. A block the screen pushed down by a margin is that screen's own
 * hole, and the inner scroller, which starts at the block's top, is not the
 * cause of it.
 */
function placedByNestedScroller(ink: LayoutNode, block: LayoutNode, scroll: LayoutNode): boolean {
  for (let box = ink.parent; box && box !== scroll; box = box.parent) {
    if (box === block) return false;
    if (box.scroll.y && !box.scroll.x) return true;
  }
  return false;
}

/**
 * How far off the middle of its box a centred block may sit, as a fraction of the
 * box height. `CenteredState` centres in the band the surface leaves, and that
 * band is the scroller minus the surface's bottom reserve: the fixed tab bar and
 * the FAB's strip on a phone, which a platform dump folds into the box. The
 * reserve moves the block's middle above the box's own middle by half the
 * reserve, and one eighth of the box height covers a phone's bar and strip while
 * still rejecting a block that a margin pushed toward one edge.
 */
const CENTRED_OFFSET_FRACTION = 1 / 8;

/**
 * Whether the block sits in the middle of the box, which is what a centred body
 * leaves behind. A block that keeps more air on one side than the other is
 * displaced: a margin above it, or a taller box that holds it at its bottom.
 */
function centredInBox(box: Rect, rect: Rect): boolean {
  const boxMiddle = box[1] + box[3] / 2;
  const middle = rect[1] + rect[3] / 2;
  return Math.abs(middle - boxMiddle) <= box[3] * CENTRED_OFFSET_FRACTION;
}

/**
 * Whether the content places its first block between two empty bands of its own
 * box, the shape a screen that centres a body leaves behind. `CenteredState`
 * centres through a measured `paddingTop` and `paddingBottom` on its scroll
 * content, and a platform dump reports no styles: the padding is invisible, so
 * the block reads as pushed down by a margin even though the content chose
 * where it sits.
 *
 * The check runs only on a platform dump, where the styles are missing. A body
 * that fills its scroller and keeps the block in the middle of its box centres
 * that block; it does not displace it. A block near an edge keeps the finding,
 * and so does a content that runs past the viewport: that is still a list whose
 * first block sits where the screen put it.
 */
function centeredBody(
  scroll: LayoutNode,
  content: LayoutNode,
  block: LayoutNode,
  isRTL: boolean,
  env: ProbeEnv
): boolean {
  if (env.source !== 'uiautomator' && env.source !== 'agent-device') return false;
  const box = contentBox(content, isRTL, layoutRect(content));
  const rect = layoutRect(block);
  if (bottom(rect) > bottom(box) + TOLERANCE_DP) return false;
  if (bottom(box) > bottom(layoutRect(scroll)) + TOLERANCE_DP) return false;
  const above = rect[1] - box[1];
  const below = bottom(box) - bottom(rect);
  return above > LEADING_GAP_MAX_DP && below > LEADING_GAP_MAX_DP && centredInBox(box, rect);
}

/**
 * Whether the content packs its first block against the bottom of a body that
 * fills its scroller. A session transcript renders from its last row upward, so
 * a short transcript sits at the bottom of the panel with empty air above it
 * that no block draws; the platform dump reports no `justifyContent`, and the
 * block reads as pushed down by a margin it does not have.
 *
 * Three frames have to agree for that shape, and each excludes a body whose
 * block a margin really displaced: the content box reaches the scroller's bottom,
 * so the body fills the viewport instead of ending after its own card; the first
 * block ends on the content box's bottom edge, so nothing is packed below it;
 * and the block starts more than the allowance under the content top, so there is
 * a gap to explain at all.
 */
function bottomAnchoredBody(
  scroll: LayoutNode,
  content: LayoutNode,
  block: LayoutNode,
  isRTL: boolean,
  env: ProbeEnv
): boolean {
  if (env.source !== 'uiautomator' && env.source !== 'agent-device') return false;
  const box = contentBox(content, isRTL, layoutRect(content));
  const rect = layoutRect(block);
  if (Math.abs(bottom(box) - bottom(layoutRect(scroll))) > TOLERANCE_DP) return false;
  if (bottom(rect) < bottom(box) - LEADING_GAP_MAX_DP) return false;
  return rect[1] - box[1] > LEADING_GAP_MAX_DP;
}

/**
 * The top of a vertically scrolling screen must start with what it shows. The
 * scroll content's own top padding is the screen's chosen gap below its header.
 * Two things add a hole under the title on top of it: a first block pushed down
 * by a margin, and a box in the first block that holds its content at its
 * bottom, usually a control's touch frame grown to the target size instead of
 * reaching it with `hitSlop`. Both are errors.
 *
 * A screen may also place its whole body in the middle of a filled surface on
 * purpose (`CenteredState` does, with measured padding a platform dump cannot
 * report), or pack it against the bottom of one (`bottomAnchoredBody`). That is
 * the content's choice, not a hole under the title, so those two helpers
 * recognise it. Ink that another scroller inside this one places belongs to
 * that scroller's own measurement.
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
    // A block pushed down by a margin is this scroller's own hole; only ink a
    // block at the content top holds below itself belongs to a nested scroller.
    if (margin <= LEADING_GAP_MAX_DP && placedByNestedScroller(ink, block, scroll)) continue;
    const holder = margin > LEADING_GAP_MAX_DP ? undefined : oneSidedBox(ink, block);
    if (margin <= LEADING_GAP_MAX_DP && !holder) continue;
    if (!holder) {
      const isRTL = tree.env.isRTL;
      if (centeredBody(scroll, content, block, isRTL, tree.env)) continue;
      if (bottomAnchoredBody(scroll, content, block, isRTL, tree.env)) continue;
    }
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
