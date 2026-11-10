import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  linkPath,
  runMatrix,
  sampleUntilSettled,
  screenFindings,
  screenIdentity,
  waitForStableLayout,
  type CaptureContext,
  type Clock,
  type Device,
} from './capture';
import type { ProbeClient } from './cdp';
import { matrixCells } from './matrix';
import { normalize, type ProbeDump } from './tree';

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
  options: {
    y?: number;
    isRTL?: boolean;
    language?: string;
    route?: string;
    text?: string;
    screen?: string;
    opacity?: number;
    display?: string;
  } = {}
): ProbeDump {
  return {
    version: 1,
    env: {
      platform: 'android',
      osVersion: '15',
      route: options.route ?? '/',
      screen: options.screen,
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
        style: { opacity: options.opacity ?? 1, display: options.display ?? 'flex' },
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

test('settling observes paint inputs and focused-screen changes with identical rectangles', async () => {
  const clock = fakeClock();
  const states = [
    { screen: '(app)/agents', opacity: 0, display: 'none' },
    { screen: '(app)/agents', opacity: 1, display: 'none' },
    { screen: '(app)/agents', opacity: 1, display: 'flex' },
    { screen: '(app)/settings', opacity: 1, display: 'flex' },
  ];
  let index = 0;
  const sampled = await sampleUntilSettled(
    {
      dump: async () => dumpWith(states[Math.min(index++, states.length - 1)]),
    },
    clock
  );
  assert.equal(sampled.settled, true);
  assert.equal(sampled.timeline.length, 6);
  assert.equal(sampled.dump.env.screen, '(app)/settings');
  assert.notEqual(
    screenIdentity(dumpWith({ screen: '(app)/agents' })),
    screenIdentity(dumpWith({ screen: '(app)/settings' }))
  );
  // Only the probe state settled. There was no pixel capture to certify paint.
  assert.equal(sampled.alignment, undefined);
});

test('an unsettled tree preserves uncertainty without reporting intermediate geometry defects', () => {
  const dump = dumpWith({ y: 195 });
  const args = { cell: 'base', target: 'moving', dump, tree: normalize(dump) };
  assert.ok(screenFindings(args).some(finding => finding.severity === 'error'));
  const findings = screenFindings({
    ...args,
    sampled: {
      dump,
      timeline: [dumpWith({ y: 50 }), dump],
      settled: false,
      elapsedMs: 8_000,
    },
  });
  assert.deepEqual(
    findings.map(finding => finding.rule),
    ['unsettled']
  );
  assert.match(findings[0]?.message ?? '', /layout rules were skipped/);
});

test('an unsettled final frame does not erase shifts between independently resting timeline segments', () => {
  const dump = dumpWith({ y: 195 });
  const findings = screenFindings({
    cell: 'base',
    target: 'moving',
    dump,
    tree: normalize(dump),
    sampled: {
      dump,
      timeline: [
        dumpWith({ y: 50 }),
        dumpWith({ y: 50 }),
        dumpWith({ y: 50 }),
        dumpWith({ y: 80 }),
        dumpWith({ y: 80 }),
        dumpWith({ y: 80 }),
        dump,
      ],
      settled: false,
      elapsedMs: 8_000,
    },
  });
  assert.deepEqual(
    findings.map(finding => finding.rule),
    ['layout-shift', 'unsettled']
  );
  assert.equal(findings[0]?.measured, 30);
  assert.ok(!findings.some(finding => finding.rule === 'clipped' || finding.rule === 'cut-off'));
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
  screen?: string;
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
        screen: state.screen,
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
            screen: state.screen,
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
    screens?: Record<string, string>;
  } = {}
): Device {
  let current = 'base';
  state.open = url => {
    calls.push(`open:${url}`);
    state.route = options.routes?.[url] ?? `/${new URL(url).host}`;
    state.screen = options.screens?.[url] ?? state.screen;
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
    readImage: () => {
      const data = new Uint8Array(100 * 200 * 4).fill(255);
      data[0] = 0;
      return { width: 100, height: 200, data };
    },
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

test('runMatrix warms the target that has to reload the language back', async () => {
  const calls: string[] = [];
  const state = probeState();
  const languages = { 'kiloapp://hindi': 'hi' };
  const ctx = context(fakeDevice(calls, state, { languages }), fakeProbe(state));
  await runMatrix(ctx, matrixCells('android', 'base'), [
    { id: 'hindi', link: 'kiloapp://hindi' },
    ...HOME,
  ]);

  // The link switched the app language, so the NEXT target reloads the runtime
  // and is cold at index 1 — it still pays its own warm open.
  assert.equal(calls.filter(call => call === 'open:kiloapp://home').length, 2);
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
  assert.ok(fs.existsSync(path.join(ctx.out, 'cells/rtl/home.json')));
  assert.ok(fs.existsSync(path.join(ctx.out, 'cells/rtl/home.timeline.json')));
});

test('a screenshot decode failure preserves the latest tree and collected timeline', async () => {
  const calls: string[] = [];
  const state = probeState();
  const ctx = context(fakeDevice(calls, state), fakeProbe(state));
  ctx.readImage = () => {
    throw new Error('decode failed');
  };
  await assert.rejects(runMatrix(ctx, matrixCells('android', 'base'), HOME), /decode failed/);
  const dump: ProbeDump = JSON.parse(
    fs.readFileSync(path.join(ctx.out, 'cells/base/home.json'), 'utf8')
  );
  assert.equal(dump.nodes[1]?.text, 'Screen /home');
  assert.ok(fs.existsSync(path.join(ctx.out, 'cells/base/home.timeline.json')));
  assert.ok(fs.existsSync(path.join(ctx.out, 'cells/base/home.png')));
  assert.equal(calls.at(-1), 'restore');
});

test('a capture returns the device to touch mode before it opens each link', async () => {
  const calls: string[] = [];
  const state = probeState();
  const taps: string[] = [];
  const device = fakeDevice(calls, state);
  const ctx = context(
    { ...device, tap: (x, y) => taps.push(`${Math.round(x)},${Math.round(y)}`) },
    fakeProbe(state)
  );
  await runMatrix(ctx, matrixCells('android', 'base'), [
    { id: 'a', link: 'kiloapp://a' },
    { id: 'b', link: 'kiloapp://b' },
  ]);
  // One tap per target, before its link: a device left in key mode paints the
  // keyboard focus highlight over the first control of the screen it opens.
  assert.deepEqual(taps, ['2,32', '2,32']);
  assert.deepEqual(
    calls.filter(call => call.startsWith('open:')),
    ['open:kiloapp://a', 'open:kiloapp://b']
  );
});

test('capture brackets the screenshot with the latest tree and persists alignment evidence', async () => {
  const calls: string[] = [];
  const state = probeState();
  const probe = fakeProbe(state);
  const originalStop = probe.stopSampling;
  probe.stopSampling = async () => {
    const samples = await originalStop();
    state.text = 'Latest before capture';
    return samples;
  };
  const ctx = context(fakeDevice(calls, state), probe);
  const outcome = await runMatrix(ctx, matrixCells('android', 'base'), HOME);
  const screen = outcome.cells[0]?.screens[0];
  assert.ok(screen?.capture);
  const dump: ProbeDump = JSON.parse(fs.readFileSync(path.join(ctx.out, screen.dump), 'utf8'));
  const alignment = JSON.parse(fs.readFileSync(path.join(ctx.out, screen.capture), 'utf8'));
  assert.equal(dump.nodes[1]?.text, 'Latest before capture');
  assert.ok(outcome.findings.some(finding => finding.rule === 'unsettled'));
  assert.equal(alignment.status, 'bracketed');
  assert.equal(alignment.before.dump.nodes[1].text, 'Latest before capture');
  assert.equal(alignment.after.dump.nodes[1].text, 'Latest before capture');
  assert.match(alignment.reason, /paint is not certified/);
});

test('capture retains a mismatched screenshot and reports inconclusive pixel alignment', async () => {
  const calls: string[] = [];
  const state = probeState();
  const device = fakeDevice(calls, state);
  const screenshot = device.screenshot;
  let captures = 0;
  device.screenshot = file => {
    captures += 1;
    screenshot(file);
    state.text = 'Changed during screenshot';
  };
  const ctx = context(device, fakeProbe(state));
  ctx.readImage = () => ({
    width: 100,
    height: 200,
    data: new Uint8Array(100 * 200 * 4).fill(255),
  });
  const outcome = await runMatrix(ctx, matrixCells('android', 'base'), HOME);
  assert.equal(captures, 1);
  assert.ok(outcome.findings.some(finding => finding.rule === 'blank-frame'));
  assert.equal(
    outcome.findings.find(finding => finding.rule === 'capture-alignment')?.severity,
    'warning'
  );
  const screen = outcome.cells[0]?.screens[0];
  assert.ok(screen?.capture);
  const alignment = JSON.parse(fs.readFileSync(path.join(ctx.out, screen.capture), 'utf8'));
  assert.equal(alignment.status, 'mismatch');
  assert.ok(fs.existsSync(path.join(ctx.out, screen.screenshot)));
});

test('capture marks slow bracketing reads inconclusive instead of certifying paint', async () => {
  const calls: string[] = [];
  const state = probeState();
  const device = fakeDevice(calls, state);
  const probe = fakeProbe(state);
  const ctx = context(device, probe);
  const screenshot = device.screenshot;
  let captured = false;
  device.screenshot = file => {
    screenshot(file);
    captured = true;
  };
  const originalDump = probe.dump;
  probe.dump = async () => {
    if (captured) await ctx.clock.sleep(2_001);
    return originalDump();
  };
  const outcome = await runMatrix(ctx, matrixCells('android', 'base'), HOME);
  const screen = outcome.cells[0]?.screens[0];
  assert.ok(screen?.capture);
  const alignment = JSON.parse(fs.readFileSync(path.join(ctx.out, screen.capture), 'utf8'));
  assert.equal(alignment.status, 'inconclusive');
  assert.match(alignment.reason, /bounded alignment window/);
  assert.ok(outcome.findings.some(finding => finding.rule === 'capture-alignment'));
});

test('uniform captured content remains visible as possible blank-frame evidence without recapture', async () => {
  const calls: string[] = [];
  const state = probeState();
  const device = fakeDevice(calls, state);
  const screenshot = device.screenshot;
  let captures = 0;
  device.screenshot = file => {
    captures += 1;
    screenshot(file);
  };
  const ctx = context(device, fakeProbe(state));
  ctx.readImage = () => ({
    width: 100,
    height: 200,
    data: new Uint8Array(100 * 200 * 4).fill(255),
  });
  const outcome = await runMatrix(ctx, matrixCells('android', 'base'), HOME);
  assert.equal(captures, 1);
  const blank = outcome.findings.find(finding => finding.rule === 'blank-frame');
  assert.equal(blank?.severity, 'warning');
  assert.match(blank?.message ?? '', /not proof of a product defect/);
  const screen = outcome.cells[0]?.screens[0];
  assert.ok(screen?.capture);
  const alignment = JSON.parse(fs.readFileSync(path.join(ctx.out, screen.capture), 'utf8'));
  assert.equal(alignment.pixels, 'uniform');
  assert.equal(alignment.status, 'bracketed');
  assert.ok(fs.existsSync(path.join(ctx.out, screen.screenshot)));
});

test('an intentionally empty uniform viewport does not become a blank-frame finding', async () => {
  const calls: string[] = [];
  const state = probeState();
  const ctx = context(
    fakeDevice(calls, state, { texts: { 'kiloapp://home': '' } }),
    fakeProbe(state)
  );
  ctx.readImage = () => ({
    width: 100,
    height: 200,
    data: new Uint8Array(100 * 200 * 4).fill(255),
  });
  const outcome = await runMatrix(ctx, matrixCells('android', 'base'), HOME);
  assert.ok(!outcome.findings.some(finding => finding.rule === 'blank-frame'));
});

test('a focused-screen transition is retained when route, text and geometry stay identical', async () => {
  const calls: string[] = [];
  const state = probeState();
  state.screen = '(app)/(tabs)/agents';
  const ctx = context(
    fakeDevice(calls, state, {
      routes: { 'kiloapp://settings': '/' },
      texts: { 'kiloapp://settings': screenTextFor('/') },
      screens: { 'kiloapp://settings': '(app)/(tabs)/settings' },
    }),
    fakeProbe(state)
  );
  const outcome = await runMatrix(ctx, matrixCells('android', 'base'), [
    { id: 'settings', link: 'kiloapp://settings' },
  ]);
  assert.equal(calls.filter(call => call === 'open:kiloapp://settings').length, 1);
  assert.ok(!outcome.findings.some(finding => finding.rule === 'env-mismatch'));
  const screen = outcome.cells[0]?.screens[0];
  assert.equal(screen?.env.screen, '(app)/(tabs)/settings');
});
