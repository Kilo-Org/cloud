import assert from 'node:assert/strict';
import test from 'node:test';

import type { ProbeEnv, ProbeNode, Rect } from '../tree';
import { checkScreen } from './index';
import { tree } from './test-dump';

const WIDTH = 400;

function run(nodes: ProbeNode[], env: Partial<ProbeEnv> = {}) {
  return checkScreen(tree(nodes, env)).filter(finding => finding.rule === 'gutter');
}

/** Every x mirrored inside the window, for a right-to-left layout. */
function mirrored(nodes: ProbeNode[], width = WIDTH): ProbeNode[] {
  return nodes.map(node => ({
    ...node,
    rect: [width - (node.rect[0] + node.rect[2]), node.rect[1], node.rect[2], node.rect[3]] as Rect,
  }));
}

/**
 * A screen shaped like the app's: a painted header band holding the title, and a
 * scrolling body that pads its content, with a card inside the body.
 */
function screen(inset: { header?: number; body?: number } = {}): ProbeNode[] {
  const header = inset.header ?? 14;
  const body = inset.body ?? 14;
  return [
    { parent: 0, tag: 'RNSScreen', rect: [0, 0, WIDTH, 800] },
    {
      parent: 1,
      tag: 'View',
      rect: [0, 40, WIDTH, 48],
      style: { backgroundColor: '#ffffff', paddingHorizontal: header },
    },
    { parent: 2, tag: 'Paragraph', rect: [header, 56, 120, 20], text: 'Settings' },
    {
      parent: 1,
      tag: 'ScrollView',
      rect: [0, 88, WIDTH, 712],
      style: { overflow: 'scroll' },
    },
    {
      parent: 4,
      tag: 'View',
      rect: [0, 88, WIDTH, 900],
      style: { paddingHorizontal: body },
    },
    { parent: 5, tag: 'Paragraph', rect: [body, 100, 300, 16], text: 'Body line' },
    {
      parent: 5,
      tag: 'View',
      rect: [body, 130, WIDTH - body * 2, 80],
      style: { backgroundColor: '#f0eee6' },
    },
    { parent: 7, tag: 'Paragraph', rect: [body + 14, 144, 200, 16], text: 'Card line' },
  ];
}

test('gutter: a screen whose header and body start at 14 dp passes', () => {
  assert.deepEqual(run(screen()), []);
});

test('gutter: a screen whose header and body start at 22 dp fails in both columns', () => {
  const findings = run(screen({ header: 22, body: 22 }));
  assert.equal(findings.length, 2);
  for (const finding of findings) {
    assert.equal(finding.severity, 'error');
    assert.equal(finding.measured, 22);
    assert.equal(finding.expected, '14 dp from the page edge');
    assert.match(finding.message, /content column starts at 22/);
  }
  assert.equal(findings[0]?.element.text, 'Settings');
  assert.equal(findings[1]?.element.text, 'Body line');
});

test('gutter: a 21 dp body under a 14 dp header fails', () => {
  const [finding, ...rest] = run(screen({ header: 14, body: 21 }));
  assert.equal(rest.length, 0);
  assert.equal(finding?.measured, 21);
  assert.equal(finding?.element.text, 'Body line');
  assert.match(finding?.message, /starts at 21 dp, expected 14 dp/);
});

test('gutter: text painted inside the gutter is an error, its block named once', () => {
  const findings = run(screen({ body: 8 }));
  assert.equal(findings.length, 2);
  for (const finding of findings) {
    assert.equal(finding.measured, 8);
    assert.equal(finding.severity, 'error');
    assert.match(finding.message, /inside the 14 dp page gutter/);
  }
});

test('gutter: the tolerance admits half a dp of rounding, not an off-grid inset', () => {
  assert.deepEqual(run(screen({ body: 14.5 })), []);
  assert.equal(run(screen({ body: 13.2 }))[0]?.measured, 13.2);
  assert.equal(run(screen({ body: 14.8 }))[0]?.measured, 14.8);
});

/**
 * A flat list: full-bleed rows with their own hairline divider, each row padding
 * its content. The row's background is chrome, its content is the column.
 */
