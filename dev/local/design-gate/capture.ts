import fs from 'node:fs';
import path from 'node:path';

import { paintSignature } from '../../../apps/mobile/src/lib/design-gate/paint-state';
import {
  CAPTURE_ALIGNMENT_BUDGET_MS,
  captureAlignment,
  screenshotObservation,
  type CaptureAlignment,
  type TimedTree,
} from './capture-evidence';
import type { ProbeClient, ProbeSample } from './cdp';
import type { ElementRef, Finding, RuleId } from './findings';
import { enterTouchMode } from './input-mode';
import { checkDevLogOverlay } from './logbox';
import { envMismatches, isRtlLanguage, mirrorReference, type CellConfig } from './matrix';
import type { Rgba } from './pixels';
import { checkMirror, checkScreen, checkShift, normalize } from './rules';
import type { LayoutTree, ProbeDump, ProbeEnv } from './tree';

export type Exec = (command: string, args: readonly string[]) => Buffer;
export type Spawned = { signal: (signal: NodeJS.Signals) => void; exited: Promise<number | null> };
export type Spawn = (command: string, args: readonly string[]) => Spawned;
export type Clock = { now: () => number; sleep: (ms: number) => Promise<void> };
export type Recording = { stop: () => Promise<void> };

export type UiSnapshot = {
  xml: string;
  densityDpi: number;
  fontScale: number;
  colorScheme: string;
  language: string;
  osVersion: string;
};

export type Device = {
  platform: 'android' | 'ios';
  id: string;
  names: readonly string[];
  apply: (config: CellConfig) => void;
  restore: () => void;
  /**
   * Restart the app process and point it back at its Metro: the recovery when
   * the inspector does not survive a runtime reload. The device knows the Metro
   * it was opened against, so the runner never has to supply it again.
   */
  relaunch?: () => void;
  screenshot: (file: string) => void;
  record: (file: string, seconds: number) => Recording;
  tap?: (xPx: number, yPx: number) => void;
  uiSnapshot?: () => UiSnapshot;
};

export class InfraError extends Error {
  override name = 'InfraError';
}

/**
 * `after` is a link opened once the target is captured: the reset of a state
 * the target link forced (`kiloapp:///dev/force-state/clear`), so the next
 * target does not inherit it.
 */
export type Target = Readonly<{ id: string; link: string; after?: string }>;

export type Screen = {
  target: string;
  link: string;
  screenshot: string;
  annotated: string;
  dump: string;
  capture?: string;
  env: ProbeEnv;
};

export type CellRun = { id: string; config: CellConfig; env?: ProbeEnv; screens: Screen[] };
/** A target the probe could not read in a cell: nothing was measured for it. */
export type SkippedTarget = { cell: string; target: string; reason: string };
export type RunOutcome = {
  cells: CellRun[];
  findings: Finding[];
  /**
   * Targets that were not measured. A run with a skip is inconclusive, never a
   * pass: exit 0 must mean every target of every cell was read and graded.
   */
  skipped: SkippedTarget[];
};

export type CaptureContext = {
  device: Device;
  probe: ProbeClient;
  clock: Clock;
  out: string;
  readImage: (png: string) => Rgba;
  observeMs: number;
  log: (line: string) => void;
  registerCleanup?: (cleanup: () => Promise<void>) => () => void;
};

export const SAMPLE_INTERVAL_MS = 120;
// The cadence asked of the app itself, which is a different cost: one in-app
// sample walks and serializes the whole document, measured at ~150 ms on a
// mid-size screen. Asking for the runner's 120 ms leaves the JS thread with no
// room to finish the screen it is measuring, and the gate then reports a target
// that never leaves its loading placeholder on a build whose own timeline does.
// The runner's own poll interval is unaffected: a CDP round trip costs more than
// this anyway.
export const IN_APP_SAMPLE_INTERVAL_MS = 250;
export const DEFAULT_OBSERVE_MS = 2_500;
const STABLE_SAMPLES = 3;
const SETTLE_TIMEOUT_MS = 8_000;
const APP_WAIT_MS = 30_000;
const APP_POLL_MS = 500;
const CONFIG_SETTLE_MS = 750;
const RELOAD_QUIET_MS = 1_000;
const RELOAD_QUIET_TIMEOUT_MS = 10_000;
const IN_APP_SAMPLING_SLACK_MS = 10_000;
// A screen that paints its loading placeholder gets this long to replace it
// with content before the sample is reported as unsettled.
const LOADING_SETTLE_TIMEOUT_MS = 30_000;
// The deep link must land before its placeholder can be judged. A link that
// never lands is the navigation retry's business, not the loading wait's, so the
// wait releases itself instead of spending the whole settle budget on it.
const LOADING_ARRIVAL_TIMEOUT_MS = 10_000;
// The iOS dev client re-downloads the bundle through the SSH tunnel after a reload.
const RELOAD_WAIT_MS = 150_000;
// Sampling stops before the screenshot, and the screen does not: a navigation
// push or a late render lands after the last sample. Reading the bracket while
// that work is still arriving reads two different screens around one screenshot
// and reports no alignment for a capture that is otherwise fine, so the bracket
// opens only once the layout has held still for this window.
const SCREEN_QUIET_MS = 1_500;
const SCREEN_QUIET_TIMEOUT_MS = 15_000;
const RTL_LANGUAGE = 'ar';
const LTR_FALLBACK_LANGUAGE = 'en';

