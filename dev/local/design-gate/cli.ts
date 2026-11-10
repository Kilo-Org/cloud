import { execFileSync, spawn as spawnProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { parseArgs } from 'node:util';

import { agentDeviceArgs, agentDeviceToProbeDump } from './agent-device';
import {
  compareProof,
  prepareProof,
  readPreparation,
  readProofManifest,
  sourceMarker,
  validatePreparedSource,
  verifyRuntimeSource,
  writeCaptureReceipt,
  type Revision,
} from './baseline';
import {
  captureFiles,
  DEFAULT_OBSERVE_MS,
  InfraError,
  layoutSignature,
  runMatrix,
  screenFindings,
  waitForApp,
  writeJson,
  type Clock,
  type Device,
  type Exec,
  type RunOutcome,
  type Spawn,
  type Target,
} from './capture';
import {
  captureAlignment,
  screenshotObservation,
  type CaptureAlignment,
  type TimedTree,
} from './capture-evidence';
import { createProbeClient } from './cdp';
import { createAndroidDevice, parseAdbDevices, resolveSerial } from './devices/android';
import { createIosDevice, resolveSimulator } from './devices/ios';
import { MATRIX_NAMES, matrixCells, type MatrixName, type Platform } from './matrix';
import { runMotion } from './motion';
import { readRgba } from './pixels';
import { APP_ID, PROBE_REQUIREMENT, recordRestoreError, summarize, writeArtifacts } from './report';
import { normalize } from './rules';
import type { Finding } from './findings';
import type { Rgba } from './pixels';
import type { ProbeDump } from './tree';
import { uiautomatorToProbeDump } from './uiautomator';

const DEFAULT_METRO = 'http://127.0.0.1:8081';
const DEFAULT_MOTION_SECONDS = 3;

type Common = { platform?: Platform; device?: string; metro: string; out?: string };

const SCAN_SOURCES = ['probe', 'uiautomator', 'agent-device'] as const;
type ScanSource = (typeof SCAN_SOURCES)[number];

export type CliArgs =
  | (Common & {
      command: 'run';
      links: string[];
      targets?: string;
      matrix: MatrixName;
      observeMs: number;
      preparation?: string;
      revision?: Revision;
    })
  | (Common & { command: 'scan'; source: ScanSource; session?: string })
  | (Common & {
      command: 'motion';
      link: string;
      tap?: string;
      seconds: number;
      observeMs: number;
    })
  | (Common & { command: 'prepare'; base: string; head: string; targets: string; out: string })
  | (Common & {
      command: 'compare';
      preparation: string;
      baseRun: string;
      headRun: string;
      out: string;
    });

export const USAGE = `Usage: pnpm dev:mobile:design-gate <command> [flags]
  run    --link <deeplink> [--link ...] [--targets <file>] [--matrix base|standard|full] [--observe-ms ${DEFAULT_OBSERVE_MS}]
  scan   [--source probe|uiautomator|agent-device] [--session <agent-device session>]   waits for a settled layout on the accessibility sources
  motion --link <deeplink> [--tap <text|testID|label>] [--seconds 3] [--observe-ms ${DEFAULT_OBSERVE_MS}]   exit 1 on an interaction layout shift
  prepare --base <exact-40hex> --head <exact-40hex> --targets <proof-manifest.json> --out <new-dir>
          creates detached worktrees and preparation.json; never copies head product source onto base
  run     --targets <proof-manifest.json> --preparation <preparation.json> --revision base|head [common flags]
          run from that prepared worktree with its fresh Metro bundle connected
  compare --preparation <preparation.json> --base-run <dir> --head-run <dir> --out <new-dir>
          exit 2 when either target is unreachable or unready; atomic comparison.json contains introduced findings; never reuses output
  help   print this text
Common: [--platform android|ios] [--device <serial|udid>] [--metro ${DEFAULT_METRO}] [--out <dir>]
Proof manifest: {"version":1,"targets":[{"id":"card","link":"kiloapp:///card","route":"/card","screen":"card","readyTestID":"card-ready"}]}
Optional target diagnostic: {"component":"apps/mobile/src/components/card.tsx","exportName":"default","props":{}}
  uses link kiloapp:///design-proof-<id>, route /design-proof-<id>, screen (auth)/design-proof-<id>; component must exist in BOTH revisions.
  Generated routes are temporary __DEV__-only data fixtures; auth, environment and product implementations are not copied or replaced.
App: ${APP_ID}; ${PROBE_REQUIREMENT}.`;

export function isHelpRequest(argv: readonly string[]): boolean {
  return argv[0] === 'help' || argv.includes('--help') || argv.includes('-h');
}

const COMMAND_FLAGS: Record<CliArgs['command'], readonly string[]> = {
  run: ['link', 'targets', 'matrix', 'observe-ms', 'preparation', 'revision'],
  scan: ['source', 'session'],
  motion: ['link', 'tap', 'seconds', 'observe-ms'],
  prepare: ['base', 'head', 'targets'],
  compare: ['preparation', 'base-run', 'head-run'],
};
const COMMON_FLAGS = ['platform', 'device', 'metro', 'out'];

export class UsageError extends Error {
  override name = 'UsageError';
}

function oneOf<T extends string>(
  flag: string,
  value: string | undefined,
  allowed: readonly T[]
): T | undefined {
  if (value === undefined) return undefined;
  const match = allowed.find(candidate => candidate === value);
  if (match === undefined) throw new UsageError(`--${flag} must be one of ${allowed.join(', ')}`);
  return match;
}

export function parseCliArgs(argv: readonly string[]): CliArgs {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      allowPositionals: true,
      options: {
        link: { type: 'string', multiple: true },
        targets: { type: 'string' },
        matrix: { type: 'string' },
        'observe-ms': { type: 'string' },
        source: { type: 'string' },
        session: { type: 'string' },
        tap: { type: 'string' },
        seconds: { type: 'string' },
        platform: { type: 'string' },
        device: { type: 'string' },
        metro: { type: 'string' },
        out: { type: 'string' },
        base: { type: 'string' },
        head: { type: 'string' },
        preparation: { type: 'string' },
        revision: { type: 'string' },
        'base-run': { type: 'string' },
        'head-run': { type: 'string' },
      },
    });
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
  const { values, positionals } = parsed;
  const [commandName, ...extra] = positionals;
  const command = oneOf('command', commandName, [
    'run',
    'scan',
    'motion',
    'prepare',
    'compare',
  ] as const);
  if (command === undefined) throw new UsageError('Missing command');
  if (extra.length > 0) throw new UsageError(`Unexpected arguments: ${extra.join(' ')}`);
  const commonFlags = command === 'prepare' || command === 'compare' ? ['out'] : COMMON_FLAGS;
  const allowed = [...commonFlags, ...COMMAND_FLAGS[command]];
  for (const [flag, value] of Object.entries(values)) {
    if (value !== undefined && !allowed.includes(flag)) {
      throw new UsageError(`--${flag} is not valid for ${command}`);
    }
  }
  const common: Common = {
    platform: oneOf('platform', values.platform, ['android', 'ios'] as const),
    device: values.device,
    metro: values.metro ?? DEFAULT_METRO,
    out: values.out,
  };
  const links = values.link ?? [];
  const observeMs =
    values['observe-ms'] === undefined ? DEFAULT_OBSERVE_MS : Number(values['observe-ms']);
  if (!Number.isInteger(observeMs) || observeMs < 0 || observeMs > 60_000) {
    throw new UsageError('--observe-ms must be an integer from 0 to 60000');
  }
  switch (command) {
    case 'prepare': {
      if (
        values.base === undefined ||
        values.head === undefined ||
        values.targets === undefined ||
        values.out === undefined
      ) {
        throw new UsageError('prepare needs --base, --head, --targets and --out');
      }
      if (![values.base, values.head].every(value => /^[0-9a-f]{40}$/.test(value))) {
        throw new UsageError('--base and --head must be exact lowercase 40-hex commit identities');
      }
      return {
        ...common,
        command,
        base: values.base,
        head: values.head,
        targets: values.targets,
        out: values.out,
      };
    }
    case 'compare': {
      if (
        values.preparation === undefined ||
        values['base-run'] === undefined ||
        values['head-run'] === undefined ||
        values.out === undefined
      ) {
        throw new UsageError('compare needs --preparation, --base-run, --head-run and --out');
      }
      return {
        ...common,
        command,
        preparation: values.preparation,
        baseRun: values['base-run'],
        headRun: values['head-run'],
        out: values.out,
      };
    }
    case 'run': {
      if (links.length === 0 && values.targets === undefined) {
        throw new UsageError('run needs --link or --targets');
      }
      if ((values.preparation === undefined) !== (values.revision === undefined)) {
        throw new UsageError('run needs both --preparation and --revision');
      }
      if (
        values.preparation !== undefined &&
        (values.targets === undefined || links.length !== 0)
      ) {
        throw new UsageError('prepared run needs --targets only, no --link overrides');
      }
      return {
        ...common,
        command,
        links,
        targets: values.targets,
        matrix: oneOf('matrix', values.matrix, MATRIX_NAMES) ?? 'standard',
        observeMs,
        ...(values.preparation === undefined
          ? {}
          : {
              preparation: values.preparation,
              revision: oneOf('revision', values.revision, ['base', 'head'] as const),
            }),
      };
    }
    case 'scan':
      return {
        ...common,
        command,
        source: oneOf('source', values.source, SCAN_SOURCES) ?? 'probe',
        session: values.session,
      };
    case 'motion': {
      const [link, ...rest] = links;
      if (link === undefined || rest.length > 0)
        throw new UsageError('motion needs exactly one --link');
      const seconds =
        values.seconds === undefined ? DEFAULT_MOTION_SECONDS : Number(values.seconds);
      if (!Number.isInteger(seconds) || seconds < 1 || seconds > 180) {
        throw new UsageError('--seconds must be an integer from 1 to 180');
      }
      return { ...common, command, link, tap: values.tap, seconds, observeMs };
    }
  }
}

