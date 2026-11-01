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

test('clipped: a transformed parent frame is compared in one space', () => {
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