export type Sampled = {
  dump: ProbeDump;
  timeline: ProbeDump[];
  /** Consecutive probe states agree; this does not establish native paint. */
  settled: boolean;
  elapsedMs: number;
  /** Set when the measured screen still paints a loading placeholder. */
  blockedBy?: 'loading-placeholder';
  /** Milliseconds this capture spent waiting for the placeholder to clear. */
  loadingWaitMs?: number;
  /**
   * Milliseconds between the retained samples, read from their own timestamps.
   * The shift rule converts sample distance with it, because the app's cadence is
   * the interval it was asked for plus the dump it runs between ticks.
   */
  intervalMs?: number;
  alignment?: CaptureAlignment;
};

/**
 * The placeholders a screen paints while its own content is still loading.
 *
 * A loading layout holds still, so a settle loop that only compares two dumps
 * accepts it and the capture measures the skeleton instead of the screen. The
 * app marks these nodes with a `-skeleton` test ID or a `Skeleton` owner, so a
 * settled sample must contain none of them.
 */
const LOADING_TEST_ID = /(?:^|-)skeleton$/u;
const LOADING_OWNERS: Readonly<Record<string, true>> = {
  SessionComposerSkeleton: true,
  SessionListSkeletonRows: true,
  SessionReadOnlyFooterPlaceholder: true,
  SessionRowSkeleton: true,
  SessionSectionHeaderSkeleton: true,
  SessionSkeletonMessages: true,
  Skeleton: true,
};

export function loadingPlaceholder(tree: LayoutTree): boolean {
  return tree.nodes.some(node => {
    if (node.probe.testID !== undefined && LOADING_TEST_ID.test(node.probe.testID)) return true;
    return (node.probe.owners ?? []).some(owner => LOADING_OWNERS[owner] === true);
  });
}

/**
 * The cadence to ask the in-app sampler for, given what one of its dumps costs.
 *
 * The dump walks and serializes the whole document on the app's own JS thread, so
 * an interval shorter than the dump it schedules starves the screen it measures:
 * the app spends every slice producing samples and the work the screen still owes
 * (a late navigation, late data) cannot run, so it lands after sampling stops. The
 * capture bracket then reads two different screens and concludes nothing. Twice
 * the measured cost leaves the app a slice between dumps; the floor is the default
 * cadence, never something shorter.
 */
export function inAppSampleInterval(dumpMs: number): number {
  return Math.max(IN_APP_SAMPLE_INTERVAL_MS, Math.ceil(dumpMs * 2));
}

/**
 * The window one capture may span, given what one of its dumps costs.
 *
 * The bracket reads two full trees around the screenshot, so on a screen whose
 * dump costs half a second the reads alone exceed the default window and a
 * perfectly aligned capture is reported inconclusive. The window grows with the
 * measurement and never shrinks below the constant: a cheap screen keeps it.
 */
export function captureBudgetMs(dumpMs: number): number {
  return Math.max(CAPTURE_ALIGNMENT_BUDGET_MS, Math.ceil(dumpMs * 2) + 1_000);
}

/** One sampling window, sized for the settle it spans. */
function startSampling(
  ctx: { probe: Pick<ProbeClient, 'startSampling'>; observeMs: number },
  intervalMs = IN_APP_SAMPLE_INTERVAL_MS
) {
  return ctx.probe.startSampling(
    intervalMs,
    ctx.observeMs + IN_APP_SAMPLING_SLACK_MS + 2 * LOADING_SETTLE_TIMEOUT_MS
  );
}

export async function sampleUntilSettled(
  probe: Pick<ProbeClient, 'dump'>,
  clock: Clock,
  observeMs = 0
): Promise<Sampled> {
  const started = clock.now();
  const timeline: ProbeDump[] = [];
  let previous: string | undefined;
  let stable = 0;
  for (;;) {
    const dump = await probe.dump();
    timeline.push(dump);
    const layout = layoutSignature(dump);
    stable = layout === previous ? stable + 1 : 1;
    previous = layout;
    const elapsedMs = clock.now() - started;
    if (elapsedMs >= observeMs && stable >= STABLE_SAMPLES) {
      return { dump, timeline, settled: true, elapsedMs };
    }
    if (elapsedMs >= observeMs + SETTLE_TIMEOUT_MS) {
      return { dump, timeline, settled: false, elapsedMs };
    }
    await clock.sleep(SAMPLE_INTERVAL_MS);
  }
}

/**
 * The result of waiting for a target's loading placeholder.
 *
 * `observed` is true only when the target itself painted a placeholder, so a
 * caller never reports one it did not see.
 */
export type LoadingWait = { cleared: boolean; observed: boolean; elapsedMs: number };

/**
 * Wait for a screen that is painting its own loading placeholder to finish.
 *
 * Only the screen the link opened is judged: the wait starts once `arrived`
 * reports one of the dumps. The wait is bounded, so a placeholder that outlives
 * it is reported as unsettled rather than measured as the screen. A link that
 * never lands releases the wait at the arrival bound.
 */
export async function waitForLoadingPlaceholder(
  probe: Pick<ProbeClient, 'dump'>,
  clock: Clock,
  arrived: (dump: ProbeDump) => boolean = () => true,
  timeoutMs = LOADING_SETTLE_TIMEOUT_MS,
  arrivalMs = LOADING_ARRIVAL_TIMEOUT_MS
): Promise<LoadingWait> {
  const started = clock.now();
  let onTarget = false;
  let observed = false;
  for (;;) {
    const dump = await probe.dump();
    onTarget ||= arrived(dump);
    const elapsedMs = clock.now() - started;
    if (!onTarget) {
      if (elapsedMs >= arrivalMs) return { cleared: false, observed, elapsedMs };
    } else if (!loadingPlaceholder(normalize(dump))) {
      return { cleared: true, observed, elapsedMs };
    } else {
      observed = true;
      if (elapsedMs >= timeoutMs) return { cleared: false, observed, elapsedMs };
    }
    await clock.sleep(SAMPLE_INTERVAL_MS);
  }
}

