import fs from 'node:fs';
import path from 'node:path';

import type { ProbeClient, ProbeSample } from './cdp';
import type { ElementRef, Finding } from './findings';
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
  screenshot: (file: string) => void;
  record: (file: string, seconds: number) => Recording;
  tap?: (xPx: number, yPx: number) => void;
  uiSnapshot?: () => UiSnapshot;
};

export class InfraError extends Error {
  override name = 'InfraError';
}

export type Target = Readonly<{ id: string; link: string }>;

export type Screen = {
  target: string;
  link: string;
  screenshot: string;
  annotated: string;
  dump: string;
  env: ProbeEnv;
};

export type CellRun = { id: string; config: CellConfig; env?: ProbeEnv; screens: Screen[] };
export type RunOutcome = { cells: CellRun[]; findings: Finding[] };

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
export const DEFAULT_OBSERVE_MS = 2_500;
const STABLE_SAMPLES = 3;
const SETTLE_TIMEOUT_MS = 8_000;
const APP_WAIT_MS = 30_000;
const APP_POLL_MS = 500;
const CONFIG_SETTLE_MS = 750;
const RELOAD_QUIET_MS = 1_000;
const RELOAD_QUIET_TIMEOUT_MS = 10_000;
const IN_APP_SAMPLING_SLACK_MS = 10_000;
// The iOS dev client re-downloads the bundle through the SSH tunnel after a reload.
const RELOAD_WAIT_MS = 150_000;
const RTL_LANGUAGE = 'ar';
const LTR_FALLBACK_LANGUAGE = 'en';

export type Sampled = {
  dump: ProbeDump;
  timeline: ProbeDump[];
  settled: boolean;
  elapsedMs: number;
};

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

