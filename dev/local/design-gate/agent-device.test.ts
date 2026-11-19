import assert from 'node:assert/strict';
import test from 'node:test';

import { agentDeviceArgs, agentDeviceToProbeDump, withScreenshotScale } from './agent-device';
import { InfraError } from './capture';
import { normalize } from './rules';
import { checkTouchOverlap } from './rules/screen';
import type { ProbeNode } from './tree';

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
    scrollAxes: { x: false, y: true },
  });
  assert.equal(dump.nodes[3]?.text, 'Additional permissions required');
  assert.equal(dump.nodes[3]?.label, undefined);
  assert.deepEqual(dump.nodes[4], {
    parent: 2,
    tag: 'ViewGroup',
    rect: [198.86, 529.9, 13.71, 14.1],
    style: { overflow: 'hidden' },
    label: 'seed-small-target',
    pressable: true,
  });
  assert.equal(dump.nodes[5]?.label, 'Re-authorize GitHub App');
  assert.equal(dump.nodes[5]?.testID, undefined);
  assert.equal(dump.nodes[5]?.pressable, true);
});

test('agent-device snapshot that is neither iOS nor Android with density is an infra failure', () => {
  assert.throws(() => agentDeviceToProbeDump(JSON.stringify({ data: { nodes: [] } })), InfraError);
});

const iosNode = (
  index: number,
  parentIndex: number | null,
  role: string,
  rect: [number, number, number, number],
  fields: Record<string, unknown> = {}
) => ({
  index,
  parentIndex,
  type: 'Other',
  role,
  kind: 'other',
  hittable: true,
  rect: { x: rect[0], y: rect[1], width: rect[2], height: rect[3] },
  ...fields,
});

/** The notifications screen on an iPhone 17 simulator (iOS 26.5), in points. */
const IOS_SNAPSHOT = JSON.stringify({
  success: true,
  data: {
    appBundleId: APP,
    nodes: [
      iosNode(0, null, 'UIApplication', [0, 0, 402, 874], {
        type: 'Application',
        kind: 'application',
      }),
      iosNode(1, 0, 'UIWindow', [0, 0, 402, 874], { type: 'Window', kind: 'window' }),
      // A development build wraps the React Native root in the dev launcher's view.
      iosNode(
        2,
        1,
        '_TtC13EXDevLauncherP33_867A144D7C8F5D750D0BFA9E58EDAFE322DevLauncherWrapperView',
        [0, 0, 402, 874]
      ),
      iosNode(3, 2, 'RCTRootComponentView', [0, 0, 402, 874]),
      iosNode(4, 3, 'RCTViewComponentView', [14, 186.33, 374, 54.67]),
      iosNode(5, 4, 'RCTParagraphComponentView', [68.67, 197, 235.67, 17.67], {
        type: 'StaticText',
        kind: 'text',
        label: 'Active agents',
      }),
      iosNode(6, 5, 'RCTAccessibilityElement', [68.67, 197, 235.67, 17.67], {
        type: 'StaticText',
        kind: 'text',
        label: 'Active agents',
      }),
      iosNode(7, 4, 'RCTSwitchComponentView', [311, 188.33, 63, 44]),
      iosNode(8, 7, 'UISwitch', [311, 188.33, 63, 28], {
        type: 'Switch',
        kind: 'switch',
        label: 'Active agents',
        identifier: 'notification-toggle-agents',
      }),
      iosNode(9, 3, 'RCTViewComponentView', [14, 300, 374, 52], { type: 'Button', kind: 'button' }),
      iosNode(10, 3, '_UIScrollViewScrollIndicator', [395, 128.67, 3, 400]),
      iosNode(11, 1, '_UIGrabber', [164.51, 455.03, 72.98, 24], { type: 'Button', kind: 'button' }),
      iosNode(12, 0, 'UITextEffectsWindow', [0, 0, 402, 874], {
        type: 'Application',
        kind: 'application',
      }),
      iosNode(13, 12, 'UIAccessibilityElementKBKey', [0, 600, 40, 42], {
        type: 'Key',
        kind: 'key',
      }),
      iosNode(14, 1, 'UIDimmingView', [-402, -874, 1206, 2622]),
    ],
  },
});

test('agent-device iOS snapshot converts the app views in points', () => {
  const dump = agentDeviceToProbeDump(IOS_SNAPSHOT);
  assert.equal(dump.env.platform, 'ios');
  assert.equal(dump.env.source, 'agent-device');
  assert.deepEqual(dump.env.window, { width: 402, height: 874 });
  assert.equal(dump.env.pixelRatio, 1);
  assert.equal(dump.env.safeAreaKnown, false);
  // The dimming view, grabber, scroll indicator, keyboard window, and the text's
  // accessibility element are the system's; the React Native views are kept.
  assert.deepEqual(
    dump.nodes.map(node => [node.parent, node.tag, node.rect[1]]),
    [
      [-1, 'View', 0],
      [0, 'View', 0],
      [1, 'View', 186.33],
      [2, 'Paragraph', 197],
      [2, 'Switch', 188.33],
      [4, 'Switch', 188.33],
      [1, 'Button', 300],
    ]
  );
  assert.equal(dump.nodes[3]?.text, 'Active agents');
  assert.equal(dump.nodes[5]?.label, 'Active agents');
  assert.equal(dump.nodes[5]?.testID, 'notification-toggle-agents');
  // Every iOS view is hittable; only a control kind is pressable.
  assert.deepEqual(
    dump.nodes.map(node => node.pressable === true),
    [false, false, false, false, false, true, true]
  );
  // The screenshot supplies the scale the snapshot does not report.
  assert.equal(withScreenshotScale(dump, 1206).env.pixelRatio, 3);
  const android = agentDeviceToProbeDump(SNAPSHOT);
  assert.equal(withScreenshotScale(android, 1206), android);
});

