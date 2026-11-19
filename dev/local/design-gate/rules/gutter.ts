import { finding, type Finding } from '../findings';
import {
  bottom,
  contentBox,
  hasPresentedOwner,
  layoutRect,
  right,
  type LayoutNode,
  type LayoutTree,
  type Rect,
} from '../tree';
import { GUTTER_TOLERANCE_DP, SCREEN_GUTTER_DP } from './thresholds';

const fmt = (value: number) => `${Math.round(value * 10) / 10} dp`;

/** The widest a square touch target pulled into the gutter may be. */
const ICON_TARGET_MAX_DP = 56;

/**
 * The component that renders a screen header. Its title, eyebrow and subtitle
 * lines all sit inside it, and the probe's short owner chain names the header's
 * outermost box rather than each line's own.
 */
const SCREEN_HEADER_OWNER = 'ScreenHeader';

/**
 * React Navigation's bottom tab bar components, from the probe's owner stack.
 *
 * The bar is navigation chrome the screen does not place: each tab item
 * centres its icon and label inside its own share of the bar, so a tab label's
 * start edge lands a fifth of the bar in from the page edge on every tab
 * screen. That is a centred item, not a page column.
 */
const TAB_BAR_OWNERS: Record<string, true> = {
  BottomTabBar: true,
  BottomTabItem: true,
  TabBarLabel: true,
  TabBarIcon: true,
};

/**
 * A chat turn's failure footer (its status line, detail and `Retry` / `Copy to
 * composer` actions) is placed by the message's own column, not by the page:
 * the user's turn is end-aligned, so the footer starts wherever that bubble
 * ends. The marker on the footer's container names it in the probe, and its
 * descendants are measured by the message, not against the page gutter.
 */
const MESSAGE_FOOTER_TEST_ID = 'message-failure-footer';

/**
 * The boxes a page gutter is measured inside.
 *
 * A native sheet or dialog lays its content out in a window of its own, so the
 * frames the probe reports for that content are relative to the surface and the
 * screen's side insets do not describe them (the presenter applies its own).
 * Everything else is measured from the window's safe-area edges, because in
 * landscape the notch and the rounded corners take room on the start side and
 * the gutter starts after it; `physical` stays the whole window, because a
 * full-bleed band still spans it.
 */
type Page = Readonly<{ box: Rect; physical: Rect; rtl: boolean }>;

/** How far a box's start edge sits inside `box`, in dp. */
function startOffset(rect: Rect, box: Rect, page: Page): number {
  return page.rtl ? right(box) - right(rect) : rect[0] - box[0];
}

/** The nearest native dialog or sheet that hosts this node, itself included. */
function surfaceRoot(node: LayoutNode): LayoutNode | undefined {
  for (let current: LayoutNode | undefined = node; current; current = current.parent) {
    if (hasPresentedOwner(current.probe)) return current;
  }
  return undefined;
}

function pageFor(tree: LayoutTree, root: LayoutNode | undefined): Page {
  const rtl = tree.env.isRTL;
  if (root) {
    const surface = layoutRect(root);
    return { box: surface, physical: surface, rtl };
  }
  const { window, safeArea } = tree.env;
  return {
    box: [safeArea.left, 0, window.width - safeArea.left - safeArea.right, window.height],
    physical: [0, 0, window.width, window.height],
    rtl,
  };
}

/** The node and its ancestors, stopping at the surface that hosts it. */
function chain(node: LayoutNode, root: LayoutNode | undefined): LayoutNode[] {
  const result: LayoutNode[] = [];
  for (let current: LayoutNode | undefined = node; current; current = current.parent) {
    result.push(current);
    if (current === root) break;
  }
  return result;
}

/**
 * A box that spans the page on both sides: a list row's own background, a
 * divider, the screen's filled root. Its fill is chrome rather than content, so
 * the gutter is not measured on it — but the content it holds still is. A band
 * that spans the safe content area counts too: the page's own background stops
 * at the insets on a landscape phone.
 */
function fullBleed(node: LayoutNode, page: Page): boolean {
  const rect = layoutRect(node);
  const spans = (box: Rect) => rect[2] >= box[2] - 1 && Math.abs(startOffset(rect, box, page)) <= 1;
  return spans(page.box) || spans(page.physical);
}

/**
 * The header's back control: the header pulls a 48 dp icon target into the
 * gutter with `-ms-4` so the glyph lands on it, and the glyph centres inside
 * that box. Nothing the target paints is content, so the whole subtree is
 * skipped; without it the centred glyph reads as content 2 dp inside the gutter
 * on every screen with a back button.
 */
