import assert from 'node:assert/strict';
import test from 'node:test';

import { compactSize, envMismatches, isRtlLanguage, matrixCells, mirrorReference } from './matrix';
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
    fontMax: false,
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

test('--cell base is a no-op, and a cell the platform lacks is refused by name', () => {
  assert.deepEqual(
    matrixCells('android', 'base', ['base', 'font-max']).map(cell => cell.id),
    ['base', 'font-max']
  );
  assert.deepEqual(
    matrixCells('ios', 'base', ['compact', 'landscape']).map(cell => cell.id),
    ['base', 'compact', 'landscape']
  );
  assert.throws(() => matrixCells('ios', 'standard', ['rtl-compact']), /ios has no rtl-compact/);
});

test('iOS landscape expects the base height as width', () => {
  const landscape = matrixCells('ios', 'full', ['landscape']).find(cell => cell.id === 'landscape');
  assert.ok(landscape);
  const portrait = { width: 402, height: 874 };
  assert.deepEqual(
    envMismatches(
      landscape,
      { ...env, platform: 'ios', window: { width: 874, height: 402 } },
      portrait,
      undefined,
      'ios'
    ),
    []
  );
  assert.deepEqual(
    envMismatches(
      landscape,
      { ...env, platform: 'ios', window: portrait },
      portrait,
      undefined,
      'ios'
    ),
    ['window width 402 dp, expected 874 dp']
  );
});

test('iOS compact expects a phone at or below the cap, not an exact width', () => {
  const compact = matrixCells('ios', 'full', ['compact']).find(cell => cell.id === 'compact');
  assert.ok(compact);
  const se = { width: 375, height: 667 };
  const pro = { width: 402, height: 874 };
  assert.deepEqual(
    envMismatches(compact, { ...env, platform: 'ios', window: se }, se, undefined, 'ios'),
    []
  );
  // A 402 pt iPhone passed off as a compact cell is a mismatch, not a pass.
  assert.deepEqual(
    envMismatches(compact, { ...env, platform: 'ios', window: pro }, pro, undefined, 'ios'),
    ['window width 402 dp, expected at most 380 dp']
  );
  // Android keeps its exact 360 dp target.
  const androidCompact = matrixCells('android', 'standard')[2];
  assert.ok(androidCompact);
  assert.deepEqual(
    envMismatches(androidCompact, { ...env, window: { width: 411, height: 914 } }, env.window),
    ['window width 411 dp, expected 360 dp']
  );
});

test('font-max expects a scale above 1 and every other cell expects 1', () => {
  const [base, fontMax] = matrixCells('android', 'base', ['font-max']);
  assert.ok(base && fontMax);
  assert.deepEqual(envMismatches(fontMax, { ...env, fontScale: 2 }, env.window), []);
  assert.deepEqual(envMismatches(fontMax, env, env.window), ['fontScale 1, expected above 1']);
  assert.deepEqual(envMismatches(base, { ...env, fontScale: 2 }, env.window), [
    'fontScale 2, expected 1',
  ]);
});

test('every right-to-left language the app ships is classified as right-to-left', () => {
  // `RTL_LANGUAGES` in apps/mobile/src/i18n/languages.ts: a language missing from
  // this tool's list loses the left-to-right fallback when the app is already set
  // to it (every left-to-right cell then reports env-mismatch), and `scan
  // --source uiautomator` labels its screenshots left-to-right.
  for (const language of ['ar', 'he', 'fa', 'ur', 'ckb', 'ps']) {
    assert.equal(isRtlLanguage(language), true, language);
  }
  // Legacy Hebrew tag a device can still report, and the LTR languages the cells
  // depend on for the fallback.
  assert.equal(isRtlLanguage('iw'), true);
  for (const language of ['en', 'de', 'zh-Hans', 'pt-BR']) {
    assert.equal(isRtlLanguage(language), false, language);
  }
});

test('a region-tagged right-to-left language is classified by its primary tag', () => {
  assert.equal(isRtlLanguage('ps-AF'), true);
  assert.equal(isRtlLanguage('ckb_IR'), true);
});
