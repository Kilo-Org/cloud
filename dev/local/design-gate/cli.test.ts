import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  detectPlatform,
  installAbortRestore,
  isHelpRequest,
  main,
  parseCliArgs,
  readSettledDump,
  resolveTargets,
  SCAN_SETTLE_READS,
  scanScreenFindings,
  targetIdFromLink,
  UsageError,
} from './cli';
import { uiautomatorToProbeDump } from './uiautomator';
import type { ProbeDump } from './tree';

// A scrolled new-session screen with the environment sheet open, captured on an Android
// emulator: the platform clamps a node whose bottom leaves the scroll viewport, and the
// drawn SVG descendants of an icon report frames outside the view that owns them.
const CLAMPED_SHEET_XML = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy rotation="0">
  <node class="android.widget.FrameLayout" bounds="[0,0][1080,2400]">
    <node class="android.widget.ScrollView" bounds="[0,311][1080,2097]">
      <node class="android.view.ViewGroup" bounds="[37,1994][1043,2097]">
        <node class="android.widget.TextView" bounds="[76,2080][1004,2097]" text="Sign in from your browser, then return here to pick a GitLab repository." />
        <node class="android.widget.Button" bounds="[76,2134][870,2097]" text="Open GitLab" clickable="true">
          <node class="com.horcrux.svg.SvgView" bounds="[115,2291][157,2097]">
            <node class="com.horcrux.svg.GroupView" bounds="[120,2296][152,2328]" />
          </node>
        </node>
      </node>
      <node class="android.view.ViewGroup" bounds="[37,1117][1043,1163]">
        <node class="android.widget.TextView" text="Run on" bounds="[37,1117][1045,1163]" />
      </node>
    </node>
  </node>
</hierarchy>`;

// The same screen read while it was still moving: the row above was already clamped to
// the viewport edge, and its text answered with the frame it held before that clamp, so
// the text sits past its parent by the scroll offset. Nothing on the screen overflows;
// two frames of one screen were compared.
const MOVING_SHEET_XML = CLAMPED_SHEET_XML.replace(
  'bounds="[76,2080][1004,2097]"',
  'bounds="[76,2080][1004,2205]"'
);

function dumpFrom(xml: string): ProbeDump {
  return uiautomatorToProbeDump({
    xml,
    densityDpi: 420,
    fontScale: 1,
    colorScheme: 'light',
    language: 'en-US',
    osVersion: '16',
  });
}

test('a scan that never settles exits 2 instead of reporting a pass', async () => {
  const xmls = [MOVING_SHEET_XML, CLAMPED_SHEET_XML];
  let reads = 0;
  let now = 0;
  const shellCalls: Record<string, string> = {
    'wm density': 'Physical density: 420',
    'wm size': 'Physical size: 1080x2400',
    'cmd uimode night': 'Night mode: no',
    'settings get system accelerometer_rotation': '0',
    'settings get system user_rotation': '0',
    'getprop ro.product.model': 'sdk_gphone64_x86_64',
    'getprop ro.product.name': 'sdk_gphone64',
    'settings get system font_scale': '1',
    'getprop persist.sys.locale': 'en-US',
    'getprop ro.build.version.release': '16',
  };
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'design-gate-scan-'));
  const lines: string[] = [];
  const code = await main(['scan', '--source', 'uiautomator', '--out', out], {
    exec: (command, args) => {
      if (command === 'ffprobe') return Buffer.from('1x1');
      if (command === 'ffmpeg') return Buffer.alloc(4);
      if (args[0] === 'devices') return Buffer.from('Listed\nemulator-5554\tdevice\n');
      if (args[1] === 'emu') return Buffer.from('omp36\n');
      if (args.includes('screencap')) return Buffer.alloc(0);
      if (args.includes('cat')) {
        const xml = xmls[reads % xmls.length] ?? '';
        reads += 1;
        return Buffer.from(xml);
      }
      const shell = args.slice(args.indexOf('shell') + 1).join(' ');
      return Buffer.from(shellCalls[shell] ?? '');
    },
    spawn: () => {
      throw new Error('no spawn expected');
    },
    clock: {
      now: () => now,
      sleep: async () => {
        now += 1_000;
      },
    },
    hostPlatform: 'linux',
    log: line => lines.push(line),
    warn: line => lines.push(line),
    onSignal: () => () => undefined,
    exit: () => {
      throw new Error('no exit expected');
    },
  });
  fs.rmSync(out, { recursive: true, force: true });
  assert.equal(code, 2);
  assert.match(lines.join('\n'), /the screen did not settle, so nothing was measured/);
  assert.match(lines.join('\n'), /1 warnings across 1 cells/);
});

test('readSettledDump measures a layout that repeats across reads', async () => {
  const dump = dumpFrom(CLAMPED_SHEET_XML);
  let reads = 0;
  const settled = await readSettledDump(
    () => {
      reads += 1;
      return dump;
    },
    { now: () => 0, sleep: async () => undefined }
  );
  assert.equal(settled.settled, true);
  assert.equal(settled.elapsedMs, 0);
  assert.equal(reads, SCAN_SETTLE_READS);
});

test('readSettledDump stops at the timeout when the layout keeps changing', async () => {
  const dumps = [dumpFrom(MOVING_SHEET_XML), dumpFrom(CLAMPED_SHEET_XML)];
  let now = 0;
  let reads = 0;
  const settled = await readSettledDump(
    () => {
      const dump = dumps[reads % dumps.length] ?? dumps[0];
      reads += 1;
      return dump as ProbeDump;
    },
    {
      now: () => now,
      sleep: async () => {
        now += 1_000;
      },
    },
    { timeoutMs: 1_000 }
  );
  assert.equal(settled.settled, false);
  assert.equal(settled.elapsedMs, 1_000);
  assert.equal(reads, 2);
});

test('a moving screen reports that it was not measurable instead of a rect defect', () => {
  const unsettled = scanScreenFindings({
    dump: dumpFrom(MOVING_SHEET_XML),
    settled: false,
    elapsedMs: 12_500,
  });
  assert.deepEqual(
    unsettled.map(finding => finding.rule),
    ['unsettled']
  );
  assert.equal(unsettled[0]?.severity, 'warning');
  assert.match(unsettled[0]?.message ?? '', /layout rules were skipped/);

  const clipped = scanScreenFindings({
    dump: dumpFrom(MOVING_SHEET_XML),
    settled: true,
    elapsedMs: 0,
  });
  assert.ok(
    clipped.some(finding => finding.rule === 'clipped' && finding.severity === 'error'),
    'a settled screen still reports the text that is really past its parent'
  );
});

test('a settled scan does not measure drawn icon geometry against its owner', () => {
  const findings = scanScreenFindings({
    dump: dumpFrom(CLAMPED_SHEET_XML),
    settled: true,
    elapsedMs: 0,
  });
  assert.deepEqual(
    findings.filter(finding => finding.rule === 'clipped'),
    []
  );
});

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
  let timeoutMs = 0;
  const exited = Promise.withResolvers<number>();
  const abort = installAbortRestore({
    onSignal: (signal, handler) => {
      handlers.set(signal, handler);
      return () => handlers.delete(signal);
    },
    exit: code => exited.resolve(code),
    warn: line => events.push(line),
    clock: {
      now: () => 0,
      sleep: ms => {
        timeoutMs = ms;
        return Promise.withResolvers<void>().promise;
      },
    },
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
  assert.equal(timeoutMs, 180_000);
  abort.dispose();
  assert.equal(handlers.size, 0);
});