export async function waitForApp(
  probe: ProbeClient,
  clock: Clock,
  accept: (dump: ProbeDump) => boolean = () => true,
  timeoutMs = APP_WAIT_MS
): Promise<ProbeDump> {
  const deadline = clock.now() + timeoutMs;
  let last: ProbeDump | undefined;
  let lastError: unknown;
  for (;;) {
    try {
      if (await probe.ready()) {
        last = await probe.dump();
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
  const findings = [...checkScreen(args.tree, args.image)];
  if (args.sampled !== undefined) {
    findings.push(...checkShift(args.sampled.timeline.map(normalize), SAMPLE_INTERVAL_MS));
    if (!args.sampled.settled) {
      findings.push({
        rule: 'unsettled',
        severity: 'warning',
        cell: args.cell,
        target: args.target,
        element: rootRef(args.dump),
        measured: args.sampled.elapsedMs,
        expected: `${STABLE_SAMPLES} identical samples within ${SETTLE_TIMEOUT_MS} ms`,
        unit: 'ms',
        message: `Layout kept changing for ${args.sampled.elapsedMs} ms; findings for this screen may describe an intermediate frame.`,
      });
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
    absolute: (relative: string) => path.join(out, relative),
  };
}

/** The text on glass, sorted: what the screen really shows, without the route. */
export function screenTexts(dump: ProbeDump): string {
  return normalize(dump)
    .nodes.flatMap(node => (node.probe.text === undefined ? [] : [node.probe.text]))
    .sort()
    .join('\n');
}

export function screenIdentity(dump: ProbeDump): string {
  return [dump.env.route, screenTexts(dump)].join('\n');
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
  const beforeTexts = screenTexts(beforeDump);
  const beforeRoute = beforeDump.env.route.split('?')[0];
  // A route name is not proof that the screen painted. Right after a language
  // switch the runtime reloads, restores its initial route and then overwrites a
  // push that landed mid-restore: the router reports the target route while the
  // previous screen is still on glass. The link counts as opened when the text
  // on screen changed, or when it re-opens the route the app was already on, so
  // the one re-send below happens on evidence, never on a fixed retry count.
  const opened = (dump: ProbeDump) =>
    screenTexts(dump) !== beforeTexts ||
    (beforeRoute === linkRoute && dump.env.route.split('?')[0] === linkRoute);
  await ctx.probe.startSampling(SAMPLE_INTERVAL_MS, ctx.observeMs + IN_APP_SAMPLING_SLACK_MS);
  await ctx.probe.openLink(target.link);
  let settled = await sampleUntilSettled(ctx.probe, ctx.clock, ctx.observeMs);
  let unopened: string | undefined;
  if (!opened(settled.dump)) {
    ctx.log(`design-gate: ${target.id} did not change the screen; opening the link again`);
    await ctx.probe.openLink(target.link);
    settled = await sampleUntilSettled(ctx.probe, ctx.clock, ctx.observeMs);
    if (!opened(settled.dump)) unopened = await ctx.probe.lastOutcome();
  }
  const { samples, truncated } = await ctx.probe.stopSampling();
  if (truncated) {
    ctx.log(
      `design-gate: ${target.id} retained only the newest layouts; older samples were dropped`
    );
  }
  const sampled: Sampled = { ...settled, timeline: expandSamples(samples) };
  const files = captureFiles(ctx.out, cell, target.id);
  writeJson(files.absolute(files.dump), sampled.dump);
  writeJson(files.absolute(files.timeline), { samples, truncated });
  ctx.device.screenshot(files.absolute(files.screenshot));
  const screen: Screen = {
    target: target.id,
    link: target.link,
    screenshot: files.screenshot,
    annotated: files.annotated,
    dump: files.dump,
    env: sampled.dump.env,
  };
  return { sampled, screen, unopened, png: files.absolute(files.screenshot) };
}

export function expandSamples(samples: readonly ProbeSample[]): ProbeDump[] {
  return samples.flatMap(sample => Array.from({ length: sample.repeat }, () => sample.dump));
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
  const dump = await waitForApp(
    ctx.probe,
    ctx.clock,
    current => languageMatches(current, want),
    RELOAD_WAIT_MS
  );
  await waitForStableLayout(ctx.probe, ctx.clock);
  return { matched: languageMatches(dump, want), reloaded: true };
}

export function layoutSignature(dump: ProbeDump): string {
  return dump.nodes.map(node => node.rect.join(',')).join(';');
}

function warningFinding(
  cell: string,
  target: string,
  dump: ProbeDump,
  expected: string,
  message: string
): Finding {
  return {
    rule: 'env-mismatch',
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
  const outcome: RunOutcome = { cells: [], findings: [] };
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
        errors.push(error);
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
  try {
    for (const config of cells) {
      ctx.log(`design-gate: cell ${config.id}`);
      ctx.device.apply(config);
      const language: LanguageTarget = config.rtl
        ? { preference: RTL_LANGUAGE, resolved: RTL_LANGUAGE, rtl: true }
        : ltrLanguage;
      const cellLanguage = await ensureLanguage(ctx, language);
      await ctx.clock.sleep(CONFIG_SETTLE_MS);
      const run: CellRun = { id: config.id, config, screens: [] };
      outcome.cells.push(run);
      const seen = new Map<string, string>();
      for (const [index, target] of targets.entries()) {
        const targetLanguage = await ensureLanguage(ctx, language);
        const languageReady = targetLanguage.matched;
        // A cell-level reload leaves only its first target cold; a reload this
        // target itself caused (the previous target switched the app language)
        // leaves this target cold whatever its index.
        const warm = targetLanguage.reloaded || (cellLanguage.reloaded && index === 0);
        const { sampled, screen, unopened, png } = await captureScreen(
          ctx,
          config.id,
          target,
          warm
        );
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
              `${target.id} left the screen unchanged (route ${dump.env.route}); the deep link did not open: ${unopened}`
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
        trees.set(`${config.id}/${target.id}`, tree);
        outcome.findings.push(
          ...screenFindings({
            cell: config.id,
            target: target.id,
            dump,
            tree,
            image: ctx.readImage(png),
            sampled,
          })
        );
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
      }
    }
    beforeRestore(outcome);
  } finally {
    unregisterCleanup?.();
    restoreErrors = await restoreState();
  }
  return restoreErrors.length === 0
    ? outcome
    : { ...outcome, restoreError: restoreErrors.map(String).join('; ') };
}
