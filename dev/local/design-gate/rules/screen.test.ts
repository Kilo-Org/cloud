import assert from 'node:assert/strict';
import test from 'node:test';

import type { Finding, RuleId } from '../findings';
import type { LayoutTree, ProbeEnv, ProbeNode } from '../tree';
import { checkScreen } from './index';
import { tree } from './test-dump';

function run(rule: RuleId, children: ProbeNode[], env: Partial<ProbeEnv> = {}): Finding[] {
  const layout: LayoutTree = tree(children, env);
  return checkScreen(layout).filter(finding => finding.rule === rule);
}

const clipBox: ProbeNode = {
  parent: 0,
  tag: 'View',
  rect: [10, 10, 100, 40],
  style: { overflow: 'hidden' },
};

test('clipped: text past a clipping ancestor is an error', () => {
  const [finding, ...rest] = run('clipped', [
    clipBox,
    { parent: 1, tag: 'Paragraph', rect: [10, 10, 101.5, 20], text: 'Hi' },
  ]);
  assert.equal(rest.length, 0);
  assert.equal(finding.severity, 'error');
  assert.equal(finding.measured, 1.5);
  assert.equal(finding.element.index, 2);
  assert.equal(finding.cell, '');
});

test('clipped: 1 dp overflow is tolerated', () => {
  assert.deepEqual(
    run('clipped', [clipBox, { parent: 1, tag: 'Paragraph', rect: [10, 10, 101, 20], text: 'Hi' }]),
    []
  );
});

test('clipped: non-text overflow is a warning and descendants are not repeated', () => {
  const findings = run('clipped', [
    clipBox,
    { parent: 1, tag: 'View', rect: [10, 10, 120, 20] },
    { parent: 2, tag: 'View', rect: [10, 10, 120, 20] },
  ]);
  assert.deepEqual(
    findings.map(f => [f.element.index, f.severity]),
    [[2, 'warning']]
  );
});

test('clipped: padding shrinks the content box', () => {
  const findings = run('clipped', [
    { parent: 0, tag: 'View', rect: [0, 0, 100, 40], style: { paddingHorizontal: 10 } },
    { parent: 1, tag: 'Paragraph', rect: [0, 0, 100, 40], text: 'x' },
  ]);
  assert.equal(findings[0]?.measured, 10);
});

test('clipped: scroll content and absolute children are not clipped', () => {
  assert.deepEqual(
    run('clipped', [
      { parent: 0, tag: 'RCTScrollView', rect: [0, 0, 400, 400] },
      { parent: 1, tag: 'View', rect: [0, 0, 400, 2000] },
      { parent: 0, tag: 'View', rect: [0, 500, 50, 50] },
      { parent: 3, tag: 'View', rect: [40, 500, 50, 50], style: { position: 'absolute' } },
    ]),
    []
  );
});

test('clipped: a transformed parent frame is compared in the transform-free space', () => {
  // A natively presented formSheet reports its screen at the window origin and
  // its content translated by the detent; only the transform-free frames say
  // whether the content is actually cut.
  assert.deepEqual(
    run('clipped', [
      { parent: 0, tag: 'RNSScreen', rect: [0, 0, 400, 800] },
      {
        parent: 1,
        tag: 'RNSScreenContentWrapper',
        rect: [0, 457, 400, 800],
        layoutRect: [0, 0, 400, 800],
        style: { backgroundColor: '#ffffff' },
      },
      {
        parent: 2,
        tag: 'Paragraph',
        rect: [0, 500, 400, 20],
        layoutRect: [0, 43, 400, 20],
        text: 'Pick a profile',
      },
    ]),
    []
  );
});

test('clipped: real overflow still reports with transform-free frames', () => {
  const findings = run('clipped', [
    { parent: 0, tag: 'View', rect: [0, 0, 400, 800] },
    {
      parent: 1,
      tag: 'Paragraph',
      rect: [0, 0, 400, 900],
      layoutRect: [0, 0, 400, 900],
      text: 'x',
    },
  ]);
  assert.equal(findings[0]?.measured, 100);
});