function listScreen(textInset = 14): ProbeNode[] {
  const nodes: ProbeNode[] = [
    { parent: 0, tag: 'RNSScreen', rect: [0, 0, WIDTH, 800] },
    {
      parent: 1,
      tag: 'ScrollView',
      rect: [0, 88, WIDTH, 712],
      style: { overflow: 'scroll' },
    },
    { parent: 2, tag: 'View', rect: [0, 88, WIDTH, 900] },
  ];
  for (const y of [88, 160]) {
    nodes.push({
      parent: 3,
      tag: 'View',
      rect: [0, y, WIDTH, 72],
      style: { paddingHorizontal: 14, borderBottomWidth: 0.5 },
    });
    const row = nodes.length;
    nodes.push({
      parent: row,
      tag: 'Paragraph',
      rect: [textInset, y + 24, 200, 16],
      text: `Chat ${y}`,
    });
    nodes.push({
      parent: 3,
      tag: 'View',
      rect: [0, y + 71.5, WIDTH, 0.5],
      style: { backgroundColor: '#e5e5e5' },
    });
  }
  return nodes;
}

test('gutter: full-bleed rows are skipped, their content is measured', () => {
  assert.deepEqual(run(listScreen(14)), []);
  const findings = run(listScreen(8));
  assert.equal(findings.length, 2);
  assert.ok(findings.every(finding => finding.measured === 8));
});

/**
 * A state whose only body content is centred in a full-bleed block, the way
 * `EmptyState` and `CenteredState` place theirs.
 */
function centeredState(headerInset = 14): ProbeNode[] {
  return [
    { parent: 0, tag: 'RNSScreen', rect: [0, 0, WIDTH, 800] },
    {
      parent: 1,
      tag: 'View',
      rect: [0, 0, WIDTH, 800],
      style: { backgroundColor: '#ffffff' },
    },
    { parent: 2, tag: 'View', rect: [0, 40, WIDTH, 48], style: { paddingHorizontal: headerInset } },
    { parent: 3, tag: 'Paragraph', rect: [headerInset, 56, 120, 20], text: 'Agents' },
    { parent: 2, tag: 'View', rect: [0, 88, WIDTH, 712] },
    { parent: 5, tag: 'Image', rect: [188, 300, 24, 24] },
    { parent: 5, tag: 'Paragraph', rect: [112, 340, 176, 20], text: 'Nothing running right now' },
  ];
}

test('gutter: a centred empty state is skipped but its header title is checked', () => {
  assert.deepEqual(run(centeredState()), []);
  const [finding, ...rest] = run(centeredState(22));
  assert.equal(rest.length, 0);
  assert.equal(finding?.measured, 22);
  assert.equal(finding?.element.text, 'Agents');
});

/**
 * The header's leading control: a 48 dp icon target pulled into the gutter, so
 * its centred glyph paints 2 dp inside it.
 */
function backControlScreen(glyph = 12): ProbeNode[] {
  return [
    { parent: 0, tag: 'RNSScreen', rect: [0, 0, WIDTH, 800] },
    {
      parent: 1,
      tag: 'View',
      rect: [0, 40, WIDTH, 88],
      style: { backgroundColor: '#ffffff', paddingHorizontal: 14 },
    },
    { parent: 2, tag: 'View', rect: [0, 40, 48, 48], style: { overflow: 'hidden' } },
    {
      parent: 3,
      tag: 'View',
      rect: [0, 40, 48, 48],
      pressable: true,
      style: { backgroundColor: '#ececec' },
    },
    { parent: 4, tag: 'Image', rect: [glyph, 52, 24, 24] },
    { parent: 2, tag: 'Paragraph', rect: [14, 96, 120, 20], text: 'Settings' },
  ];
}

test('gutter: the back control pulled into the gutter is a touch frame, not content', () => {
  assert.deepEqual(run(backControlScreen()), []);
});

test('gutter: paint inside the gutter with no such frame is an error', () => {
  // A glyph drawn on the gutter itself, outside a 48 dp target, is content.
  const nodes = backControlScreen(8);
  nodes[3] = { parent: 2, tag: 'View', rect: [0, 40, 48, 48] };
  nodes[4] = { parent: 3, tag: 'Image', rect: [8, 52, 24, 24] };
  const [finding, ...rest] = run(nodes);
  assert.equal(rest.length, 0);
  assert.equal(finding?.measured, 8);
});

test('gutter: a right-to-left screen mirrors both the pass and the 22 dp failure', () => {
  assert.deepEqual(run(mirrored(screen()), { isRTL: true }), []);
  const findings = run(mirrored(screen({ header: 22, body: 22 })), { isRTL: true });
  assert.equal(findings.length, 2);
  assert.ok(findings.every(finding => finding.measured === 22));
});