test('system bars establish safe insets before their nodes are filtered', () => {
  const dump = agentDeviceToProbeDump(
    JSON.stringify({
      data: {
        androidSnapshot: { pixelDensity: 2 },
        viewport: { width: 800, height: 1600 },
        nodes: [
          {
            index: 0,
            bundleId: 'com.android.systemui',
            systemBar: 'status',
            rect: { x: 0, y: 0, width: 800, height: 48 },
          },
          {
            index: 1,
            bundleId: 'com.android.systemui',
            systemBar: 'navigation',
            rect: { x: 0, y: 1552, width: 800, height: 48 },
          },
          {
            index: 2,
            bundleId: APP,
            type: 'android.view.View',
            rect: { x: 0, y: 0, width: 800, height: 1600 },
          },
        ],
      },
    })
  );
  assert.equal(dump.env.safeAreaKnown, true);
  assert.deepEqual(dump.env.safeArea, { top: 24, bottom: 24, left: 0, right: 0 });
  assert.equal(dump.nodes.length, 2);
  const absent = agentDeviceToProbeDump(SNAPSHOT);
  assert.equal(absent.env.safeAreaKnown, false);
});

/** Frames measured on a 1080x2400 emulator (density 2.625) over a scrolled transcript. */
const SCROLLED_TRANSCRIPT = JSON.stringify({
  data: {
    androidSnapshot: { pixelDensity: 2.625 },
    viewport: { width: 1080, height: 2400 },
    nodes: [
      {
        index: 0,
        bundleId: APP,
        type: 'android.widget.FrameLayout',
        rect: { x: 0, y: 0, width: 1080, height: 2400 },
      },
      {
        index: 1,
        parentIndex: 0,
        bundleId: APP,
        type: 'android.widget.ScrollView',
        kind: 'scroll-area',
        hittable: true,
        rect: { x: 0, y: 359, width: 1080, height: 1900 },
      },
      {
        index: 2,
        parentIndex: 1,
        bundleId: APP,
        type: 'android.view.ViewGroup',
        label: 'User message',
        hittable: true,
        rect: { x: 0, y: 359, width: 1080, height: 310 },
      },
      {
        index: 3,
        parentIndex: 2,
        bundleId: APP,
        type: 'android.widget.TextView',
        kind: 'text',
        label: 'User message',
        hittable: true,
        rect: { x: 0, y: 359, width: 1080, height: 310 },
      },
      {
        index: 4,
        parentIndex: 2,
        bundleId: APP,
        type: 'android.view.ViewGroup',
        rect: { x: 218, y: 359, width: 825, height: 301 },
      },
      {
        index: 5,
        parentIndex: 4,
        bundleId: APP,
        type: 'android.widget.FrameLayout',
        rect: { x: 250, y: 359, width: 762, height: 278 },
      },
      {
        index: 6,
        parentIndex: 5,
        bundleId: APP,
        type: 'android.widget.TextView',
        kind: 'text',
        hittable: true,
        rect: { x: 250, y: 359, width: 762, height: 215 },
      },
      {
        index: 7,
        parentIndex: 6,
        bundleId: APP,
        type: 'android.view.View',
        kind: 'text',
        label: 'User message 57 of 60.',
        hittable: true,
        rect: { x: 250, y: 123, width: 443, height: 73 },
      },
      {
        index: 8,
        parentIndex: 6,
        bundleId: APP,
        type: 'android.view.View',
        kind: 'text',
        label: 'Padded so fifty messages overflow the chat viewport.',
        hittable: true,
        rect: { x: 250, y: 196, width: 761, height: 378 },
      },
      {
        index: 9,
        parentIndex: 1,
        bundleId: APP,
        type: 'android.view.ViewGroup',
        label: 'Assistant message',
        hittable: true,
        rect: { x: 0, y: 669, width: 1080, height: 406 },
      },
    ],
  },
});

test('agent-device snapshot marks a scrolled box as one that clips what it draws', () => {
  const dump = agentDeviceToProbeDump(SCROLLED_TRANSCRIPT);
  const byLabel = (query: string): ProbeNode =>
    dump.nodes.find(entry => entry.label === query || entry.text === query) ?? dump.nodes[0];
  // Every node keeps the frame the platform gave it, so the size and overflow
  // rules still measure this control instead of the slice of a pane it shows.
  assert.deepEqual(
    byLabel('Padded so fifty messages overflow the chat viewport.').rect,
    [95.24, 74.67, 289.9, 144]
  );
  assert.deepEqual(byLabel('Assistant message').style, { overflow: 'hidden' });
  // A box outside every scrolling pane keeps its frame and carries no marker:
  // a child that really paints outside it must still reach the overflow rules.
  assert.equal(dump.nodes.find(entry => entry.tag === 'FrameLayout')?.style, undefined);
});

test('a clipped text run leaves one tap owner on the message row', () => {
  const findings = checkTouchOverlap(normalize(agentDeviceToProbeDump(SCROLLED_TRANSCRIPT)));
  assert.deepEqual(findings, []);
});