function iconTarget(node: LayoutNode, page: Page, touch: number): boolean {
  if (!node.isControl && !node.pressable) return false;
  const rect = layoutRect(node);
  return (
    startOffset(rect, page.box, page) <= GUTTER_TOLERANCE_DP &&
    rect[2] >= touch &&
    rect[2] <= ICON_TARGET_MAX_DP &&
    rect[3] >= touch
  );
}

function subtreePaints(node: LayoutNode): boolean {
  if (node.paints) return true;
  return node.children.some(child => subtreePaints(child));
}

function verticallyOverlaps(a: LayoutNode, b: LayoutNode): boolean {
  const first = layoutRect(a);
  const second = layoutRect(b);
  return Math.min(bottom(first), bottom(second)) - Math.max(first[1], second[1]) > 0;
}

/**
 * Whether the node is an out-of-flow bar pinned across the page's bottom: the
 * tab bar is absolutely positioned by the navigator, spans the page and ends on
 * its bottom edge. A full-height absolute layer — a modal backdrop — starts at
 * the page's own top and is not a bar, so its content is still measured.
 */
function fixedBottomBar(node: LayoutNode, page: Page): boolean {
  if (!node.absolute) return false;
  const rect = layoutRect(node);
  return (
    rect[1] > page.box[1] + GUTTER_TOLERANCE_DP &&
    Math.abs(bottom(rect) - bottom(page.box)) <= GUTTER_TOLERANCE_DP &&
    fullBleed(node, page)
  );
}

/**
 * Whether the node belongs to the bottom tab bar: navigation chrome, not page
 * content. The bar's own component tree names it; an out-of-flow bar pinned
 * across the page's bottom covers a bar that does not use those components.
 */
function insideTabBar(nodes: readonly LayoutNode[], page: Page): boolean {
  return nodes.some(
    node =>
      (node.probe.owners ?? []).some(owner => TAB_BAR_OWNERS[owner] === true) ||
      fixedBottomBar(node, page)
  );
}

/**
 * Whether the node holds a control whose start edge is on or before the page
 * gutter: the header pulls a 48 dp back target into the gutter, so the title
 * after it is placed by the row, not by the page column. A box that paints
 * nothing and holds no control is not a leading element, and a control further
 * in is the row's own content, so neither exempts the text that follows.
 */
function leadingControl(node: LayoutNode, page: Page, touch: number): boolean {
  const rect = layoutRect(node);
  if (startOffset(rect, page.box, page) > SCREEN_GUTTER_DP + GUTTER_TOLERANCE_DP) return false;
  return controlOnGutter(node, page, touch);
}

function controlOnGutter(node: LayoutNode, page: Page, touch: number): boolean {
  if (node.isControl) {
    const rect = layoutRect(node);
    return (
      startOffset(rect, page.box, page) <= SCREEN_GUTTER_DP + GUTTER_TOLERANCE_DP &&
      rect[2] >= touch &&
      rect[3] >= touch
    );
  }
  return node.children.some(child => controlOnGutter(child, page, touch));
}

/**
 * Whether the content starts beside an element its row already placed before it
 * in the same row: a session row's hue strip, an `IconTile`, an avatar, the
 * header's leading back control, or a composer's input frame that the bar insets
 * inside its own padding. The box after it starts past the page gutter by design:
 * a row places its content from its own start edge, so only its first painted
 * element is that row's column, and a control at a row's end is never the column
 * the page gutter describes. A sibling above the box (a stacked section label)
 * does not count: content under it is a column of its own and must still start at
 * the gutter.
 */
function followsRowContent(
  node: LayoutNode,
  page: Page,
  nodes: readonly LayoutNode[],
  touch: number
): boolean {
  for (const current of nodes) {
    const parent = current.parent;
    if (!parent) continue;
    for (const sibling of parent.children) {
      if (sibling === current) break;
      if (sibling.absolute || !verticallyOverlaps(sibling, node)) continue;
      if (leadingControl(sibling, page, touch) || subtreePaints(sibling)) return true;
    }
  }
  return false;
}

/**
 * Whether the node is the square a row leads with, on or before the gutter: the
 * header's 48 dp back target. A pushed header pulls it into the gutter with
 * `-ms-4`; a centred header keeps it on the gutter and centres the title
 * between two such targets. Either way the box after it — the title, and the
 * eyebrow and subtitle rows that cancel the same column — belongs to that
 * target's column, not to the page's.
 */
function leadingFrame(node: LayoutNode, page: Page, touch: number): boolean {
  const rect = layoutRect(node);
  return (
    startOffset(rect, page.box, page) <= SCREEN_GUTTER_DP + GUTTER_TOLERANCE_DP &&
    rect[2] >= touch &&
    rect[2] <= ICON_TARGET_MAX_DP &&
    rect[3] >= touch &&
    rect[3] <= ICON_TARGET_MAX_DP
  );
}

