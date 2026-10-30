import assert from 'node:assert/strict';
import test from 'node:test';

import type { ProbeNode, Rect } from '../tree';
import { checkMirror } from './index';
import { tree } from './test-dump';

function row(icon: Rect, label: Rect, badge?: Rect) {
  const nodes: ProbeNode[] = [
    { parent: 0, tag: 'View', rect: [0, 0, 400, 48], style: { flexDirection: 'row' } },
    { parent: 1, tag: 'Image', rect: icon },
    { parent: 1, tag: 'Paragraph', rect: label, text: 'Settings' },
  ];
  if (badge) nodes.push({ parent: 1, tag: 'View', rect: badge, style: { position: 'absolute' } });
  return tree(nodes);
}

const ltr = row([16, 12, 24, 24], [48, 14, 80, 20], [380, 0, 10, 10]);

test('rtl-mirror: reversed row order passes even when text width and insets differ', () => {
  assert.deepEqual(
    checkMirror(ltr, row([360, 12, 24, 24], [200, 14, 150, 20], [10, 0, 10, 10])),
    []
  );
});

test('rtl-mirror: row keeping LTR order warns once on the container', () => {
  const findings = checkMirror(ltr, row([16, 12, 24, 24], [48, 14, 150, 20], [10, 0, 10, 10]));
  assert.deepEqual(
    findings.map(f => [f.element.index, f.unit, f.measured]),
    [[1, 'ratio', 1]]
  );
});

test('rtl-mirror: absolute children must anchor to the mirrored edge within 1 dp', () => {
  const mirroredRow = (badge: Rect) => row([360, 12, 24, 24], [200, 14, 150, 20], badge);
  assert.deepEqual(checkMirror(ltr, mirroredRow([11, 0, 10, 10])), []);
  const [finding, ...rest] = checkMirror(ltr, mirroredRow([11.5, 0, 10, 10]));
  assert.equal(rest.length, 0);
  assert.equal(finding?.element.index, 4);
  assert.equal(finding?.measured, 1.5);
});
