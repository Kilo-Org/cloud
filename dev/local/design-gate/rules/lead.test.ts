import assert from 'node:assert/strict';
import test from 'node:test';

import type { ProbeNode, Rect } from '../tree';
import { checkScreen } from './index';
import { tree } from './test-dump';

/**
 * A Profile-shaped screen: a vertical scroll whose content pads 14 dp at the
 * top (content box starts at y=124), then a first block holding a row and its
 * eyebrow text, then a painted card.
 */
function screen(options: {
  block?: Rect;
  row: Rect;
  text: Rect;
  contentStyle?: ProbeNode['style'];
  contentHeight?: number;
  blockStyle?: ProbeNode['style'];
  blockAbsolute?: boolean;
}) {
  const nodes: ProbeNode[] = [
    { parent: 0, tag: 'ScrollView', rect: [0, 110, 400, 690], style: { overflow: 'scroll' } },
    {
      parent: 1,
      tag: 'View',
      rect: [0, 110, 400, options.contentHeight ?? 1200],
      style: { paddingTop: 14, ...options.contentStyle },
    },
    {
      parent: 2,
      tag: 'View',
      rect: options.block ?? [14, 124, 372, 160],
      style: { ...options.blockStyle, ...(options.blockAbsolute ? { position: 'absolute' } : {}) },
    },
    { parent: 3, tag: 'View', rect: options.row },
    { parent: 4, tag: 'Paragraph', rect: options.text, text: 'Credits' },
    { parent: 2, tag: 'View', rect: [14, 300, 372, 60], style: { backgroundColor: '#f0eee6' } },
  ];
  return checkScreen(tree(nodes)).filter(finding => finding.rule === 'leading-gap');
}

test('leading-gap: a touch frame that holds the first text at its bottom is an error', () => {
  // The reported Profile defect: a 44 dp row holds the eyebrow at its bottom,
  // so the first text sits 31.2 dp under the content's 14 dp padding.
  const [finding, ...rest] = screen({ row: [14, 124, 52, 44.2], text: [14, 155.2, 52, 12.6] });
  assert.equal(rest.length, 0);
  assert.equal(finding?.severity, 'error');
  assert.equal(Math.round((finding?.measured ?? 0) * 10) / 10, 31.2);
  assert.equal(finding?.element.text, 'Credits');
  assert.match(finding?.message ?? '', /hitSlop/);
});

test('leading-gap: content at its padding, within the allowance, or centred in its row passes', () => {
  assert.deepEqual(screen({ row: [14, 124, 52, 14], text: [14, 124, 52, 12.6] }), []);
  // Bottom-aligned text: 24 dp above it is the allowance, 24.5 dp is past it.
  // Home's first section header keeps the 22.9 dp label air every later one has.
  assert.deepEqual(screen({ row: [14, 124, 52, 46.1], text: [14, 146.9, 52, 14.1] }), []);
  assert.deepEqual(screen({ row: [14, 124, 52, 36.6], text: [14, 148, 52, 12.6] }), []);
  assert.equal(screen({ row: [14, 124, 52, 37.1], text: [14, 148.5, 52, 12.6] }).length, 1);
  // A 48 dp list row that centres its line keeps equal space on both sides.
  assert.deepEqual(screen({ row: [14, 124, 372, 48], text: [14, 141.5, 300, 14] }), []);
});

test('leading-gap: a first block pushed down by a margin is an error', () => {
  const [finding] = screen({
    block: [14, 150, 372, 160],
    row: [14, 150, 52, 14],
    text: [14, 150, 52, 12.6],
  });
  assert.equal(finding?.measured, 26);
  assert.match(finding?.message ?? '', /top margin/);
  assert.deepEqual(
    screen({ block: [14, 148, 372, 160], row: [14, 148, 52, 14], text: [14, 148, 52, 12.6] }),
    []
  );
});

test('leading-gap: content the screen places on purpose is skipped', () => {
  for (const justifyContent of ['center', 'flex-end', 'space-between']) {
    assert.deepEqual(
      screen({
        row: [14, 124, 52, 44],
        text: [14, 300, 52, 12.6],
        contentStyle: { justifyContent },
      }),
      []
    );
  }
});