export function targetIdFromLink(link: string): string {
  let raw = link;
  try {
    const url = new URL(link);
    raw = `${url.host}${url.pathname}`;
  } catch {
    raw = link;
  }
  const slug = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug.length > 0 ? slug : 'target';
}

export function resolveTargets(
  links: readonly string[],
  targetsJson: string | undefined
): Target[] {
  const entries: { id?: string; link: string }[] = links.map(link => ({ link }));
  if (targetsJson !== undefined) {
    const parsed: unknown = JSON.parse(targetsJson);
    const list =
      typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) && 'targets' in parsed
        ? parsed.targets
        : parsed;
    if (!Array.isArray(list))
      throw new UsageError('--targets file must contain a JSON array of {id, link}');
    for (const entry of list) {
      if (typeof entry === 'string') {
        entries.push({ link: entry });
        continue;
      }
      const { id, name, link } = (
        typeof entry === 'object' && entry !== null ? entry : {}
      ) as Record<string, unknown>;
      if (typeof link !== 'string')
        throw new UsageError('Every --targets entry needs a string link');
      const explicit = typeof id === 'string' ? id : typeof name === 'string' ? name : undefined;
      entries.push({ id: explicit, link });
    }
  }
  const seen = new Map<string, number>();
  return entries.map(entry => {
    const base = targetIdFromLink(entry.id ?? entry.link);
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);
    return { id: count === 1 ? base : `${base}-${count}`, link: entry.link };
  });
}

