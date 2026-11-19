import assert from 'node:assert/strict';
import test from 'node:test';

import type { ProbeEnv, ProbeNode, Rect } from '../tree';
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

const IOS = {
  platform: 'ios',
  osVersion: '26.5',
  window: { width: 402, height: 874 },
  safeArea: { top: 62, right: 0, bottom: 34, left: 0 },
};

function insets(nodes: ProbeNode[], env: Partial<ProbeEnv> = IOS) {
  return checkScreen(tree(nodes, env)).filter(finding => finding.rule === 'inset-asymmetry');
}

test('inset-asymmetry: a card partly below the window is not measured', () => {
  // Org billing: the card starts at 795 and is 193 tall, so only 79 pt show.
  // Its children below the window are dropped, and the union of the rest
  // stops at the first line.
  const billing = (top: number): ProbeNode[] => [
    { parent: 0, tag: 'View', rect: [14, top, 374, 193], style: { backgroundColor: '#ffffff' } },
    { parent: 1, tag: 'Paragraph', rect: [28, top + 14, 300, 20], text: 'Invoices' },
    { parent: 1, tag: 'Paragraph', rect: [28, top + 159, 300, 20], text: 'View all' },
  ];
  assert.deepEqual(insets(billing(795)), []);
  // The same card on screen is balanced, so nothing is lost by skipping it.
  assert.deepEqual(insets(billing(400)), []);
});

test('inset-asymmetry: an iOS page sheet footer pads the home indicator', () => {
  // Credits: the footer ends at the sheet's bottom, which UIKit puts at the
  // window's bottom, so 34 of its 34 pt bottom gap are the home indicator inset.
  assert.deepEqual(
    insets([
      { parent: 0, tag: 'RNSModalScreen', rect: [0, 0, 402, 812] },
      { parent: 1, tag: 'View', rect: [0, 728, 402, 84], style: { backgroundColor: '#ffffff' } },
      { parent: 2, tag: 'View', rect: [14, 742, 374, 36], label: 'Buy credits', pressable: true },
    ]),
    []
  );
});

test('inset-asymmetry: a header at an iOS sheet top pads for the grabber', () => {
  // The sheet header's 32 pt top padding clears the grabber the way a screen's
  // top clears the status bar.
  const header = (sheetHeight: number) =>
    insets([
      { parent: 0, tag: 'RNSModalScreen', rect: [0, 0, 402, sheetHeight] },
      { parent: 1, tag: 'View', rect: [0, 0, 402, 74], style: { backgroundColor: '#ffffff' } },
      { parent: 2, tag: 'Paragraph', rect: [14, 32, 374, 30], text: 'Add instruction' },
    ]);
  assert.deepEqual(header(423), []);
  // The same header lower in the sheet is measured.
  const [finding] = insets([
    { parent: 0, tag: 'RNSModalScreen', rect: [0, 0, 402, 423] },
    { parent: 1, tag: 'View', rect: [0, 100, 402, 74], style: { backgroundColor: '#ffffff' } },
    { parent: 2, tag: 'Paragraph', rect: [14, 132, 374, 30], text: 'Add instruction' },
  ]);
  assert.equal(finding?.measured, 20);
});