export async function waitForApp(
  probe: ProbeClient,
  clock: Clock,
  accept: (dump: ProbeDump) => boolean = () => true,
  timeoutMs = APP_WAIT_MS
): Promise<ProbeDump> {
  const deadline = clock.now() + timeoutMs;
  let last: ProbeDump | undefined;
  let lastError: unknown;
  let logBoxDisabled = false;
  for (;;) {
    try {
      // A probe that has just lost its page waits for it; this wait's own
      // budget caps that, so an absent app still fails within the declared time.
      if (await probe.ready(Math.max(0, deadline - clock.now()))) {
        // Every readiness wait is a fresh app runtime after a reload and the same
        // runtime after a cell's Activity recreation. Disabling LogBox's UI is
        // idempotent per runtime, so doing it here covers both without the caller
        // tracking reloads. A runtime that cannot disable it leaves the app
        // running; the raw dump still reports any toast that then paints. The
        // wait's own budget caps this probe call too, so a target that stops
        // answering still fails within the declared time.
        const disable = probe.disableLogBox;
        if (!logBoxDisabled && disable !== undefined) {
          try {
            await disable(Math.max(0, deadline - clock.now()));
            logBoxDisabled = true;
          } catch {
            // Retried on the next pass, inside this wait's own budget.
          }
        }
        last = await probe.dump(Math.max(0, deadline - clock.now()));
        if (accept(last)) return last;
      }
    } catch (error) {
      lastError = error;
      probe.disconnect();
    }
    if (clock.now() >= deadline) break;
    await clock.sleep(APP_POLL_MS);
  }
  if (last !== undefined) return last;
  if (lastError instanceof InfraError) throw lastError;
  const reason = lastError === undefined ? 'ready() stayed false' : String(lastError);
  throw new InfraError(`Design gate probe not ready within ${timeoutMs} ms: ${reason}`);
}

/**
 * States in the run log what the readiness waits did to the dev overlay: the
 * gate disables LogBox's UI so no toast or inspector paints over a capture, and
 * a run whose runtime offered no such module says so here instead of leaving a
 * clean matrix unexplained.
 */
async function reportLogBox(probe: ProbeClient, log: (line: string) => void): Promise<void> {
  try {
    const result = await probe.disableLogBox?.();
    if (result === undefined) return;
    if (result.disabled > 0) {
      log(
        `design-gate: disabled the LogBox UI in the app runtime (${result.disabled} of ${result.exposing} module(s) exposing setDisabled)`
      );
      return;
    }
    if (result.exposing === 0) {
      log(
        'design-gate: no module of the app runtime exposed LogBox setDisabled; a dev toast still painting is reported as a dev-overlay warning'
      );
      return;
    }
    log(
      `design-gate: ${result.exposing} module(s) exposed LogBox setDisabled but none accepted the switch; a dev toast still painting is reported as a dev-overlay warning`
    );
  } catch (error) {
    log(`design-gate: LogBox disable unavailable: ${String(error)}`);
  }
}

export function rootRef(dump: ProbeDump): ElementRef {
  const root = dump.nodes[0];
  return {
    index: 0,
    path: root?.tag ?? 'root',
    tag: root?.tag ?? 'root',
    rect: root?.rect ?? [0, 0, dump.env.window.width, dump.env.window.height],
  };
}

export function screenFindings(args: {
  cell: string;
  target: string;
  dump: ProbeDump;
  tree: LayoutTree;
  image?: Rgba;
  sampled?: Sampled;
}): Finding[] {
  const alignment = args.sampled?.alignment;
  const image =
    alignment === undefined || alignment.status === 'bracketed' ? args.image : undefined;
  const findings: Finding[] = [];
  if (args.sampled?.settled !== false) findings.push(...checkScreen(args.tree, image));
  findings.push(...checkDevLogOverlay(args.dump));
  if (alignment !== undefined && alignment.status !== 'bracketed') {
    findings.push({
      rule: 'capture-alignment',
      severity: 'warning',
      cell: args.cell,
      target: args.target,
      element: rootRef(args.dump),
      measured: alignment.after.completedMs - alignment.before.startedMs,
      expected: `matching probe states bracketing a screenshot within ${alignment.budgetMs} ms`,
      unit: 'ms',
      message: `${alignment.reason} The screenshot is preserved; pixel-to-tree rules were skipped.`,
    });
  }
  if (alignment?.pixels === 'uniform' && alignment.expectedText) {
    findings.push({
      rule: 'blank-frame',
      severity: 'warning',
      cell: args.cell,
      target: args.target,
      element: rootRef(args.dump),
      measured: 0,
      expected: 'inspect the preserved screenshot for the intended screen content',
      unit: 'ratio',
      message:
        'The captured content viewport is a uniform color while the probe contains visible text. ' +
        'This is a possible blank frame, not proof of a product defect or successful paint; ' +
        'the original screenshot was retained without retrying it away.',
    });
  }
  if (args.sampled !== undefined) {
    findings.push(
      ...checkShift(
        args.sampled.timeline.map(normalize),
        args.sampled.intervalMs ?? IN_APP_SAMPLE_INTERVAL_MS
      )
    );
    if (!args.sampled.settled) {
      findings.push(
        unsettledFinding({
          cell: args.cell,
          target: args.target,
          dump: args.dump,
          // A placeholder it waited on is reported by the wait that ran, not by
          // the settle loop that only saw the screen hold still.
          elapsedMs:
            args.sampled.blockedBy === 'loading-placeholder'
              ? (args.sampled.loadingWaitMs ?? args.sampled.elapsedMs)
              : args.sampled.elapsedMs,
          blockedBy: args.sampled.blockedBy,
        })
      );
    }
  }
  return findings.map(finding => ({ ...finding, cell: args.cell, target: args.target }));
}

