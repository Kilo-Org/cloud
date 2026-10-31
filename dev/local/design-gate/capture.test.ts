import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  linkPath,
  runMatrix,
  sampleUntilSettled,
  waitForStableLayout,
  type CaptureContext,
  type Clock,
  type Device,
} from './capture';
import type { ProbeClient } from './cdp';
import { matrixCells } from './matrix';
import type { ProbeDump } from './tree';

function fakeClock(): Clock & { elapsed: () => number } {
  let now = 0;
  return {
    now: () => now,
    sleep: async ms => {
      now += ms;
    },
    elapsed: () => now,
  };
}

function dumpWith(
  options: { y?: number; isRTL?: boolean; language?: string; route?: string; text?: string } = {}
): ProbeDump {
  return {
    version: 1,
    env: {
      platform: 'android',
      osVersion: '15',
      route: options.route ?? '/',
      window: { width: 100, height: 200 },
      pixelRatio: 1,
      fontScale: 1,
      colorScheme: 'light',
      isRTL: options.isRTL ?? false,
      language: options.language ?? 'en',
      languagePreference: 'system',
      safeArea: { top: 0, right: 0, bottom: 0, left: 0 },
      tapTarget: { min: 28, touch: 44 },
    },
    nodes: [
      { parent: -1, tag: 'View', rect: [0, 0, 100, 200] },
      {
        parent: 0,
        tag: 'Paragraph',
        rect: [10, options.y ?? 50, 50, 20],
        text: options.text ?? 'Title',
      },
    ],
  };
}

test('sampleUntilSettled returns after three identical samples', async () => {
  const clock = fakeClock();
  const ys = [0, 10, 50, 50, 50, 99];
  const probe = { dump: async () => dumpWith({ y: ys.shift() }) };
  const sampled = await sampleUntilSettled(probe, clock);
  assert.equal(sampled.settled, true);
  assert.equal(sampled.timeline.length, 5);
  assert.equal(clock.elapsed(), 480);
});

test('sampleUntilSettled keeps observing for the window before settling', async () => {
  const clock = fakeClock();
  let samples = 0;
  const sampled = await sampleUntilSettled(
    {
      dump: async () => {
        samples += 1;
        return dumpWith({ y: clock.elapsed() >= 1_200 ? 80 : 50 });
      },
    },
    clock,
    2_500
  );
  assert.equal(sampled.settled, true);
  assert.ok(sampled.elapsedMs >= 2_500);
  assert.equal(sampled.dump.nodes[1]?.rect[1], 80);
  assert.equal(sampled.timeline.length, samples);
});

test('linkPath maps deep links to router paths', () => {
  assert.equal(linkPath('kiloapp:///login'), '/login');
  assert.equal(linkPath('kiloapp://sessions/abc?tab=1'), '/sessions/abc');
  assert.equal(linkPath('kiloapp:///'), '/');
  assert.equal(linkPath('not a url'), undefined);
});

test('sampleUntilSettled gives up after 8 s', async () => {
  const clock = fakeClock();
  let y = 0;
  const sampled = await sampleUntilSettled({ dump: async () => dumpWith({ y: y++ }) }, clock);
  assert.equal(sampled.settled, false);
  assert.ok(sampled.elapsedMs >= 8_000 && sampled.elapsedMs < 8_200);
});

type ProbeState = {
  language: string;
  route: string;
  text: string;
  languageCalls: string[];
  persisted: string;
  open?: (url: string) => void;
};

// Each route shows its own text, as real screens do: a link that routes without
// painting is only distinguishable from a real navigation when the text on glass
// is what betrays it.
function screenTextFor(route: string): string {
  return `Screen ${route}`;
}

function probeState(language = 'en', persisted = 'en'): ProbeState {
  return { language, persisted, route: '/', text: screenTextFor('/'), languageCalls: [] };
}