/**
 * A landscape phone: the notch takes 47 dp on each side, and the header adds its
 * gutter inside that inset.
 */
function landscape(bodyInset: number): ProbeNode[] {
  return [
    { parent: 0, tag: 'RNSScreen', rect: [0, 0, 900, 400] },
    {
      parent: 1,
      tag: 'View',
      rect: [0, 0, 900, 60],
      style: { backgroundColor: '#ffffff', paddingHorizontal: 14 },
    },
    {
      parent: 2,
      tag: 'View',
      rect: [14, 0, 872, 60],
      style: { paddingLeft: 47, paddingRight: 47 },
    },
    { parent: 3, tag: 'Paragraph', rect: [61, 20, 120, 20], text: 'Settings' },
    { parent: 1, tag: 'ScrollView', rect: [0, 60, 900, 340], style: { overflow: 'scroll' } },
    {
      parent: 5,
      tag: 'View',
      rect: [0, 60, 900, 600],
      style: { paddingLeft: 47 + bodyInset, paddingRight: 47 },
    },
    { parent: 6, tag: 'Paragraph', rect: [47 + bodyInset, 80, 300, 16], text: 'Body line' },
  ];
}

const LANDSCAPE: Partial<ProbeEnv> = {
  window: { width: 900, height: 400 },
  safeArea: { top: 0, right: 47, bottom: 21, left: 47 },
};

test('gutter: a landscape side inset is the page edge, not the window edge', () => {
  assert.deepEqual(run(landscape(14), LANDSCAPE), []);
  const [finding, ...rest] = run(landscape(21), LANDSCAPE);
  assert.equal(rest.length, 0);
  assert.equal(finding?.measured, 21);
});

/**
 * A native sheet: the platform presents it in a window of its own, so every
 * frame of its content is relative to the surface, not the screen.
 */
function presentedContent(inset: number): ProbeNode[] {
  return [
    { parent: 0, tag: 'RNHostView', rect: [0, 170, 900, 230], owners: ['RNHostView'] },
    {
      parent: 1,
      tag: 'View',
      rect: [0, 170, 900, 230],
      owners: ['View', 'PresentedContent'],
    },
    { parent: 2, tag: 'View', rect: [0, 0, 900, 230], style: { paddingHorizontal: inset } },
    { parent: 3, tag: 'Paragraph', rect: [inset, 0, 200, 20], text: 'Select account' },
  ];
}

test('gutter: content a native sheet hosts is measured from the sheet root', () => {
  // The window's 47 dp side inset does not describe the sheet's frames; if it
  // did, content at 14 dp inside the sheet would read as 33 dp outside it.
  assert.deepEqual(run(presentedContent(14), LANDSCAPE), []);
  assert.equal(run(presentedContent(21), LANDSCAPE)[0]?.measured, 21);
});

test('gutter: chips in a horizontal scroller keep their scroll offset', () => {
  assert.deepEqual(
    run([
      {
        parent: 0,
        tag: 'ScrollView',
        rect: [0, 200, WIDTH, 40],
        scrollAxes: { x: true, y: false },
      },
      {
        parent: 1,
        tag: 'View',
        rect: [8, 200, 600, 40],
        style: { flexDirection: 'row' },
      },
      { parent: 2, tag: 'View', rect: [8, 204, 80, 32], style: { backgroundColor: '#eeeeee' } },
      { parent: 2, tag: 'Paragraph', rect: [18, 212, 60, 16], text: 'All' },
    ]),
    []
  );
});

test('gutter: a painted block places its own content, so inner insets are not measured', () => {
  assert.deepEqual(
    run([
      { parent: 0, tag: 'RNSScreen', rect: [0, 0, WIDTH, 800] },
      { parent: 1, tag: 'View', rect: [0, 88, WIDTH, 700], style: { paddingHorizontal: 14 } },
      { parent: 2, tag: 'View', rect: [14, 100, 372, 96], style: { backgroundColor: '#f0eee6' } },
      { parent: 3, tag: 'View', rect: [28, 108, 344, 44], style: { paddingHorizontal: 14 } },
      { parent: 4, tag: 'Paragraph', rect: [42, 120, 200, 16], text: 'Row title' },
    ]),
    []
  );
});

