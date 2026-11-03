import assert from 'node:assert/strict';
import test from 'node:test';

import { compactSize, envMismatches, matrixCells, mirrorReference } from './matrix';
import type { ProbeEnv } from './tree';

const env: ProbeEnv = {
  platform: 'android',
  osVersion: '15',
  route: '/',
  window: { width: 411.43, height: 914.29 },
  pixelRatio: 2.625,
  fontScale: 1,
  colorScheme: 'light',
  isRTL: false,
  language: 'en',
  languagePreference: 'system',
  safeArea: { top: 24, right: 0, bottom: 16, left: 0 },
  tapTarget: { min: 28, touch: 44 },
};

test('matrix presets list cells per platform', () => {
  const ids = (platform: 'android' | 'ios', matrix: 'base' | 'standard' | 'full') =>
    matrixCells(platform, matrix).map(cell => cell.id);
  assert.deepEqual(ids('android', 'base'), ['base']);
  assert.deepEqual(ids('android', 'standard'), ['base', 'dark', 'compact', 'rtl']);
  assert.deepEqual(ids('android', 'full'), [
    'base',
    'dark',
    'compact',
    'rtl',
    'landscape',
    'rtl-compact',
  ]);
  assert.deepEqual(ids('ios', 'standard'), ['base', 'dark', 'rtl']);
  assert.deepEqual(ids('ios', 'full'), ['base', 'dark', 'rtl']);
});

test('rtl-compact combines rtl and compact and mirrors against compact', () => {
  const cell = matrixCells('android', 'full').find(entry => entry.id === 'rtl-compact');
  assert.deepEqual(cell, {
    id: 'rtl-compact',
    dark: false,
    rtl: true,
    compact: true,
    landscape: false,
  });
  assert.ok(cell);
  assert.equal(mirrorReference(cell), 'compact');
});

test('compactSize keeps density and scales 360x640 dp to px', () => {
  assert.equal(compactSize(420), '945x1680');
  assert.equal(compactSize(160), '360x640');
  assert.equal(compactSize(440), '990x1760');
});

test('envMismatches accepts a matching env and reports each mismatch', () => {
  const [base, dark, compact] = matrixCells('android', 'standard');
  assert.ok(base && dark && compact);
  assert.deepEqual(envMismatches(base, env, undefined), []);
  assert.deepEqual(envMismatches(dark, env, env.window), ['colorScheme light, expected dark']);
  assert.deepEqual(
    envMismatches(compact, { ...env, window: { width: 362, height: 640 } }, env.window),
    []
  );
  assert.deepEqual(
    envMismatches(compact, { ...env, window: { width: 362.5, height: 640 } }, env.window),
    ['window width 362.5 dp, expected 360 dp']
  );
  assert.deepEqual(envMismatches(base, { ...env, fontScale: 1.3 }, env.window), [
    'fontScale 1.3, expected 1',
  ]);
});

test('landscape expects the base height as width', () => {
  const landscape = matrixCells('android', 'full').find(cell => cell.id === 'landscape');
  assert.ok(landscape);
  assert.deepEqual(
    envMismatches(landscape, { ...env, window: { width: 914, height: 411 } }, env.window),
    []
  );
  assert.equal(envMismatches(landscape, env, env.window).length, 1);
});