function fakeProbe(state: ProbeState): ProbeClient {
  return {
    ready: async () => true,
    dump: async () =>
      dumpWith({
        isRTL: state.language === 'ar',
        language: state.language,
        route: state.route,
        text: state.text,
      }),
    setLanguage: async (preference, resolved) => {
      state.languageCalls.push(`${preference}/${resolved}`);
      state.language = resolved;
    },
    resolvedLanguage: async () => state.persisted,
    openLink: async url => {
      state.open?.(url);
    },
    resetNavigation: async () => {
      state.route = '/';
      state.text = screenTextFor('/');
    },
    lastOutcome: async () => 'openLink kiloapp://dead: failed (no route)',
    press: async () => 'not-found',
    startSampling: async () => undefined,
    stopSampling: async () => ({
      truncated: false,
      samples: [
        {
          t: 0,
          repeat: 3,
          dump: dumpWith({
            isRTL: state.language === 'ar',
            language: state.language,
            route: state.route,
            text: state.text,
          }),
        },
      ],
    }),
    disconnect: () => undefined,
  };
}

function fakeDevice(
  calls: string[],
  state: ProbeState,
  options: {
    failScreenshotFor?: string;
    routes?: Record<string, string>;
    texts?: Record<string, string | string[]>;
    languages?: Record<string, string>;
  } = {}
): Device {
  let current = 'base';
  state.open = url => {
    calls.push(`open:${url}`);
    state.route = options.routes?.[url] ?? `/${new URL(url).host}`;
    // A text list models a router that reports the target route while the
    // previous screen is still on glass; the last entry repeats.
    const texts = options.texts?.[url];
    const paints = Array.isArray(texts) ? texts : undefined;
    const openCount = calls.filter(call => call === `open:${url}`).length;
    const queued =
      paints === undefined ? undefined : paints[Math.min(openCount - 1, paints.length - 1)];
    state.text = queued ?? (typeof texts === 'string' ? texts : screenTextFor(state.route));
    state.language = options.languages?.[url] ?? state.language;
  };
  return {
    platform: 'android',
    id: 'emulator-5554',
    names: ['Pixel'],
    apply: config => {
      current = config.id;
      calls.push(`apply:${config.id}`);
    },
    restore: () => calls.push('restore'),
    screenshot: file => {
      if (current === options.failScreenshotFor) throw new Error('screencap failed');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, '');
    },
    record: () => ({ stop: async () => undefined }),
  };
}

function context(device: Device, probe: ProbeClient): CaptureContext {
  return {
    device,
    probe,
    clock: fakeClock(),
    out: fs.mkdtempSync(path.join(os.tmpdir(), 'design-gate-test-')),
    readImage: () => ({ width: 100, height: 200, data: new Uint8Array(100 * 200 * 4) }),
    observeMs: 0,
    log: () => undefined,
  };
}

const HOME = [{ id: 'home', link: 'kiloapp://home' }];

test('runMatrix switches to Arabic for rtl cells, flags env mismatches, and restores state', async () => {
  const calls: string[] = [];
  const state = probeState();
  const ctx = context(fakeDevice(calls, state), fakeProbe(state));
  const outcome = await runMatrix(ctx, matrixCells('android', 'standard'), HOME);
  assert.deepEqual(state.languageCalls, ['ar/ar', 'system/en']);
  assert.equal(state.language, 'en');
  assert.equal(calls.at(-1), 'restore');
  assert.deepEqual(
    outcome.cells.map(cell => cell.id),
    ['base', 'dark', 'compact', 'rtl']
  );
  const mismatches = outcome.findings
    .filter(finding => finding.rule === 'env-mismatch')
    .map(finding => finding.cell);
  assert.deepEqual(mismatches, ['dark', 'compact']);
  assert.ok(fs.existsSync(path.join(ctx.out, 'cells/rtl/home.timeline.json')));
});

test('runMatrix resets an unpersisted in-memory language before the first cell', async () => {
  const calls: string[] = [];
  const state = probeState('hi');
  const ctx = context(fakeDevice(calls, state), fakeProbe(state));
  const outcome = await runMatrix(ctx, matrixCells('android', 'base'), HOME);
  assert.deepEqual(state.languageCalls, ['system/en']);
  assert.deepEqual(outcome.findings, []);
});