export type AbortSignalName = 'SIGINT' | 'SIGTERM';

export type CliDeps = {
  exec: Exec;
  spawn: Spawn;
  clock: Clock;
  hostPlatform: NodeJS.Platform;
  log: (line: string) => void;
  warn: (line: string) => void;
  onSignal: (signal: AbortSignalName, handler: () => void) => () => void;
  exit: (code: number) => void;
};

const SIGNAL_EXIT_CODES: Record<AbortSignalName, number> = { SIGINT: 130, SIGTERM: 143 };
const ABORT_RESTORE_TIMEOUT_MS = 180_000;

export function installAbortRestore(deps: Pick<CliDeps, 'onSignal' | 'exit' | 'warn' | 'clock'>) {
  const cleanups = new Set<() => Promise<void>>();
  let aborting = false;
  const abort = async (signal: AbortSignalName) => {
    if (aborting) return;
    aborting = true;
    deps.warn(`design-gate: ${signal}: restoring device state before exit`);
    const restored = await Promise.race([
      Promise.allSettled([...cleanups].map(cleanup => cleanup())).then(() => true),
      deps.clock.sleep(ABORT_RESTORE_TIMEOUT_MS).then(() => false),
    ]);
    if (!restored) {
      deps.warn(
        `design-gate: restore exceeded ${ABORT_RESTORE_TIMEOUT_MS} ms; language restoration may be incomplete`
      );
    }
    deps.exit(SIGNAL_EXIT_CODES[signal]);
  };
  const removers = (['SIGINT', 'SIGTERM'] as const).map(signal =>
    deps.onSignal(signal, () => {
      void abort(signal);
    })
  );
  return {
    register: (cleanup: () => Promise<void>) => {
      cleanups.add(cleanup);
      return () => {
        cleanups.delete(cleanup);
      };
    },
    dispose: () => {
      for (const remove of removers) remove();
    },
  };
}

