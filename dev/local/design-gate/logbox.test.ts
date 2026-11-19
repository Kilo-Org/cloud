import assert from 'node:assert/strict';
import test from 'node:test';

import { screenFindings } from './capture';
import { NOT_YET_MOUNTED_WARNING, checkDevLogOverlay, logBoxDisableExpression } from './logbox';
import { normalize, type ProbeDump } from './tree';

const WARNING = `${NOT_YET_MOUNTED_WARNING}. This indicates that you have a side-effect in your render function that asynchronously tries to update the component. Move this work to useEffect instead.`;

type Store = { calls: boolean[]; setDisabled: (value: boolean) => void };

function store(): Store {
  const calls: boolean[] = [];
  return {
    calls,
    setDisabled: value => {
      calls.push(value);
    },
  };
}

type AppRuntime = {
  globalThis: Record<string, unknown>;
  disable: () => { exposing: number; disabled: number };
  emitError: (...args: unknown[]) => void;
};

type DisableFn = (scope: unknown, console: unknown) => { exposing: number; disabled: number };

/** The app runtime as Metro exposes it: `__r.getModules()` over the bundle. */
function appRuntime(
  modules: Record<string, unknown> | undefined,
  consoleTarget: { error: (...args: unknown[]) => void } = { error: () => undefined }
): AppRuntime {
  const globalThis: Record<string, unknown> = { console: consoleTarget };
  if (modules !== undefined) {
    globalThis.__r = {
      getModules: () =>
        new Map(
          Object.entries(modules).map(([id, exports]) => [id, { publicModule: { exports } }])
        ),
    };
  }
  const disable = new Function(
    'globalThis',
    'console',
    `return ${logBoxDisableExpression()}`
  ) as unknown as DisableFn;
  return {
    globalThis,
    disable: () => disable(globalThis, consoleTarget),
    emitError: (...args: unknown[]) => consoleTarget.error(...args),
  };
}

test('every module exposing setDisabled is disabled once per runtime', () => {
  const namespace = store();
  const defaultExport = store();
  const runtime = appRuntime({
    '1': { setDisabled: namespace.setDisabled },
    '2': { default: defaultExport },
    '3': { observe: () => undefined },
  });
  // One call per module that offers the switch, counted once per runtime.
  assert.deepEqual(runtime.disable(), { exposing: 2, disabled: 2 });
  assert.deepEqual(namespace.calls, [true]);
  assert.deepEqual(defaultExport.calls, [true]);
  assert.deepEqual(runtime.disable(), { exposing: 2, disabled: 2 });
  assert.deepEqual(namespace.calls, [true]);
  assert.deepEqual(defaultExport.calls, [true]);
});

test('a reloaded runtime disables LogBox again', () => {
  const before = store();
  appRuntime({ '7': { setDisabled: before.setDisabled } }).disable();
  // The marker lives on the runtime's own `globalThis`, which a reload replaces.
  const after = store();
  appRuntime({ '7': { setDisabled: after.setDisabled } }).disable();
  assert.deepEqual(before.calls, [true]);
  assert.deepEqual(after.calls, [true]);
});

test('a runtime with no registry or no exposing module reports none', () => {
  assert.deepEqual(appRuntime(undefined).disable(), { exposing: 0, disabled: 0 });
  const unrelated = appRuntime({ '4': { observe: () => undefined } });
  assert.deepEqual(unrelated.disable(), { exposing: 0, disabled: 0 });
});

test('a pass with no registry claims no module exposed the switch', () => {
  const runtime = appRuntime({ '6': { setDisabled: store().setDisabled } });
  assert.deepEqual(runtime.disable(), { exposing: 1, disabled: 1 });

  // The ids a previous pass disabled stay disabled; this pass cannot inspect the
  // bundle, so the run log must not read them back as modules that exposed it.
  delete runtime.globalThis.__r;
  assert.deepEqual(runtime.disable(), { exposing: 0, disabled: 1 });
});