test('gutter: content after a leading element of the row starts past the gutter', () => {
  // A session row: the hue strip sits on the gutter and the text follows it.
  assert.deepEqual(
    run([
      { parent: 0, tag: 'ScrollView', rect: [0, 88, WIDTH, 712], style: { overflow: 'scroll' } },
      { parent: 1, tag: 'View', rect: [0, 88, WIDTH, 600] },
      {
        parent: 2,
        tag: 'View',
        rect: [0, 88, WIDTH, 72],
        style: { paddingHorizontal: 14, borderBottomWidth: 0.5 },
      },
      { parent: 3, tag: 'View', rect: [14, 92, 3, 64], style: { backgroundColor: '#22c55e' } },
      { parent: 3, tag: 'View', rect: [22, 100, 300, 44] },
      { parent: 5, tag: 'Paragraph', rect: [22, 104, 200, 16], text: 'Session A' },
    ]),
    []
  );
});

test('gutter: a sibling stacked above the box does not exempt its column', () => {
  // The label sits on the gutter above the content; the body below it is still
  // the screen's column and must start at the gutter too.
  const nodes: ProbeNode[] = [
    { parent: 0, tag: 'RNSScreen', rect: [0, 0, WIDTH, 800] },
    { parent: 1, tag: 'View', rect: [0, 88, WIDTH, 700], style: { paddingHorizontal: 21 } },
    { parent: 2, tag: 'Paragraph', rect: [21, 100, 80, 12], text: 'SESSIONS' },
    { parent: 2, tag: 'Paragraph', rect: [21, 120, 200, 16], text: 'Body line' },
  ];
  assert.equal(run(nodes)[0]?.measured, 21);
});

/**
 * A failed user turn as the device measured it: the turn is end-aligned, so its
 * Retry / Copy to composer row begins where the bubble's column does, at 211 dp,
 * and the row's first button is its own content.
 */
function messageActionsScreen(marked = true): ProbeNode[] {
  return [
    { parent: 0, tag: 'RNSScreen', rect: [0, 0, WIDTH, 800] },
    { parent: 1, tag: 'View', rect: [0, 88, WIDTH, 600], style: { paddingHorizontal: 14 } },
    {
      parent: 2,
      tag: 'View',
      rect: [211, 96, 175, 32],
      style: { flexDirection: 'row' },
      ...(marked ? { testID: 'message-failure-actions' } : {}),
    },
    {
      parent: 3,
      tag: 'View',
      rect: [211, 96, 80, 32],
      pressable: true,
      role: 'button',
      label: 'Retry',
      style: { backgroundColor: '#f0eee6' },
    },
  ];
}

test("gutter: a chat turn's failure actions follow the message, not the page column", () => {
  assert.deepEqual(run(messageActionsScreen()), []);
  const [finding, ...rest] = run(messageActionsScreen(false));
  assert.equal(rest.length, 0);
  assert.equal(finding?.measured, 211);
  assert.equal(finding?.element.label, 'Retry');
});

test('gutter: an out-of-flow overlay is not a column', () => {
  assert.deepEqual(
    run([
      {
        parent: 0,
        tag: 'View',
        rect: [0, 700, 24, 24],
        style: { position: 'absolute', backgroundColor: '#000000' },
      },
    ]),
    []
  );
});

test('gutter: unknown side insets skip the rule', () => {
  assert.deepEqual(run(screen({ header: 22, body: 22 }), { safeAreaKnown: false }), []);
});

/**
 * The bottom tab bar as the device measured it (411 dp wide, window 914 dp): an
 * out-of-flow bar pinned across the page's bottom, its 54 dp row holding four
 * tab items, each centring its label. The first label paints at 4.95 dp.
 */
