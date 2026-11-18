import assert from 'node:assert/strict';
import test from 'node:test';

import type { ProbeNode, Rect } from '../tree';
import { checkScreen } from './index';
import { tree } from './test-dump';

function card(child: Rect, extra: Partial<ProbeNode> = {}) {
  const nodes: ProbeNode[] = [
    {
      parent: 0,
      tag: 'View',
      rect: [0, 100, 200, 40],
      style: { backgroundColor: '#ffffff' },
      ...extra,
    },
    { parent: 1, tag: 'Paragraph', rect: child, text: 'Badge' },
  ];
  return checkScreen(tree(nodes)).filter(finding => finding.rule === 'inset-asymmetry');
}

test('inset-asymmetry: uneven vertical padding on a painted card warns', () => {
  const [finding, ...rest] = card([10, 104, 180, 20]);
  assert.equal(rest.length, 0);
  assert.equal(finding?.severity, 'warning');
  assert.equal(finding?.measured, 12);
  assert.match(finding?.message ?? '', /top gap 4 dp vs bottom gap 16 dp/);
});

test('inset-asymmetry: balanced, boundary, full-bleed, transparent, and control cases pass', () => {
  assert.deepEqual(card([10, 110, 180, 20]), []);
  assert.deepEqual(card([10, 107, 180, 20]), []);
  assert.equal(card([10, 106.5, 180, 20])[0]?.measured, 7);
  assert.deepEqual(card([10, 100, 180, 20]), []);
  assert.deepEqual(card([10, 104, 180, 20], { style: { backgroundColor: 'transparent' } }), []);
  assert.deepEqual(card([10, 104, 180, 20], { pressable: true }), []);
});

test('inset-asymmetry: horizontal only when content spans at least 60% of the width', () => {
  assert.deepEqual(card([10, 110, 100, 20]), []);
  assert.deepEqual(card([4, 110, 180, 20]), []);
  const [finding] = card([4, 110, 150, 20]);
  assert.equal(finding?.measured, 42);
  assert.match(finding?.message ?? '', /left gap 4 dp vs right gap 46 dp/);
});

test('inset-asymmetry: safe-area insets are excluded at the window edges', () => {
  const header = (
    rect: [number, number, number, number],
    child: [number, number, number, number]
  ) =>
    checkScreen(
      tree(
        [
          { parent: 0, tag: 'View', rect, style: { backgroundColor: '#ffffff' } },
          { parent: 1, tag: 'Paragraph', rect: child, text: 'Title' },
        ],
        { safeArea: { top: 51.8, right: 0, bottom: 30, left: 0 } }
      )
    ).filter(finding => finding.rule === 'inset-asymmetry');
  assert.deepEqual(header([0, 0, 400, 100], [10, 59.8, 380, 29.5]), []);
  assert.deepEqual(header([0, 700, 400, 100], [10, 710, 380, 50]), []);
  assert.equal(header([0, 2, 400, 100], [10, 61.8, 380, 29.5]).length, 1);
});