test('the disable pass leaves the console chain alone', () => {
  const forwarded: unknown[][] = [];
  const error = function error(...args: unknown[]) {
    forwarded.push(args);
  };
  const runtime = appRuntime({ '5': { setDisabled: store().setDisabled } }, { error });
  runtime.disable();
  // The app's Sentry integration has already wrapped console.error and calls the
  // previous one through `apply`: a bare replacement makes that call throw and
  // LogBox paints a full screen instead of a toast.
  const consoleTarget = runtime.globalThis.console as { error: unknown };
  assert.equal(consoleTarget.error, error);
  runtime.emitError('Loaded 4 items');
  assert.deepEqual(forwarded, [['Loaded 4 items']]);
});

function warningDump(text: string): ProbeDump {
  return {
    version: 1,
    env: {
      platform: 'android',
      osVersion: '15',
      route: '/',
      window: { width: 400, height: 800 },
      pixelRatio: 1,
      fontScale: 1,
      colorScheme: 'dark',
      isRTL: false,
      language: 'en',
      languagePreference: 'system',
      safeArea: { top: 0, right: 0, bottom: 0, left: 0 },
      tapTarget: { min: 28, touch: 44 },
    },
    nodes: [
      { parent: -1, tag: 'View', rect: [0, 0, 400, 800] },
      { parent: 0, tag: 'View', rect: [0, 0, 400, 800] },
      { parent: 1, tag: 'Paragraph', rect: [16, 16, 368, 24], text: 'Profile' },
      {
        parent: 1,
        tag: 'SafeAreaView',
        rect: [9.9, 506.29, 340.19, 113.9],
        owners: [
          'LogBoxNotificationContainer',
          'LogBoxStateSubscription',
          'View',
          'AppContainer',
          'main(RootComponent)',
        ],
      },
      {
        parent: 3,
        tag: 'View',
        rect: [9.9, 542.48, 340.19, 48.38],
        owners: [
          'View',
          'LogBoxNotificationContainer',
          'LogBoxStateSubscription',
          'View',
          'AppContainer',
          'main(RootComponent)',
        ],
      },
      {
        parent: 4,
        tag: 'View',
        rect: [9.9, 542.86, 340.19, 48],
        testID: 'logbox_notification',
        owners: [
          'View',
          'LogBoxNotification',
          'View',
          'LogBoxNotificationContainer',
          'LogBoxStateSubscription',
          'View',
        ],
      },
      {
        parent: 5,
        tag: 'View',
        rect: [52.19, 556.19, 260.95, 22.1],
        owners: ['View', 'LogBoxNotificationMessage', 'View', 'Pressable', 'LogBoxButton', 'View'],
      },
      {
        parent: 6,
        tag: 'Paragraph',
        rect: [60.95, 556.19, 252.19, 22.86],
        testID: 'logbox_notification_message_text',
        owners: ['Text', 'View', 'LogBoxNotificationMessage', 'View', 'Pressable', 'LogBoxButton'],
        text,
      },
    ],
  };
}

test('a toast painted after disabling is an environment warning, not a screen defect', () => {
  const dump = warningDump(WARNING);
  // The toast's owners are the ignored overlay's: the layout rules never see it,
  // so the rule has to read the dump.
  assert.equal(
    normalize(dump).nodes.some(node => node.probe.testID === 'logbox_notification_message_text'),
    false
  );
  const findings = screenFindings({
    cell: 'dark',
    target: 'app-tabs-3-profile',
    dump,
    tree: normalize(dump),
  });
  const overlay = findings.find(entry => entry.rule === 'dev-overlay');
  assert.equal(overlay?.severity, 'warning');
  assert.equal(overlay?.cell, 'dark');
  assert.equal(overlay?.target, 'app-tabs-3-profile');
  assert.equal(overlay?.element.testID, 'logbox_notification_message_text');
  assert.equal(overlay?.element.index, 7);
  assert.equal(overlay?.measured, 22.86);
  assert.match(overlay?.message ?? '', /Disabling failed in this runtime/);
});

test('a dump whose LogBox node carries no text has no overlay finding', () => {
  // LogBox chrome is in the dump with nothing painted into it: no message, no
  // finding.
  assert.deepEqual(checkDevLogOverlay(warningDump('   ')), []);
  assert.deepEqual(checkDevLogOverlay(warningDump('')), []);
});

