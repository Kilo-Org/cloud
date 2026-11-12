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