function envMismatchFinding(
  cell: string,
  target: string,
  dump: ProbeDump,
  mismatches: string[]
): Finding {
  return {
    rule: 'env-mismatch',
    severity: 'error',
    cell,
    target,
    element: rootRef(dump),
    measured: mismatches.length,
    expected: 'probe env matches the cell config',
    unit: 'ratio',
    message: `Cell config did not apply (${mismatches.join('; ')}); layout rules were skipped for this screen.`,
  };
}

export function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

export function captureFiles(out: string, cell: string, target: string) {
  const base = path.join('cells', cell, target);
  return {
    screenshot: `${base}.png`,
    annotated: `${base}.annotated.png`,
    dump: `${base}.json`,
    timeline: `${base}.timeline.json`,
    capture: `${base}.capture.json`,
    absolute: (relative: string) => path.join(out, relative),
  };
}

/** Visible text reported by the probe, not evidence that those glyphs reached the glass. */
export function screenTexts(dump: ProbeDump): string {
  return normalize(dump)
    .nodes.flatMap(node => (node.probe.text === undefined ? [] : [node.probe.text]))
    .sort()
    .join('\n');
}

export function screenIdentity(dump: ProbeDump): string {
  return [dump.env.route, dump.env.screen ?? '', screenTexts(dump)].join('\n');
}

export async function waitForStableLayout(
  probe: Pick<ProbeClient, 'dump'>,
  clock: Clock,
  quietMs = RELOAD_QUIET_MS,
  timeoutMs = RELOAD_QUIET_TIMEOUT_MS
): Promise<boolean> {
  const started = clock.now();
  let previous: string | undefined;
  let changedAt = started;
  for (;;) {
    const layout = layoutSignature(await probe.dump());
    const now = clock.now();
    if (layout !== previous) {
      previous = layout;
      changedAt = now;
    } else if (now - changedAt >= quietMs) {
      return true;
    }
    if (now - started >= timeoutMs) return false;
    await clock.sleep(SAMPLE_INTERVAL_MS);
  }
}

export async function openTarget(probe: ProbeClient, link: string): Promise<void> {
  await probe.resetNavigation();
  await probe.openLink(link);
}

export function linkPath(link: string): string | undefined {
  try {
    const url = new URL(link);
    const joined = `/${url.host}${url.pathname}`.replace(/\/{2,}/g, '/');
    return joined.length > 1 ? joined.replace(/\/$/, '') : joined;
  } catch {
    return undefined;
  }
}