test('runMatrix measures LTR cells in English when the run starts in an RTL language', async () => {
  const calls: string[] = [];
  const state = probeState('ar', 'ar');
  const ctx = context(fakeDevice(calls, state), fakeProbe(state));
  const outcome = await runMatrix(ctx, matrixCells('ios', 'standard'), HOME);
  assert.deepEqual(state.languageCalls, ['en/en', 'ar/ar']);
  assert.equal(state.language, 'ar');
  assert.deepEqual(
    outcome.findings.filter(finding => finding.cell !== 'dark').map(finding => finding.cell),
    []
  );
});

test('runMatrix warns when two targets end on the same screen', async () => {
  const calls: string[] = [];
  const state = probeState();
  const routes = {
    'kiloapp://a': '/login',
    'kiloapp://b': '/login',
    'kiloapp://c': '/chat',
    'kiloapp://d': '/login',
  };
  const texts = { 'kiloapp://d': 'Review' };
  const ctx = context(fakeDevice(calls, state, { routes, texts }), fakeProbe(state));
  const outcome = await runMatrix(ctx, matrixCells('android', 'base'), [
    { id: 'a', link: 'kiloapp://a' },
    { id: 'b', link: 'kiloapp://b' },
    { id: 'c', link: 'kiloapp://c' },
    { id: 'd', link: 'kiloapp://d' },
  ]);
  assert.deepEqual(
    outcome.findings.map(finding => [
      finding.rule,
      finding.severity,
      finding.target,
      finding.message,
    ]),
    [
      [
        'env-mismatch',
        'warning',
        'b',
        'b showed the same screen as a (route /login); the deep link did not open',
      ],
    ]
  );
  assert.equal(calls.filter(call => call === 'open:kiloapp://b').length, 1);
});

test('runMatrix counts a root-screen link as opened when the route matches its path', async () => {
  const calls: string[] = [];
  const state = probeState();
  const routes = { 'kiloapp:///': '/' };
  const ctx = context(fakeDevice(calls, state, { routes }), fakeProbe(state));
  const outcome = await runMatrix(ctx, matrixCells('android', 'base'), [
    { id: 'root', link: 'kiloapp:///' },
  ]);
  assert.deepEqual(outcome.findings, []);
  assert.equal(calls.filter(call => call === 'open:kiloapp:///').length, 1);
});

test('runMatrix retries a link that leaves the screen unchanged and reports lastOutcome', async () => {
  const calls: string[] = [];
  const state = probeState();
  const routes = { 'kiloapp://dead': '/' };
  const ctx = context(fakeDevice(calls, state, { routes }), fakeProbe(state));
  const outcome = await runMatrix(ctx, matrixCells('android', 'base'), [
    { id: 'dead', link: 'kiloapp://dead' },
  ]);
  assert.equal(calls.filter(call => call === 'open:kiloapp://dead').length, 2);
  assert.deepEqual(
    outcome.findings.map(finding => [finding.severity, finding.message]),
    [
      [
        'warning',
        'dead left the screen unchanged (route /); the deep link did not open: openLink kiloapp://dead: failed (no route)',
      ],
    ]
  );
});

test('runMatrix re-sends a link the router routed without painting the screen', async () => {
  const calls: string[] = [];
  const state = probeState();
  // Right after a language reload the router can report the target route while
  // the previous screen is still on glass; the re-send is what lands the cell.
  const ctx = context(
    fakeDevice(calls, state, {
      routes: { 'kiloapp://stale': '/pr-review' },
      texts: { 'kiloapp://stale': ['Screen /', 'Review inbox'] },
    }),
    fakeProbe(state)
  );
  const outcome = await runMatrix(ctx, matrixCells('android', 'base'), [
    { id: 'stale', link: 'kiloapp://stale' },
  ]);

  assert.equal(calls.filter(call => call === 'open:kiloapp://stale').length, 2);
  assert.deepEqual(outcome.findings, []);
  assert.equal(state.text, 'Review inbox');
});

