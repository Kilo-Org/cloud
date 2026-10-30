import assert from 'node:assert/strict';
import test from 'node:test';

import {
  detectPlatform,
  installAbortRestore,
  isHelpRequest,
  main,
  parseCliArgs,
  resolveTargets,
  targetIdFromLink,
  UsageError,
} from './cli';

test('parseCliArgs parses run with repeated links and defaults', () => {
  assert.deepEqual(
    parseCliArgs(['run', '--link', 'kiloapp://sessions', '--link', 'kiloapp://profile']),
    {
      command: 'run',
      links: ['kiloapp://sessions', 'kiloapp://profile'],
      targets: undefined,
      matrix: 'standard',
      platform: undefined,
      device: undefined,
      metro: 'http://127.0.0.1:8081',
      out: undefined,
      observeMs: 2_500,
    }
  );
  const full = parseCliArgs([
    'run',
    '--targets',
    't.json',
    '--matrix',
    'full',
    '--platform',
    'ios',
    '--device',
    'U',
    '--observe-ms',
    '0',
  ]);
  assert.equal(full.command === 'run' && full.matrix, 'full');
  assert.equal(full.command === 'run' && full.observeMs, 0);
  assert.equal(full.platform, 'ios');
});

test('parseCliArgs parses scan and motion', () => {
  const scan = parseCliArgs(['scan', '--source', 'uiautomator']);
  assert.equal(scan.command === 'scan' && scan.source, 'uiautomator');
  assert.equal(parseCliArgs(['scan']).command === 'scan' && 'probe', 'probe');
  const agentScan = parseCliArgs(['scan', '--source', 'agent-device', '--session', 's1']);
  assert.deepEqual(agentScan.command === 'scan' && [agentScan.source, agentScan.session], [
    'agent-device',
    's1',
  ]);
  assert.throws(() => parseCliArgs(['run', '--link', 'x', '--session', 's1']), /not valid for run/);
  const motion = parseCliArgs([
    'motion',
    '--link',
    'kiloapp://x',
    '--tap',
    'Send',
    '--seconds',
    '5',
  ]);
  assert.deepEqual(motion.command === 'motion' && [motion.link, motion.tap, motion.seconds], [
    'kiloapp://x',
    'Send',
    5,
  ]);
});

test('parseCliArgs rejects invalid input', () => {
  const rejects = (argv: string[], pattern: RegExp) =>
    assert.throws(
      () => parseCliArgs(argv),
      (error: unknown) => error instanceof UsageError && pattern.test(error.message)
    );
  rejects([], /Missing command/);
  rejects(['deploy'], /--command must be one of/);
  rejects(['run'], /needs --link or --targets/);
  rejects(['run', '--link', 'x', '--matrix', 'huge'], /--matrix must be one of/);
  rejects(['scan', '--link', 'x'], /--link is not valid for scan/);
  rejects(['motion'], /exactly one --link/);
  rejects(['motion', '--link', 'x', '--seconds', '0'], /--seconds/);
  rejects(['run', '--link', 'x', '--bogus'], /bogus/);
  rejects(['run', '--link', 'x', '--platform', 'web'], /--platform/);
  rejects(['run', '--link', 'x', '--observe-ms', '-1'], /--observe-ms/);
  rejects(['scan', '--observe-ms', '100'], /not valid for scan/);
});

test('targets resolve to unique slug ids', () => {
  assert.equal(targetIdFromLink('kiloapp://sessions/abc?tab=1'), 'sessions-abc');
  assert.equal(targetIdFromLink('???'), 'target');
  assert.deepEqual(
    resolveTargets(
      ['kiloapp://sessions'],
      JSON.stringify([
        { id: 'Sessions', link: 'kiloapp://sessions?x=1' },
        'kiloapp://profile',
        { name: 'Chat', link: 'kiloapp://chat' },
      ])
    ),
    [
      { id: 'sessions', link: 'kiloapp://sessions' },
      { id: 'sessions-2', link: 'kiloapp://sessions?x=1' },
      { id: 'profile', link: 'kiloapp://profile' },
      { id: 'chat', link: 'kiloapp://chat' },
    ]
  );
  assert.deepEqual(resolveTargets([], JSON.stringify({ targets: [{ link: 'kiloapp://a' }] })), [
    { id: 'a', link: 'kiloapp://a' },
  ]);
  assert.throws(() => resolveTargets([], '[{"id":"x"}]'), /string link/);
});

test('detectPlatform prefers a connected adb device', () => {
  const adb = (output: string) => () => Buffer.from(output);
  assert.equal(
    detectPlatform(adb('List of devices attached\nemulator-5554\tdevice\n'), 'darwin'),
    'android'
  );
  assert.equal(detectPlatform(adb('List of devices attached\n'), 'darwin'), 'ios');
  assert.equal(detectPlatform(adb('List of devices attached\n'), 'linux'), 'android');
  assert.throws(
    () =>
      detectPlatform(() => {
        throw new Error('ENOENT');
      }, 'linux'),
    /adb is not available/
  );
});

test('help prints usage with the app and probe requirement and exits 0', async () => {
  assert.ok(isHelpRequest(['help']) && isHelpRequest(['run', '--help']) && isHelpRequest(['-h']));
  assert.equal(isHelpRequest(['run', '--link', 'x']), false);
  const lines: string[] = [];
  const fail = () => {
    throw new Error('no device calls expected');
  };
  const code = await main(['--help'], {
    exec: fail,
    spawn: fail,
    clock: { now: () => 0, sleep: async () => undefined },
    hostPlatform: 'linux',
    log: line => lines.push(line),
    warn: line => lines.push(line),
    onSignal: () => () => undefined,
    exit: fail,
  });
  assert.equal(code, 0);
  assert.match(
    lines.join('\n'),
    /com\.kilocode\.kiloapp; needs a dev build connected to Metro; release builds: use scan --source uiautomator/
  );
});

test('SIGINT runs registered restores once, then exits 130; disposal removes handlers', async () => {
  const handlers = new Map<string, () => void>();
  const events: string[] = [];
  const exited = Promise.withResolvers<number>();
  const abort = installAbortRestore({
    onSignal: (signal, handler) => {
      handlers.set(signal, handler);
      return () => handlers.delete(signal);
    },
    exit: code => exited.resolve(code),
    warn: line => events.push(line),
    clock: { now: () => 0, sleep: () => new Promise(() => undefined) },
  });
  abort.register(async () => {
    events.push('restore device');
  });
  const unregister = abort.register(async () => {
    events.push('stale cleanup');
  });
  unregister();
  handlers.get('SIGINT')?.();
  handlers.get('SIGTERM')?.();
  assert.equal(await exited.promise, 130);
  assert.deepEqual(events.slice(1), ['restore device']);
  abort.dispose();
  assert.equal(handlers.size, 0);
});