test('clipped: a transformed parent keeps its own padding in the transform-free space', () => {
  const findings = run('clipped', [
    {
      parent: 0,
      tag: 'View',
      rect: [0, 60, 400, 200],
      layoutRect: [0, 0, 400, 200],
      style: { paddingHorizontal: 16 },
    },
    {
      parent: 1,
      tag: 'Paragraph',
      rect: [0, 60, 400, 20],
      layoutRect: [0, 0, 400, 20],
      text: 'x',
    },
  ]);
  assert.equal(findings[0]?.measured, 16);
});

test('cut-off: past the window edge, tolerance, horizontal scroll', () => {
  const paragraph = (width: number): ProbeNode => ({
    parent: 0,
    tag: 'Paragraph',
    rect: [0, 100, width, 20],
    text: 'x',
  });
  assert.equal(run('cut-off', [paragraph(402)])[0]?.measured, 2);
  assert.deepEqual(run('cut-off', [paragraph(401)]), []);
  assert.deepEqual(
    run('cut-off', [
      { parent: 0, tag: 'AndroidHorizontalScrollView', rect: [0, 0, 400, 50] },
      { parent: 1, tag: 'View', rect: [0, 0, 1200, 50], style: { flexDirection: 'row' } },
    ]),
    []
  );
});

test('touch-overlap: intersecting pressables, tolerance, containment', () => {
  const button = (x: number): ProbeNode => ({
    parent: 0,
    tag: 'View',
    rect: [x, 0, 50, 50],
    pressable: true,
  });
  const [finding] = run('touch-overlap', [button(0), button(48)]);
  assert.equal(finding?.measured, 2);
  assert.deepEqual(
    finding?.related?.map(ref => ref.index),
    [1]
  );
  assert.deepEqual(run('touch-overlap', [button(0), button(49)]), []);
  assert.deepEqual(
    run('touch-overlap', [
      button(0),
      { parent: 1, tag: 'View', rect: [10, 10, 30, 30], pressable: true },
    ]),
    []
  );
});

test('touch-overlap: a clipped run is contained by the row that draws it', () => {
  const row = (clips: boolean): ProbeNode => ({
    parent: 0,
    tag: 'ViewGroup',
    rect: [0, 100, 400, 120],
    pressable: true,
    ...(clips ? { style: { overflow: 'hidden' } } : {}),
  });
  const runBox: ProbeNode = { parent: 1, tag: 'View', rect: [90, 40, 290, 144], pressable: true };
  // The row draws its child clipped to its own box, so the child's visible area
  // sits inside the row's and the row is the only target a tap can reach.
  assert.deepEqual(run('touch-overlap', [row(true), runBox]), []);
  // The same box outside a clipping parent is still a second target.
  const [finding] = run('touch-overlap', [row(false), runBox]);
  assert.equal(finding?.measured, 84);
});

test('touch-target: a control inside a clipping row is measured by its own frame', () => {
  // The row shows 38 dp of this 48 dp control at the pane edge. Size rules read
  // the frame the platform gave the control, so its own target still counts.
  const findings = run('touch-target', [
    { parent: 0, tag: 'ViewGroup', rect: [0, 100, 400, 120], style: { overflow: 'hidden' } },
    { parent: 1, tag: 'View', rect: [0, 90, 400, 48], pressable: true, role: 'button' },
  ]);
  assert.deepEqual(findings, []);
});