async function captureScreen(ctx: CaptureContext, cell: string, target: Target, warm: boolean) {
  const linkRoute = linkPath(target.link);
  // A language switch reloads the runtime. Right after it the target screen is
  // cold: its own loading state can be the first stable layout, so the measured
  // capture would show skeletons rather than the screen the link opens. Open the
  // target once, let it settle, and measure the second, warm open instead.
  if (warm) {
    ctx.log(`design-gate: warming ${target.id} after the language reload`);
    await ctx.probe.openLink(target.link);
    let warmRoute = (await sampleUntilSettled(ctx.probe, ctx.clock, ctx.observeMs)).dump.env.route;
    // The first link after a reload is the one that gets dropped. Re-send it on
    // that evidence, never on a fixed retry count.
    if (linkRoute !== undefined && warmRoute.split('?')[0] !== linkRoute) {
      ctx.log(`design-gate: warm link for ${target.id} did not land; sending it again`);
      await ctx.probe.openLink(target.link);
      warmRoute = (await sampleUntilSettled(ctx.probe, ctx.clock, ctx.observeMs)).dump.env.route;
    }
  }
  await ctx.probe.resetNavigation();
  const beforeDump = (await sampleUntilSettled(ctx.probe, ctx.clock)).dump;
  // A device left in key mode by an earlier `adb shell input keyevent` paints
  // Android's keyboard focus highlight over the first control of every screen it
  // opens, which reads as a stuck pressed state in a screenshot. The tap lands on
  // a point no control claims, so it only returns the device to touch mode.
  enterTouchMode(ctx, beforeDump);
  const beforeTexts = screenTexts(beforeDump);
  const beforeRoute = beforeDump.env.route.split('?')[0];
  const beforeScreen = beforeDump.env.screen;
  // Route and probe text can reveal stale navigation, but neither proves native paint.
  // Keep this bounded navigation retry separate from screenshot capture: a genuine
  // blank screenshot must survive as evidence rather than be retried until it disappears.
  const opened = (dump: ProbeDump) =>
    screenTexts(dump) !== beforeTexts ||
    (dump.env.screen !== undefined && dump.env.screen !== beforeScreen) ||
    (beforeRoute === linkRoute && dump.env.route.split('?')[0] === linkRoute);
  await ctx.probe.openLink(target.link);
  // A cold screen paints its own loading placeholder and holds it still, so a
  // settle loop would measure the placeholder. Wait for it to clear first, and
  // never claim a placeholder the target did not paint.
  let placeholderWaitedMs = 0;
  const waitForPlaceholder = async (): Promise<void> => {
    const wait = await waitForLoadingPlaceholder(ctx.probe, ctx.clock, opened);
    placeholderWaitedMs += wait.elapsedMs;
    if (!wait.cleared && wait.observed) {
      ctx.log(
        `design-gate: ${target.id} still paints its loading placeholder after ${wait.elapsedMs}ms`
      );
    }
  };
  await waitForPlaceholder();
  // Sampling starts only once the placeholder is gone. The in-app sampler
  // traverses and serializes the whole tree on the app's own JS thread every
  // interval, so a sampler ticking through a cold open competes with the very
  // work that open is doing: on a headless emulator a screen that settles in
  // about ten seconds unsampled never mounted at all, and the run recorded
  // placeholder frames for the whole budget. Those frames are not the screen
  // either way — the settle below is what the rules read.
  // The cadence is asked of this screen rather than assumed: one dump is measured
  // on the probe that will sample, and an interval shorter than that cost is what
  // starves the thread and lets pending work escape the sampling window.
  const measuredFrom = ctx.clock.now();
  await ctx.probe.dump();
  const dumpMs = ctx.clock.now() - measuredFrom;
  const samplingMs = inAppSampleInterval(dumpMs);
  if (samplingMs > IN_APP_SAMPLE_INTERVAL_MS) {
    ctx.log(
      `design-gate: ${target.id} one in-app dump costs ${dumpMs}ms; sampling every ${samplingMs}ms`
    );
  }
  // The bracket reads two full trees around the screenshot, so on a screen whose
  // dump is expensive those reads alone outlast the default window and a correct
  // bracket is reported inconclusive. The window follows the same measurement; a
  // cheap screen keeps the constant.
  const alignmentBudgetMs = captureBudgetMs(dumpMs);
  if (alignmentBudgetMs > CAPTURE_ALIGNMENT_BUDGET_MS) {
    ctx.log(
      `design-gate: ${target.id} one dump costs ${dumpMs}ms; alignment window ${alignmentBudgetMs}ms`
    );
  }
  await startSampling(ctx, samplingMs);
  let settled = await sampleUntilSettled(ctx.probe, ctx.clock, ctx.observeMs);
  let unopened: string | undefined;
  if (!opened(settled.dump)) {
    ctx.log(`design-gate: ${target.id} did not change the screen; opening the link again`);
    // The retry opens the same cold screen, so it gets the same wait, and the
    // timeline is restarted after it for the same reason as above.
    await ctx.probe.stopSampling();
    await ctx.probe.openLink(target.link);
    await waitForPlaceholder();
    await startSampling(ctx, samplingMs);
    settled = await sampleUntilSettled(ctx.probe, ctx.clock, ctx.observeMs);
    if (!opened(settled.dump)) unopened = await ctx.probe.lastOutcome();
  }
  let { samples, truncated } = await ctx.probe.stopSampling();
  const reportTruncation = () => {
    if (truncated) {
      ctx.log(
        `design-gate: ${target.id} retained only the newest layouts; older samples were dropped`
      );
    }
  };
  // The samples report the cadence they were produced at, which the app's own
  // tick cost extends beyond the interval it was asked for. Say so when that
  // spacing is far enough from the constant that the shift timings would move.
  // A pass with fewer than two retained samples carries no delta to read, so the
  // caller keeps the spacing it already had.
  const reportSpacing = (sampled: readonly ProbeSample[]): number | undefined => {
    if (sampled.length < 2) return undefined;
    const spacing = sampleInterval(sampled);
    if (Math.abs(spacing - IN_APP_SAMPLE_INTERVAL_MS) > IN_APP_SAMPLE_INTERVAL_MS * 0.25) {
      ctx.log(
        `design-gate: ${target.id} samples are ${Math.round(spacing)}ms apart; the shift rule reads that spacing`
      );
    }
    return spacing;
  };
  reportTruncation();
  let spacingMs = reportSpacing(samples) ?? IN_APP_SAMPLE_INTERVAL_MS;
  const files = captureFiles(ctx.out, cell, target.id);
  // Sampling stops before the screenshot, and the screen does not: a navigation
  // push or a late render arrives after the last sample. The bracket compares two
  // dumps around one screenshot, so it opens only once the layout has held still
  // for the quiet window; reading it while that work is still landing makes a
  // correct capture look like two different screens. A screen that never holds
  // still keeps its mismatch instead of becoming a pass.
  const waitForQuiet = async (): Promise<boolean> => {
    const held = await waitForStableLayout(
      ctx.probe,
      ctx.clock,
      SCREEN_QUIET_MS,
      SCREEN_QUIET_TIMEOUT_MS
    );
    if (!held) ctx.log(`design-gate: ${target.id} screen still changing before the screenshot`);
    return held;
  };
  let started = ctx.clock.now();
  const readTree = async (): Promise<TimedTree> => {
    const startedMs = ctx.clock.now() - started;
    try {
      const dump = await ctx.probe.dump();
      return { startedMs, completedMs: ctx.clock.now() - started, dump };
    } catch (error) {
      return { startedMs, completedMs: ctx.clock.now() - started, error: String(error) };
    }
  };
  let quiet = await waitForQuiet();
  let before = await readTree();
  let dump = before.dump ?? settled.dump;
  if (before.dump !== undefined && layoutSignature(before.dump) !== layoutSignature(settled.dump)) {
    // A layout the sampled window never saw is real work, and the bracket must not
    // absorb it: silent acceptance would hide a late layout shift exactly on the
    // slow screens this wait exists for. One more pass samples the screen as it now
    // is, and both passes join one timeline, so the shift rule reports the late
    // change instead of reading the late layout as the rest state. A bound of one
    // retry keeps a screen that keeps moving from extending the run.
    const firstPass = samples;
    const firstPassTruncated = truncated;
    ctx.log(`design-gate: ${target.id} late change after sampling stopped; bracket waited for it`);
    ctx.log(`design-gate: ${target.id} sampling once more; the late change stays in the timeline`);
    await startSampling(ctx, samplingMs);
    settled = await sampleUntilSettled(ctx.probe, ctx.clock, ctx.observeMs);
    const retry = await ctx.probe.stopSampling();
    // The stretch between the two passes is not a cadence, so the spacing comes
    // from one pass only: the first pass sizes the gap, and the retry pass, when it
    // reports one, becomes the spacing the shift rule reads.
    samples = joinPasses(firstPass, retry.samples, spacingMs);
    truncated = firstPassTruncated || retry.truncated;
    reportTruncation();
    spacingMs = reportSpacing(retry.samples) ?? spacingMs;
    quiet = await waitForQuiet();
    started = ctx.clock.now();
    before = await readTree();
    dump = before.dump ?? settled.dump;
  }
  writeJson(files.absolute(files.timeline), { samples, truncated });
  // Preserve collected tree evidence even if the native screenshot or its decode fails.
  writeJson(files.absolute(files.dump), dump);
  const screenshot = { startedMs: ctx.clock.now() - started, completedMs: 0 };
  ctx.device.screenshot(files.absolute(files.screenshot));
  screenshot.completedMs = ctx.clock.now() - started;
  const after = await readTree();
  const image = ctx.readImage(files.absolute(files.screenshot));
  const alignment = captureAlignment(
    before,
    screenshot,
    after,
    layoutSignature,
    screenshotObservation(dump, image),
    alignmentBudgetMs
  );
  const stillLoading = loadingPlaceholder(normalize(dump));
  const sampled: Sampled = {
    ...settled,
    dump,
    timeline: expandSamples(samples),
    intervalMs: spacingMs,
    alignment,
    // A screen that still paints its loading placeholder is never the settled
    // screen the target describes. The settle loop only saw the sampled window, so
    // work that landed after it counts as settled only when the quiet wait above
    // proved the layout held still before the bracket opened.
    settled: settled.settled && !stillLoading && quiet,
    ...(stillLoading ? { blockedBy: 'loading-placeholder' as const } : {}),
    ...(placeholderWaitedMs > 0 ? { loadingWaitMs: placeholderWaitedMs } : {}),
  };
  writeJson(files.absolute(files.capture), alignment);
  const screen: Screen = {
    target: target.id,
    link: target.link,
    screenshot: files.screenshot,
    annotated: files.annotated,
    dump: files.dump,
    capture: files.capture,
    env: sampled.dump.env,
  };
  return { sampled, screen, unopened, image };
}

