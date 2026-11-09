import assert from 'node:assert/strict';
import test from 'node:test';

import type { Rgba } from '../pixels';
import type { ProbeNode } from '../tree';
import { checkScreen } from './index';
import { tree } from './test-dump';

const env = { window: { width: 50, height: 50 } };

function image(ink: { x: number; y: number; size: number }): Rgba {
  const width = 100;
  const data = new Uint8Array(width * width * 4).fill(255);
  for (let y = ink.y; y < ink.y + ink.size; y++) {
    for (let x = ink.x; x < ink.x + ink.size; x++)
      data.fill(0, (y * width + x) * 4, (y * width + x) * 4 + 3);
  }
  return { width, height: width, data };
}

function inkFindings(nodes: ProbeNode[], rgba: Rgba) {
  return checkScreen(tree(nodes, env), rgba).filter(finding => finding.rule === 'ink-off-center');
}

const button = (style?: ProbeNode['style']): ProbeNode => ({
  parent: 0,
  tag: 'View',
  rect: [0, 0, 40, 40],
  pressable: true,
  style: { backgroundColor: '#ffffff', ...style },
});

test('ink-off-center: transparent tap boxes have no visible center', () => {
  const transparent = { ...button(), style: { backgroundColor: 'transparent' } };
  assert.deepEqual(inkFindings([transparent], image({ x: 30, y: 35, size: 20 })), []);
});

test('ink-off-center: vertical asymmetry above max(2 dp, 12% height) warns', () => {
  const [finding, ...rest] = inkFindings([button()], image({ x: 30, y: 35, size: 20 }));
  assert.equal(rest.length, 0);
  assert.equal(finding?.severity, 'warning');
  assert.equal(finding?.measured, 5);
});

test('ink-off-center: centered and just-inside-tolerance ink passes', () => {
  assert.deepEqual(inkFindings([button()], image({ x: 30, y: 30, size: 20 })), []);
  assert.deepEqual(inkFindings([button()], image({ x: 30, y: 34, size: 20 })), []);
});

test('ink-off-center: skipped without an image and when ink coverage is tiny', () => {
  assert.deepEqual(
    checkScreen(tree([button()], env)).filter(f => f.rule === 'ink-off-center'),
    []
  );
  assert.deepEqual(inkFindings([button()], image({ x: 10, y: 10, size: 2 })), []);
});

test('ink-off-center: horizontal only for centered icon-only controls', () => {
  const offRight = image({ x: 35, y: 30, size: 20 });
  assert.deepEqual(inkFindings([button()], offRight), []);
  assert.equal(inkFindings([button({ alignItems: 'center' })], offRight)[0]?.measured, 5);
  assert.deepEqual(
    inkFindings(
      [
        button({ alignItems: 'center' }),
        { parent: 1, tag: 'Paragraph', rect: [5, 5, 10, 10], text: 'Go' },
      ],
      offRight
    ),
    []
  );
});

test('ink-off-center: skipped when screenshot scale does not match the window', () => {
  const layout = tree([button()], { window: { width: 60, height: 50 } });
  assert.deepEqual(
    checkScreen(layout, image({ x: 30, y: 35, size: 20 })).filter(f => f.rule === 'ink-off-center'),
    []
  );
});
