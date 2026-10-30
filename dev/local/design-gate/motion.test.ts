import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { InfraError, type Clock, type Device } from './capture';
import type { ProbeClient } from './cdp';
import {
  findTapTarget,
  frameStripArgs,
  frameTimesArgs,
  motionFilterArgs,
  motionFrameRate,
  motionSegments,
  parseFrameTimes,
  parseSignalstats,
  runMotion,
  unreliableNote,
  type FrameMotion,
} from './motion';
import type { ProbeDump } from './tree';

test('parseSignalstats reads per-frame YAVG with pts_time', () => {
  const output = [
    'frame:0    pts:0       pts_time:0',
    'lavfi.signalstats.YAVG=0.000000',
    'frame:1    pts:1       pts_time:0.0166667',
    'lavfi.signalstats.YAVG=12.5',
    '',
  ].join('\n');
  assert.deepEqual(parseSignalstats(output), [
    { timeMs: 0, yavg: 0 },
    { timeMs: 17, yavg: 12.5 },
  ]);
});

const series = (values: number[]): FrameMotion[] =>
  values.map((yavg, index) => ({ timeMs: Math.round((index * 1000) / 60), yavg }));

test('motionSegments flags a single-frame jump as abrupt', () => {
  const [segment, ...rest] = motionSegments(series([0, 0, 20, 0, 0, 0, 0]));
  assert.equal(rest.length, 0);
  assert.deepEqual(segment, {
    startMs: 33,
    endMs: 33,
    durationMs: 17,
    frames: 1,
    peakShare: 1,
    abrupt: true,
  });
});

test('motionSegments keeps a smooth animation as one non-abrupt segment across short gaps', () => {
  const segments = motionSegments(series([0, 2, 3, 4, 0, 0, 4, 3, 2, 0, 0, 0, 0]));
  assert.equal(segments.length, 1);
  assert.equal(segments[0]?.frames, 6);
  assert.equal(segments[0]?.abrupt, false);
  assert.equal(segments[0]?.peakShare, 0.222);
});

test('motionSegments splits after more than two quiet frames and ignores noise', () => {
  const segments = motionSegments(series([3, 0, 0, 0, 3, 0.4, 0.5]));
  assert.deepEqual(
    segments.map(segment => segment.startMs),
    [0, 67]
  );
});

test('ffmpeg argument construction', () => {
  assert.deepEqual(motionFilterArgs('in.mp4'), [
    '-v',
    'error',
    '-i',
    'in.mp4',
    '-vf',
    'fps=60,tblend=all_mode=difference,signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=-',
    '-f',
    'null',
    '-',
  ]);
  assert.equal(frameStripArgs('in.mp4', 'strip.png', 3)[6], 'fps=10,scale=180:-2,tile=10x3');
});

test('frame times come from ffprobe best-effort timestamps', () => {
  assert.deepEqual(frameTimesArgs('in.mp4').slice(-4), [
    'frame=best_effort_timestamp_time',
    '-of',
    'csv=p=0',
    'in.mp4',
  ]);
  assert.deepEqual(parseFrameTimes('0.000000\n0.016667,\nN/A\n0.5\n'), [0, 17, 500]);
  assert.throws(
    () => parseFrameTimes('0.000000\n'),
    /the screen did not change during the recording; the tap did nothing/
  );
  assert.equal(
    unreliableNote(5.1),
    'the recording ran at 5.1 fps; motion cannot be judged on this device; use the iOS simulator or a device'
  );
});

const segment = (startMs: number, endMs: number) => ({
  startMs,
  endMs,
  durationMs: endMs - startMs,
  frames: 1,
  peakShare: 0.2,
  abrupt: false,
});

test('motionFrameRate judges the rate inside motion, not over the static clip', () => {
  const animation = Array.from({ length: 20 }, (_, index) => 1_000 + Math.round(index * 16.67));
  const times = [0, 400, ...animation, 2_900];
  const rate = motionFrameRate(times, [segment(1_000, 1_317)]);
  assert.equal(rate.fps, 58.8);
  assert.equal(rate.clipFps, 7.6);
  assert.equal(rate.reliable, true);
});

