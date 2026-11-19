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

test('clipped: padding shrinks the content box of a parent that clips', () => {
  const findings = run('clipped', [
    {
      parent: 0,
      tag: 'View',
      rect: [0, 0, 100, 40],
      style: { overflow: 'hidden', paddingHorizontal: 10 },
    },
    { parent: 1, tag: 'Paragraph', rect: [0, 0, 100, 40], text: 'x' },
  ]);
  assert.equal(findings[0]?.measured, 10);
});

test('clipped: a parent that does not clip is measured by its border box', () => {
  // An iOS tab button: 5 pt padding, a 28 pt icon, and a 14.33 pt label line
  // box that ends 2.33 pt into the bottom padding. The label's ink stays inside
  // the button, and nothing clips it.
  const tab = (labelHeight: number) =>
    run(
      'clipped',
      [
        {
          parent: 0,
          tag: 'View',
          rect: [301.67, 790, 100.33, 50],
          style: { alignItems: 'center', flexDirection: 'column', padding: 5 },
        },
        { parent: 1, tag: 'View', rect: [336.33, 795, 31, 28] },
        {
          parent: 1,
          tag: 'Paragraph',
          rect: [306.67, 823, 90.67, labelHeight],
          text: 'Profile',
        },
      ],
      { platform: 'ios', window: { width: 402, height: 874 } }
    );
  assert.deepEqual(tab(14.33), []);
  // Past the border box the label leaves the button, and that is still reported.
  const [finding, ...rest] = tab(19.5);
  assert.equal(rest.length, 0);
  assert.equal(finding?.severity, 'error');
  assert.equal(Math.round((finding?.measured ?? 0) * 10) / 10, 2.5);
  assert.match(finding?.message ?? '', /beyond the border box of its parent/);
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

test('clipped: a transformed clipping parent keeps its own padding in the transform-free space', () => {
  const findings = run('clipped', [
    {
      parent: 0,
      tag: 'View',
      rect: [0, 60, 400, 200],
      layoutRect: [0, 0, 400, 200],
      style: { overflow: 'hidden', paddingHorizontal: 16 },
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

test('cut-off: an iOS keyboard accessory placeholder is not measured', () => {
  // The instructions editor's "Done" bar: absolute in the app tree at x 14 with
  // the window's width, painted only in the keyboard's accessory window.
  const bar = (tag: string): ProbeNode[] => [
    { parent: 0, tag, rect: [14, 139.33, 402, 45.67], style: { position: 'absolute' } },
    { parent: 1, tag: 'View', rect: [14, 139.33, 402, 45.67], style: { flexDirection: 'row' } },
    { parent: 2, tag: 'Paragraph', rect: [360, 151, 40, 21], text: 'Done' },
  ];
  const ios = { platform: 'ios', window: { width: 402, height: 874 } };
  assert.deepEqual(run('cut-off', bar('InputAccessoryView'), ios), []);
  assert.equal(run('cut-off', bar('View'), ios)[0]?.measured, 14);
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

const IOS_26: Partial<ProbeEnv> = {
  platform: 'ios',
  osVersion: '26.5',
  window: { width: 402, height: 874 },
};

/** An instruction row: an iOS switch in a 44 pt frame beside a 32 pt trash button. */
function switchAndIcon(switchY: number): ProbeNode[] {
  return [
    {
      parent: 0,
      tag: 'View',
      rect: [261.67, 170, 112.33, 32],
      style: { alignItems: 'center', flexDirection: 'row' },
    },
    {
      parent: 1,
      tag: 'Switch',
      role: 'switch',
      rect: [261.67, switchY, 63, 44],
      style: { alignSelf: 'flex-start' },
    },
    { parent: 1, tag: 'View', rect: [342.33, 170, 32, 32], pressable: true },
  ];
}

test('row-misaligned: an iOS switch is measured by the track it paints', () => {
  // UISwitch paints its 28 pt track at the top of the 44 pt frame, so the track
  // center is 175.33 while the trash button's is 186.
  const [finding, ...rest] = run('row-misaligned', switchAndIcon(161.33), IOS_26);
  assert.equal(rest.length, 0);
  assert.equal(Math.round((finding?.measured ?? 0) * 100) / 100, 10.67);
  assert.deepEqual(
    finding?.related?.map(ref => ref.index),
    [2, 3]
  );
  // Before iOS 26 the track is 31 pt.
  const legacy = run('row-misaligned', switchAndIcon(161.33), { ...IOS_26, osVersion: '18.4' });
  assert.equal(Math.round((legacy[0]?.measured ?? 0) * 100) / 100, 9.17);
  // Android centers its track in the frame, so the frame's center is the track's.
  assert.deepEqual(
    run('row-misaligned', switchAndIcon(164), { ...IOS_26, platform: 'android' }),
    []
  );
  // A centered iOS switch frame (28 pt) beside the button passes.
  assert.deepEqual(
    run(
      'row-misaligned',
      switchAndIcon(172).map(node =>
        node.tag === 'Switch' ? { ...node, rect: [261.67, 172, 63, 28] as const } : node
      ),
      IOS_26
    ),
    []
  );
});

/** A notification row: a two-line text block beside a switch, in a row that centers its items. */
function twoLineSwitchRow(switchY: number, alignItems = 'center'): ProbeNode[] {
  return [
    {
      parent: 0,
      tag: 'View',
      rect: [14, 186.33, 374, 54.67],
      style: { alignItems, flexDirection: 'row', paddingBlock: 10.5, paddingInline: 14 },
    },
    { parent: 1, tag: 'View', rect: [28, 186.33, 276, 54.67] },
    { parent: 2, tag: 'Paragraph', rect: [28, 196.83, 276, 20], text: 'Active agents' },
    { parent: 2, tag: 'Paragraph', rect: [28, 218.83, 276, 18], text: 'When an agent starts' },
    { parent: 1, tag: 'Switch', role: 'switch', rect: [311, switchY, 63, 44] },
  ];
}

test('row-misaligned: a switch beside a two-line block is measured against the row center', () => {
  // The text block is the only other child and it wraps, so there is no
  // single-line sibling to compare with. The row centers its items, so the
  // track belongs on the row's center (213.67); it paints at 202.33.
  const [finding, ...rest] = run('row-misaligned', twoLineSwitchRow(188.33), IOS_26);
  assert.equal(rest.length, 0);
  assert.ok(Math.abs((finding?.measured ?? 0) - 11.33) < 0.01);
  assert.deepEqual(
    finding?.related?.map(ref => ref.index),
    [5]
  );
  assert.match(finding?.message ?? '', /off the center of row/);
  // A centered track passes, on iOS and on Android.
  assert.deepEqual(run('row-misaligned', twoLineSwitchRow(191.67 + 8), IOS_26), []);
  assert.deepEqual(
    run('row-misaligned', twoLineSwitchRow(191.67), { ...IOS_26, platform: 'android' }),
    []
  );
  // A row that puts its items at the top asks for the switch there.
  assert.deepEqual(run('row-misaligned', twoLineSwitchRow(188.33, 'flex-start'), IOS_26), []);
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

test('touch-target: read-only text a field lets you select is not a control', () => {
  // A `SelectableText` value: a read-only multiline `TextInput` whose height is
  // its text's, not a target's. The platform still hands it a press handler to
  // start a selection, which the probe reports beside `readOnly`.
  const value = (height: number): ProbeNode => ({
    parent: 0,
    tag: 'TextInput',
    rect: [14, 275, 384, height],
    pressable: true,
    readOnly: true,
    text: '/tmp/random.txt',
  });
  assert.deepEqual(run('touch-target', [value(14.1)]), []);
  assert.deepEqual(run('touch-target', [value(28.2)]), []);
  // The same field while editable is a target: the reader taps it to type.
  assert.equal(
    run('touch-target', [{ ...value(14.1), readOnly: undefined }])[0]?.severity,
    'error'
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

test('safe-area: an iOS page sheet is measured where UIKit places it', () => {
  // The probe reports the 812 pt page sheet's "Go back" 32 pt from the top, in
  // the status bar. UIKit puts the sheet 62 pt down, so the button is at 94.
  const env = {
    ...IOS_26,
    safeArea: { top: 62, right: 0, bottom: 34, left: 0 },
  };
  const pageSheet = (footerY: number): ProbeNode[] => [
    { parent: 0, tag: 'RNSModalScreen', rect: [0, 0, 402, 812] },
    { parent: 1, tag: 'View', rect: [14, 32, 44, 44], label: 'Go back', pressable: true },
    { parent: 1, tag: 'View', rect: [14, footerY, 374, 44], label: 'Buy credits', pressable: true },
  ];
  assert.deepEqual(run('safe-area', pageSheet(720), env), []);
  // The sheet ends at the window's bottom, so its footer must still clear the
  // home indicator: at 760 in the sheet it sits at 822–866, 26 pt into the inset.
  const [finding, ...rest] = run('safe-area', pageSheet(760), env);
  assert.equal(rest.length, 0);
  assert.equal(finding?.element.label, 'Buy credits');
  assert.equal(finding?.measured, 26);
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

test('touch-overlap: an iOS @expo/ui sheet never competes with the header under it', () => {
  // T1-auth02 part-detail sheet: its Wrap segment reported 30.3 × 30 dp over
  // the header's back button behind the sheet.
  const nodes: ProbeNode[] = [
    { parent: 0, tag: 'View', rect: [0, 70, 48, 48], label: 'Back', pressable: true },
    { parent: 0, tag: 'ViewManagerAdapter_ExpoUI_HostView', rect: [0, 0, 402, 778] },
    { parent: 2, tag: 'ViewManagerAdapter_ExpoUI_RNHostView', rect: [0, 0, 402, 778] },
    { parent: 3, tag: 'View', rect: [17.67, 88, 183.33, 48], label: 'Wrap', pressable: true },
  ];
  const env = {
    ...IOS_26,
    safeArea: { top: 62, right: 0, bottom: 34, left: 0 },
  };
  assert.deepEqual(run('touch-overlap', nodes, env), []);
});