/** The outermost box of the screen header a node's chain sits in. */
function headerRoot(nodes: readonly LayoutNode[]): LayoutNode | undefined {
  let header: LayoutNode | undefined = undefined;
  for (const node of nodes) {
    if ((node.probe.owners ?? []).includes(SCREEN_HEADER_OWNER)) header = node;
  }
  return header;
}

/**
 * The columns the screen header places its own lines on: a row that leads with
 * the 48 dp back target puts the box after it — the title — on that target's
 * column, and the eyebrow above and subtitle below start on the same x because
 * they carry the same pull as a spacer. Those lines are the header's block, not
 * a page column. A header with no control has no such column, so every line it
 * paints stays the page's to place. Undefined when the node is not in a header.
 */
function screenHeaderColumns(
  nodes: readonly LayoutNode[],
  page: Page,
  touch: number
): number[] | undefined {
  const header = headerRoot(nodes);
  if (!header) return undefined;
  const columns: number[] = [];
  const pending = [header];
  for (let row = pending.pop(); row !== undefined; row = pending.pop()) {
    const frame = row.children.findIndex(
      child => !child.absolute && leadingFrame(child, page, touch)
    );
    const next =
      frame < 0 ? undefined : row.children.slice(frame + 1).find(child => !child.absolute);
    if (next) {
      const offset = startOffset(layoutRect(next), page.box, page);
      if (offset > SCREEN_GUTTER_DP + GUTTER_TOLERANCE_DP) columns.push(offset);
    }
    pending.push(...row.children);
  }
  return columns;
}

/**
 * Whether the box has a painted block between it and the page: a card the
 * screen placed on the gutter. Its own padding is an inner inset, which the
 * contract leaves to the block, so the gutter is not measured inside it. A
 * full-bleed block is chrome, and the content it holds is still measured.
 */
function insidePaintedBlock(nodes: readonly LayoutNode[], page: Page): boolean {
  return nodes.slice(1).some(node => node.paints && !fullBleed(node, page));
}

/** Whether the box begins where its parent's content box begins. */
function alignedToContentStart(node: LayoutNode, page: Page): boolean {
  const parent = node.parent;
  if (!parent) return false;
  const box = contentBox(parent, page.rtl, layoutRect(parent));
  return (
    Math.abs(startOffset(layoutRect(node), page.box, page) - startOffset(box, page.box, page)) <=
    GUTTER_TOLERANCE_DP
  );
}

/** Whether the box is centred in its parent, an empty or error state's choice. */
function centered(node: LayoutNode, page: Page): boolean {
  const parent = node.parent;
  if (!parent) return false;
  const box = contentBox(parent, page.rtl, layoutRect(parent));
  const gapStart = startOffset(layoutRect(node), page.box, page) - startOffset(box, page.box, page);
  const gapEnd = box[2] - layoutRect(node)[2] - gapStart;
  return (
    gapStart > GUTTER_TOLERANCE_DP &&
    gapEnd > GUTTER_TOLERANCE_DP &&
    Math.abs(gapStart - gapEnd) <= GUTTER_TOLERANCE_DP
  );
}

/**
 * Whether the box, or a block it sits in, is centred: an empty or error state
 * centres a stack of content, and the text inside that stack begins where the
 * stack does. That is the block's own placement, not the page column, and the
 * stack's own padding is an inner inset the block owns.
 */
function insideCenteredBlock(nodes: readonly LayoutNode[], page: Page): boolean {
  return nodes.some(candidate => centered(candidate, page));
}

/**
 * Every screen starts its content at the 14 dp page gutter, in both reading
 * directions: a header title, a section label, a card, a row group, a flat list
 * row's content and an empty state's block all begin on one column.
 *
 * Two things break it. Paint whose start edge lands inside the gutter is an
 * error: nothing may sit closer to the page edge than the gutter. A column that
 * starts past the gutter is an error too, and it takes the start-most content of
 * each column to see it — a 22 dp body under a 14 dp header, or a whole screen
 * shifted by 8 dp. A screen's header and each scrolling body are separate
 * columns, because a body can move without the header; a screen with no body
 * scroller has one.
 *
 * The rule measures the page column, not inner insets: a card, a row group or a
 * sheet places its own content from its own edge, and content after a leading
 * element of a row (a hue strip, an icon tile, the header's back control) starts
 * past the gutter on purpose. Full-bleed chrome — a list row's background, its
 * divider and the bottom tab bar — is not a column, but the content inside it
 * is. Centred content (an empty or error state's box and the stack inside it) is
 * the content's own placement, and content a native sheet or dialog hosts is
 * measured from that surface's root. Unknown side insets skip the rule, as they
 * do the safe-area check: the page edge is not known.
 */
