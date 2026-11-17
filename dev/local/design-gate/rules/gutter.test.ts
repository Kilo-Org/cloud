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