function tabBarScreen(bodyInset = 14, named = true): ProbeNode[] {
  const owners = (...names: string[]) => (named ? ['View', ...names, 'View'] : ['View']);
  return [
    {
      parent: 0,
      tag: 'View',
      rect: [0, 0, WIDTH, 800],
      style: { paddingHorizontal: bodyInset },
    },
    { parent: 1, tag: 'Paragraph', rect: [bodyInset, 40, 300, 16], text: 'Body line' },
    {
      parent: 0,
      tag: 'View',
      rect: [0, 720, WIDTH, 80],
      style: { position: 'absolute' },
      owners: owners('BottomTabBar'),
    },
    {
      parent: 3,
      tag: 'View',
      rect: [0, 720, WIDTH, 54.1],
      style: { flexDirection: 'row' },
      owners: owners('BottomTabBar'),
    },
    {
      parent: 4,
      tag: 'View',
      rect: [0, 720, 102.86, 54.1],
      owners: owners('BottomTabItem'),
    },
    {
      parent: 5,
      tag: 'View',
      rect: [0, 720, 102.86, 54.1],
      pressable: true,
      role: 'button',
      label: 'Home, tab, 1 of 4',
      style: { alignItems: 'center', flexDirection: 'column', padding: 5 },
      owners: owners('BottomTabItem'),
    },
    {
      parent: 6,
      tag: 'Paragraph',
      rect: [4.95, 748, 92.95, 14.1],
      text: 'Home',
      owners: named ? ['Text', 'TabBarLabel', 'View', 'BottomTabItem'] : ['Text', 'View'],
    },
  ];
}

test('gutter: the bottom tab bar is navigation chrome, its centred labels are not columns', () => {
  // The bar names itself in the component tree, and an out-of-flow bar pinned
  // across the page's bottom is the same chrome without those components.
  assert.deepEqual(run(tabBarScreen()), []);
  assert.deepEqual(run(tabBarScreen(14, false)), []);
});

test('gutter: a tab screen body still starts at the gutter', () => {
  const [finding, ...rest] = run(tabBarScreen(22));
  assert.equal(rest.length, 0);
  assert.equal(finding?.measured, 22);
  assert.equal(finding?.element.text, 'Body line');
});

test('gutter: an out-of-flow full-height layer does not exempt the column it holds', () => {
  // A modal backdrop is absolute but starts at the page top: it is not a bar.
  const [finding, ...rest] = run([
    { parent: 0, tag: 'View', rect: [0, 0, WIDTH, 800], style: { position: 'absolute' } },
    { parent: 1, tag: 'View', rect: [0, 0, WIDTH, 800], style: { paddingHorizontal: 21 } },
    { parent: 2, tag: 'Paragraph', rect: [21, 40, 300, 16], text: 'Body line' },
  ]);
  assert.equal(rest.length, 0);
  assert.equal(finding?.measured, 21);
});

/**
 * A pushed screen's header as the device measured it: the band pads 14 dp, the
 * 48 dp back target is pulled into the gutter (its shell at 0, glyph at 12.19),
 * and the title after it paints at 51.43 dp.
 */
function backHeaderScreen(bodyInset = 14): ProbeNode[] {
  return [
    { parent: 0, tag: 'View', rect: [0, 0, WIDTH, 800] },
    {
      parent: 1,
      tag: 'View',
      rect: [0, 0, WIDTH, 128],
      style: {
        backgroundColor: '#fbfaf5',
        paddingBottom: 10.5,
        paddingInline: 14,
        paddingTop: 40,
      },
    },
    {
      parent: 2,
      tag: 'View',
      rect: [14, 40, WIDTH - 28, 48],
      style: { alignItems: 'center', flexDirection: 'row' },
    },
    { parent: 3, tag: 'View', rect: [0, 40, 48, 48], style: { overflow: 'hidden' } },
    {
      parent: 4,
      tag: 'View',
      rect: [0, 40, 48, 48],
      pressable: true,
      role: 'button',
      label: 'Go back',
      style: { alignItems: 'center', justifyContent: 'center' },
    },
    { parent: 5, tag: 'Image', rect: [12.19, 52, 24, 24] },
    { parent: 3, tag: 'View', rect: [51.43, 52, 320, 24.76] },
    { parent: 7, tag: 'Paragraph', rect: [51.43, 52, 320, 24.76], text: 'Preferences' },
    { parent: 1, tag: 'ScrollView', rect: [0, 128, WIDTH, 672], style: { overflow: 'scroll' } },
    {
      parent: 9,
      tag: 'View',
      rect: [0, 128, WIDTH, 672],
      style: { paddingHorizontal: bodyInset },
    },
    { parent: 10, tag: 'Paragraph', rect: [bodyInset, 140, 300, 16], text: 'Body line' },
  ];
}

test('gutter: a pushed header title follows its back control and is not the column', () => {
  assert.deepEqual(run(backHeaderScreen()), []);
  assert.deepEqual(run(mirrored(backHeaderScreen()), { isRTL: true }), []);
});

