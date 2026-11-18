import assert from 'node:assert/strict';
import test from 'node:test';

import { screenFindings } from './capture';
import {
  NOT_YET_MOUNTED_WARNING,
  checkDevLogOverlay,
  logSourceFilterDismissExpression,
  logSourceFilterExpression,
  logSourceFilterStatsExpression,
} from './log-source-filter';
import { normalize, type ProbeDump } from './tree';

const WARNING = `${NOT_YET_MOUNTED_WARNING}. This indicates that you have a side-effect in your render function that asynchronously tries to update the component. Move this work to useEffect instead.`;

// A Metro dev bundle reports every frame of the app under one URL: the gate
// cannot recognise the engine by a package path, only by the method names the
// bundle keeps.
const BUNDLE = 'http://localhost:8081/index.bundle?platform=android&dev=true&minify=false';

const ENGINE_FRAME = { file: BUNDLE, methodName: 'useNativeCss', lineNumber: 1200, column: 34 };

const EFFECT_FRAME = { file: BUNDLE, methodName: 'styleEffect.run', lineNumber: 88, column: 12 };

const APP_FRAME = { file: BUNDLE, methodName: 'ProfileScreen', lineNumber: 9876, column: 5 };

const ENGINE_STACK = [
  'Error: at',
  `  <anonymous> (${BUNDLE}:1:1)`,
  `  useNativeCss (${BUNDLE}:1200:34)`,
  `  styleEffect.run (${BUNDLE}:88:12)`,
].join('\n');

const APP_STACK = [
  'Error: at',
  `  <anonymous> (${BUNDLE}:1:1)`,
  `  ProfileScreen (${BUNDLE}:9876:5)`,
].join('\n');

const PACKAGE_STACK =
  '  notify (node_modules/react-native-css/dist/module/native/reactivity.js:65:34)';

type FakeLog = {
  message: { content: string };
  stack?: readonly unknown[];
  componentStack?: readonly unknown[];
};

type FilterStats = { suppressed: number; forwardedGuard: number; dismissed: number };

type FilterRuntime = {
  install: () => Promise<unknown>;
  dismiss: () => Promise<number>;
  emitError: (...args: unknown[]) => void;
  logs: FakeLog[];
  forwarded: unknown[][];
  dismissed: FakeLog[];
  stats: () => Promise<FilterStats | null>;
};

function filterRuntime(options: {
  stack?: string;
  logs?: readonly FakeLog[];
  logBox?: boolean;
}): FilterRuntime {
  const forwarded: unknown[][] = [];
  const dismissed: FakeLog[] = [];
  const logs: FakeLog[] = options.logs === undefined ? [] : [...options.logs];
  const logBox = {
    observe: (observer: (state: { logs: FakeLog[] }) => void) => {
      observer({ logs: [...logs] });
      return { unsubscribe: () => undefined };
    },
    dismiss: (log: FakeLog) => {
      dismissed.push(log);
      const index = logs.indexOf(log);
      if (index >= 0) logs.splice(index, 1);
    },
    addLog: () => undefined,
    setDisabled: () => undefined,
  };
  const scope: Record<string, unknown> =
    options.logBox === false
      ? {}
      : { __r: { getModules: () => new Map([['42', { publicModule: { exports: logBox } }]]) } };
  const consoleTarget = {
    error: function error(...args: unknown[]) {
      forwarded.push(args);
    },
  };
  class FakeError {
    stack = options.stack ?? '';
  }
  const install = new Function(
    'console',
    'globalThis',
    'Error',
    `return ${logSourceFilterExpression()}`
  ) as unknown as (console: unknown, scope: unknown, error: unknown) => unknown;
  const dismiss = new Function(
    'globalThis',
    `return ${logSourceFilterDismissExpression()}`
  ) as unknown as (scope: unknown) => unknown;
  const stats = new Function(
    'globalThis',
    `return ${logSourceFilterStatsExpression()}`
  ) as unknown as (scope: unknown) => unknown;
  return {
    install: async () => install(consoleTarget, scope, FakeError),
    dismiss: async () => dismiss(scope) as number,
    emitError: (...args: unknown[]) => consoleTarget.error(...args),
    logs,
    forwarded,
    dismissed,
    stats: async () => stats(scope) as FilterStats | null,
  };
}