const defaultDeps: CliDeps = {
  exec: (command, args) =>
    execFileSync(command, [...args], {
      maxBuffer: 512 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    }),
  spawn: (command, args) => {
    const child = spawnProcess(command, [...args], { stdio: 'ignore' });
    const exited = Promise.withResolvers<number | null>();
    child.on('exit', code => exited.resolve(code));
    child.on('error', error => exited.reject(error));
    return { signal: signal => child.kill(signal), exited: exited.promise };
  },
  clock: {
    now: () => Date.now(),
    sleep: ms => delay(ms),
  },
  hostPlatform: process.platform,
  log: line => console.log(line),
  warn: line => console.error(line),
  onSignal: (signal, handler) => {
    process.on(signal, handler);
    return () => {
      process.off(signal, handler);
    };
  },
  exit: code => process.exit(code),
};

export function detectPlatform(exec: Exec, hostPlatform: NodeJS.Platform): Platform {
  try {
    if (parseAdbDevices(exec('adb', ['devices']).toString()).length > 0) return 'android';
  } catch {
    if (hostPlatform !== 'darwin') throw new InfraError('adb is not available');
  }
  return hostPlatform === 'darwin' ? 'ios' : 'android';
}

function openDevice(args: CliArgs, deps: CliDeps): Device {
  const platform = args.platform ?? detectPlatform(deps.exec, deps.hostPlatform);
  if (platform === 'android') {
    return createAndroidDevice({
      exec: deps.exec,
      spawn: deps.spawn,
      serial: resolveSerial(deps.exec, args.device),
    });
  }
  return createIosDevice({
    exec: deps.exec,
    spawn: deps.spawn,
    simulator: resolveSimulator(deps.exec, args.device),
  });
}

export const SCAN_SETTLE_READS = 3;
const SCAN_SETTLE_INTERVAL_MS = 250;
const SCAN_SETTLE_TIMEOUT_MS = 15_000;

export type SettledRead = { dump: ProbeDump; settled: boolean; elapsedMs: number; reads: number };

/**
 * The accessibility sources have no probe to ask: `uiautomator dump` and an
 * `agent-device snapshot` read the platform's native tree node by node, and a screen that
 * is still moving (a sheet sliding in, a list settling, a transcript streaming) answers
 * with nodes from different layouts. A text read after its container was clipped to the
 * window edge is then past that container by the whole scroll offset, and the same
 * mismatch turns any window clamp into a "clipped" report. Reads repeat until two
 * consecutive layouts match, so only a screen that has stopped moving is measured.
 */