test('gutter: a pushed screen whose body column starts at 21 dp still fails', () => {
  const findings = run(backHeaderScreen(21));
  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.measured, 21);
  assert.equal(findings[0]?.element.text, 'Body line');
});

/**
 * The empty state as the device measured it: a body that pads 21 dp and centres
 * a 205 dp stack, whose own text starts with the stack at 103.24 dp.
 */
function emptyStateStack(centeredStack = true): ProbeNode[] {
  const stackX = centeredStack ? 97.34 : 21;
  return [
    { parent: 0, tag: 'View', rect: [0, 0, WIDTH, 800] },
    {
      parent: 1,
      tag: 'View',
      rect: [0, 300, WIDTH, 229.33],
      style: { alignItems: 'center', paddingInline: 21 },
    },
    {
      parent: 2,
      tag: 'View',
      rect: [stackX, 363, 205.33, 45.71],
      style: { alignItems: 'center' },
    },
    {
      parent: 3,
      tag: 'Paragraph',
      rect: [stackX, 363, 205.33, 17.52],
      text: 'Start a coding task from your phone.',
    },
  ];
}

test('gutter: a centred empty state measures its stack, not the text inside it', () => {
  assert.deepEqual(run(emptyStateStack()), []);
  const [finding, ...rest] = run(emptyStateStack(false));
  assert.equal(rest.length, 0);
  assert.equal(finding?.measured, 21);
});

/**
 * The two layers the device dump carried on Preferences: the profile tab root
 * (a 22 dp header column) still mounted under the pushed screen, whose own
 * header repeats the back-control shape above.
 */
function pushedOverTabRoot(bodyInset = 14): ProbeNode[] {
  return [
    { parent: 0, tag: 'View', rect: [0, 0, WIDTH, 800] },
    { parent: 1, tag: 'RNSScreenStack', rect: [0, 0, WIDTH, 800] },
    { parent: 2, tag: 'RNSScreen', rect: [0, 0, WIDTH, 800], style: { position: 'absolute' } },
    { parent: 3, tag: 'View', rect: [0, 0, WIDTH, 800] },
    {
      parent: 4,
      tag: 'View',
      rect: [0, 40, WIDTH, 48],
      style: { backgroundColor: '#fbfaf5', paddingHorizontal: 22 },
    },
    { parent: 5, tag: 'Paragraph', rect: [22, 56, 120, 20], text: 'Profile' },
    { parent: 2, tag: 'RNSScreen', rect: [0, 0, WIDTH, 800], style: { position: 'absolute' } },
    { parent: 7, tag: 'View', rect: [0, 0, WIDTH, 800] },
    {
      parent: 8,
      tag: 'View',
      rect: [0, 0, WIDTH, 128],
      style: {
        backgroundColor: '#fbfaf5',
        paddingBottom: 10.5,
        paddingInline: 14,
        paddingTop: 40,
      },
    },
    {
      parent: 9,
      tag: 'View',
      rect: [14, 40, WIDTH - 28, 48],
      style: { alignItems: 'center', flexDirection: 'row' },
    },
    { parent: 10, tag: 'View', rect: [0, 40, 48, 48], style: { overflow: 'hidden' } },
    {
      parent: 11,
      tag: 'View',
      rect: [0, 40, 48, 48],
      pressable: true,
      role: 'button',
      label: 'Go back',
      style: { alignItems: 'center', justifyContent: 'center' },
    },
    { parent: 12, tag: 'Image', rect: [12.19, 52, 24, 24] },
    { parent: 10, tag: 'View', rect: [51.43, 52, 320, 24.76] },
    { parent: 14, tag: 'Paragraph', rect: [51.43, 52, 320, 24.76], text: 'Preferences' },
    { parent: 8, tag: 'ScrollView', rect: [0, 128, WIDTH, 672], style: { overflow: 'scroll' } },
    {
      parent: 16,
      tag: 'View',
      rect: [0, 128, WIDTH, 672],
      style: { paddingHorizontal: bodyInset },
    },
    { parent: 17, tag: 'Paragraph', rect: [bodyInset, 140, 300, 16], text: 'Preferences body' },
  ];
}

test('gutter: only the top-most screen is measured over the tab root below', () => {
  // The covered profile root's 22 dp column is not the screen's column.
  assert.deepEqual(run(pushedOverTabRoot()), []);
  const findings = run(pushedOverTabRoot(21));
  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.measured, 21);
  assert.equal(findings[0]?.element.text, 'Preferences body');
});