export function expandSamples(samples: readonly ProbeSample[]): ProbeDump[] {
  return samples.flatMap(sample => Array.from({ length: sample.repeat }, () => sample.dump));
}

/**
 * The spacing the retained samples report, read from their own timestamps.
 *
 * The app samples itself on its own JS thread, so the distance between two
 * samples is the interval it was asked for plus the cost of the dump between
 * ticks, and both vary with the screen. Identical consecutive states collapse
 * into one sample, which keeps the stamp of its first tick, so two retained
 * stamps are a whole number of spacings apart, never one spacing. The spacing is
 * therefore the span the samples cover divided by the ticks that span it: every
 * sample but the last one adds its repeats, because the last sample's repeats
 * happen after its own stamp. A shift converts sample distance into milliseconds
 * with the spacing that produced those samples, never with a constant: a change
 * that arrives two samples after the rest says how long the screen took, and the
 * constant is only the answer when no sample carries a spacing of its own.
 */
export function sampleInterval(samples: readonly ProbeSample[]): number {
  if (samples.length < 2) return IN_APP_SAMPLE_INTERVAL_MS;
  const ordered = [...samples].sort((left, right) => left.t - right.t);
  const first = ordered[0];
  const last = ordered[ordered.length - 1];
  if (first === undefined || last === undefined) return IN_APP_SAMPLE_INTERVAL_MS;
  const span = last.t - first.t;
  let ticks = 0;
  for (const sample of ordered.slice(0, -1)) ticks += sample.repeat;
  if (span <= 0 || ticks === 0) return IN_APP_SAMPLE_INTERVAL_MS;
  return span / ticks;
}

// A second sampling pass starts after a stretch no pass sampled. The bracket saw
// no layout change across that stretch, so the stretch counts as repeats of the
// last state of the first pass, and both passes stay one timeline. The cap bounds
// a long quiet wait, and a repeat stores only the reference to the same dump.
const MAX_GAP_REPEATS = 64;

/**
 * Join two sampling passes into one timeline.
 *
 * The unsampled stretch between the passes is counted as repeats of the last
 * state of the first pass, at the spacing that pass reported. The join keeps the
 * late layout change in the timeline the shift rule reads, instead of letting a
 * fresh pass become the baseline. A pass that retained nothing falls back to the
 * concatenation.
 */
export function joinPasses(
  first: readonly ProbeSample[],
  second: readonly ProbeSample[],
  spacingMs: number
): ProbeSample[] {
  const last = first[first.length - 1];
  const start = second[0];
  if (last === undefined || start === undefined) return [...first, ...second];
  // `last.t` stamps the first tick of the collapsed tail, and `last.repeat` counts
  // every tick that tail already covers, so only the ticks the tail does not
  // account for are added.
  const gap = start.t - last.t;
  const ticks = spacingMs > 0 ? Math.round(gap / spacingMs) - last.repeat : 0;
  const repeats = Math.min(MAX_GAP_REPEATS, Math.max(0, ticks));
  return [
    ...first.slice(0, -1),
    { t: last.t, repeat: last.repeat + repeats, dump: last.dump },
    ...second,
  ];
}

type LanguageTarget = { preference: string; resolved: string; rtl?: boolean };

const languageMatches = (dump: ProbeDump, want: LanguageTarget) =>
  dump.env.language === want.resolved && (want.rtl === undefined || dump.env.isRTL === want.rtl);

type LanguageOutcome = { matched: boolean; reloaded: boolean };