test('the source decides: only a method name from the styling engine is dropped', async () => {
  const engine = filterRuntime({ stack: ENGINE_STACK });
  await engine.install();
  engine.emitError(WARNING);
  assert.deepEqual(engine.forwarded, []);
  assert.deepEqual(await engine.stats(), { suppressed: 1, forwardedGuard: 0, dismissed: 0 });

  const app = filterRuntime({ stack: APP_STACK });
  await app.install();
  app.emitError(WARNING);
  assert.deepEqual(app.forwarded, [[WARNING]]);
  assert.deepEqual(await app.stats(), { suppressed: 0, forwardedGuard: 1, dismissed: 0 });

  // The package path alone is not the engine: a bundle resolves it away, and a
  // frame that only mentions the package never dispatched React's update.
  const packageOnly = filterRuntime({ stack: PACKAGE_STACK });
  await packageOnly.install();
  packageOnly.emitError(WARNING);
  assert.deepEqual(packageOnly.forwarded, [[WARNING]]);
});

test('unrelated logs pass through the installed filter', async () => {
  const runtime = filterRuntime({ stack: ENGINE_STACK });
  await runtime.install();
  runtime.emitError('Loaded 4 items');
  runtime.emitError(WARNING);
  assert.deepEqual(runtime.forwarded, [['Loaded 4 items']]);
  assert.deepEqual(await runtime.stats(), { suppressed: 1, forwardedGuard: 0, dismissed: 0 });
});

test('the filter and its counters survive a second install in one runtime', async () => {
  const runtime = filterRuntime({ stack: ENGINE_STACK });
  await runtime.install();
  await runtime.install();
  runtime.emitError('Loaded 4 items');
  runtime.emitError(WARNING);
  assert.deepEqual(runtime.forwarded, [['Loaded 4 items']]);
  assert.deepEqual(await runtime.stats(), { suppressed: 1, forwardedGuard: 0, dismissed: 0 });
});

test('a toast painted before the filter is closed only when a frame names the engine', async () => {
  const engineLog: FakeLog = { message: { content: WARNING }, stack: [ENGINE_FRAME] };
  const companion: FakeLog = { message: { content: WARNING }, componentStack: [EFFECT_FRAME] };
  const painted = filterRuntime({ stack: ENGINE_STACK, logs: [engineLog, companion] });
  await painted.install();
  assert.deepEqual(painted.dismissed, [engineLog, companion]);
  assert.deepEqual(await painted.stats(), { suppressed: 0, forwardedGuard: 0, dismissed: 2 });

  const appLog: FakeLog = { message: { content: WARNING }, stack: [APP_FRAME] };
  const other: FakeLog = { message: { content: 'Loaded 4 items' }, stack: [ENGINE_FRAME] };
  const kept = filterRuntime({ stack: ENGINE_STACK, logs: [appLog, other] });
  await kept.install();
  assert.deepEqual(kept.dismissed, []);
});

test('a toast painted after the install is closed by the pass each capture runs', async () => {
  const runtime = filterRuntime({ stack: ENGINE_STACK });
  await runtime.install();
  const painted: FakeLog = { message: { content: WARNING }, stack: [EFFECT_FRAME] };
  const appLog: FakeLog = { message: { content: WARNING }, stack: [APP_FRAME] };
  runtime.logs.push(painted, appLog);
  assert.equal(await runtime.dismiss(), 1);
  assert.deepEqual(runtime.dismissed, [painted]);
  assert.deepEqual(await runtime.stats(), { suppressed: 0, forwardedGuard: 0, dismissed: 1 });
  assert.equal(await runtime.dismiss(), 0);
});

test('a runtime without the LogBox module keeps the toast', async () => {
  const runtime = filterRuntime({ stack: ENGINE_STACK, logBox: false });
  await runtime.install();
  assert.deepEqual(runtime.dismissed, []);
  assert.equal(await runtime.dismiss(), 0);
  assert.deepEqual(await runtime.stats(), { suppressed: 0, forwardedGuard: 0, dismissed: 0 });
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
        owners: [
          'View',
          'LogBoxNotificationMessage',
          'View',
          'Pressable',
          'LogBoxButton',
          'View',
        ],
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

test('a raw dump warning is a cell defect, though normalize drops LogBox chrome', () => {
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
  assert.equal(overlay?.severity, 'error');
  assert.equal(overlay?.cell, 'dark');
  assert.equal(overlay?.target, 'app-tabs-3-profile');
  assert.equal(overlay?.element.testID, 'logbox_notification_message_text');
  assert.equal(overlay?.element.index, 7);
  assert.equal(overlay?.measured, 22.86);
  assert.equal(checkDevLogOverlay(warningDump('Loaded 4 items')).length, 0);
});