test('touch-overlap: runs of one wrapped paragraph share the text owner, separate owners still collide', () => {
  // agent-device reports every hittable accessibility node pressable, so a
  // wrapped paragraph comes back as two sibling boxes that intersect where the
  // line wraps. The text owns that tap, so the pair is skipped; the same two
  // boxes as two separate targets are still a defect.
  const wrapped = (secondParent: number): ProbeNode[] => [
    { parent: 0, tag: 'Paragraph', rect: [0, 120, 384, 72], text: 'first second third' },
    { parent: 1, tag: 'View', rect: [0, 120, 384, 48], pressable: true, text: 'first second' },
    { parent: secondParent, tag: 'View', rect: [0, 144, 384, 48], pressable: true, text: 'third' },
  ];
  assert.deepEqual(run('touch-overlap', wrapped(1)), []);
  const [ownOwner] = run('touch-overlap', wrapped(0));
  assert.equal(ownOwner?.measured, 24);
  assert.deepEqual(
    ownOwner?.related?.map(ref => ref.index),
    [2]
  );

  // Two inline links are their own tap owners even inside one text, so their
  // own overlap is still measured. Their rects intersect without one holding
  // the other.
  const [linksFinding] = run('touch-overlap', [
    { parent: 0, tag: 'Paragraph', rect: [0, 120, 384, 72], text: 'first second third' },
    {
      parent: 1,
      tag: 'View',
      rect: [0, 144, 384, 48],
      pressable: true,
      role: 'link',
      text: 'third',
    },
    {
      parent: 1,
      tag: 'View',
      rect: [20, 160, 384, 30],
      pressable: true,
      role: 'link',
      text: 'more',
    },
  ]);
  assert.equal(linksFinding?.element?.index, 3);
  assert.deepEqual(
    linksFinding?.related?.map(ref => ref.index),
    [2]
  );
  const [linkFinding] = run('touch-overlap', [
    ...wrapped(1),
    {
      parent: 1,
      tag: 'View',
      rect: [370, 146, 40, 60],
      pressable: true,
      role: 'link',
      text: 'link',
    },
    { parent: 0, tag: 'View', rect: [350, 150, 60, 48], pressable: true, text: 'Done' },
  ]);
  assert.equal(linkFinding?.element?.index, 4);
});

test('overlap: text siblings collide, tolerance, absolute sibling', () => {
  const text = (y: number, style?: ProbeNode['style']): ProbeNode => ({
    parent: 0,
    tag: 'Paragraph',
    rect: [0, y, 100, 20],
    text: 'x',
    ...(style ? { style } : {}),
  });
  assert.equal(run('overlap', [text(0), text(18)])[0]?.measured, 2);
  assert.deepEqual(run('overlap', [text(0), text(19)]), []);
  assert.deepEqual(run('overlap', [text(0), text(10, { position: 'absolute' })]), []);
});

test('row-misaligned: centers apart, tolerance, tall row', () => {
  const row = (height: number, secondY: number): ProbeNode[] => [
    { parent: 0, tag: 'View', rect: [0, 0, 400, height], style: { flexDirection: 'row' } },
    { parent: 1, tag: 'View', rect: [0, 10, 20, 20] },
    { parent: 1, tag: 'View', rect: [30, secondY, 20, 20] },
  ];
  const [finding] = run('row-misaligned', row(48, 12));
  assert.equal(finding?.measured, 2);
  assert.deepEqual(
    finding?.related?.map(ref => ref.index),
    [2, 3]
  );
  assert.deepEqual(run('row-misaligned', row(48, 11)), []);
  assert.deepEqual(run('row-misaligned', row(65, 12)), []);
});

test('row-misaligned: an icon on the first line of a stacked text block is not a defect', () => {
  assert.deepEqual(
    run('row-misaligned', [
      { parent: 0, tag: 'View', rect: [0, 0, 400, 52], style: { flexDirection: 'row' } },
      { parent: 1, tag: 'View', rect: [0, 8, 300, 36] },
      { parent: 2, tag: 'Paragraph', rect: [0, 8, 100, 14], text: 'CLI' },
      { parent: 2, tag: 'Paragraph', rect: [0, 26, 200, 18], text: 'Title' },
      { parent: 1, tag: 'View', rect: [380, 8, 14, 14] },
    ]),
    []
  );
});

test('touch-target: below minimum, below touch size, hitSlop, covering pressable', () => {
  const pressable = (width: number, height: number, extra: Partial<ProbeNode> = {}): ProbeNode => ({
    parent: 0,
    tag: 'View',
    rect: [100, 100, width, height],
    pressable: true,
    ...extra,
  });
  assert.equal(run('touch-target', [pressable(27, 40)])[0]?.severity, 'error');
  assert.deepEqual(
    run('touch-target', [pressable(28, 44)]).map(f => f.severity),
    ['warning']
  );
  assert.deepEqual(run('touch-target', [pressable(44, 44)]), []);
  assert.deepEqual(
    run('touch-target', [pressable(30, 30, { hitSlop: { top: 7, right: 7, bottom: 7, left: 7 } })]),
    []
  );
  assert.deepEqual(
    run('touch-target', [
      { parent: 0, tag: 'View', rect: [90, 90, 60, 60], pressable: true },
      { ...pressable(20, 20), parent: 1 },
    ]),
    []
  );
});