async function ensureLanguage(ctx: CaptureContext, want: LanguageTarget): Promise<LanguageOutcome> {
  if (languageMatches(await waitForApp(ctx.probe, ctx.clock), want)) {
    return { matched: true, reloaded: false };
  }
  try {
    ctx.log(`design-gate: language → ${want.preference} (${want.resolved})`);
    await ctx.probe.setLanguage(want.preference, want.resolved);
  } catch (error) {
    ctx.log(`design-gate: setLanguage did not answer (${String(error)}); waiting for reload`);
  }
  ctx.probe.disconnect();
  // The reload takes the app away for a few seconds, and it ends two ways
  // without the new language: the old target answers and still reports the old
  // one, or nothing answers at all because the inspector went with the reload
  // and the page list is empty. Both are the same outage, and both are what the
  // relaunch recovers, so a timed-out wait falls through to it.
  let unreachable: InfraError | undefined;
  let dump: ProbeDump | undefined;
  try {
    dump = await waitForApp(
      ctx.probe,
      ctx.clock,
      current => languageMatches(current, want),
      RELOAD_WAIT_MS
    );
  } catch (error) {
    if (!(error instanceof InfraError)) throw error;
    unreachable = error;
    ctx.log(`design-gate: the reloaded app did not answer (${String(error)})`);
  }
  let settledDump = dump;
  if (settledDump === undefined || !languageMatches(settledDump, want)) {
    // The inspector does not survive the reload on every emulator: the app keeps
    // painting while the page list stays empty until the process restarts.
    // Restart the app — the recovery the app itself supports — and wait again.
    if (ctx.device.relaunch === undefined) {
      if (unreachable !== undefined) throw unreachable;
    } else {
      ctx.log(`design-gate: relaunching the app to get its inspector back`);
      ctx.probe.disconnect();
      // A device that cannot start the app leaves the cell unmeasured, not the
      // whole run failed: adb reports it as a plain error, so it is raised as an
      // InfraError that the cell records as a skip.
      try {
        ctx.device.relaunch();
      } catch (error) {
        throw error instanceof InfraError
          ? error
          : new InfraError(`Relaunch failed: ${String(error)}`);
      }
      settledDump = await waitForApp(
        ctx.probe,
        ctx.clock,
        current => languageMatches(current, want),
        APP_WAIT_MS
      );
    }
  }
  await waitForStableLayout(ctx.probe, ctx.clock);
  return {
    matched: settledDump !== undefined && languageMatches(settledDump, want),
    reloaded: true,
  };
}

export function layoutSignature(dump: ProbeDump): string {
  return paintSignature(dump);
}

/**
 * The screen was still moving while it was read, so its frames describe more than one
 * layout and every rule that measures a rect against another rect is meaningless. One
 * warning replaces those findings; the run is not a pass, and it is not a defect either.
 */
export function unsettledFinding(args: {
  cell: string;
  target: string;
  dump: ProbeDump;
  elapsedMs: number;
  blockedBy?: Sampled['blockedBy'];
}): Finding {
  if (args.blockedBy === 'loading-placeholder') {
    return {
      rule: 'unsettled',
      severity: 'warning',
      cell: args.cell,
      target: args.target,
      element: rootRef(args.dump),
      measured: args.elapsedMs,
      expected: 'the screen content after its loading placeholder',
      unit: 'ms',
      message:
        `The screen still paints its loading placeholder after ${args.elapsedMs} ms, so it is not ` +
        'settled; layout rules were skipped for this screen.',
    };
  }
  return {
    rule: 'unsettled',
    severity: 'warning',
    cell: args.cell,
    target: args.target,
    element: rootRef(args.dump),
    measured: args.elapsedMs,
    expected: 'the same layout on consecutive reads',
    unit: 'ms',
    message:
      `The screen kept changing for ${args.elapsedMs} ms and its frames describe more than one ` +
      'layout; layout rules were skipped for this screen.',
  };
}

function warningFinding(
  cell: string,
  target: string,
  dump: ProbeDump,
  expected: string,
  message: string,
  rule: RuleId = 'env-mismatch'
): Finding {
  return {
    rule,
    severity: 'warning',
    cell,
    target,
    element: rootRef(dump),
    measured: 1,
    expected,
    unit: 'ratio',
    message,
  };
}