export async function readSettledDump(
  read: () => ProbeDump,
  clock: Clock,
  options: { reads?: number; intervalMs?: number; timeoutMs?: number } = {}
): Promise<SettledRead> {
  const settledReads = options.reads ?? SCAN_SETTLE_READS;
  const intervalMs = options.intervalMs ?? SCAN_SETTLE_INTERVAL_MS;
  const timeoutMs = options.timeoutMs ?? SCAN_SETTLE_TIMEOUT_MS;
  const started = clock.now();
  let dump = read();
  let count = 1;
  let run = 1;
  for (;;) {
    if (run >= settledReads) {
      return { dump, settled: true, elapsedMs: clock.now() - started, reads: count };
    }
    if (clock.now() - started >= timeoutMs) {
      return { dump, settled: false, elapsedMs: clock.now() - started, reads: count };
    }
    await clock.sleep(intervalMs);
    const next = read();
    count += 1;
    run = layoutSignature(next) === layoutSignature(dump) ? run + 1 : 1;
    dump = next;
  }
}

/**
 * A settled screen is measured by every rule; a screen that never stopped moving only
 * reports that it could not be measured. Its frames mix layouts, so a rect rule there
 * reports the mismatch between two frames as a layout defect — the false "text past its
 * parent" report this scan source is prone to.
 */
export function scanScreenFindings(args: {
  dump: ProbeDump;
  image?: Rgba;
  settled: boolean;
  elapsedMs: number;
  alignment?: CaptureAlignment;
}): Finding[] {
  return screenFindings({
    cell: 'current',
    target: 'current',
    dump: args.dump,
    tree: normalize(args.dump),
    image: args.image,
    sampled: {
      dump: args.dump,
      timeline: [],
      settled: args.settled,
      elapsedMs: args.elapsedMs,
      alignment: args.alignment,
    },
  });
}

async function scanOutcome(
  args: Extract<CliArgs, { command: 'scan' }>,
  device: Device,
  deps: CliDeps,
  out: string
): Promise<RunOutcome & { unmeasured?: true }> {
  const readAccessibilityDump = (): ProbeDump => {
    if (args.source === 'uiautomator') {
      if (device.uiSnapshot === undefined)
        throw new UsageError('--source uiautomator is Android only');
      return uiautomatorToProbeDump(device.uiSnapshot());
    }
    return agentDeviceToProbeDump(
      deps.exec('agent-device', agentDeviceArgs(args.session)).toString()
    );
  };
  let dump: ProbeDump;
  let settled = true;
  let elapsedMs = 0;
  let readCurrentDump: () => Promise<ProbeDump>;
  if (args.source === 'probe') {
    const probe = createProbeClient({ metro: args.metro, names: device.names });
    dump = await waitForApp(probe, deps.clock, undefined, 5_000);
    readCurrentDump = () => probe.dump();
  } else {
    const read = await readSettledDump(readAccessibilityDump, deps.clock);
    dump = read.dump;
    settled = read.settled;
    elapsedMs = read.elapsedMs;
    readCurrentDump = async () => readAccessibilityDump();
    deps.log(
      settled
        ? `design-gate: layout settled after ${read.reads} reads (${elapsedMs} ms)`
        : `design-gate: layout kept changing for ${elapsedMs} ms over ${read.reads} reads; layout rules skipped`
    );
  }
  const files = captureFiles(out, 'current', 'current');
  const started = deps.clock.now();
  const readTree = async (): Promise<TimedTree> => {
    const startedMs = deps.clock.now() - started;
    try {
      const current = await readCurrentDump();
      return { startedMs, completedMs: deps.clock.now() - started, dump: current };
    } catch (error) {
      return { startedMs, completedMs: deps.clock.now() - started, error: String(error) };
    }
  };
  const before = await readTree();
  settled =
    settled &&
    (before.dump === undefined || layoutSignature(dump) === layoutSignature(before.dump));
  dump = before.dump ?? dump;
  // Keep the latest tree even when native screenshot capture or pixel decoding fails.
  writeJson(files.absolute(files.dump), dump);
  const screenshot = { startedMs: deps.clock.now() - started, completedMs: 0 };
  device.screenshot(files.absolute(files.screenshot));
  screenshot.completedMs = deps.clock.now() - started;
  const after = await readTree();
  const image = readRgba(files.absolute(files.screenshot), deps.exec);
  const alignment = captureAlignment(
    before,
    screenshot,
    after,
    layoutSignature,
    screenshotObservation(dump, image)
  );
  writeJson(files.absolute(files.capture), alignment);
  const findings = scanScreenFindings({ dump, image, settled, elapsedMs, alignment });
  return {
    cells: [
      {
        id: 'current',
        config: {
          id: 'base',
          dark: dump.env.colorScheme === 'dark',
          rtl: dump.env.isRTL,
          compact: false,
          landscape: false,
        },
        env: dump.env,
        screens: [
          {
            target: 'current',
            link: '',
            screenshot: files.screenshot,
            annotated: files.annotated,
            dump: files.dump,
            capture: files.capture,
            env: dump.env,
          },
        ],
      },
    ],
    findings,
    ...(settled &&
    alignment.status === 'bracketed' &&
    !(alignment.pixels === 'uniform' && alignment.expectedText)
      ? {}
      : { unmeasured: true as const }),
  };
}