test('motionFrameRate is unreliable below 24 fps or with a sparse segment', () => {
  const slow = [0, 1_000, 1_050, 1_100, 1_150, 1_200, 2_000];
  assert.deepEqual(motionFrameRate(slow, [segment(1_000, 1_200)]), {
    fps: 20,
    clipFps: 3,
    reliable: false,
  });
  const sparse = [0, 1_000, 1_017, 2_000];
  assert.equal(motionFrameRate(sparse, [segment(1_000, 1_017)]).reliable, false);
  assert.deepEqual(motionFrameRate([0, 2_000], []), { fps: 0.5, clipFps: 0.5, reliable: true });
});

function motionFixture(options: { press: string; tapAdb: boolean }) {
  let now = 0;
  let tapped = false;
  const events: string[] = [];
  let beforeTap: ProbeDump | undefined;
  const clock: Clock = {
    now: () => now,
    sleep: async ms => {
      now += ms;
    },
  };
  const dump = (): ProbeDump => ({
    version: 1,
    env: {
      platform: 'ios',
      osVersion: '26',
      route: '/chat',
      window: { width: 100, height: 200 },
      pixelRatio: 2,
      fontScale: 1,
      colorScheme: 'light',
      isRTL: false,
      language: 'en',
      languagePreference: 'system',
      safeArea: { top: 0, right: 0, bottom: 0, left: 0 },
      tapTarget: { min: 28, touch: 44 },
    },
    nodes: [
      { parent: -1, tag: 'View', rect: [0, 0, 100, 200] },
      {
        parent: 0,
        tag: 'Paragraph',
        rect: [10, (now >= 1_000 ? 72 : 50) + (tapped ? 30 : 0), 60, 20],
        text: 'Send',
        pressable: true,
      },
    ],
  });
  const probe: ProbeClient = {
    ready: async () => true,
    dump: async () => dump(),
    setLanguage: async () => undefined,
    resolvedLanguage: async () => 'en',
    openLink: async url => {
      events.push(`open ${url}`);
    },
    resetNavigation: async () => undefined,
    lastOutcome: async () => '',
    press: async query => {
      events.push(`press ${query} at ${now}`);
      if (options.press.startsWith('pressed')) tapped = true;
      return options.press;
    },
    startSampling: async () => {
      beforeTap = dump();
    },
    stopSampling: async () =>
      beforeTap === undefined
        ? []
        : [
            { t: 0, repeat: 3, dump: beforeTap },
            { t: 360, repeat: 5, dump: dump() },
          ],
    disconnect: () => undefined,
  };
  const device: Device = {
    platform: options.tapAdb ? 'android' : 'ios',
    id: 'dev',
    names: [],
    apply: () => undefined,
    restore: () => undefined,
    screenshot: () => undefined,
    record: () => ({
      stop: async () => {
        events.push('stop');
      },
    }),
    tap: options.tapAdb
      ? (x, y) => {
          events.push(`adb tap ${x} ${y}`);
          tapped = true;
        }
      : undefined,
  };
  const exec = (command: string) =>
    Buffer.from(command === 'ffprobe' ? '0.000000\n1.900000\n' : '');
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'design-gate-motion-'));
  return { ctx: { device, probe, clock, exec, out, log: () => undefined }, events };
}

test('runMotion presses through the probe on iOS and reports the interaction shift', async () => {
  const { ctx, events } = motionFixture({ press: 'pressed View Send', tapAdb: false });
  const result = await runMotion(ctx, {
    link: 'kiloapp://chat',
    target: 'chat',
    tap: 'Send',
    seconds: 2,
    observeMs: 2_500,
  });
  assert.match(events.find(event => event.startsWith('press')) ?? '', /^press Send at/);
  assert.equal(events.at(-1), 'stop');
  assert.ok(result.findings.some(finding => finding.severity === 'error'));
  assert.ok(
    result.findings.every(finding => finding.cell === 'motion' && finding.target === 'chat')
  );
  assert.equal(result.reliable, true);
  assert.ok(fs.existsSync(path.join(ctx.out, 'motion.json')));
});

