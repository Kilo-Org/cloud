import path from 'node:path';

import {
  expandSamples,
  InfraError,
  openTarget,
  SAMPLE_INTERVAL_MS,
  sampleUntilSettled,
  writeJson,
  type Clock,
  type Device,
  type Exec,
} from './capture';
import type { ProbeClient, ProbeSample } from './cdp';
import type { Finding } from './findings';
import { checkShift, normalize } from './rules';
import { ancestors, type LayoutNode, type ProbeDump } from './tree';

export type FrameMotion = { timeMs: number; yavg: number };

export type MotionSegment = {
  startMs: number;
  endMs: number;
  durationMs: number;
  frames: number;
  peakShare: number;
  abrupt: boolean;
  nativeFrames?: number;
  samplingAmbiguous?: boolean;
};

export const MOTION_FPS = 60;
const FRAME_MS = 1000 / MOTION_FPS;
const MOTION_THRESHOLD = 0.5;
const MAX_GAP_FRAMES = 2;
const ABRUPT_PEAK_SHARE = 0.6;
const TAP_DELAY_MS = 500;
const PRE_TAP_SAMPLE_MS = 300;
const STRIP_FPS = 10;
export const MIN_RELIABLE_FPS = 24;
const MIN_SEGMENT_FRAMES = 3;

export function frameTimesArgs(video: string): string[] {
  return [
    '-v',
    'error',
    '-select_streams',
    'v:0',
    '-show_entries',
    'frame=best_effort_timestamp_time',
    '-of',
    'csv=p=0',
    video,
  ];
}

export function parseFrameTimes(csv: string): number[] {
  const times = csv
    .split('\n')
    .map(line => Number.parseFloat(line.trim().replace(/,$/, '')))
    .filter(Number.isFinite)
    .map(seconds => Math.round(seconds * 1000));
  if (times.length <= 1) {
    throw new InfraError('the screen did not change during the recording; the tap did nothing');
  }
  return times;
}

const round1 = (value: number) => Math.round(value * 10) / 10;

export type FrameRate = { fps: number; clipFps: number; reliable: boolean };

// Screen recorders write a frame only when the screen changes, so the clip-wide rate understates
// smoothness; judge the rate between frames inside motion segments.
export function motionFrameRate(
  times: readonly number[],
  segments: readonly MotionSegment[]
): FrameRate {
  const first = times[0] ?? 0;
  const last = times.at(-1) ?? 0;
  const clipFps = last > first ? round1(((times.length - 1) * 1000) / (last - first)) : 0;
  const intervals: number[] = [];
  let sparseSegment = false;
  for (const segment of segments) {
    const inside = times.filter(
      time => time >= segment.startMs - FRAME_MS && time <= segment.endMs + FRAME_MS
    );
    if (inside.length < MIN_SEGMENT_FRAMES) sparseSegment = true;
    for (let index = 1; index < inside.length; index++) {
      intervals.push((inside[index] ?? 0) - (inside[index - 1] ?? 0));
    }
  }
  if (segments.length === 0) return { fps: clipFps, clipFps, reliable: true };
  intervals.sort((a, b) => a - b);
  const median = intervals[Math.floor(intervals.length / 2)];
  const fps = median === undefined || median <= 0 ? 0 : round1(1000 / median);
  return { fps, clipFps, reliable: !sparseSegment && fps >= MIN_RELIABLE_FPS };
}

export function unreliableNote(fps: number): string {
  return `the recording ran at ${fps} fps; motion cannot be judged on this device; use the iOS simulator or a device`;
}