test('leading-gap: an out-of-flow first block is not the first thing shown', () => {
  // The painted card below becomes the first block and sits at y=300 with no
  // flow sibling above it, so the gap is its margin.
  const [finding] = screen({
    row: [14, 124, 52, 44],
    text: [14, 155, 52, 12.6],
    blockAbsolute: true,
  });
  assert.equal(finding?.measured, 176);
  assert.equal(finding?.element.text, undefined);
});

test('leading-gap: a painted first block at the padding passes in a content box that ends with it', () => {
  // The walk must stop at the first block when the block itself is the ink:
  // above it is only the content's own top padding, which the screen chose.
  assert.deepEqual(
    screen({
      contentHeight: 190,
      contentStyle: { paddingTop: 30 },
      block: [14, 140, 372, 160],
      blockStyle: { backgroundColor: '#f0eee6' },
      row: [14, 150, 52, 14],
      text: [14, 150, 52, 12.6],
    }),
    []
  );
});

/**
 * A platform dump: the frames of a vertical scroller, its content and the first
 * block, with no styles at all. `uiautomator` and `agent-device` report no
 * padding, so `CenteredState`'s measured `paddingTop`/`paddingBottom` are
 * invisible and the block's distance from the content's top edge is all the
 * rule can read. Measured on the Agents tab: the scroller and its content span
 * y 174.48–914.29, the centred block starts at 342.86 and ends at 571.81.
 */
function platformScreen(options: { content?: Rect; block: Rect; holder?: Rect; text: Rect }) {
  const nodes: ProbeNode[] = [
    { parent: 0, tag: 'ScrollView', rect: [0, 174.48, 400, 739.81] },
    { parent: 1, tag: 'ViewGroup', rect: options.content ?? [0, 174.48, 400, 739.81] },
    { parent: 2, tag: 'ViewGroup', rect: options.block },
    ...(options.holder ? [{ parent: 3, tag: 'ViewGroup', rect: options.holder } as ProbeNode] : []),
    {
      parent: options.holder ? 4 : 3,
      tag: 'Paragraph',
      rect: options.text,
      text: 'Nothing running right now',
    } as ProbeNode,
  ];
  return checkScreen(tree(nodes, { source: 'uiautomator' })).filter(
    finding => finding.rule === 'leading-gap'
  );
}

test('leading-gap: a filled body that centres its first block passes on a platform dump', () => {
  assert.deepEqual(
    platformScreen({
      block: [0, 342.86, 400, 228.95],
      text: [112.38, 342.86, 187.05, 24.76],
    }),
    []
  );
});

test('leading-gap: a first block pushed down in a content that runs past the viewport is an error', () => {
  const [finding] = platformScreen({
    content: [0, 174.48, 400, 1200],
    block: [14, 200, 372, 120],
    text: [14, 200, 100, 20],
  });
  assert.equal(finding?.measured, 25.52);
  assert.match(finding?.message ?? '', /top margin/);
});

test('leading-gap: a centred body whose block holds its text low is placement, not a hole', () => {
  // The reported Agents-tab shape: the block is centred in a filled scroller and
  // a box inside it carries the paragraph at its bottom. The gap belongs to the
  // state's placement, so the rule must not report a control's touch frame.
  assert.deepEqual(
    platformScreen({
      block: [0, 342.86, 400, 228.95],
      holder: [0, 342.86, 400, 120],
      text: [10, 440, 100, 20],
    }),
    []
  );
});

test('leading-gap: a small margin high in a filled body is a margin, not placement', () => {
  // A centred body leaves its block near the middle of the box. A block that
  // starts just past the allowance under the content top and runs toward the
  // bottom of the panel is a margin the screen must drop, even though the air
  // below it is far larger than the air above.
  const [finding] = platformScreen({
    content: [0, 174.48, 400, 739.81],
    block: [0, 200, 400, 120],
    text: [14, 200, 100, 20],
  });
  assert.equal(finding?.measured, 25.52);
  assert.match(finding?.message ?? '', /top margin/);
});