export function checkGutter(tree: LayoutTree): Finding[] {
  const { env } = tree;
  if (env.safeAreaKnown === false) return [];
  if (env.window.width - env.safeArea.left - env.safeArea.right <= 0) return [];

  const findings: Finding[] = [];
  const flagged = new Set<LayoutNode>();
  const columns = new Map<string, { node: LayoutNode; offset: number }>();

  for (const node of tree.nodes) {
    if (!node.paints || node.absolute) continue;
    const root = surfaceRoot(node);
    const page = pageFor(tree, root);
    const nodes = chain(node, root);
    if (nodes.some(candidate => candidate.scroll.x)) continue;
    if (nodes.some(candidate => iconTarget(candidate, page, env.tapTarget.touch))) continue;
    if (insideTabBar(nodes, page)) continue;
    // A chat turn's failure footer is placed by the message's own column, not
    // the page; the footer's container names the subtree.
    if (nodes.some(candidate => candidate.probe.testID?.includes(MESSAGE_FOOTER_TEST_ID) === true))
      continue;
    if (fullBleed(node, page)) continue;
    const offset = startOffset(layoutRect(node), page.box, page);

    if (offset > 0 && offset < SCREEN_GUTTER_DP - GUTTER_TOLERANCE_DP) {
      // One finding per offending block: the rows inside a misplaced card are
      // not each their own defect.
      if (nodes.some(candidate => flagged.has(candidate))) continue;
      flagged.add(node);
      findings.push(
        finding({
          rule: 'gutter',
          severity: 'error',
          element: node.ref,
          related: node.parent ? [node.parent.ref] : [],
          measured: offset,
          expected: `${SCREEN_GUTTER_DP} dp from the page edge`,
          unit: 'dp',
          message: `${node.path} starts ${fmt(offset)} from the page edge, inside the ${SCREEN_GUTTER_DP} dp page gutter; move its start edge to the gutter.`,
        })
      );
      continue;
    }

    if (insidePaintedBlock(nodes, page)) continue;
    if (!alignedToContentStart(node, page)) continue;
    if (insideCenteredBlock(nodes, page)) continue;
    // A screen header's lines share one x: the title's, after the back control,
    // or the page gutter when the header has no control. They are that header's
    // column, not the page's — a line anywhere else is the page's, off its
    // column. A control's own label is placed by the control.
    if (
      offset > SCREEN_GUTTER_DP + GUTTER_TOLERANCE_DP &&
      node.isText &&
      !nodes.some(candidate => candidate.isControl)
    ) {
      const headerColumns = screenHeaderColumns(nodes, page, env.tapTarget.touch);
      if (headerColumns) {
        const column = headerColumns.reduce(
          (best, candidate) =>
            Math.abs(candidate - offset) < Math.abs(best - offset) ? candidate : best,
          SCREEN_GUTTER_DP
        );
        if (Math.abs(column - offset) <= GUTTER_TOLERANCE_DP) continue;
        findings.push(
          finding({
            rule: 'gutter',
            severity: 'error',
            element: node.ref,
            related: node.parent ? [node.parent.ref] : [],
            measured: offset,
            expected: `${fmt(column)} from the page edge`,
            unit: 'dp',
            message: `${node.path} starts ${fmt(offset)} from the page edge; a screen header's eyebrow, title and subtitle all start on one column, at ${fmt(column)}.`,
          })
        );
        continue;
      }
    }
    if (followsRowContent(node, page, nodes, env.tapTarget.touch)) continue;

    const scroller = nodes.find(candidate => candidate.scroll.y && !candidate.scroll.x);
    const key = `${root?.index ?? 'window'}:${scroller?.index ?? 'page'}`;
    const best = columns.get(key);
    if (!best || offset < best.offset) columns.set(key, { node, offset });
  }

  for (const { node, offset } of columns.values()) {
    if (Math.abs(offset - SCREEN_GUTTER_DP) <= GUTTER_TOLERANCE_DP) continue;
    // Paint inside the gutter is reported above, against the box that paints.
    if (offset > 0 && offset < SCREEN_GUTTER_DP - GUTTER_TOLERANCE_DP) continue;
    findings.push(
      finding({
        rule: 'gutter',
        severity: 'error',
        element: node.ref,
        related: node.parent ? [node.parent.ref] : [],
        measured: offset,
        expected: `${SCREEN_GUTTER_DP} dp from the page edge`,
        unit: 'dp',
        message: `${node.path} is the start-most content of its column: the content column starts at ${fmt(offset)}, expected ${SCREEN_GUTTER_DP} dp.`,
      })
    );
  }

  return findings;
}