test('runMotion taps the element where it is after the observe window', async () => {
  const { ctx, events } = motionFixture({ press: 'unused', tapAdb: true });
  await runMotion(ctx, {
    link: 'kiloapp://chat',
    target: 'chat',
    tap: 'Send',
    seconds: 2,
    observeMs: 2_500,
  });
  assert.ok(events.includes('adb tap 80 164'), events.join('\n'));
});

test('runMotion stops recording and exits as infra failure when press finds nothing', async () => {
  const { ctx, events } = motionFixture({ press: 'not-found', tapAdb: false });
  await assert.rejects(
    runMotion(ctx, {
      link: 'kiloapp://chat',
      target: 'chat',
      tap: 'Nope',
      seconds: 2,
      observeMs: 0,
    }),
    (error: unknown) => error instanceof InfraError && /--tap "Nope": not-found/.test(error.message)
  );
  assert.equal(events.at(-1), 'stop');
});

function tapDump(nodes: ProbeDump['nodes']): ProbeDump {
  return {
    version: 1,
    env: {
      platform: 'android',
      osVersion: '15',
      route: '/reauthorize',
      window: { width: 400, height: 800 },
      pixelRatio: 2,
      fontScale: 1,
      colorScheme: 'light',
      isRTL: false,
      language: 'en',
      languagePreference: 'system',
      safeArea: { top: 0, right: 0, bottom: 0, left: 0 },
      tapTarget: { min: 28, touch: 44 },
    },
    nodes: [{ parent: -1, tag: 'View', rect: [0, 0, 400, 800] }, ...nodes],
  };
}

test('findTapTarget prefers pressable matches, then exact ones', () => {
  const dump = tapDump([
    { parent: 0, tag: 'Paragraph', rect: [20, 100, 300, 20], text: 'Re-authorize GitHub App now' },
    { parent: 0, tag: 'Paragraph', rect: [20, 200, 300, 20], text: 'Re-authorize GitHub App' },
    { parent: 0, tag: 'View', rect: [20, 300, 360, 48], pressable: true, label: 'Continue' },
    {
      parent: 3,
      tag: 'Paragraph',
      rect: [40, 314, 200, 20],
      text: 'Re-authorize GitHub App and more',
    },
    { parent: 0, tag: 'View', rect: [20, 400, 360, 48], pressable: true },
    { parent: 5, tag: 'Paragraph', rect: [40, 414, 200, 20], text: 'Re-authorize GitHub App' },
  ]);
  assert.deepEqual(findTapTarget(dump, 'Re-authorize GitHub App').rect, [40, 414, 200, 20]);
  assert.deepEqual(findTapTarget(dump, 'Continue').rect, [20, 300, 360, 48]);
});

test('findTapTarget lists up to three matched paths when none is pressable', () => {
  const dump = tapDump([
    { parent: 0, tag: 'Paragraph', rect: [20, 100, 300, 20], text: 'Send' },
    { parent: 0, tag: 'Paragraph', rect: [20, 140, 300, 20], text: 'Send' },
    { parent: 0, tag: 'Paragraph', rect: [20, 180, 300, 20], text: 'Send' },
    { parent: 0, tag: 'Paragraph', rect: [20, 220, 300, 20], text: 'Send' },
  ]);
  assert.throws(
    () => findTapTarget(dump, 'Send'),
    (error: unknown) =>
      error instanceof InfraError &&
      /matched no pressable element/.test(error.message) &&
      error.message.split(', ').length === 3
  );
  assert.throws(() => findTapTarget(dump, 'Missing'), /No element with testID, label, or text/);
});