test('safe-area: text under the top and bottom insets, tolerance', () => {
  const env = { safeArea: { top: 24, right: 0, bottom: 30, left: 0 } };
  const text = (y: number): ProbeNode => ({
    parent: 0,
    tag: 'Paragraph',
    rect: [0, y, 100, 20],
    text: 'x',
  });
  assert.equal(run('safe-area', [text(22)], env)[0]?.measured, 2);
  assert.deepEqual(run('safe-area', [text(23)], env), []);
  assert.equal(run('safe-area', [text(752)], env)[0]?.measured, 2);
  assert.deepEqual(run('safe-area', [text(751)], env), []);
  assert.deepEqual(run('safe-area', [{ parent: 0, tag: 'View', rect: [0, 0, 400, 100] }], env), []);
});

test('safe-area: a presented surface is measured from its own origin', () => {
  const env = {
    safeArea: { top: 24, right: 0, bottom: 30, left: 0 },
    window: { width: 400, height: 800 },
  };
  // A native sheet presents in its own window, so every frame of its content
  // starts at the surface's origin whatever its height: a bottom sheet 170 dp
  // tall and a full-window one both report their heading at y 0, and neither
  // frame can be compared with the window's top inset.
  const presented = (height: number): ProbeNode[] => [
    { parent: 0, tag: 'RNHostView', rect: [0, 800 - height, 400, height], owners: ['RNHostView'] },
    {
      parent: 1,
      tag: 'View',
      rect: [0, 800 - height, 400, height],
      owners: ['View', 'PresentedContent'],
    },
    { parent: 2, tag: 'Paragraph', rect: [0, 0, 400, 20], text: 'Select account' },
  ];
  assert.deepEqual(run('safe-area', presented(170), env), []);
  assert.deepEqual(run('safe-area', presented(746), env), []);

  // The same frame outside a presented surface still reports the inset.
  assert.equal(
    run(
      'safe-area',
      [{ parent: 0, tag: 'Paragraph', rect: [0, 0, 400, 20], text: 'Select account' }],
      env
    )[0]?.measured,
    20
  );
});

test('touch-target: allows 0.5 dp of pixel-snapping rounding', () => {
  const pressable = (size: number): ProbeNode => ({
    parent: 0,
    tag: 'View',
    rect: [100, 100, size, size],
    pressable: true,
  });
  assert.deepEqual(run('touch-target', [pressable(43.81)]), []);
  assert.deepEqual(
    run('touch-target', [pressable(43.4)]).map(f => f.severity),
    ['warning']
  );
  assert.deepEqual(
    run('touch-target', [pressable(27.6)]).map(f => f.severity),
    ['warning']
  );
  assert.deepEqual(
    run('touch-target', [pressable(27.4)]).map(f => f.severity),
    ['error']
  );
});

test('clipped: transparent boxes overflowing a non-clipping parent paint nothing', () => {
  const line: ProbeNode = { parent: 0, tag: 'View', rect: [0, 100, 200, 20] };
  const tapBox = (style?: ProbeNode['style']): ProbeNode => ({
    parent: 1,
    tag: 'View',
    rect: [0, 86, 48, 48],
    pressable: true,
    ...(style ? { style } : {}),
  });
  assert.deepEqual(run('clipped', [line, tapBox()]), []);
  assert.deepEqual(run('clipped', [line, tapBox({ backgroundColor: 'rgba(0, 0, 0, 0)' })]), []);
  assert.equal(
    run('clipped', [line, tapBox({ backgroundColor: '#ff0000' })])[0]?.severity,
    'warning'
  );
  assert.equal(run('clipped', [line, tapBox({ borderWidth: 1 })])[0]?.measured, 14);
  assert.equal(run('clipped', [line, { ...tapBox(), tag: 'ExpoImage' }])[0]?.measured, 14);
});

test('overlap: a sibling layered fully inside another is not a collision', () => {
  const scroll: ProbeNode = {
    parent: 0,
    tag: 'RCTScrollView',
    rect: [0, 0, 400, 800],
    pressable: true,
  };
  const floating: ProbeNode = { parent: 0, tag: 'Paragraph', rect: [340, 740, 48, 48], text: 'EN' };
  assert.deepEqual(run('overlap', [scroll, floating]), []);
  assert.equal(run('overlap', [scroll, { ...floating, rect: [370, 740, 48, 48] }]).length, 1);
  assert.equal(
    run('overlap', [
      { parent: 0, tag: 'Paragraph', rect: [0, 0, 100, 20], text: 'a' },
      { parent: 0, tag: 'Paragraph', rect: [50, 10, 100, 20], text: 'b' },
    ]).length,
    1
  );
});

