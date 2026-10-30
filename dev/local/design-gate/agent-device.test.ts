import assert from 'node:assert/strict';
import test from 'node:test';

import { agentDeviceArgs, agentDeviceToProbeDump } from './agent-device';
import { InfraError } from './capture';

const APP = 'com.kilocode.kiloapp';
const node = (fields: Record<string, unknown>) => ({ bundleId: APP, kind: 'group', ...fields });

const SNAPSHOT = JSON.stringify({
  success: true,
  data: {
    androidSnapshot: { pixelDensity: 2.625 },
    viewport: { width: 1080, height: 2400 },
    nodes: [
      node({
        index: 0,
        type: 'android.widget.FrameLayout',
        bundleId: 'com.android.systemui',
        rect: { x: 0, y: 0, width: 1080, height: 136 },
      }),
      node({
        index: 1,
        parentIndex: 0,
        type: 'android.widget.TextView',
        kind: 'text',
        label: '1:24',
        bundleId: 'com.android.systemui',
        systemBar: 'status',
        rect: { x: 47, y: 47, width: 104, height: 43 },
      }),
      node({
        index: 2,
        type: 'android.widget.FrameLayout',
        identifier: 'android:id/content',
        rect: { x: 0, y: 0, width: 1080, height: 2400 },
      }),
      node({
        index: 3,
        parentIndex: 2,
        type: 'android.view.ViewGroup',
        bundleId: 'com.android.systemui',
        rect: { x: 0, y: 0, width: 1080, height: 2400 },
      }),
      node({
        index: 4,
        parentIndex: 3,
        type: 'android.widget.ScrollView',
        kind: 'scroll-area',
        identifier: 'centered-state',
        hittable: true,
        rect: { x: 0, y: 311, width: 1080, height: 2089 },
      }),
      node({
        index: 5,
        parentIndex: 4,
        type: 'android.widget.TextView',
        kind: 'text',
        label: 'Additional permissions required',
        rect: { x: 320, y: 797, width: 530, height: 56 },
      }),
      node({
        index: 6,
        parentIndex: 4,
        type: 'android.view.ViewGroup',
        label: 'seed-small-target',
        hittable: true,
        rect: { x: 522, y: 1391, width: 36, height: 37 },
      }),
      node({
        index: 7,
        parentIndex: 4,
        type: 'android.widget.Button',
        kind: 'button',
        contentDescription: 'Re-authorize GitHub App',
        identifier: 'com.android.internal:id/button1',
        hittable: true,
        rect: { x: 55, y: 1483, width: 970, height: 120 },
      }),
    ],
  },
});

test('agentDeviceArgs adds --session only when given', () => {
  assert.deepEqual(agentDeviceArgs(undefined), ['snapshot', '--json', '--raw']);
  assert.deepEqual(agentDeviceArgs('explorer-1'), [
    'snapshot',
    '--json',
    '--raw',
    '--session',
    'explorer-1',
  ]);
});

test('agent-device snapshot converts app nodes to a ProbeDump in dp', () => {
  const dump = agentDeviceToProbeDump(SNAPSHOT);
  assert.equal(dump.env.source, 'agent-device');
  assert.equal(dump.env.pixelRatio, 2.625);
  assert.deepEqual(dump.env.window, { width: 411.43, height: 914.29 });
  assert.deepEqual(
    dump.nodes.map(entry => [entry.parent, entry.tag]),
    [
      [-1, 'View'],
      [0, 'FrameLayout'],
      [1, 'ScrollView'],
      [2, 'Paragraph'],
      [2, 'ViewGroup'],
      [2, 'Button'],
    ]
  );
  assert.equal(dump.nodes[1]?.testID, 'android:id/content');
  assert.deepEqual(dump.nodes[2], {
    parent: 1,
    tag: 'ScrollView',
    rect: [0, 118.48, 411.43, 795.81],
    testID: 'centered-state',
  });
  assert.equal(dump.nodes[3]?.text, 'Additional permissions required');
  assert.equal(dump.nodes[3]?.label, undefined);
  assert.deepEqual(dump.nodes[4], {
    parent: 2,
    tag: 'ViewGroup',
    rect: [198.86, 529.9, 13.71, 14.1],
    label: 'seed-small-target',
    pressable: true,
  });
  assert.equal(dump.nodes[5]?.label, 'Re-authorize GitHub App');
  assert.equal(dump.nodes[5]?.testID, undefined);
  assert.equal(dump.nodes[5]?.pressable, true);
});

test('agent-device snapshot without Android density is an infra failure', () => {
  assert.throws(() => agentDeviceToProbeDump(JSON.stringify({ data: { nodes: [] } })), InfraError);
});
