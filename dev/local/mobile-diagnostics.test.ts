import assert from 'node:assert/strict';
import test from 'node:test';

import {
  RefusedError,
  cliArgsFor,
  formatErrors,
  gateStatus,
  parseArgs,
  parseDuration,
  parsePort,
  resolvePort,
  runDiagnostics,
  sandboxEnv,
} from './mobile-diagnostics';

const MANIFEST = {
  session: 'kilo-dev-cloud',
  portOffset: 200,
  wranglerRegistryPath: '/tmp/wrangler',
  services: [{ name: 'mobile', port: 8281, group: 'mobile', type: 'app' }],
};

function statusReport(overrides: Record<string, unknown> = {}) {
  return {
    devServer: {
      url: 'http://127.0.0.1:8281',
      running: true,
      ready: true,
      appsConnected: 1,
      projectRootMatched: true,
      ...overrides,
    },
  };
}

function harness(
  argv: string[],
  reports: { status: unknown; errors?: unknown },
  exits: number[] = [0, 0]
) {
  const calls: string[][] = [];
  const printed: string[] = [];
  const code = runDiagnostics(argv, {
    mobileProjectRoot: '/repo/apps/mobile',
    manifest: MANIFEST,
    defaultPort: 8081,
    runCli: args => {
      calls.push(args);
      const index = calls.length - 1;
      const payload = index === 0 ? reports.status : reports.errors;
      return {
        code: exits[index] ?? 0,
        stdout: payload == null ? '' : JSON.stringify(payload),
        stderr: '',
      };
    },
    print: line => printed.push(line),
  });
  return { calls, printed, code };
}

test('port comes from the running dev session, not the Metro default', () => {
  assert.equal(resolvePort({ manifest: MANIFEST, defaultPort: 8081, override: null }), 8281);
  assert.equal(resolvePort({ manifest: undefined, defaultPort: 8081, override: null }), 8081);
  assert.equal(resolvePort({ manifest: MANIFEST, defaultPort: 8081, override: 8300 }), 8300);
  assert.throws(
    () =>
      resolvePort({
        manifest: { ...MANIFEST, services: [] },
        defaultPort: undefined,
        override: null,
      }),
    /no mobile dev session/
  );
});

test('every runtime read names the resolved port and asks for the project platform', () => {
  assert.deepEqual(cliArgsFor(parseArgs([]), 'http://127.0.0.1:8281'), [
    'status',
    '--json',
    '--dev-server-url',
    'http://127.0.0.1:8281',
  ]);
  assert.deepEqual(
    cliArgsFor(parseArgs(['errors', '--ios', '--duration', '5s']), 'http://127.0.0.1:8281'),
    [
      'runtime:errors',
      '--json',
      '--dev-server-url',
      'http://127.0.0.1:8281',
      '--platform',
      'ios',
      '--duration',
      '5000ms',
    ]
  );
});

test('a dev server that is not this project is refused', () => {
  gateStatus(statusReport() as never);
  assert.throws(
    () => gateStatus(statusReport({ projectRootMatched: false }) as never),
    /another project/
  );
  assert.throws(
    () => gateStatus(statusReport({ projectRootMatched: null }) as never),
    /another project/
  );
  assert.throws(
    () => gateStatus(statusReport({ running: false }) as never),
    /No dev server answered/
  );
});

test('telemetry stays off in the CLI child environment', () => {
  assert.equal(sandboxEnv({ PATH: '/bin' }).EXPO_NO_TELEMETRY, '1');
  assert.equal(sandboxEnv({ PATH: '/bin', EXPO_NO_TELEMETRY: '0' }).EXPO_NO_TELEMETRY, '1');
});

test('status prints the verified port and the app count', () => {
  const { calls, printed, code } = harness([], { status: statusReport() });
  assert.equal(code, 0);
  assert.equal(calls.length, 1);
  assert.equal(printed[0], 'worktree  /repo/apps/mobile');
  assert.match(printed[1] ?? '', /http:\/\/127\.0\.0\.1:8281.*1 app\(s\) connected/);
});

test('errors prints the project frame of each error', () => {
  const { calls, printed, code } = harness(['errors'], {
    status: statusReport(),
    errors: {
      count: 1,
      durationMs: 4000,
      runtimeReadable: true,
      errors: [
        {
          message: 'Error: boom\n  at LoginRoute',
          frames: [
            { file: 'node_modules/react-native/index.js', lineNumber: 2 },
            { file: 'src/app/(auth)/login.tsx', lineNumber: 5 },
          ],
        },
      ],
    },
  });
  assert.equal(code, 0);
  assert.equal(calls[1]?.[0], 'runtime:errors');
  assert.equal(printed[0], 'metro     http://127.0.0.1:8281  project root verified');
  assert.equal(printed[1], '1 runtime error(s) in 4000ms.');
  assert.equal(printed[2], '  Error: boom (src/app/(auth)/login.tsx:5)');
});

test('an empty error window does not claim the app is healthy', () => {
  const lines = formatErrors({ count: 0, durationMs: 4000, errors: [] });
  assert.match(lines[0] ?? '', /not a healthy app/);
});

test('a refused dev server stops before the runtime is read', () => {
  const calls: string[][] = [];
  assert.throws(
    () =>
      runDiagnostics(['errors'], {
        mobileProjectRoot: '/repo/apps/mobile',
        manifest: MANIFEST,
        runCli: args => {
          calls.push(args);
          return {
            code: 0,
            stdout: JSON.stringify(statusReport({ projectRootMatched: false })),
            stderr: '',
          };
        },
        print: () => {},
      }),
    (error: unknown) => error instanceof RefusedError
  );
  assert.deepEqual(
    calls.map(args => args[0]),
    ['status']
  );
});

test('a failing CLI status is reported, not treated as an empty answer', () => {
  assert.throws(
    () => harness([], { status: statusReport() }, [1]),
    /could not read http:\/\/127\.0\.0\.1:8281 \(exit 1\)/
  );
});

test('bad arguments are rejected before anything runs', () => {
  assert.throws(() => parseArgs(['deploy']), /Unknown command/);
  assert.throws(() => parseArgs(['--port']), /needs a value/);
  assert.throws(() => parseArgs(['--android', '--ios']), /one platform/);
  assert.throws(() => parsePort('0'), /not a port/);
  assert.throws(() => parsePort('abc'), /not a port/);
  assert.throws(() => parseDuration('soon'), /not a duration/);
  assert.equal(parseDuration('1500'), 1500);
  assert.equal(parseDuration('5s'), 5000);
});
