import assert from 'node:assert/strict';
import test from 'node:test';

import { paintSignature } from '../../../apps/mobile/src/lib/design-gate/paint-state';
import {
  CAPTURE_ALIGNMENT_BUDGET_MS,
  captureAlignment,
  screenshotObservation,
} from './capture-evidence';
import type { Rgba } from './pixels';
import { dump } from './rules/test-dump';

const observation = { pixels: 'nonuniform', expectedText: true } as const;
const screenshot = { startedMs: 100, completedMs: 200 };

test('failed tree reads retain diagnostic evidence and cannot certify capture alignment', () => {
  const before = { startedMs: 0, completedMs: 100, dump: dump([]) };
  const after = { startedMs: 200, completedMs: 300, error: 'Inspector disconnected' };
  const evidence = captureAlignment(before, screenshot, after, paintSignature, observation);
  assert.equal(evidence.status, 'inconclusive');
  assert.equal(evidence.after.error, 'Inspector disconnected');
  assert.equal(evidence.before.dump, before.dump);
});

test('same geometry with changed focused screen or opacity is a capture mismatch', () => {
  const before = { startedMs: 0, completedMs: 100, dump: dump([], { screen: '(app)/agents' }) };
  const focus = { startedMs: 200, completedMs: 300, dump: dump([], { screen: '(app)/settings' }) };
  assert.equal(
    captureAlignment(before, screenshot, focus, paintSignature, observation).status,
    'mismatch'
  );
  const opaque = dump([{ parent: 0, tag: 'View', rect: [0, 0, 10, 10], style: { opacity: 1 } }]);
  const hidden = dump([{ parent: 0, tag: 'View', rect: [0, 0, 10, 10], style: { opacity: 0 } }]);
  assert.equal(
    captureAlignment(
      { startedMs: 0, completedMs: 100, dump: opaque },
      screenshot,
      { startedMs: 200, completedMs: 300, dump: hidden },
      paintSignature,
      observation
    ).status,
    'mismatch'
  );
});

test('nonmonotonic timing and unalignable pixels are inconclusive despite identical tree state', () => {
  const tree = dump([]);
  const before = { startedMs: 0, completedMs: 100, dump: tree };
  const after = { startedMs: 200, completedMs: 300, dump: tree };
  assert.equal(
    captureAlignment(
      before,
      { startedMs: 50, completedMs: 200 },
      after,
      paintSignature,
      observation
    ).status,
    'inconclusive'
  );
  assert.equal(
    captureAlignment(before, screenshot, after, paintSignature, {
      pixels: 'unavailable',
      expectedText: true,
    }).status,
    'inconclusive'
  );
});

function image(): Rgba {
  return { width: 4, height: 4, data: new Uint8Array(4 * 4 * 4).fill(255) };
}

function smallDump(opacity = 1, text = 'Title') {
  return dump([{ parent: 0, tag: 'Paragraph', rect: [0, 0, 4, 4], text, style: { opacity } }], {
    window: { width: 4, height: 4 },
    pixelRatio: 1,
  });
}

test('pixel observations retain uniform frames but do not treat hidden or absent text as expected ink', () => {
  assert.deepEqual(screenshotObservation(smallDump(), image()), {
    pixels: 'uniform',
    expectedText: true,
  });
  assert.deepEqual(screenshotObservation(smallDump(0), image()), {
    pixels: 'uniform',
    expectedText: false,
  });
  assert.deepEqual(screenshotObservation(smallDump(1, ''), image()), {
    pixels: 'uniform',
    expectedText: false,
  });
  const painted = image();
  painted.data[0] = 0;
  assert.equal(screenshotObservation(smallDump(), painted).pixels, 'nonuniform');
});

test('transparent and wrong-sized screenshots never supply paint evidence', () => {
  const transparent = image();
  transparent.data[3] = 0;
  assert.equal(screenshotObservation(smallDump(), transparent).pixels, 'unavailable');
  assert.equal(
    screenshotObservation(smallDump(), { width: 8, height: 4, data: new Uint8Array(128) }).pixels,
    'unavailable'
  );
});

test('a bracket wider than the constant is bracketed only under a measured budget', () => {
  const before = { startedMs: 0, completedMs: 1_500, dump: dump([]) };
  const shot = { startedMs: 1_500, completedMs: 2_000 };
  const after = { startedMs: 2_000, completedMs: 3_000, dump: dump([]) };
  // Two full-tree reads around a screenshot cost more than 2 s on an expensive
  // screen, so the constant alone calls a correct bracket inconclusive.
  const tight = captureAlignment(before, shot, after, paintSignature, observation);
  assert.equal(tight.status, 'inconclusive');
  assert.equal(tight.budgetMs, CAPTURE_ALIGNMENT_BUDGET_MS);
  const measured = captureAlignment(before, shot, after, paintSignature, observation, 4_000);
  assert.equal(measured.status, 'bracketed');
  assert.equal(measured.budgetMs, 4_000);
  // A cheap bracket keeps the constant, and the evidence reports it.
  const cheap = captureAlignment(
    { startedMs: 0, completedMs: 100, dump: dump([]) },
    { startedMs: 100, completedMs: 200 },
    { startedMs: 200, completedMs: 300, dump: dump([]) },
    paintSignature,
    observation
  );
  assert.equal(cheap.status, 'bracketed');
  assert.equal(cheap.budgetMs, CAPTURE_ALIGNMENT_BUDGET_MS);
});