test('runMatrix skips a target that switches the language and resets it for the next one', async () => {
  const calls: string[] = [];
  const state = probeState();
  const languages = { 'kiloapp://hindi': 'hi' };
  const ctx = context(fakeDevice(calls, state, { languages }), fakeProbe(state));
  const outcome = await runMatrix(ctx, matrixCells('android', 'base'), [
    { id: 'hindi', link: 'kiloapp://hindi' },
    ...HOME,
  ]);
  assert.deepEqual(
    outcome.findings.map(finding => [finding.severity, finding.target, finding.message]),
    [['warning', 'hindi', 'hindi switched the app language to hi; its rules were skipped']]
  );
  assert.deepEqual(state.languageCalls, ['system/en']);
});

test('runMatrix warms a cell once after the language reload', async () => {
  const calls: string[] = [];
  const state = probeState();
  const ctx = context(fakeDevice(calls, state), fakeProbe(state));
  await runMatrix(ctx, matrixCells('android', 'standard'), HOME);

  // Three cells match the baseline language; the RTL cell reloads the runtime
  // and pays one unmeasured warm open so its measured capture is the warm screen.
  assert.equal(calls.filter(call => call === 'open:kiloapp://home').length, 5);
  assert.deepEqual(state.languageCalls, ['ar/ar', 'system/en']);
});

test('waitForStableLayout waits for one quiet second', async () => {
  const clock = fakeClock();
  const ys = [0, 10, 20];
  const quiet = await waitForStableLayout(
    { dump: async () => dumpWith({ y: ys.shift() ?? 20 }) },
    clock
  );
  assert.equal(quiet, true);
  assert.ok(clock.elapsed() >= 1_240 && clock.elapsed() < 1_400);
});

test('runMatrix writes artifacts before the final restore and reports a restore failure', async () => {
  const calls: string[] = [];
  const state = probeState();
  const device = fakeDevice(calls, state);
  const failingDevice: Device = {
    ...device,
    restore: () => {
      calls.push('restore');
      throw new Error('wm size reset failed');
    },
  };
  const ctx = context(failingDevice, fakeProbe(state));
  const outcome = await runMatrix(ctx, matrixCells('android', 'base'), HOME, () =>
    calls.push('artifacts')
  );
  assert.deepEqual(calls.slice(-2), ['artifacts', 'restore']);
  assert.equal(outcome.restoreError, 'Error: wm size reset failed');
});

test('an abort cleanup and the run finally share one restore, device first', async () => {
  const calls: string[] = [];
  const state = probeState('ar', 'ar');
  const device = fakeDevice(calls, state);
  let cleanup: (() => Promise<void>) | undefined;
  const ctx = {
    ...context(device, fakeProbe(state)),
    registerCleanup: (fn: () => Promise<void>) => {
      cleanup = fn;
      return () => undefined;
    },
  };
  await runMatrix(ctx, matrixCells('ios', 'base'), HOME);
  const before = calls.filter(call => call === 'restore').length;
  assert.equal(before, 1);
  assert.ok(cleanup);
  await cleanup();
  assert.equal(calls.filter(call => call === 'restore').length, 1);
  assert.deepEqual(state.languageCalls, ['en/en', 'system/ar']);
});

test('runMatrix still restores the device when writing artifacts fails', async () => {
  const calls: string[] = [];
  const state = probeState();
  const ctx = context(fakeDevice(calls, state), fakeProbe(state));
  await assert.rejects(
    runMatrix(ctx, matrixCells('android', 'standard'), HOME, () => {
      throw new Error('magick failed');
    }),
    /magick failed/
  );
  assert.equal(calls.at(-1), 'restore');
  assert.equal(state.language, 'en');
});

test('runMatrix restores device and language when a capture fails', async () => {
  const calls: string[] = [];
  const state = probeState();
  const ctx = context(fakeDevice(calls, state, { failScreenshotFor: 'rtl' }), fakeProbe(state));
  await assert.rejects(
    runMatrix(ctx, matrixCells('android', 'standard'), HOME),
    /screencap failed/
  );
  assert.deepEqual(state.languageCalls, ['ar/ar', 'system/en']);
  assert.equal(calls.at(-1), 'restore');
});