test('touch-target: uiautomator floor violations are warnings', () => {
  const link: ProbeNode = { parent: 0, tag: 'View', rect: [100, 100, 60, 14], pressable: true };
  assert.deepEqual(
    run('touch-target', [link], { source: 'agent-device' }).map(f => f.severity),
    ['warning']
  );
  assert.deepEqual(
    run('touch-target', [link], { source: 'uiautomator' }).map(f => f.severity),
    ['warning']
  );
  assert.deepEqual(
    run('touch-target', [link], { source: 'probe' }).map(f => f.severity),
    ['error']
  );
});

test('row-misaligned: wrapping rows are skipped', () => {
  const nodes = (flexWrap?: string): ProbeNode[] => [
    {
      parent: 0,
      tag: 'View',
      rect: [0, 0, 400, 48],
      style: { flexDirection: 'row', ...(flexWrap ? { flexWrap } : {}) },
    },
    { parent: 1, tag: 'View', rect: [0, 0, 20, 20] },
    { parent: 1, tag: 'View', rect: [30, 24, 20, 20] },
  ];
  assert.equal(run('row-misaligned', nodes()).length, 1);
  assert.deepEqual(run('row-misaligned', nodes('wrap')), []);
  assert.deepEqual(run('row-misaligned', nodes('wrap-reverse')), []);
});

test('safe-area: content scrolled under a system inset is fine', () => {
  const env = { safeArea: { top: 24, right: 0, bottom: 30, left: 0 } };
  assert.deepEqual(
    run(
      'safe-area',
      [
        { parent: 0, tag: 'RCTScrollView', rect: [0, 0, 400, 800] },
        { parent: 1, tag: 'View', rect: [0, -200, 400, 2000] },
        { parent: 2, tag: 'Paragraph', rect: [0, 10, 100, 20], text: 'x' },
      ],
      env
    ),
    []
  );
});

test('touch-overlap: a presented sheet never competes with the window behind it', () => {
  // A full detent spans the window, so its placed frames sit exactly where the
  // window's own controls are. The sheet still takes the tap first: two boxes
  // that intersect across windows are not one ambiguous target. `normalize`
  // places the sheet in window space before the rule runs.
  const header: ProbeNode = { parent: 0, tag: 'View', rect: [0, 0, 48, 48], pressable: true };
  const sheet: ProbeNode = { parent: 3, tag: 'View', rect: [0, 0, 400, 44], pressable: true };
  const presented: ProbeNode[] = [
    header,
    { parent: 0, tag: 'ViewManagerAdapter_ExpoUI_HostView', rect: [0, 0, 400, 800] },
    { parent: 2, tag: 'ViewManagerAdapter_ExpoUI_RNHostView', rect: [0, 0, 400, 800] },
    sheet,
  ];

  const placed = tree(presented);
  const headerNode = placed.nodes[1];
  const sheetButton = placed.nodes[4];
  // Precondition: both boxes are in window space and they do intersect.
  assert.deepEqual(headerNode.rect, [0, 0, 48, 48]);
  assert.deepEqual(sheetButton.rect, [0, 0, 400, 44]);
  assert.equal(sheetButton.presented?.space, placed.nodes[2].index);
  assert.equal(headerNode.presented, undefined);
  assert.ok(sheetButton.rect[2] > headerNode.rect[0] && headerNode.rect[2] > sheetButton.rect[0]);
  assert.ok(sheetButton.rect[3] > headerNode.rect[1] && headerNode.rect[3] > sheetButton.rect[1]);

  assert.deepEqual(run('touch-overlap', presented), []);

  // The same two boxes in one window are the defect the rule exists for.
  const [finding] = run('touch-overlap', [
    header,
    { parent: 0, tag: 'View', rect: [0, 0, 400, 44], pressable: true },
  ]);
  assert.equal(finding?.measured, 44);
});