test('leading-gap: a state centred above its box middle by the tab-bar reserve passes', () => {
  // Measured on the Agents tab: the empty state is centred in the band above the
  // fixed tab bar, which a platform dump folds into the box, so the block's
  // middle sits 38.9 dp above the box's middle. That asymmetry is the reserve,
  // not a margin.
  assert.deepEqual(
    platformScreen({
      content: [0, 174.48, 411.43, 739.81],
      block: [0, 375.24, 411.43, 260.57],
      text: [112.38, 436.85, 187.05, 24.76],
    }),
    []
  );
});

test('leading-gap: a block near the bottom of a filled body is still an error', () => {
  // A margin can push the first block down without centring it: a block off the
  // middle of its box is a hole under the title, not placement.
  const [finding] = platformScreen({
    block: [14, 600, 372, 120],
    text: [14, 600, 100, 20],
  });
  assert.equal(finding?.measured, 425.52);
  assert.match(finding?.message ?? '', /top margin/);
});

test('leading-gap: a taller box inside the first block is an error on a platform dump', () => {
  const [finding] = platformScreen({
    block: [0, 174.48, 400, 350],
    holder: [0, 174.48, 400, 300],
    text: [10, 400, 100, 20],
  });
  assert.equal(finding?.element.text, 'Nothing running right now');
  assert.match(finding?.message ?? '', /hitSlop/);
});

/** The measured window of the emulator these frames came from, read from a dump. */
const MEASURED_WINDOW = {
  window: { width: 411.43, height: 914.29 },
  source: 'uiautomator',
} as const;

/**
 * The screen's window-scrolling wrapper, a scroller nested inside it, and the
 * frames a platform dump reports for both. The wrapper is the `ScrollView` every
 * screen mounts around the window; the nested one is the body that places its
 * own content. Measured on the session route's not-found body: the wrapper and
 * its content span the window, the body's scroller starts at 136.76, and its
 * centred block starts at 426.29.
 */
function nestedScrollerScreen(options: { bodyBlock?: Rect; text: Rect }): ProbeNode[] {
  return [
    { parent: 0, tag: 'ScrollView', rect: [0, 0, 411.43, 914.29] },
    { parent: 1, tag: 'ViewGroup', rect: [0, 0, 411.43, 914.29] },
    { parent: 2, tag: 'ViewGroup', rect: [0, 0, 411.43, 914.29] },
    { parent: 3, tag: 'ScrollView', rect: [0, 136.76, 411.43, 777.52] },
    { parent: 4, tag: 'ViewGroup', rect: [0, 136.76, 411.43, 777.52] },
    { parent: 5, tag: 'ViewGroup', rect: options.bodyBlock ?? [0, 426.29, 411.43, 174.48] },
    {
      parent: 6,
      tag: 'Paragraph',
      rect: options.text,
      text: 'This item may have been removed',
    },
  ];
}

test('leading-gap: ink that a body inside this scroller places is not this scroller gap', () => {
  // The reported not-found state: the window wrapper's first block is the whole
  // app tree, and the first ink it can paint is the centred body's paragraph
  // inside the body's own scroller. That scroller places the paragraph, so the
  // wrapper must not report it — and the body's own frame centres it, so it is
  // not a hole either.
  assert.deepEqual(
    checkScreen(
      tree(nestedScrollerScreen({ text: [39.62, 528.38, 332.19, 17.52] }), MEASURED_WINDOW)
    ).filter(finding => finding.rule === 'leading-gap'),
    []
  );
});

test('leading-gap: a body inside this scroller still reports its own pushed-down block', () => {
  // The guard hands the ink to the nested scroller, so that scroller's own first
  // block must still answer for a margin it did not choose: this block sits in the
  // lower part of the panel and leaves a band of air under itself, which is a
  // margin and not a centred body.
  const nodes: ProbeNode[] = [...nestedScrollerScreen({ text: [14, 606, 100, 20] })];
  nodes[5] = { parent: 5, tag: 'ViewGroup', rect: [14.1, 600, 383.2, 150] };
  nodes[6] = { parent: 6, tag: 'Paragraph', rect: [14, 606, 100, 20], text: 'LIVE NOW' };
  const [finding] = checkScreen(tree(nodes, MEASURED_WINDOW)).filter(
    found => found.rule === 'leading-gap'
  );
  assert.equal(Math.round((finding?.measured ?? 0) * 10) / 10, 469.2);
  assert.match(finding?.message ?? '', /top margin/);
});