export function motionEvidence(times: readonly number[], detected: readonly MotionSegment[]) {
  const segments = detected.map(segment => {
    const nativeFrames = times.filter(
      time => time >= segment.startMs - FRAME_MS && time <= segment.endMs + FRAME_MS
    ).length;
    return { ...segment, nativeFrames, samplingAmbiguous: nativeFrames < MIN_SEGMENT_FRAMES };
  });
  const rate = motionFrameRate(times, detected);
  const note = [
    ...(rate.reliable ? [] : [unreliableNote(rate.fps)]),
    ...(segments.some(segment => segment.samplingAmbiguous)
      ? [
          'A segment has fewer than 3 source frames: an instantaneous jump and undersampling cannot be distinguished.',
        ]
      : []),
    'Abrupt segments are frame-difference candidates, not proven visual jank; layout-shift findings are primary evidence.',
  ].join(' ');
  return { ...rate, segments, note };
}

export function motionFilterArgs(video: string): string[] {
  return [
    '-v',
    'error',
    '-i',
    video,
    '-vf',
    `fps=${MOTION_FPS},tblend=all_mode=difference,signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=-`,
    '-f',
    'null',
    '-',
  ];
}

export function frameStripArgs(video: string, output: string, seconds: number): string[] {
  const rows = Math.max(1, Math.ceil((seconds * STRIP_FPS) / 10));
  return [
    '-v',
    'error',
    '-y',
    '-i',
    video,
    '-vf',
    `fps=${STRIP_FPS},scale=180:-2,tile=10x${rows}`,
    '-frames:v',
    '1',
    output,
  ];
}

export function parseSignalstats(output: string): FrameMotion[] {
  const frames: FrameMotion[] = [];
  let timeMs: number | undefined;
  for (const line of output.split('\n')) {
    const time = /pts_time:(-?[\d.]+)/.exec(line);
    if (time?.[1] !== undefined) {
      timeMs = Number(time[1]) * 1000;
      continue;
    }
    const yavg = /lavfi\.signalstats\.YAVG=([\d.]+)/.exec(line);
    if (yavg?.[1] !== undefined && timeMs !== undefined) {
      frames.push({ timeMs: Math.round(timeMs), yavg: Number(yavg[1]) });
      timeMs = undefined;
    }
  }
  return frames;
}

export function motionSegments(frames: readonly FrameMotion[]): MotionSegment[] {
  const segments: MotionSegment[] = [];
  let current: FrameMotion[] = [];
  let gap = 0;
  const flush = () => {
    const first = current[0];
    const last = current.at(-1);
    if (first !== undefined && last !== undefined) {
      const total = current.reduce((sum, frame) => sum + frame.yavg, 0);
      const peak = Math.max(...current.map(frame => frame.yavg));
      const peakShare = Math.round((peak / total) * 1000) / 1000;
      segments.push({
        startMs: first.timeMs,
        endMs: last.timeMs,
        durationMs: Math.round(last.timeMs - first.timeMs + FRAME_MS),
        frames: current.length,
        peakShare,
        abrupt: peakShare > ABRUPT_PEAK_SHARE,
      });
    }
    current = [];
    gap = 0;
  };
  for (const frame of frames) {
    if (frame.yavg > MOTION_THRESHOLD) {
      current.push(frame);
      gap = 0;
    } else if (current.length > 0 && ++gap > MAX_GAP_FRAMES) {
      flush();
    }
  }
  flush();
  return segments;
}

const TAP_MATCH_LIST_LIMIT = 3;

export function findTapTarget(dump: ProbeDump, query: string): LayoutNode {
  const values = (node: LayoutNode) =>
    [node.probe.testID, node.probe.label, node.probe.text].filter(
      (value): value is string => value !== undefined
    );
  const matches = normalize(dump).nodes.filter(node =>
    values(node).some(value => value.includes(query))
  );
  const exact = (node: LayoutNode) => (values(node).includes(query) ? 1 : 0);
  const [best] = matches
    .filter(node => node.pressable || ancestors(node).some(ancestor => ancestor.pressable))
    .sort((a, b) => exact(b) - exact(a));
  if (best !== undefined) return best;
  if (matches.length === 0) {
    throw new InfraError(`No element with testID, label, or text "${query}" on ${dump.env.route}`);
  }
  const paths = matches.slice(0, TAP_MATCH_LIST_LIMIT).map(node => node.path);
  throw new InfraError(`--tap "${query}" matched no pressable element: ${paths.join(', ')}`);
}

