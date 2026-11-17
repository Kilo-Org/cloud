import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  IN_APP_SAMPLE_INTERVAL_MS,
  InfraError,
  inAppSampleInterval,
  joinPasses,
  linkPath,
  loadingPlaceholder,
  runMatrix,
  sampleInterval,
  sampleUntilSettled,
  screenFindings,
  screenIdentity,
  waitForLoadingPlaceholder,
  waitForStableLayout,
  type CaptureContext,
  type Clock,
  type Device,
  type RunOutcome,
} from './capture';
import { CAPTURE_ALIGNMENT_BUDGET_MS } from './capture-evidence';
import type { ProbeClient, ProbeSample } from './cdp';
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
        rect: [14, options.y ?? 50, 50, 20],
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

test('loadingPlaceholder recognizes a skeleton test ID and a skeleton owner', () => {
  assert.equal(loadingPlaceholder(normalize(dumpWith())), false);
  const byTestID = dumpWith();
  byTestID.nodes.push({
    parent: 0,
    tag: 'View',
    rect: [0, 0, 10, 10],
    testID: 'session-row-skeleton',
  });
  assert.equal(loadingPlaceholder(normalize(byTestID)), true);
  const byOwner = dumpWith();
  byOwner.nodes.push({
    parent: 0,
    tag: 'View',
    rect: [0, 0, 10, 10],
    owners: ['View', 'SessionSkeletonMessages'],
  });
  assert.equal(loadingPlaceholder(normalize(byOwner)), true);
  // A test ID that only ends in letters does not name a placeholder.
  const unrelated = dumpWith();
  unrelated.nodes.push({ parent: 0, tag: 'View', rect: [0, 0, 10, 10], testID: 'skeletons' });
  assert.equal(loadingPlaceholder(normalize(unrelated)), false);
});

test('waitForLoadingPlaceholder waits for the screen the link opened and its placeholder to clear', async () => {
  const clock = fakeClock();
  const skeleton = dumpWith({ text: 'Loading', route: '/session' });
  skeleton.nodes.push({
    parent: 0,
    tag: 'View',
    rect: [0, 0, 10, 10],
    owners: ['View', 'SessionSkeletonMessages'],
  });
  const states = [
    dumpWith({ route: '/' }),
    skeleton,
    skeleton,
    dumpWith({ text: 'Card', route: '/session' }),
  ];
  let index = 0;
  const waited = await waitForLoadingPlaceholder(
    { dump: async () => states[Math.min(index++, states.length - 1)] },
    clock,
    dump => dump.env.route !== '/'
  );
  assert.equal(waited.cleared, true);
  assert.equal(waited.observed, true);
  assert.equal(index, 4);
});

test('waitForLoadingPlaceholder reports a placeholder that outlives its budget', async () => {
  const clock = fakeClock();
  const skeleton = dumpWith();
  skeleton.nodes.push({
    parent: 0,
    tag: 'View',
    rect: [0, 0, 10, 10],
    owners: ['View', 'Skeleton'],
  });
  const waited = await waitForLoadingPlaceholder(
    { dump: async () => skeleton },
    clock,
    () => true,
    1_000
  );
  assert.equal(waited.cleared, false);
  assert.equal(waited.observed, true);
  assert.ok(waited.elapsedMs >= 1_000);
});

test('waitForLoadingPlaceholder releases a link that never lands without claiming a placeholder', async () => {
  const clock = fakeClock();
  const skeleton = dumpWith({ route: '/elsewhere' });
  skeleton.nodes.push({
    parent: 0,
    tag: 'View',
    rect: [0, 0, 10, 10],
    owners: ['View', 'Skeleton'],
  });
  const waited = await waitForLoadingPlaceholder(
    { dump: async () => skeleton },
    clock,
    () => false,
    30_000,
    1_000
  );
  // A placeholder on another screen is not this target's state.
  assert.equal(waited.cleared, false);
  assert.equal(waited.observed, false);
  assert.ok(waited.elapsedMs >= 1_000 && waited.elapsedMs < 5_000);
});