test('leading-gap: a nested list the rule does not measure never takes the ink', () => {
  // A platform dump reports both axes for a list class it cannot classify (a
  // FlashList's RecyclerView), so the rule never measures it. The wrapper must
  // keep reporting the gap instead of handing the ink to a scroller that is
  // skipped.
  const nodes = nestedScrollerScreen({ text: [39.62, 528.38, 332.19, 17.52] });
  nodes[3] = {
    parent: 3,
    tag: 'RecyclerView',
    rect: [0, 136.76, 411.43, 777.52],
    scrollAxes: { x: true, y: true },
  } as ProbeNode;
  const findings = checkScreen(tree(nodes, MEASURED_WINDOW)).filter(
    found => found.rule === 'leading-gap'
  );
  assert.equal(findings.length, 1);
  assert.match(findings[0]?.message ?? '', /ScrollView/);
});

test('leading-gap: a first block that is itself a scroller keeps its own margin measured', () => {
  // The handoff covers ink a block holds below itself, not a block that is the
  // scroller: the inner scroller's own content starts at its top, so nothing
  // would report a body that pushed the whole scroller down.
  const nodes: ProbeNode[] = [
    { parent: 0, tag: 'ScrollView', rect: [0, 0, 411.43, 914.29] },
    { parent: 1, tag: 'ViewGroup', rect: [0, 0, 411.43, 1200] },
    { parent: 2, tag: 'ScrollView', rect: [0, 100, 411.43, 700] },
    { parent: 3, tag: 'ViewGroup', rect: [0, 100, 411.43, 700] },
    { parent: 4, tag: 'Paragraph', rect: [14, 100, 200, 20], text: 'Pinned body' },
  ];
  const findings = checkScreen(tree(nodes, MEASURED_WINDOW)).filter(
    found => found.rule === 'leading-gap'
  );
  assert.equal(findings.length, 1);
  assert.equal(Math.round((findings[0]?.measured ?? 0) * 10) / 10, 100);
  assert.match(findings[0]?.message ?? '', /top margin/);
});

test('leading-gap: a tab body inside the tab scroller is not the wrapper gap', () => {
  // The reported Home tab shape at 472 dp: the wrapper's first ink is the live
  // section's paragraph, placed by the tab scroller's centred body. The measured
  // air above it belongs to that body, and the wrapper's own top padding has
  // nothing to do with it.
  const nodes: ProbeNode[] = [
    { parent: 0, tag: 'ScrollView', rect: [0, 0, 411.43, 914.29] },
    { parent: 1, tag: 'ViewGroup', rect: [0, 0, 411.43, 914.29] },
    { parent: 2, tag: 'ViewGroup', rect: [0, 0, 411.43, 914.29] },
    { parent: 3, tag: 'ScrollView', rect: [0, 111.24, 411.43, 724.95] },
    { parent: 4, tag: 'ViewGroup', rect: [0, 111.24, 411.43, 724.95] },
    { parent: 5, tag: 'ViewGroup', rect: [0, 340, 411.43, 263] },
    { parent: 6, tag: 'ViewGroup', rect: [0, 340, 411.43, 200] },
    { parent: 7, tag: 'Paragraph', rect: [112.38, 472, 187.05, 24.76], text: 'Nothing running' },
  ];
  assert.deepEqual(
    checkScreen(tree(nodes, MEASURED_WINDOW)).filter(found => found.rule === 'leading-gap'),
    []
  );
});

test('leading-gap: a block the wrapper itself holds low is still an error', () => {
  // Without a scroller between the wrapper and the text, the wrapper does own
  // the placement: a block that holds the first line at its bottom is a touch
  // frame grown past what it draws, and the guard must not hide it.
  const nodes: ProbeNode[] = [
    { parent: 0, tag: 'ScrollView', rect: [0, 0, 411.43, 914.29] },
    { parent: 1, tag: 'ViewGroup', rect: [0, 0, 411.43, 914.29] },
    { parent: 2, tag: 'ViewGroup', rect: [0, 0, 411.43, 600] },
    { parent: 3, tag: 'Paragraph', rect: [14, 528.38, 332.19, 17.52], text: 'Session' },
  ];
  const [finding] = checkScreen(tree(nodes, MEASURED_WINDOW)).filter(
    found => found.rule === 'leading-gap'
  );
  assert.equal(finding?.element.text, 'Session');
  assert.match(finding?.message ?? '', /hitSlop/);
});

