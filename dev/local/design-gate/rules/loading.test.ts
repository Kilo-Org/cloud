import assert from 'node:assert/strict';
import { test } from 'node:test';

import { normalize } from '../tree';
import { checkLoadingAffordance, checkLoadingLabels, loadingPlaceholders } from './loading';
import { tree } from './test-dump';

test('loading: a skeleton says the screen is waiting', () => {
  const state = tree([
    { parent: 0, tag: 'RCTView', rect: [14, 60, 372, 20], testID: 'session-row-skeleton' },
  ]);
  assert.equal(loadingPlaceholders(state).length, 1);
  assert.deepEqual(checkLoadingAffordance(state), []);
});

test('loading: a skeleton owner says the screen is waiting without a test ID', () => {
  const state = tree([
    {
      parent: 0,
      tag: 'RCTView',
      rect: [14, 60, 372, 48],
      owners: ['RowSkeleton'],
    },
  ]);
  assert.equal(loadingPlaceholders(state).length, 1);
  assert.deepEqual(checkLoadingAffordance(state), []);
});

test('loading: a progress indicator says the screen is waiting', () => {
  const state = tree([
    {
      parent: 0,
      tag: 'RCTActivityIndicatorView',
      rect: [190, 390, 20, 20],
      role: 'progressbar',
      label: 'Loading…',
    },
  ]);
  assert.equal(loadingPlaceholders(state).length, 1);
  assert.deepEqual(checkLoadingAffordance(state), []);
});

test('loading: a screen with neither a skeleton nor a progress indicator is blank while it waits', () => {
  const state = tree([{ parent: 0, tag: 'RCTView', rect: [14, 60, 372, 200] }]);
  const findings = checkLoadingAffordance(state);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].rule, 'loading-placeholder');
  assert.equal(findings[0].severity, 'warning');
  assert.match(findings[0].message, /blank until the content lands/);
});

test('loading: a progress indicator with no name is reported as unlabelled', () => {
  const state = tree([
    { parent: 0, tag: 'RCTActivityIndicatorView', rect: [190, 390, 20, 20], role: 'progressbar' },
  ]);
  const findings = checkLoadingLabels(state);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].rule, 'loading-unlabelled');
  assert.equal(findings[0].severity, 'error');
});

test('loading: a progress indicator named by its label or its text is not reported', () => {
  const labelled = tree([
    {
      parent: 0,
      tag: 'RCTActivityIndicatorView',
      rect: [190, 390, 20, 20],
      role: 'progressbar',
      label: 'Loading…',
    },
  ]);
  const spoken = tree([
    {
      parent: 0,
      tag: 'RCTActivityIndicatorView',
      rect: [190, 390, 20, 20],
      role: 'progressbar',
      text: 'Loading…',
    },
  ]);
  assert.deepEqual(checkLoadingLabels(labelled), []);
  assert.deepEqual(checkLoadingLabels(spoken), []);
});

test('loading: a skeleton is not a progress indicator, so an unnamed one is not unlabelled', () => {
  const state = tree([
    {
      parent: 0,
      tag: 'RCTView',
      rect: [14, 60, 372, 20],
      testID: 'row',
      owners: ['SessionListSkeletonRows'],
    },
  ]);
  assert.deepEqual(checkLoadingLabels(state), []);
});

test('loading: the rules read a dump that also carries the landed content', () => {
  // Both captures of a held target share one tree shape: the loading frame has
  // the skeleton, the landed frame has the rows. The loading rules run on the
  // loading frame only, so the skeleton is what they see.
  const loading = tree([
    { parent: 0, tag: 'RCTView', rect: [14, 60, 372, 20], testID: 'session-row-skeleton' },
    { parent: 0, tag: 'RCTScrollView', rect: [0, 40, 400, 700] },
  ]);
  const landed = normalize({
    version: 1,
    env: loading.env,
    nodes: [
      { parent: -1, tag: 'View', rect: [0, 0, 400, 800] },
      { parent: 0, tag: 'RCTText', rect: [14, 60, 372, 20], text: 'A session' },
      { parent: 0, tag: 'RCTScrollView', rect: [0, 40, 400, 700] },
    ],
  });
  assert.deepEqual(checkLoadingAffordance(loading), []);
  assert.equal(checkLoadingAffordance(landed).length, 1);
});