export async function main(argv: readonly string[], deps: CliDeps = defaultDeps): Promise<number> {
  let args: CliArgs;
  if (isHelpRequest(argv)) {
    deps.log(USAGE);
    return 0;
  }
  try {
    args = parseCliArgs(argv);
  } catch (error) {
    deps.log(`${String(error instanceof Error ? error.message : error)}\n${USAGE}`);
    return 2;
  }
  const startedAt = new Date();
  const abort =
    args.command === 'run' || args.command === 'motion' ? installAbortRestore(deps) : undefined;
  try {
    if (args.command === 'prepare' || args.command === 'compare') {
      const controller = new AbortController();
      let interrupted: AbortSignalName | undefined;
      const interrupt = (signal: AbortSignalName) => {
        interrupted ??= signal;
        controller.abort(signal);
      };
      const off = [
        deps.onSignal('SIGINT', () => interrupt('SIGINT')),
        deps.onSignal('SIGTERM', () => interrupt('SIGTERM')),
      ];
      try {
        if (args.command === 'prepare') {
          const prepared = await prepareProof(
            {
              repo: process.cwd(),
              base: args.base,
              head: args.head,
              targets: args.targets,
              out: path.resolve(args.out),
            },
            controller.signal
          );
          deps.log(`design-gate: ${path.resolve(args.out, 'preparation.json')}`);
          deps.log(`design-gate: base ${prepared.base.directory}; head ${prepared.head.directory}`);
          return 0;
        }
        const result = await compareProof(
          readPreparation(args.preparation),
          args.baseRun,
          args.headRun,
          args.out,
          controller.signal
        );
        deps.log(`design-gate: ${path.resolve(args.out, 'comparison.json')}; ${result.status}`);
        if (result.status === 'inconclusive') return 2;
        return result.introduced.length > 0 ? 1 : 0;
      } catch (error) {
        if (interrupted === undefined) throw error;
        deps.warn(`design-gate: ${interrupted}: interrupted proof operation: ${String(error)}`);
        return SIGNAL_EXIT_CODES[interrupted];
      } finally {
        for (const remove of off) remove();
      }
    }
    const out = path.resolve(args.out ?? fs.mkdtempSync(path.join(os.tmpdir(), 'design-gate-')));
    fs.mkdirSync(out, { recursive: true });
    const device = openDevice(args, deps);
    if (args.command === 'motion') {
      const probe = createProbeClient({ metro: args.metro, names: device.names });
      await waitForApp(probe, deps.clock);
      const result = await runMotion(
        {
          device,
          probe,
          clock: deps.clock,
          exec: deps.exec,
          out,
          log: deps.log,
          registerCleanup: abort?.register,
        },
        { ...args, target: targetIdFromLink(args.link) }
      );
      const abrupt = result.segments.filter(segment => segment.abrupt).length;
      const counts = summarize(result.findings);
      deps.log(`design-gate: ${path.join(out, 'motion.json')}`);
      deps.log(
        `design-gate: ${result.segments.length} motion segments, ${abrupt} abrupt candidates at ${result.fps} fps; strip ${result.strip}`
      );
      if (result.note !== undefined) deps.log(`design-gate: ${result.note}`);
      deps.log(
        `design-gate: interaction layout shift: ${counts.errors} errors, ${counts.warnings} warnings`
      );
      for (const finding of result.findings) {
        deps.log(`design-gate: ${finding.severity} ${finding.element.path}: ${finding.message}`);
      }
      return counts.errors > 0 ? 1 : 0;
    }
    let reportPath = '';
    const write = (outcome: RunOutcome, matrix: string) => {
      reportPath = writeArtifacts({
        exec: deps.exec,
        out,
        meta: {
          platform: device.platform,
          device: device.id,
          matrix,
          startedAt: startedAt.toISOString(),
          finishedAt: new Date().toISOString(),
        },
        outcome,
      });
    };
    let outcome: RunOutcome;
    let unmeasured = false;
    if (args.command === 'run') {
      const targetsJson =
        args.targets === undefined ? undefined : fs.readFileSync(args.targets, 'utf8');
      const preparation =
        args.preparation === undefined ? undefined : readPreparation(args.preparation);
      if (preparation !== undefined && args.revision !== undefined) {
        validatePreparedSource(preparation, args.revision, process.cwd());
        if (args.targets === undefined) throw new UsageError('Prepared run needs --targets');
        const requested = readProofManifest(args.targets);
        if (JSON.stringify(requested) !== JSON.stringify(preparation.manifest)) {
          throw new UsageError('Targets must match the preparation manifest exactly');
        }
        await verifyRuntimeSource(preparation, args.revision, args.metro, device.names);
        deps.log(
          `design-gate: verified product bundle ${sourceMarker(preparation, args.revision)}`
        );
      }
      const targets = preparation?.manifest.targets ?? resolveTargets(args.links, targetsJson);
      const result = await runMatrix(
        {
          device,
          probe: createProbeClient({ metro: args.metro, names: device.names }),
          clock: deps.clock,
          out,
          readImage: png => readRgba(png, deps.exec),
          observeMs: args.observeMs,
          log: deps.log,
          registerCleanup: abort?.register,
        },
        matrixCells(device.platform, args.matrix),
        targets,
        captured => write(captured, args.matrix)
      );
      if (result.restoreError !== undefined) {
        deps.warn(`design-gate: warning: device state restore failed: ${result.restoreError}`);
        recordRestoreError(out, result.restoreError);
        deps.log(`design-gate: ${reportPath}`);
        return 2;
      }
      outcome = result;
      if (preparation !== undefined && args.revision !== undefined) {
        validatePreparedSource(preparation, args.revision, process.cwd());
        await verifyRuntimeSource(preparation, args.revision, args.metro, device.names);
        const readiness = writeCaptureReceipt(preparation, args.revision, result, out);
        if (readiness.length > 0) {
          deps.log(`design-gate: inconclusive target readiness: ${readiness.join('; ')}`);
          return 2;
        }
      }
    } else {
      const scanned = await scanOutcome(args, device, deps, out);
      outcome = scanned;
      unmeasured = scanned.unmeasured === true;
      write(outcome, `scan:${args.source}`);
    }
    const counts = summarize(outcome.findings);
    deps.log(`design-gate: ${reportPath}`);
    deps.log(
      `design-gate: ${counts.errors} errors, ${counts.warnings} warnings across ${outcome.cells.length} cells`
    );
    if (unmeasured) {
      deps.log(
        'design-gate: capture is inconclusive (unsettled screen, alignment or possible blank frame); exit 2'
      );
      return 2;
    }
    return counts.errors > 0 ? 1 : 0;
  } catch (error) {
    deps.log(
      `design-gate: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`
    );
    return 2;
  } finally {
    abort?.dispose();
  }
}

const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename);
if (isMain) {
  process.exit(await main(process.argv.slice(2)));
}
