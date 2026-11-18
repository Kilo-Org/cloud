import assert from 'node:assert/strict';
import test from 'node:test';

import { screenFindings } from './capture';
import {
  NOT_YET_MOUNTED_WARNING,
  checkDevLogOverlay,
  logSourceFilterExpression,
  logSourceFilterStatsExpression,
} from './log-source-filter';
import { normalize, type ProbeDump } from './tree';

const WARNING = `${NOT_YET_MOUNTED_WARNING}. This indicates that you have a side-effect in your render function that asynchronously tries to update the component. Move this work to useEffect instead.`;

const ENGINE_FRAME = {
  file: 'node_modules/.pnpm/react-native-css@3.1.0-rc.1/node_modules/react-native-css/dist/module/native/react/useNativeCss.js',
  methodName: 'styleEffect.run',
  lineNumber: 41,
  column: 26,
};

const APP_FRAME = {
  file: 'apps/mobile/src/components/profile-screen.tsx',
  methodName: 'ProfileScreen',
  lineNumber: 275,
  column: 5,
};

const LIBRARY_STACK = [
  'Error: at',
  '  <anonymous> (@sentry/core/build/esm/instrument/console.js:45:21)',
  `  styleEffect.run (${ENGINE_FRAME.file}:41:26)`,
  '  notify (node_modules/.pnpm/react-native-css@3.1.0-rc.1/node_modules/react-native-css/dist/module/native/reactivity.js:65:34)',
].join('\n');

const APP_STACK = [
  'Error: at',
  '  ProfileScreen (apps/mobile/src/components/profile-screen.tsx:275:5)',
].join('\n');

type FakeLog = {
  message: { content: string };
  stack?: readonly unknown[];
  componentStack?: readonly unknown[];
};

type FilterStats = { suppressed: number; forwardedGuard: number; dismissed: number };

type FilterRuntime = {
  install: () => Promise<unknown>;
  emitError: (...args: unknown[]) => void;
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
  const logs = options.logs === undefined ? undefined : [...options.logs];
  const logBox = {
    observe: (observer: (state: { logs: FakeLog[] }) => void) => {
      observer({ logs: logs ?? [] });
      return { unsubscribe: () => undefined };
    },
    dismiss: (log: FakeLog) => {
      dismissed.push(log);
      const index = logs?.indexOf(log) ?? -1;
      if (index >= 0) logs?.splice(index, 1);
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
  const stats = new Function(
    'globalThis',
    `return ${logSourceFilterStatsExpression()}`
  ) as unknown as (scope: unknown) => unknown;
  return {
    install: async () => install(consoleTarget, scope, FakeError),
    emitError: (...args: unknown[]) => consoleTarget.error(...args),
    forwarded,
    dismissed,
    stats: async () => stats(scope) as FilterStats | null,
  };
}

test('the source decides: only a dispatch through the styling engine is dropped', async () => {
  const engine = filterRuntime({ stack: LIBRARY_STACK });
  await engine.install();
  engine.emitError(WARNING);
  assert.deepEqual(engine.forwarded, []);
  assert.deepEqual(await engine.stats(), { suppressed: 1, forwardedGuard: 0, dismissed: 0 });

  const app = filterRuntime({ stack: APP_STACK });
  await app.install();
  app.emitError(WARNING);
  assert.deepEqual(app.forwarded, [[WARNING]]);
  assert.deepEqual(await app.stats(), { suppressed: 0, forwardedGuard: 1, dismissed: 0 });

  // A stack that names the package but not the subscription that dispatched it.
  const packageOnly = filterRuntime({
    stack: 'notify (node_modules/react-native-css/dist/module/native/reactivity.js:65:34)',
  });
  await packageOnly.install();
  packageOnly.emitError(WARNING);
  assert.deepEqual(packageOnly.forwarded, [[WARNING]]);
});

test('unrelated logs pass through the installed filter', async () => {
  const runtime = filterRuntime({ stack: LIBRARY_STACK });
  await runtime.install();
  runtime.emitError('Loaded 4 items');
  runtime.emitError(WARNING);
  assert.deepEqual(runtime.forwarded, [['Loaded 4 items']]);
  assert.deepEqual(await runtime.stats(), { suppressed: 1, forwardedGuard: 0, dismissed: 0 });
});

test('the filter and its counters survive a second install in one runtime', async () => {
  const runtime = filterRuntime({ stack: LIBRARY_STACK });
  await runtime.install();
  await runtime.install();
  runtime.emitError('Loaded 4 items');
  runtime.emitError(WARNING);
  assert.deepEqual(runtime.forwarded, [['Loaded 4 items']]);
  assert.deepEqual(await runtime.stats(), { suppressed: 1, forwardedGuard: 0, dismissed: 0 });
});

test('a warning painted before the filter is closed only when a frame names the engine', async () => {
  const engineLog: FakeLog = { message: { content: WARNING }, stack: [ENGINE_FRAME] };
  const companion: FakeLog = { message: { content: WARNING }, componentStack: [ENGINE_FRAME] };
  const painted = filterRuntime({ stack: LIBRARY_STACK, logs: [engineLog, companion] });
  await painted.install();
  assert.deepEqual(painted.dismissed, [engineLog, companion]);
  assert.deepEqual(await painted.stats(), { suppressed: 0, forwardedGuard: 0, dismissed: 2 });

  const appLog: FakeLog = { message: { content: WARNING }, stack: [APP_FRAME] };
  const other: FakeLog = { message: { content: 'Loaded 4 items' }, stack: [ENGINE_FRAME] };
  const kept = filterRuntime({ stack: LIBRARY_STACK, logs: [appLog, other] });
  await kept.install();
  assert.deepEqual(kept.dismissed, []);
});

test('a runtime without the LogBox module keeps the toast', async () => {
  const runtime = filterRuntime({ stack: LIBRARY_STACK, logBox: false });
  await runtime.install();
  assert.deepEqual(runtime.dismissed, []);
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
      {
        parent: 0,
        tag: 'Paragraph',
        rect: [0, 0, 400, 33],
        testID: 'logbox_notification_message_text',
        text,
      },
    ],
  };
}

test('a warning left on screen is a cell defect, not a hidden log', () => {
  const dump = warningDump(WARNING);
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
  assert.equal(checkDevLogOverlay(normalize(warningDump('Loaded 4 items'))).length, 0);
});