/**
 * The transcript panel a session opens on: a scroller from 136.76 to 824.38, the
 * content container that fills it, and the rendered rows. Measured on the
 * development transcript fixture, whose rows render from the last row upward:
 * the first row block starts at 510.86 and ends at 816.38, inside the content's
 * own 8 dp bottom padding, which a platform dump folds into the content box.
 * `contentHeight` is the compact cell's shorter panel, where the same rows start
 * 97.5 dp under the content top.
 */
function transcriptScreen(options: {
  rows: Rect;
  text: Rect;
  panelHeight?: number;
  contentHeight?: number;
}): ProbeNode[] {
  const panel = options.panelHeight ?? 687.62;
  return [
    { parent: 0, tag: 'ScrollView', rect: [0, 136.76, 411.43, panel] },
    { parent: 1, tag: 'ViewGroup', rect: [0, 136.76, 411.43, options.contentHeight ?? panel] },
    { parent: 2, tag: 'ViewGroup', rect: options.rows },
    { parent: 3, tag: 'Paragraph', rect: options.text, text: 'Nov 14, 2023, 10:12 PM' },
  ];
}

test('leading-gap: a short transcript packed against the bottom of its panel passes', () => {
  // The reported shape: a session with three rows keeps them at the bottom of the
  // transcript panel, so the first row starts far below the content's top. That
  // is the transcript's placement, not a top margin.
  assert.deepEqual(
    checkScreen(
      tree(
        transcriptScreen({
          rows: [0, 510.86, 411.43, 305.52],
          text: [124.19, 517.71, 163.05, 14.86],
        }),
        MEASURED_WINDOW
      )
    ).filter(finding => finding.rule === 'leading-gap'),
    []
  );
});

test('leading-gap: the same rows packed at the bottom of the compact panel pass', () => {
  // The permission-request state's frames: the compact cell's shorter panel holds
  // the same rows block, so the first row starts 97.5 dp under the content top and
  // the block ends on the content's bottom edge. The panel is the placement.
  assert.deepEqual(
    checkScreen(
      tree(
        transcriptScreen({
          panelHeight: 411.43,
          rows: [0, 234.26, 411.43, 305.52],
          text: [124.19, 241.11, 163.05, 14.86],
        }),
        MEASURED_WINDOW
      )
    ).filter(finding => finding.rule === 'leading-gap'),
    []
  );
});

test('leading-gap: a body that ends after its own card and starts under a margin is an error', () => {
  // A content-sized body is not a packed transcript: this box holds one card and
  // ends above the scroller's bottom, so the card's distance from the content top
  // is a margin the screen must drop, however much air the box leaves below it.
  const [finding] = checkScreen(
    tree(
      transcriptScreen({
        contentHeight: 400,
        rows: [0, 216.38, 411.43, 360],
        text: [124.19, 223.23, 163.05, 14.86],
      }),
      MEASURED_WINDOW
    )
  ).filter(found => found.rule === 'leading-gap');
  assert.equal(Math.round((finding?.measured ?? 0) * 10) / 10, 86.5);
  assert.match(finding?.message ?? '', /top margin/);
});

test('leading-gap: rows that keep air below them are still a top margin', () => {
  // The same panel with the rows lifted off its bottom edge: nothing packs them
  // there, so the gap above the first row is a margin the screen must drop.
  const [finding] = checkScreen(
    tree(
      transcriptScreen({
        rows: [0, 430, 411.43, 305.52],
        text: [124.19, 436.85, 163.05, 14.86],
      }),
      MEASURED_WINDOW
    )
  ).filter(found => found.rule === 'leading-gap');
  assert.equal(Math.round((finding?.measured ?? 0) * 10) / 10, 300.1);
  assert.match(finding?.message ?? '', /top margin/);
});