export type MotionContext = {
  device: Device;
  probe: ProbeClient;
  clock: Clock;
  exec: Exec;
  out: string;
  log: (line: string) => void;
  registerCleanup?: (cleanup: () => Promise<void>) => () => void;
};

export type MotionResult = {
  link: string;
  target: string;
  tap?: string;
  seconds: number;
  video: string;
  strip: string;
  fps: number;
  clipFps: number;
  reliable: boolean;
  note?: string;
  segments: MotionSegment[];
  findings: Finding[];
};

const PRESS_FAILURES: Record<string, true> = { 'not-found': true, 'not-pressable': true };

async function tapElement(ctx: MotionContext, query: string): Promise<void> {
  if (ctx.device.tap === undefined) {
    const outcome = await ctx.probe.press(query);
    if (PRESS_FAILURES[outcome]) throw new InfraError(`--tap "${query}": ${outcome}`);
    ctx.log(`design-gate: ${outcome}`);
    return;
  }
  const dump = await ctx.probe.dump();
  const node = findTapTarget(dump, query);
  const [x, y, width, height] = node.rect;
  const ratio = dump.env.pixelRatio;
  ctx.device.tap((x + width / 2) * ratio, (y + height / 2) * ratio);
}

export async function runMotion(
  ctx: MotionContext,
  options: { link: string; target: string; tap?: string; seconds: number; observeMs: number }
): Promise<MotionResult> {
  await openTarget(ctx.probe, options.link);
  await sampleUntilSettled(ctx.probe, ctx.clock, options.observeMs);
  const video = path.join(ctx.out, 'motion.mp4');
  const strip = path.join(ctx.out, 'motion-strip.png');
  const recordingMs = options.seconds * 1000;
  const recording = ctx.device.record(video, options.seconds);
  const unregisterCleanup = ctx.registerCleanup?.(async () => {
    await Promise.allSettled([recording.stop(), ctx.probe.stopSampling()]);
  });
  let sampling: { readonly samples: ProbeSample[]; readonly truncated: boolean } | undefined;
  try {
    await ctx.clock.sleep(TAP_DELAY_MS - PRE_TAP_SAMPLE_MS);
    await ctx.probe.startSampling(SAMPLE_INTERVAL_MS, recordingMs);
    await ctx.clock.sleep(PRE_TAP_SAMPLE_MS);
    if (options.tap !== undefined) await tapElement(ctx, options.tap);
    await ctx.clock.sleep(recordingMs - TAP_DELAY_MS);
    sampling = await ctx.probe.stopSampling();
  } finally {
    unregisterCleanup?.();
    await recording.stop();
  }
  if (sampling === undefined) throw new InfraError('Sampling stopped without a layout series');
  const { samples, truncated } = sampling;
  writeJson(path.join(ctx.out, 'motion-timeline.json'), { samples, truncated });
  const timeline = expandSamples(samples);
  const findings = checkShift(timeline.map(normalize), SAMPLE_INTERVAL_MS).map(finding => ({
    ...finding,
    cell: 'motion',
    target: options.target,
  }));
  const detected = motionSegments(
    parseSignalstats(ctx.exec('ffmpeg', motionFilterArgs(video)).toString())
  );
  const times = parseFrameTimes(ctx.exec('ffprobe', frameTimesArgs(video)).toString());
  const { fps, clipFps, reliable, segments, note } = motionEvidence(times, detected);
  ctx.exec('ffmpeg', frameStripArgs(video, strip, options.seconds));
  const result: MotionResult = {
    link: options.link,
    target: options.target,
    tap: options.tap,
    seconds: options.seconds,
    video,
    strip,
    fps,
    clipFps,
    reliable,
    note,
    segments,
    findings,
  };
  writeJson(path.join(ctx.out, 'motion.json'), {
    version: 1,
    platform: ctx.device.platform,
    device: ctx.device.id,
    ...result,
  });
  return result;
}
