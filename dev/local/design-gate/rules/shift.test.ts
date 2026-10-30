import assert from 'node:assert/strict';
import test from 'node:test';

import type { ProbeNode, Rect } from '../tree';
import { checkShift } from './index';
import { tree } from './test-dump';

function timeline(rects: (Rect | undefined)[]) {
  return rects.map(rect =>
    tree(rect ? [{ parent: 0, tag: 'Paragraph', rect, text: 'Title', testID: 'title' }] : [])
  );
}

test('layout-shift: element at rest moves and rests again', () => {
  const findings = checkShift(
    timeline([
      [0, 10, 100, 20],
      [0, 10, 100, 20],
      [0, 40, 100, 20],
      [0, 40, 100, 20],
    ]),
    120
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0].measured, 30);
  assert.equal(findings[0].element.testID, 'title');
  assert.match(findings[0].message, /240 ms/);
});

test('layout-shift: 1 dp movement, resize, and never resting are not shifts', () => {
  const rest = (y: number, height = 20): Rect => [0, y, 100, height];
  assert.deepEqual(checkShift(timeline([rest(10), rest(10), rest(11), rest(11)]), 120), []);
  assert.deepEqual(checkShift(timeline([rest(10), rest(10), rest(40, 30), rest(40, 30)]), 120), []);
  assert.deepEqual(checkShift(timeline([rest(10), rest(20), rest(30), rest(40)]), 120), []);
});

test('layout-shift: appearing and moving before the first rest are not shifts', () => {
  assert.deepEqual(
    checkShift(timeline([undefined, [0, 80, 100, 20], [0, 10, 100, 20], [0, 10, 100, 20]]), 120),
    []
  );
});

test('layout-shift: elements that appear late are tracked from their first rest', () => {
  const at = (y: number): [number, number, number, number] => [0, y, 100, 20];
  const findings = checkShift(
    timeline([undefined, at(538.67), ...Array(3).fill(at(479.24)), ...Array(10).fill(at(501.71))]),
    120
  );
  assert.deepEqual(
    findings.map(f => [f.severity, f.measured]),
    [['error', 22.47]]
  );
});

test('layout-shift: testID duplicates are told apart by order', () => {
  const samples = [10, 10, 40, 40].map(y =>
    tree([
      { parent: 0, tag: 'Paragraph', rect: [0, 0, 100, 20], text: 'Row', testID: 'row' },
      { parent: 0, tag: 'Paragraph', rect: [0, y + 20, 100, 20], text: 'Row', testID: 'row' },
    ])
  );
  const findings = checkShift(samples, 120);
  assert.deepEqual(
    findings.map(f => f.element.index),
    [2]
  );
});

test('layout-shift: transitions spanning at least 200 ms are animated warnings', () => {
  const at = (y: number): Rect => [0, y, 100, 20];
  const animated = checkShift(timeline([at(10), at(10), at(20), at(30), at(40), at(40)]), 120);
  assert.deepEqual(
    animated.map(f => f.severity),
    ['warning']
  );
  assert.match(animated[0].message, /animated layout shift/);
  const twoStep = checkShift(timeline([at(10), at(10), at(25), at(40), at(40)]), 120);
  assert.deepEqual(
    twoStep.map(f => f.severity),
    ['error']
  );
});

test('layout-shift: elements moved by one cause are grouped into one finding', () => {
  const samples = [0, 0, 1.1, 1.1].map((dy, i) =>
    tree([
      { parent: 0, tag: 'Paragraph', rect: [0, 100 + dy, 100, 20], text: 'A' },
      { parent: 0, tag: 'Paragraph', rect: [0, 130 + dy, 100, 20], text: 'B' },
      { parent: 0, tag: 'Paragraph', rect: [0, 160 + dy * (i > 1 ? 3 : 1), 100, 20], text: 'C' },
    ])
  );
  const findings = checkShift(samples, 120);
  assert.deepEqual(
    findings.map(f => [f.element.text, f.related?.map(ref => ref.text)]),
    [
      ['A', ['B']],
      ['C', ['C']],
    ]
  );
  assert.match(findings[0].message, /^Paragraph\[0\] and 1 more elements moved 1\.1 dp/);
});