export async function runMatrix(
  ctx: CaptureContext,
  cells: readonly CellConfig[],
  targets: readonly Target[],
  beforeRestore: (outcome: RunOutcome) => void = () => undefined
): Promise<RunOutcome & { restoreError?: string }> {
  const initial = await waitForApp(ctx.probe, ctx.clock);
  const baseline: LanguageTarget = {
    preference: initial.env.languagePreference,
    resolved: await ctx.probe.resolvedLanguage(),
  };
  const ltrLanguage: LanguageTarget = isRtlLanguage(baseline.resolved)
    ? { preference: LTR_FALLBACK_LANGUAGE, resolved: LTR_FALLBACK_LANGUAGE, rtl: false }
    : baseline;
  const outcome: RunOutcome = { cells: [], findings: [], skipped: [] };
  const trees = new Map<string, LayoutTree>();
  let baseWindow: ProbeEnv['window'] | undefined;
  let restored: Promise<unknown[]> | undefined;
  const restoreState = (): Promise<unknown[]> => {
    restored ??= (async () => {
      const errors: unknown[] = [];
      try {
        ctx.device.restore();
      } catch (error) {
        errors.push(error);
      }
      try {
        await ensureLanguage(ctx, baseline);
      } catch (error) {
        // A reload window that outlives the probe client's retry leaves the
        // language unverified on the device. That is probe availability, not
        // a device state the next run inherits wrongly: log it, but do not
        // report the whole run as unrestored for it.
        if (error instanceof InfraError) {
          ctx.log(`design-gate: language restore skipped: ${String(error)}`);
        } else {
          errors.push(error);
        }
      }
      for (const error of errors) ctx.log(`design-gate: restore failed: ${String(error)}`);
      return errors;
    })();
    return restored;
  };
  let restoreErrors: unknown[] = [];
  const unregisterCleanup = ctx.registerCleanup?.(async () => {
    await restoreState();
  });
  // A cell whose language cannot be reached leaves every target of that cell
  // unmeasured: record them as skipped and keep the other cells, so one probe
  // failure ends the run inconclusive instead of aborting it.
  const switchCellLanguage = async (
    cellId: string,
    want: LanguageTarget
  ): Promise<LanguageOutcome | undefined> => {
    try {
      return await ensureLanguage(ctx, want);
    } catch (error) {
      if (!(error instanceof InfraError)) throw error;
      const reason = String(error);
      ctx.log(`design-gate: cell ${cellId} language failed: ${reason}`);
      for (const target of targets)
        outcome.skipped.push({ cell: cellId, target: target.id, reason });
      return undefined;
    }
  };
  try {
    for (const config of cells) {
      ctx.log(`design-gate: cell ${config.id}`);
      ctx.device.apply(config);
      // A cell's config (night mode, size) recreates the Android Activity: the
      // dev client drops its inspector target and the page list is empty until
      // it re-attaches. waitForApp rides that window out the same way it rides
      // a runtime reload.
      await waitForApp(ctx.probe, ctx.clock);
      const language: LanguageTarget = config.rtl
        ? { preference: RTL_LANGUAGE, resolved: RTL_LANGUAGE, rtl: true }
        : ltrLanguage;
      // The cell is part of the run from the moment it is applied: a cell whose
      // language never arrives is listed with no screens, so the matrix the run
      // covered stays visible and a comparison reports the gap against the
      // manifest instead of comparing a shorter matrix.
      const run: CellRun = { id: config.id, config, screens: [] };
      outcome.cells.push(run);
      const cellLanguage = await switchCellLanguage(config.id, language);
      if (cellLanguage === undefined) continue;
      await ctx.clock.sleep(CONFIG_SETTLE_MS);
      const seen = new Map<string, string>();
      for (const [index, target] of targets.entries()) {
        try {
          const targetLanguage = await ensureLanguage(ctx, language);
          const languageReady = targetLanguage.matched;
          // A cell-level reload leaves only its first target cold; a reload this
          // target itself caused (the previous target switched the app language)
          // leaves this target cold whatever its index.
          const warm = targetLanguage.reloaded || (cellLanguage.reloaded && index === 0);
          // The reset runs even when the capture fails, so a forced state never
          // leaks into the next target.
          const { sampled, screen, unopened, image } = await captureScreen(
            ctx,
            config.id,
            target,
            warm
          ).finally(async () => {
            if (target.after !== undefined) await ctx.probe.openLink(target.after);
          });
          const { dump } = sampled;
          run.env ??= dump.env;
          run.screens.push(screen);
          const identity = screenIdentity(dump);
          const other = seen.get(identity);
          if (other === undefined) seen.set(identity, target.id);
          if (unopened !== undefined) {
            outcome.findings.push(
              warningFinding(
                config.id,
                target.id,
                dump,
                'the deep link changes the screen',
                `${target.id} left the screen unchanged (route ${dump.env.route}); the deep link did not open: ${unopened}`,
                // A tab route keeps the URL at its group root, so an unchanged
                // route is not by itself a failed open; the screen identity is
                // what decides that, so this notice has its own rule.
                'link-unopened'
              )
            );
          } else if (other !== undefined) {
            outcome.findings.push(
              warningFinding(
                config.id,
                target.id,
                dump,
                'a distinct screen per target',
                `${target.id} showed the same screen as ${other} (route ${dump.env.route}); the deep link did not open`
              )
            );
          }
          if (config.id === 'base') baseWindow ??= dump.env.window;
          if (languageReady && dump.env.language !== language.resolved) {
            outcome.findings.push(
              warningFinding(
                config.id,
                target.id,
                dump,
                `language ${language.resolved}`,
                `${target.id} switched the app language to ${dump.env.language}; its rules were skipped`
              )
            );
            continue;
          }
          const mismatches = envMismatches(config, dump.env, baseWindow, language.resolved);
          if (mismatches.length > 0) {
            outcome.findings.push(envMismatchFinding(config.id, target.id, dump, mismatches));
            continue;
          }
          const tree = normalize(dump);
          outcome.findings.push(
            ...screenFindings({
              cell: config.id,
              target: target.id,
              dump,
              tree,
              image,
              sampled,
            })
          );
          if (!sampled.settled) continue;
          trees.set(`${config.id}/${target.id}`, tree);
          const reference = config.rtl
            ? trees.get(`${mirrorReference(config)}/${target.id}`)
            : undefined;
          if (reference !== undefined) {
            outcome.findings.push(
              ...checkMirror(reference, tree).map(finding => ({
                ...finding,
                cell: config.id,
                target: target.id,
              }))
            );
          }
        } catch (error) {
          // A reload window that outlives the probe client's own retry leaves
          // the target unreadable: the probe client reports it as an
          // InfraError. The cell still measures its other targets, and this one
          // is recorded as skipped rather than aborting the whole run. No
          // finding without a dump: there is nothing measured to grade, and the
          // run is inconclusive (exit 2) rather than a pass. Every other error
          // (a failed screencap, a decode) is a real defect and still aborts.
          if (!(error instanceof InfraError)) throw error;
          const reason = String(error);
          ctx.log(`design-gate: ${target.id} could not be read this cell: ${reason}`);
          outcome.skipped.push({ cell: config.id, target: target.id, reason });
        }
      }
    }
    beforeRestore(outcome);
    await reportLogBox(ctx.probe, ctx.log);
  } finally {
    unregisterCleanup?.();
    restoreErrors = await restoreState();
  }
  return restoreErrors.length === 0
    ? outcome
    : { ...outcome, restoreError: restoreErrors.map(String).join('; ') };
}