test('an unsettled capture from a loading placeholder names that cause', () => {
  const dump = dumpWith();
  const blocked = screenFindings({
    cell: 'base',
    target: 'loading',
    dump,
    tree: normalize(dump),
    sampled: {
      dump,
      timeline: [dump, dump, dump],
      settled: false,
      elapsedMs: 12_000,
      blockedBy: 'loading-placeholder',
    },
  });
  assert.deepEqual(
    blocked.map(finding => finding.rule),
    ['unsettled']
  );
  assert.match(blocked[0]?.message ?? '', /still paints its loading placeholder/u);
  // The finding measures the wait that ran, not the settle loop's own elapsed time.
  const waited = screenFindings({
    cell: 'base',
    target: 'loading',
    dump,
    tree: normalize(dump),
    sampled: {
      dump,
      timeline: [dump, dump, dump],
      settled: false,
      elapsedMs: 12_000,
      blockedBy: 'loading-placeholder',
      loadingWaitMs: 30_101,
    },
  });
  assert.equal(waited[0]?.measured, 30_101);
  assert.match(waited[0]?.message ?? '', /after 30101 ms/u);
  const changing = screenFindings({
    cell: 'base',
    target: 'moving',
    dump,
    tree: normalize(dump),
    sampled: {
      dump,
      timeline: [dumpWith({ y: 50 }), dump],
      settled: false,
      elapsedMs: 12_000,
    },
  });
  assert.match(changing[0]?.message ?? '', /kept changing/u);
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

test('a language reload the inspector never returns from relaunches the app', async () => {
  const calls: string[] = [];
  const state = probeState();
  const base = fakeProbe(state);
  const probe: ProbeClient = {
    ...base,
    // The runtime reloads into an instance the inspector never lists again: the
    // Arabic cell only sees its language after the app process restarts.
    setLanguage: async (preference, resolved) => {
      state.languageCalls.push(`${preference}/${resolved}`);
      if (resolved === 'ar') return;
      state.language = resolved;
    },
  };
  const device: Device = {
    ...fakeDevice(calls, state),
    relaunch: () => {
      calls.push('relaunch');
      state.language = 'ar';
    },
  };
  const ctx = context(device, probe);
  const outcome = await runMatrix(ctx, matrixCells('android', 'standard'), HOME);
  assert.deepEqual(
    calls.filter(call => call === 'relaunch'),
    ['relaunch']
  );
  // The rtl cell is measured after the restart instead of aborting the run, and
  // the restore brings the app back to English.
  assert.equal(fs.existsSync(path.join(ctx.out, 'cells/rtl/home.timeline.json')), true);
  assert.deepEqual(outcome.skipped, []);
  assert.equal(state.language, 'en');
});

test('a reload that leaves no debugger at all still relaunches and measures the cell', async () => {
  const calls: string[] = [];
  const state = probeState();
  const base = fakeProbe(state);
  // The reload takes the inspector with it: nothing is listed, so the readiness
  // wait ends by throwing instead of returning a stale dump. That is the outage
  // the relaunch exists for, and it must not end the run.
  let detached = false;
  const dead = () => new InfraError('No Metro debugger page for Pixel (0 pages listed)');
  const probe: ProbeClient = {
    ...base,
    setLanguage: async (preference, resolved) => {
      state.languageCalls.push(`${preference}/${resolved}`);
      if (resolved === 'ar') {
        detached = true;
        return;
      }
      state.language = resolved;
    },
    ready: async () => {
      if (detached) throw dead();
      return true;
    },
    dump: async () => {
      if (detached) throw dead();
      return base.dump();
    },
  };
  const device: Device = {
    ...fakeDevice(calls, state),
    relaunch: () => {
      calls.push('relaunch');
      detached = false;
      state.language = 'ar';
    },
  };
  const ctx = context(device, probe);
  const outcome = await runMatrix(ctx, matrixCells('android', 'standard'), HOME);
  assert.equal(calls.filter(call => call === 'relaunch').length, 1);
  assert.deepEqual(
    outcome.cells.map(cell => [cell.id, cell.screens.map(screen => screen.target)]),
    [
      ['base', ['home']],
      ['dark', ['home']],
      ['compact', ['home']],
      ['rtl', ['home']],
    ]
  );
  assert.deepEqual(outcome.skipped, []);
  assert.equal(state.language, 'en');
});

test('a relaunch the device cannot perform skips the cell instead of aborting the run', async () => {
  const calls: string[] = [];
  const state = probeState();
  const base = fakeProbe(state);
  const probe: ProbeClient = {
    ...base,
    setLanguage: async (preference, resolved) => {
      state.languageCalls.push(`${preference}/${resolved}`);
      if (resolved === 'ar') return;
      state.language = resolved;
    },
  };
  const device: Device = {
    ...fakeDevice(calls, state),
    relaunch: () => {
      calls.push('relaunch');
      throw new Error('adb: device offline');
    },
  };
  const outcome = await runMatrix(context(device, probe), matrixCells('android', 'standard'), HOME);
  // The cell that needed the restart is named as unmeasured; the three cells
  // that did not are still graded, and the run reports the gap instead of
  // dying on one adb error.
  assert.deepEqual(outcome.skipped, [
    {
      cell: 'rtl',
      target: 'home',
      reason: 'InfraError: Relaunch failed: Error: adb: device offline',
    },
  ]);
  assert.deepEqual(
    outcome.cells.map(cell => [cell.id, cell.screens.length]),
    [
      ['base', 1],
      ['dark', 1],
      ['compact', 1],
      ['rtl', 0],
    ]
  );
  assert.equal(calls.filter(call => call === 'relaunch').length, 1);
});

test('runMatrix records a target the probe cannot read instead of reporting a pass', async () => {
  const calls: string[] = [];
  const state = probeState();
  const base = fakeProbe(state);
  const probe: ProbeClient = {
    ...base,
    openLink: async url => {
      if (url === 'kiloapp://gone') throw new InfraError('No Metro debugger page for Pixel');
      await base.openLink(url);
    },
  };
  const outcome = await runMatrix(
    context(fakeDevice(calls, state), probe),
    matrixCells('android', 'base'),
    [{ id: 'gone', link: 'kiloapp://gone' }, ...HOME]
  );
  // A target nothing measured is named, so the caller can report the run as
  // inconclusive instead of a pass over the screens it did read.
  assert.deepEqual(outcome.skipped, [
    { cell: 'base', target: 'gone', reason: 'InfraError: No Metro debugger page for Pixel' },
  ]);
  assert.deepEqual(
    outcome.cells[0]?.screens.map(screen => screen.target),
    ['home']
  );
  assert.equal(calls.at(-1), 'restore');
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
  // The change landed after sampling stopped; the bracket's quiet wait absorbed it,
  // so the capture is settled and the two bracket reads see the same screen.
  assert.ok(!outcome.findings.some(finding => finding.rule === 'unsettled'));
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

test('the in-app sampling cadence follows the cost of one measured dump', async () => {
  const calls: string[] = [];
  const state = probeState();
  const probe = fakeProbe(state);
  const ctx = context(fakeDevice(calls, state), probe);
  // The in-app sampler walks and serializes the whole document on the app's own
  // JS thread, so one dump is what a tick costs the screen it measures.
  const dumpMs = 600;
  const originalDump = probe.dump;
  probe.dump = async () => {
    await ctx.clock.sleep(dumpMs);
    return originalDump();
  };
  const intervals: number[] = [];
  probe.startSampling = async intervalMs => {
    intervals.push(intervalMs);
  };
  const logs: string[] = [];
  ctx.log = line => logs.push(line);
  await runMatrix(ctx, matrixCells('android', 'base'), HOME);
  assert.deepEqual(intervals, [inAppSampleInterval(dumpMs)]);
  assert.ok((intervals[0] ?? 0) > IN_APP_SAMPLE_INTERVAL_MS);
  assert.deepEqual(
    logs.filter(line => line.includes('in-app dump')),
    ['design-gate: home one in-app dump costs 600ms; sampling every 1200ms']
  );
});

test('a dump that costs less than the floor keeps the default sampling cadence', async () => {
  const calls: string[] = [];
  const state = probeState();
  const probe = fakeProbe(state);
  const ctx = context(fakeDevice(calls, state), probe);
  const originalDump = probe.dump;
  probe.dump = async () => {
    await ctx.clock.sleep(40);
    return originalDump();
  };
  const intervals: number[] = [];
  probe.startSampling = async intervalMs => {
    intervals.push(intervalMs);
  };
  const logs: string[] = [];
  ctx.log = line => logs.push(line);
  await runMatrix(ctx, matrixCells('android', 'base'), HOME);
  assert.deepEqual(intervals, [IN_APP_SAMPLE_INTERVAL_MS]);
  assert.deepEqual(
    logs.filter(line => line.includes('in-app dump')),
    []
  );
});

function sampleAt(t: number, dump: ProbeDump = dumpWith()): ProbeSample {
  return { t, repeat: 1, dump };
}

test('sampleInterval reads the spacing the retained samples carry', () => {
  // Fewer than two samples carry no spacing of their own.
  assert.equal(sampleInterval([]), IN_APP_SAMPLE_INTERVAL_MS);
  assert.equal(sampleInterval([sampleAt(0)]), IN_APP_SAMPLE_INTERVAL_MS);
  assert.equal(sampleInterval([sampleAt(0), sampleAt(850), sampleAt(1_700)]), 850);
  // The span is divided by the ticks that span it, so an uneven capture is timed
  // with the weighted average of its spacings rather than with its middle one.
  assert.equal(sampleInterval([sampleAt(0), sampleAt(300), sampleAt(1_200), sampleAt(2_100)]), 700);
});

test('sampleInterval counts the repeats of a collapsed run as spacings', () => {
  // A repeated state keeps the stamp of its first tick, so the second sample's
  // repeats happen after its own stamp and only the first sample spans the gap.
  assert.equal(
    sampleInterval([
      { t: 0, repeat: 1, dump: sampleAt(0).dump },
      { t: 1_000, repeat: 5, dump: sampleAt(0).dump },
    ]),
    1_000
  );
  // Three ticks of one state and then three of the next: the span covers both
  // runs of the first state at its own two spacings.
  assert.equal(
    sampleInterval([
      { t: 0, repeat: 2, dump: sampleAt(0).dump },
      { t: 750, repeat: 3, dump: sampleAt(0).dump },
    ]),
    375
  );
  // The timestamps are read in their own order, whatever order they arrive in.
  assert.equal(sampleInterval([sampleAt(1_700), sampleAt(0), sampleAt(850)]), 850);
});

test('joinPasses counts the unsampled stretch as repeats of the first pass last state', () => {
  const early = dumpWith({ y: 50 });
  const late = dumpWith({ y: 80 });
  const first = [
    { t: 0, repeat: 1, dump: early },
    { t: 250, repeat: 2, dump: early },
  ];
  const second = [{ t: 2_000, repeat: 1, dump: late }];
  const joined = joinPasses(first, second, 250);
  // The 1750 ms gap is seven spacings, and the tail's own two ticks already cover
  // two of them, so five ticks are added and the tail spans seven.
  assert.deepEqual(
    joined.map(sample => [sample.t, sample.repeat]),
    [
      [0, 1],
      [250, 7],
      [2_000, 1],
    ]
  );
  assert.equal(joined[1]?.dump, early);
  // The capped stretch keeps a long quiet wait bounded.
  const capped = joinPasses(first, [{ t: 250 + 250 * 500, repeat: 1, dump: late }], 250);
  assert.equal(capped[1]?.repeat, 2 + 64);
  // A pass that retained nothing falls back to the concatenation.
  assert.deepEqual(joinPasses([], second, 250), second);
  assert.deepEqual(joinPasses(first, [], 250), first);
  // Without a spacing there is no tick to count.
  assert.equal(joinPasses(first, second, 0)[1]?.repeat, 2);
});

test('a late arrival is timed with the spacing its samples report', () => {
  const early = dumpWith({ y: 50 });
  const late = dumpWith({ y: 80 });
  const shifts = (intervalMs?: number) =>
    screenFindings({
      cell: 'base',
      target: 'home',
      dump: late,
      tree: normalize(late),
      sampled: {
        dump: late,
        timeline: [early, early, late, late],
        settled: true,
        elapsedMs: 2_000,
        ...(intervalMs === undefined ? {} : { intervalMs }),
      },
    }).filter(finding => finding.rule === 'layout-shift');
  // Two samples after the rest is two sample spacings, whatever they measured.
  const measured = shifts(850)[0];
  assert.equal(measured?.severity, 'error');
  assert.match(measured?.message ?? '', /within 1700 ms after settling/u);
  // Without a spacing of its own, the rule still falls back to the constant.
  assert.match(shifts(undefined)[0]?.message ?? '', /within 500 ms after settling/u);
});

/** A probe whose reads the test can hold at a fixed cost per read. */
function costingProbe(dumpMs: number) {
  const calls: string[] = [];
  const state = probeState();
  const probe = fakeProbe(state);
  const ctx = context(fakeDevice(calls, state), probe);
  const originalDump = probe.dump;
  probe.dump = async () => {
    await ctx.clock.sleep(dumpMs);
    return originalDump();
  };
  const logs: string[] = [];
  ctx.log = line => logs.push(line);
  return { ctx, logs, probe, state };
}

function captureEvidence(ctx: CaptureContext, outcome: { cells: RunOutcome['cells'] }) {
  const capture = outcome.cells[0]?.screens[0]?.capture;
  assert.ok(capture);
  return JSON.parse(fs.readFileSync(path.join(ctx.out, capture), 'utf8'));
}

test('the alignment window follows the measured dump cost and keeps the constant when cheap', async () => {
  const slow = costingProbe(600);
  const slowRun = await runMatrix(slow.ctx, matrixCells('android', 'base'), HOME);
  // Two bracket reads of a 600 ms dump alone outlast the 2 s window, so the
  // caller widens it by the same measurement the sampling cadence uses.
  assert.equal(captureEvidence(slow.ctx, slowRun).budgetMs, 2_200);
  assert.deepEqual(
    slow.logs.filter(line => line.includes('alignment window')),
    ['design-gate: home one dump costs 600ms; alignment window 2200ms']
  );
  const cheap = costingProbe(40);
  const cheapRun = await runMatrix(cheap.ctx, matrixCells('android', 'base'), HOME);
  assert.equal(captureEvidence(cheap.ctx, cheapRun).budgetMs, CAPTURE_ALIGNMENT_BUDGET_MS);
  assert.deepEqual(
    cheap.logs.filter(line => line.includes('alignment window')),
    []
  );
});

test('the bracket waits for a screen that changes once after sampling stops', async () => {
  const calls: string[] = [];
  const state = probeState();
  const probe = fakeProbe(state);
  const ctx = context(fakeDevice(calls, state), probe);
  const samplingPasses: number[] = [];
  probe.startSampling = async intervalMs => {
    samplingPasses.push(intervalMs);
  };
  const originalStop = probe.stopSampling;
  let samplingStopped = false;
  probe.stopSampling = async () => {
    const sampled = await originalStop();
    samplingStopped = true;
    return sampled;
  };
  const originalDump = probe.dump;
  let readsAfterStop = 0;
  probe.dump = async () => {
    if (samplingStopped) {
      readsAfterStop += 1;
      // The late navigation lands while the bracket waits for the screen to hold.
      if (readsAfterStop === 2) {
        state.route = '/late';
        state.text = screenTextFor('/late');
      }
    }
    return originalDump();
  };
  const logs: string[] = [];
  ctx.log = line => logs.push(line);
  const outcome = await runMatrix(ctx, matrixCells('android', 'base'), HOME);
  // The bracket opens on the screen the late push produced, so both reads agree.
  assert.equal(captureEvidence(ctx, outcome).status, 'bracketed');
  const screen = outcome.cells[0]?.screens[0];
  assert.ok(screen?.dump);
  const captured = JSON.parse(fs.readFileSync(path.join(ctx.out, screen.dump), 'utf8'));
  assert.equal(captured.env.route, '/late');
  assert.ok(!outcome.findings.some(finding => finding.rule === 'unsettled'));
  assert.ok(
    logs.some(line => line.includes('late change after sampling stopped')),
    `expected a late-change line, saw ${JSON.stringify(logs)}`
  );
  // The late change is real work, so the sampled window follows the screen: one
  // more pass samples it and the timeline the shift rule reads ends on it.
  assert.equal(samplingPasses.length, 2);
  assert.equal(samplingPasses[1], samplingPasses[0]);
  assert.ok(logs.some(line => line.includes('sampling once more')));
  const timeline = JSON.parse(
    fs.readFileSync(path.join(ctx.out, 'cells/base/home.timeline.json'), 'utf8')
  ) as { samples: { dump: ProbeDump }[] };
  assert.equal(timeline.samples.at(-1)?.dump.env.route, '/late');
});

test('a late layout change on the same route is reported as a shift, not absorbed', async () => {
  const calls: string[] = [];
  const state = probeState();
  const probe = fakeProbe(state);
  const ctx = context(fakeDevice(calls, state), probe);
  // The screen keeps its route and moves one node, so the shift rule reads one
  // comparison context across both passes.
  let moved = false;
  const current = () =>
    dumpWith({ y: moved ? 80 : 50, route: state.route, text: state.text, screen: state.screen });
  let passes = 0;
  probe.stopSampling = async () => {
    passes += 1;
    // Each pass stamps its own window, and the second pass samples the late layout.
    return {
      truncated: false,
      samples: [{ t: passes === 1 ? 0 : 1_000, repeat: 3, dump: current() }],
    };
  };
  let readsAfterStop = 0;
  probe.dump = async () => {
    if (passes > 0) {
      readsAfterStop += 1;
      // The late layout lands while the bracket waits for the screen to hold.
      if (readsAfterStop === 2) moved = true;
    }
    return current();
  };
  const logs: string[] = [];
  ctx.log = line => logs.push(line);
  const outcome = await runMatrix(ctx, matrixCells('android', 'base'), HOME);
  assert.equal(captureEvidence(ctx, outcome).status, 'bracketed');
  // The two passes are one timeline: the late layout is the arrival the shift rule
  // reads, not the rest state it starts from.
  const shifts = outcome.findings.filter(finding => finding.rule === 'layout-shift');
  assert.deepEqual(
    shifts.map(finding => [finding.severity, finding.measured]),
    [['error', 30]]
  );
  // The bridge adds only the ticks the tail does not cover, so the shift is timed
  // at the four spacings it really spans, not at the two the tail double-counted.
  assert.match(shifts[0]?.message ?? '', /within 1000 ms/u);
  assert.ok(
    logs.some(line => line.includes('sampling once more')),
    `expected a retry line, saw ${JSON.stringify(logs)}`
  );
  // The screen held still and the bracket agrees, so the capture stays settled and
  // the late change is reported instead of being hidden as an unsettled read.
  assert.ok(!outcome.findings.some(finding => finding.rule === 'unsettled'));
  const timeline = JSON.parse(
    fs.readFileSync(path.join(ctx.out, 'cells/base/home.timeline.json'), 'utf8')
  ) as { samples: { t: number; repeat: number; dump: ProbeDump }[] };
  // The first pass keeps its state and gains the ticks of the unsampled stretch
  // that its own three-tick tail does not already cover.
  assert.deepEqual(
    timeline.samples.map(sample => [sample.t, sample.repeat, sample.dump.nodes[1]?.rect[1]]),
    [
      [0, 4, 50],
      [1_000, 3, 80],
    ]
  );
  // The route is the one the link opened, and both passes share it.
  assert.equal(timeline.samples.at(-1)?.dump.env.route, '/home');
});

test('a late change is sampled at most once more', async () => {
  const calls: string[] = [];
  const state = probeState();
  const probe = fakeProbe(state);
  const ctx = context(fakeDevice(calls, state), probe);
  const samplingPasses: number[] = [];
  let readsThisPass = 0;
  probe.startSampling = async intervalMs => {
    samplingPasses.push(intervalMs);
    readsThisPass = 0;
  };
  const originalStop = probe.stopSampling;
  let passes = 0;
  probe.stopSampling = async () => {
    passes += 1;
    readsThisPass = 0;
    return originalStop();
  };
  const originalDump = probe.dump;
  let changes = 0;
  probe.dump = async () => {
    readsThisPass += 1;
    // The screen changes late in both passes; the second must not start a third.
    if (passes >= 1 && readsThisPass === 2 && changes < 2) {
      changes += 1;
      state.route = `/late-${changes}`;
      state.text = screenTextFor(state.route);
    }
    return originalDump();
  };
  const logs: string[] = [];
  ctx.log = line => logs.push(line);
  await runMatrix(ctx, matrixCells('android', 'base'), HOME);
  assert.equal(changes, 2);
  assert.equal(samplingPasses.length, 2);
  assert.equal(logs.filter(line => line.includes('sampling once more')).length, 1);
});

test('a screen that keeps changing keeps the bracket a mismatch and says so', async () => {
  const calls: string[] = [];
  const state = probeState();
  const probe = fakeProbe(state);
  const ctx = context(fakeDevice(calls, state), probe);
  const originalStop = probe.stopSampling;
  let samplingStopped = false;
  probe.stopSampling = async () => {
    const sampled = await originalStop();
    samplingStopped = true;
    return sampled;
  };
  const originalDump = probe.dump;
  let readsAfterStop = 0;
  probe.dump = async () => {
    if (samplingStopped) {
      readsAfterStop += 1;
      state.text = readsAfterStop % 2 === 0 ? screenTextFor('/') : 'Still moving';
    }
    return originalDump();
  };
  const logs: string[] = [];
  ctx.log = line => logs.push(line);
  const outcome = await runMatrix(ctx, matrixCells('android', 'base'), HOME);
  // A screen that never holds still is never certified: the two bracket reads
  // differ, and the wait reports that it timed out rather than a settle.
  assert.equal(captureEvidence(ctx, outcome).status, 'mismatch');
  assert.ok(logs.some(line => line.includes('screen still changing before the screenshot')));
  assert.ok(outcome.findings.some(finding => finding.rule === 'unsettled'));
});