test('layout-shift: text-only identities repeated within a sample are not tracked', () => {
  const sample = (y: number, dupe: boolean) =>
    tree([
      { parent: 0, tag: 'View', rect: [0, 0, 40, 40], owners: ['Eyebrow'] },
      {
        parent: 1,
        tag: 'Paragraph',
        rect: [0, y, 100, 20],
        owners: ['Text', 'Eyebrow'],
        text: 'SAMPLE',
      },
      ...(dupe
        ? [{ parent: 0, tag: 'Paragraph', rect: [0, 300, 100, 20], text: 'SAMPLE' } as ProbeNode]
        : []),
    ]);
  assert.equal(
    checkShift([sample(10, false), sample(10, false), sample(40, false), sample(40, false)], 120)
      .length,
    1
  );
  assert.deepEqual(
    checkShift([sample(10, true), sample(10, true), sample(40, true), sample(40, true)], 120),
    []
  );
});

test('layout-shift: an overlay or motion shared with an ancestor is not a layout shift', () => {
  // A push transition moves the container and its child by the same vector.
  const moving = (y: number) => [
    { parent: 0, tag: 'View', rect: [0, y, 400, 200] as Rect },
    {
      parent: 1,
      tag: 'Paragraph',
      rect: [0, y + 10, 100, 20] as Rect,
      text: 'Title',
      testID: 'title',
    },
  ];
  assert.deepEqual(
    checkShift(
      [moving(0), moving(0), moving(300), moving(300)].map(nodes => tree(nodes)),
      120
    ),
    []
  );
  // The child moves inside a container that stays put, which is a real shift.
  const inside = (y: number) => [
    { parent: 0, tag: 'View', rect: [0, 0, 400, 200] as Rect },
    { parent: 1, tag: 'Paragraph', rect: [0, y, 100, 20] as Rect, text: 'Title', testID: 'title' },
  ];
  assert.equal(
    checkShift(
      [inside(10), inside(10), inside(40), inside(40)].map(nodes => tree(nodes)),
      120
    ).length,
    1
  );
  // An out-of-flow overlay moves on purpose.
  const overlay = (y: number) => [
    {
      parent: 0,
      tag: 'View',
      rect: [0, y, 300, 60] as Rect,
      text: 'Footer',
      testID: 'footer',
      style: { position: 'absolute' },
    },
  ];
  assert.deepEqual(
    checkShift(
      [overlay(10), overlay(10), overlay(200), overlay(200)].map(nodes => tree(nodes)),
      120
    ),
    []
  );
  // An ancestor that also changes size means content arrived, so the child still reports.
  const growing = (y: number, height: number, shift: number) => [
    { parent: 0, tag: 'View', rect: [0, y, 400, height] as Rect },
    {
      parent: 1,
      tag: 'Paragraph',
      rect: [0, y + shift, 100, 20] as Rect,
      text: 'Title',
      testID: 'title',
    },
  ];
  assert.equal(
    checkShift(
      [growing(0, 200, 10), growing(0, 200, 10), growing(30, 260, 40), growing(30, 260, 40)].map(
        nodes => tree(nodes)
      ),
      120
    ).length,
    1
  );
});

test('layout-shift: a route change starts a new rest', () => {
  const sample = (route: string, y: number) =>
    tree([{ parent: 0, tag: 'Paragraph', rect: [0, y, 100, 20], text: 'Title', testID: 'title' }], {
      route,
    });
  const samples = [sample('/', 10), sample('/', 10), sample('/target', 40), sample('/target', 40)];
  assert.deepEqual(checkShift(samples, 120), []);
});