const RENDER_ERROR = 'Text strings must be rendered within a <Text> component.';
const ARBITRARY = 'Loaded 4 items';
type Level = 'warn' | 'error' | undefined;

/**
 * A dump holding the toast's message node, the chrome that repeats it and the
 * buttons LogBox paints its level into.
 */
function toastDump(level: Level, ...texts: readonly string[]): ProbeDump {
  const dump = warningDump(texts[0] ?? '');
  // LogBox paints the same string twice: the message paragraph, and the
  // notification chrome that renders it. One notification must read as one
  // finding, and the paragraph names the message, so it wins.
  const message = dump.nodes[7];
  dump.nodes.push(
    {
      parent: 5,
      tag: 'View',
      rect: [9.9, 556.19, 340.19, 48],
      testID: 'logbox',
      text: texts[0] ?? '',
    },
    // The badge carries the count, never a message: it must not read as one.
    {
      parent: 5,
      tag: 'Paragraph',
      rect: [27.81, 832.38, 10.29, 18.29],
      testID: 'logbox_notification_count_text',
      text: '!',
    },
    ...(level === undefined
      ? []
      : [
          {
            parent: 5,
            tag: 'View',
            rect: [9.9, 817.52, 391.62, 48],
            testID: `logbox_open_button_${level}`,
          },
          {
            parent: 5,
            tag: 'View',
            rect: [369.52, 831.62, 19.81, 19.81],
            testID: `logbox_dismiss_button_${level}`,
          },
        ]),
    ...texts.slice(1).map(text => ({ ...message, text }))
  );
  return dump;
}

test('an error-level notification makes any message an error, not a screen defect', () => {
  const findings = checkDevLogOverlay(toastDump('error', RENDER_ERROR));
  // The chrome repeats the message; the notification still yields one finding.
  assert.equal(findings.length, 1);
  const [overlay] = findings;
  assert.equal(overlay.rule, 'dev-overlay');
  assert.equal(overlay.severity, 'error');
  assert.equal(overlay.element.testID, 'logbox_notification_message_text');
  assert.equal(overlay.element.index, 7);
  assert.equal(overlay.element.text, RENDER_ERROR);
  assert.equal(overlay.measured, 22.86);
  assert.equal(overlay.expected, 'no LogBox toast painted over the screen');
  assert.match(overlay.message, /cannot grade what it covers/);
  assert.match(overlay.message, new RegExp(RENDER_ERROR.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('LogBox decides the severity: an error-level unlock of an arbitrary message still fails the run', () => {
  // The message says nothing the gate could recognize; the notification's own
  // level does, which is why the text is never the classifier.
  const [overlay] = checkDevLogOverlay(toastDump('error', ARBITRARY));
  assert.equal(overlay.severity, 'error');
  assert.equal(overlay.element.text, ARBITRARY);
});

test('LogBox decides the severity: a warn-level notification stays a warning whatever it says', () => {
  const [overlay] = checkDevLogOverlay(toastDump('warn', RENDER_ERROR));
  assert.equal(overlay.severity, 'warning');
  assert.equal(overlay.element.text, RENDER_ERROR);
  // The quoted text stays in the finding, so the run says what painted over it.
  assert.match(overlay.message, new RegExp(RENDER_ERROR.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('a warn-level not-yet-mounted toast keeps its environment wording', () => {
  const [overlay] = checkDevLogOverlay(toastDump('warn', WARNING));
  assert.equal(overlay.severity, 'warning');
  assert.match(overlay.message, /Disabling failed in this runtime/);
});

test('without level chrome the message text is the only classification left', () => {
  // A dump from a runtime whose LogBox chrome the probe did not model: the one
  // message the gate knows is an environment warning stays a warning, and
  // anything else is assumed to be the error it would be.
  assert.deepEqual(
    checkDevLogOverlay(toastDump(undefined, WARNING, RENDER_ERROR)).map(entry => [
      entry.severity,
      entry.element.text,
    ]),
    [
      ['warning', WARNING],
      ['error', RENDER_ERROR],
    ]
  );
});
