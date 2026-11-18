import assert from 'node:assert/strict';
import test from 'node:test';

import { emptyTouchPoint, enterTouchMode } from './input-mode';
import type { ProbeDump } from './tree';

function dumpWith(
  nodes: ProbeDump['nodes'],
  options: { platform?: string; width?: number; height?: number } = {}
): ProbeDump {
  return {
    version: 1,
    env: {
      platform: options.platform ?? 'android',
      osVersion: '15',
      route: '/',
      window: { width: options.width ?? 100, height: options.height ?? 200 },
      pixelRatio: 2,
      fontScale: 1,
      colorScheme: 'light',
      isRTL: false,
      language: 'en',
      languagePreference: 'system',
      safeArea: { top: 0, right: 0, bottom: 0, left: 0 },
      tapTarget: { min: 44, touch: 48 },
    },
    nodes,
  };
}

const root = {
  parent: -1,
  tag: 'View',
  rect: [0, 0, 100, 200] as const,
  layoutRect: [0, 0, 100, 200] as const,
};

test('the point a capture taps avoids every control and its clearance', () => {
  const point = emptyTouchPoint(
    dumpWith([root, { parent: 0, tag: 'View', rect: [0, 24, 100, 40] as const, pressable: true }])
  );
  assert.ok(point);
  assert.ok(point.y >= 24 + 40 + 8, `y ${point.y} sits inside the control's clearance`);
});

test('a text field is a control even when the dump marks no press', () => {
  const point = emptyTouchPoint(
    dumpWith([root, { parent: 0, tag: 'TextInput', rect: [0, 24, 100, 40] as const }])
  );
  assert.ok(point);
  assert.ok(point.y >= 24 + 40 + 8, `y ${point.y} sits inside the field's clearance`);
});

test('a screen every pixel of which is a control has no point to tap', () => {
  const point = emptyTouchPoint(
    dumpWith([root, { parent: 0, tag: 'View', rect: [0, 0, 100, 200] as const, role: 'button' }])
  );
  assert.equal(point, undefined);
});

test('entering touch mode taps device pixels, and only on Android', () => {
  const taps: [number, number][] = [];
  const device = { tap: (x: number, y: number) => taps.push([x, y]) };
  const dump = dumpWith([root]);
  enterTouchMode({ device, log: () => undefined }, dump);
  assert.deepEqual(taps, [[4, 64]]);

  enterTouchMode({ device, log: () => undefined }, dumpWith([root], { platform: 'ios' }));
  assert.equal(taps.length, 1);
});

test('a device with no free point is left alone and says so', () => {
  const taps: [number, number][] = [];
  const lines: string[] = [];
  enterTouchMode(
    { device: { tap: (x: number, y: number) => taps.push([x, y]) }, log: line => lines.push(line) },
    dumpWith([root, { parent: 0, tag: 'View', rect: [0, 0, 100, 200] as const, pressable: true }])
  );
  assert.deepEqual(taps, []);
  assert.equal(lines.length, 1);
});
