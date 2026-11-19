import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { parseArgs } from 'node:util';

import {
  classifyDump,
  DEFAULT_MANIFEST,
  expectationMismatch,
  expectedOutcome,
  FORCE_CLEAR_LINK,
  formatManifest,
  groupBatches,
  listRouteFiles,
  parseShard,
  PHASES,
  readManifest,
  resolveTemplates,
  shardBatches,
  targetLink,
  TemplateError,
  type Batch,
  type ManifestRow,
  type Phase,
  type SeedMap,
} from './batch-manifest';
import { waitForApp, type Clock, type Exec, type Spawn } from './capture';
import { createProbeClient } from './cdp';
import {
  coverageProblems,
  DEFAULT_COVERAGE,
  formatCoverage,
  generateCoverage,
  readCoverage,
} from './coverage';
import { createAndroidDevice } from './devices/android';
import { createIosDevice, resolveSimulator } from './devices/ios';
import { CELL_IDS, MATRIX_NAMES, type CellId, type MatrixName, type Platform } from './matrix';
import { APP_ID } from './report';
import { pnpmSeedRunner, readSeedMap, SEED_STEPS, seedAll, writeSeedMap } from './seed-all';

export const BATCHES_USAGE = `Usage: pnpm dev:mobile:design-gate batches <command> [flags]
  run --device <serial|udid>@<metro-url> [--device ...] --out <dir>
      [--platform android|ios] [--phase signed-in|signed-out] [--shard <i>/<n>] [--only <batch>,<batch>]
      [--seeds <seed-map.json>] [--matrix base|standard|full] [--cell <id> ...] [--observe-ms <ms>]
      [--manifest <file>] [--no-restart]
      Runs the shard's batches of one phase, one gate run per batch, in parallel across the devices.
      Each device needs its own Metro (its own port and adb reverse); a device takes the next batch when
      it finishes one. Before each batch the app is restarted on that device's Metro and must reach the
      phase's ready screen (signed-in: Home, signed-out: Login). A batch that exits 2 is retried once;
      a second 2 stops dispatching and writes RUN-STOPPED. Rows that force a state open
      ${FORCE_CLEAR_LINK} after their capture.
      Writes <out>/<batch>/ (gate artifacts, targets.json, expectations.json, gate.log),
      <out>/summary.tsv and <out>/resolved-links.tsv.
      --matrix overrides every batch's own matrix; --cell adds a cell (${CELL_IDS.join(', ')}).
  seed --email <fake@example.com> --out <seed-map.json> [--step <name> ...]
      Runs every seed topic the manifest needs (${SEED_STEPS.map(step => step.step).join(', ')})
      for a signed-in fake account and writes the id map {{seed:<step>.<key>}} links resolve against.
  expect [--manifest <file>] [--write]
      Recomputes each row's kind and screen from the route files; exit 1 when the manifest differs.
  coverage [--manifest <file>] [--coverage <file>] [--write]
      Checks the screen x state x platform map against the route files and the manifest; exit 1 when a
      route file has no row or a generated cell is stale. --write regenerates it, keeping hand-written cells.
Exit codes: 0 every batch clean; 1 measured errors or a link that did not settle where expected;
2 infrastructure (a device or app never ready, an unresolved seed id, a gate run that exited 2 twice).`;

export type BatchesDeps = { log: (line: string) => void; warn: (line: string) => void };

type DeviceSpec = Readonly<{ id: string; metro: string; platform: Platform }>;

export function parseDeviceSpec(value: string, platform: Platform): DeviceSpec {
  const at = value.indexOf('@');
  const id = at === -1 ? '' : value.slice(0, at);
  const metro = at === -1 ? '' : value.slice(at + 1);
  if (id === '' || !/^https?:\/\/[^/]+:\d+\/?$/.test(metro)) {
    throw new Error(`--device must be <serial|udid>@http://<host>:<port>, got "${value}"`);
  }
  return { id, metro: metro.replace(/\/$/, ''), platform };
}

type SummaryRow = Readonly<{
  batch: string;
  tier: string;
  phase: Phase;
  device: string;
  exit: number;
  counts: string;
  durationS: number;
  attempts: number;
}>;

const SUMMARY_HEADER = 'batch\ttier\tphase\tdevice\texit\terrors_per_rule\tduration_s\tattempts';
const READY: Record<Phase, { link: string; screen: string }> = {
  'signed-in': { link: 'kiloapp:///(app)/(tabs)/(0_home)', screen: '(app)/(tabs)/(0_home)' },
  'signed-out': { link: 'kiloapp:///(auth)/login', screen: '(auth)/login' },
};
const APP_READY_TIMEOUT_MS = 120_000;
const RETRY_PAUSE_MS = 10_000;
const CLI = path.join(import.meta.dirname, 'cli.ts');

const exec: Exec = (command, args) =>
  execFileSync(command, [...args], {
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
const spawnQuiet: Spawn = (command, args) => {
  const child = spawn(command, [...args], { stdio: 'ignore' });
  const exited = Promise.withResolvers<number | null>();
  child.on('exit', code => exited.resolve(code));
  child.on('error', error => exited.reject(error));
  return { signal: signal => child.kill(signal), exited: exited.promise };
};
const clock: Clock = { now: () => Date.now(), sleep: ms => delay(ms) };

type ResolvedTarget = Readonly<{ id: string; link: string; after?: string; row: ManifestRow }>;

/** The batch's gate targets: links with seed ids filled in and force-state wrapping. */
export function batchTargets(batch: Batch, seeds: SeedMap | undefined): ResolvedTarget[] {
  return batch.rows.map((row, index) => {
    const link = targetLink(row, resolveTemplates(row.link, seeds));
    return {
      id: `${String(index + 1).padStart(2, '0')}-${row.force === undefined ? '' : `force-${row.force}-`}${
        link
          .replace(/^kiloapp:\/\/\/?/, '')
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-+|-+$/g, '')
          .slice(0, 80) || 'root'
      }`,
      link,
      ...(row.force === undefined ? {} : { after: FORCE_CLEAR_LINK }),
      row,
    };
  });
}

/**
 * Restarts the app on the device's Metro and waits until the phase's ready
 * screen renders: one app process per batch, because one long-lived process
 * died mid-run with a native out-of-memory abort after 44 batches.
 */
async function prepareApp(device: DeviceSpec, phase: Phase, log: (line: string) => void) {
  const port = Number(new URL(device.metro).port);
  let names: readonly string[];
  if (device.platform === 'android') {
    const android = createAndroidDevice({
      exec,
      spawn: spawnQuiet,
      serial: device.id,
      metroPort: port,
    });
    names = android.names;
    android.relaunch?.();
  } else {
    const simulator = resolveSimulator(exec, device.id);
    names = createIosDevice({ exec, spawn: spawnQuiet, simulator }).names;
    try {
      exec('xcrun', ['simctl', 'terminate', simulator.udid, APP_ID]);
    } catch {
      // Not running: nothing to stop.
    }
    exec('xcrun', [
      'simctl',
      'openurl',
      simulator.udid,
      `kiloapp://expo-development-client/?url=${encodeURIComponent(device.metro)}`,
    ]);
  }
  const probe = createProbeClient({ metro: device.metro, names, pageWaitMs: 45_000 });
  const ready = READY[phase];
  const started = clock.now();
  try {
    await waitForApp(probe, clock, () => true, APP_READY_TIMEOUT_MS);
    await probe.openLink(ready.link);
    const dump = await waitForApp(
      probe,
      clock,
      candidate => candidate.env.screen === ready.screen,
      Math.max(5_000, APP_READY_TIMEOUT_MS - (clock.now() - started))
    );
    if (dump.env.screen !== ready.screen) {
      throw new Error(
        `screen "${dump.env.screen ?? ''}" (route ${dump.env.route}) is not ${ready.screen}`
      );
    }
    log(
      `${device.id}: app restarted, ${ready.screen} ready in ${Math.round((clock.now() - started) / 1000)}s`
    );
  } finally {
    probe.disconnect();
  }
}

function runGate(args: readonly string[], logFile: string): Promise<number> {
  const out = fs.openSync(logFile, 'a');
  // The gate runs in its own process: its device calls are synchronous, so two
  // gates in one process would take turns instead of running in parallel.
  const child = spawn(process.execPath, [...process.execArgv, CLI, ...args], {
    stdio: ['ignore', out, out],
  });
  fs.closeSync(out);
  const { promise, resolve } = Promise.withResolvers<number>();
  child.on('exit', code => resolve(code ?? 2));
  child.on('error', () => resolve(2));
  return promise;
}

type FindingsFile = {
  cells?: { id: string; screens?: { target: string; link: string; dump?: string }[] }[];
  findings?: { rule: string; severity: string; count?: number }[];
};

function errorCounts(findings: FindingsFile): string {
  const counts = new Map<string, number>();
  for (const finding of findings.findings ?? []) {
    if (finding.severity !== 'error') continue;
    counts.set(finding.rule, (counts.get(finding.rule) ?? 0) + (finding.count ?? 1));
  }
  return [...counts.entries()].map(([rule, count]) => `${rule}:${count}`).join(',');
}

/** The old check-batch.mjs: does each target's settled dump meet its row? */
export function checkExpectations(out: string, targets: readonly ResolvedTarget[]) {
  const findings: FindingsFile = JSON.parse(
    fs.readFileSync(path.join(out, 'findings.json'), 'utf8')
  );
  const byId = new Map(targets.map(target => [target.id, target]));
  const mismatches: Record<string, unknown>[] = [];
  let checked = 0;
  for (const cell of findings.cells ?? []) {
    for (const screen of cell.screens ?? []) {
      const target = byId.get(screen.target);
      if (target === undefined) continue;
      let dump: { env?: { screen?: string }; nodes?: { text?: string; label?: string }[] };
      try {
        dump = JSON.parse(fs.readFileSync(path.join(out, screen.dump ?? ''), 'utf8'));
      } catch {
        mismatches.push({
          cell: cell.id,
          target: target.id,
          link: target.link,
          reason: 'dump missing',
        });
        continue;
      }
      checked += 1;
      const state = classifyDump(dump.nodes ?? []);
      const actual = dump.env?.screen ?? '';
      const reason = expectationMismatch(target.row, actual, state);
      if (reason !== undefined) {
        mismatches.push({
          cell: cell.id,
          target: target.id,
          link: target.link,
          reason,
          expected: target.row.screen || target.row.kind,
          actual,
          text: state.sample,
        });
      }
    }
  }
  return { checked, mismatches };
}

type RunOptions = {
  devices: DeviceSpec[];
  out: string;
  phase: Phase;
  batches: Batch[];
  seeds?: SeedMap;
  matrix?: MatrixName;
  cells: CellId[];
  observeMs?: string;
  restart: boolean;
};

async function runBatch(
  batch: Batch,
  device: DeviceSpec,
  options: RunOptions,
  log: (line: string) => void
): Promise<SummaryRow & { stop: boolean }> {
  const dir = path.join(options.out, batch.id);
  fs.mkdirSync(dir, { recursive: true });
  const started = clock.now();
  const finish = (exit: number, counts: string, attempts: number, stop = false) => ({
    batch: batch.id,
    tier: batch.tier,
    phase: batch.phase,
    device: device.id,
    exit,
    counts,
    durationS: Math.round((clock.now() - started) / 1000),
    attempts,
    stop,
  });
  let targets: ResolvedTarget[];
  try {
    targets = batchTargets(batch, options.seeds);
  } catch (error) {
    if (!(error instanceof TemplateError)) throw error;
    fs.writeFileSync(path.join(dir, 'unresolved.txt'), `${error.message}\n`);
    log(`${batch.id}: ${error.message}`);
    return finish(2, 'unresolved-seed', 0);
  }
  const targetsFile = path.join(dir, 'targets.json');
  fs.writeFileSync(
    targetsFile,
    `${JSON.stringify(
      {
        targets: targets.map(({ id, link, after }) => ({ id, link, ...(after ? { after } : {}) })),
      },
      null,
      2
    )}\n`
  );
  const gateArgs = [
    'run',
    '--targets',
    targetsFile,
    '--matrix',
    options.matrix ?? batch.matrix,
    ...options.cells.flatMap(cell => ['--cell', cell]),
    ...(options.observeMs === undefined ? [] : ['--observe-ms', options.observeMs]),
    '--platform',
    device.platform,
    '--device',
    device.id,
    '--metro',
    device.metro,
    '--out',
    dir,
  ];
  let code = 2;
  let attempt = 0;
  let notReady = false;
  while (attempt < 2) {
    attempt += 1;
    notReady = false;
    log(`${batch.id}: attempt ${attempt} on ${device.id}`);
    if (options.restart) {
      try {
        await prepareApp(device, batch.phase, log);
      } catch (error) {
        notReady = true;
        code = 2;
        log(`${batch.id}: app never reached the ready screen on ${device.id}: ${String(error)}`);
      }
    }
    if (!notReady) code = await runGate(gateArgs, path.join(dir, 'gate.log'));
    if (code !== 2) break;
    if (attempt < 2) {
      log(`${batch.id}: exited 2 (attempt ${attempt}); retrying once`);
      await delay(RETRY_PAUSE_MS);
    }
  }
  if (notReady) return finish(2, 'app-not-ready', attempt, true);
  const findingsPath = path.join(dir, 'findings.json');
  if (!fs.existsSync(findingsPath)) return finish(code, 'no-findings-json', attempt, code === 2);
  const findings: FindingsFile = JSON.parse(fs.readFileSync(findingsPath, 'utf8'));
  const counts = [errorCounts(findings)];
  const expectations = checkExpectations(dir, targets);
  fs.writeFileSync(
    path.join(dir, 'expectations.json'),
    `${JSON.stringify({ batch: batch.id, ...expectations }, null, 2)}\n`
  );
  if (expectations.mismatches.length > 0) {
    counts.push(`link-mismatch:${expectations.mismatches.length}`);
    if (code === 0) code = 1;
    log(`${batch.id}: ${expectations.mismatches.length} link(s) did not settle where expected`);
  }
  return finish(code, counts.filter(Boolean).join(',') || 'none', attempt, code === 2);
}

function writeSummary(out: string, order: readonly Batch[], rows: ReadonlyMap<string, SummaryRow>) {
  const lines = order.flatMap(batch => {
    const row = rows.get(batch.id);
    return row === undefined
      ? []
      : [
          [
            row.batch,
            row.tier,
            row.phase,
            row.device,
            row.exit,
            row.counts,
            row.durationS,
            row.attempts,
          ].join('\t'),
        ];
  });
  fs.writeFileSync(path.join(out, 'summary.tsv'), `${[SUMMARY_HEADER, ...lines].join('\n')}\n`);
}

export async function runBatches(
  options: RunOptions,
  log: (line: string) => void
): Promise<number> {
  fs.mkdirSync(options.out, { recursive: true });
  // Every link the run opens, resolved, before any device starts: the proof of
  // which ids the templates became.
  const resolved: string[] = ['batch\ttarget\tlink'];
  for (const batch of options.batches) {
    try {
      for (const target of batchTargets(batch, options.seeds)) {
        resolved.push([batch.id, target.id, target.link].join('\t'));
      }
    } catch (error) {
      resolved.push([batch.id, '-', String(error)].join('\t'));
    }
  }
  fs.writeFileSync(path.join(options.out, 'resolved-links.tsv'), `${resolved.join('\n')}\n`);
  const queue = [...options.batches];
  const results = new Map<string, SummaryRow>();
  let stopped: string | undefined;
  const worker = async (device: DeviceSpec) => {
    for (;;) {
      if (stopped !== undefined) return;
      const batch = queue.shift();
      if (batch === undefined) return;
      const result = await runBatch(batch, device, options, line => log(`[${device.id}] ${line}`));
      results.set(batch.id, result);
      writeSummary(options.out, options.batches, results);
      log(
        `[${device.id}] ${batch.id}\texit ${result.exit}\t${result.counts}\t${result.durationS}s`
      );
      if (result.stop && stopped === undefined) {
        stopped = `${batch.id} exited 2 twice on ${device.id} (${result.counts})`;
      }
    }
  };
  await Promise.all(options.devices.map(worker));
  writeSummary(options.out, options.batches, results);
  log(`summary: ${path.join(options.out, 'summary.tsv')}`);
  if (stopped !== undefined) {
    const rest = options.batches.filter(batch => !results.has(batch.id)).map(batch => batch.id);
    fs.writeFileSync(
      path.join(options.out, 'RUN-STOPPED'),
      `RUN-STOPPED: ${stopped}\nnot run: ${rest.join(',') || '(none)'}\n`
    );
    log(`RUN-STOPPED: ${stopped}; rerun the rest with --only ${rest.join(',')}`);
    return 2;
  }
  const exits = [...results.values()].map(row => row.exit);
  if (exits.includes(2)) return 2;
  return exits.includes(1) ? 1 : 0;
}

function selectBatches(
  rows: readonly ManifestRow[],
  options: {
    platform: Platform;
    phase: Phase;
    only?: string[];
    shard?: { index: number; count: number };
  }
): Batch[] {
  const all = groupBatches(rows.filter(row => row.platforms.includes(options.platform)));
  let batches: Batch[];
  if (options.only !== undefined) {
    const unknown = options.only.filter(id => !all.some(batch => batch.id === id));
    if (unknown.length > 0) throw new Error(`unknown batch(es): ${unknown.join(', ')}`);
    batches = options.only.flatMap(id => all.filter(batch => batch.id === id));
    const wrongPhase = batches.filter(batch => batch.phase !== options.phase);
    if (wrongPhase.length > 0) {
      throw new Error(
        `${wrongPhase.map(batch => batch.id).join(', ')} belong to another phase than ${options.phase}`
      );
    }
  } else {
    batches = all.filter(batch => batch.phase === options.phase);
  }
  return options.shard === undefined ? batches : shardBatches(batches, options.shard);
}

export async function batchesMain(argv: readonly string[], deps: BatchesDeps): Promise<number> {
  const [command, ...rest] = argv;
  if (
    command === undefined ||
    command === 'help' ||
    argv.includes('--help') ||
    argv.includes('-h')
  ) {
    deps.log(BATCHES_USAGE);
    return command === undefined ? 2 : 0;
  }
  try {
    const { values } = parseArgs({
      args: rest,
      options: {
        device: { type: 'string', multiple: true },
        platform: { type: 'string' },
        phase: { type: 'string' },
        shard: { type: 'string' },
        only: { type: 'string' },
        seeds: { type: 'string' },
        matrix: { type: 'string' },
        cell: { type: 'string', multiple: true },
        'observe-ms': { type: 'string' },
        manifest: { type: 'string' },
        coverage: { type: 'string' },
        'no-restart': { type: 'boolean' },
        out: { type: 'string' },
        email: { type: 'string' },
        step: { type: 'string', multiple: true },
        write: { type: 'boolean' },
      },
    });
    const manifestFile = values.manifest ?? DEFAULT_MANIFEST;
    switch (command) {
      case 'run': {
        const platform = values.platform ?? 'android';
        if (platform !== 'android' && platform !== 'ios')
          throw new Error('--platform must be android or ios');
        const phase = PHASES.find(candidate => candidate === (values.phase ?? 'signed-in'));
        if (phase === undefined) throw new Error(`--phase must be one of ${PHASES.join(', ')}`);
        if (values.out === undefined) throw new Error('run needs --out <dir>');
        const devices = (values.device ?? []).map(spec => parseDeviceSpec(spec, platform));
        if (devices.length === 0)
          throw new Error('run needs at least one --device <id>@<metro-url>');
        const ports = devices.map(device => device.metro);
        if (
          new Set(ports).size !== ports.length ||
          new Set(devices.map(device => device.id)).size !== devices.length
        ) {
          throw new Error('every --device needs its own device and its own Metro');
        }
        const matrix =
          values.matrix === undefined
            ? undefined
            : MATRIX_NAMES.find(name => name === values.matrix);
        if (values.matrix !== undefined && matrix === undefined) {
          throw new Error(`--matrix must be one of ${MATRIX_NAMES.join(', ')}`);
        }
        const cells = (values.cell ?? []).map(id => {
          const cell = CELL_IDS.find(candidate => candidate === id);
          if (cell === undefined) throw new Error(`--cell must be one of ${CELL_IDS.join(', ')}`);
          return cell;
        });
        const batches = selectBatches(readManifest(manifestFile), {
          platform,
          phase,
          only: values.only?.split(',').filter(Boolean),
          shard: values.shard === undefined ? undefined : parseShard(values.shard),
        });
        deps.log(
          `batches: ${batches.length} (${batches.map(batch => batch.id).join(', ')}) on ${devices
            .map(device => `${device.id}@${device.metro}`)
            .join(', ')}`
        );
        return await runBatches(
          {
            devices,
            out: path.resolve(values.out),
            phase,
            batches,
            seeds: values.seeds === undefined ? undefined : readSeedMap(values.seeds),
            matrix,
            cells,
            observeMs: values['observe-ms'],
            restart: values['no-restart'] !== true,
          },
          deps.log
        );
      }
      case 'seed': {
        if (values.email === undefined || values.out === undefined) {
          throw new Error('seed needs --email <fake@example.com> and --out <seed-map.json>');
        }
        const map = seedAll({
          email: values.email,
          steps: values.step,
          run: pnpmSeedRunner(path.join(import.meta.dirname, '..', '..', '..')),
          log: deps.log,
        });
        writeSeedMap(values.out, map);
        const failed = Object.entries(map.steps).filter(([, step]) => !step.ok);
        deps.log(`seed map: ${path.resolve(values.out)}`);
        return failed.length > 0 ? 1 : 0;
      }
      case 'expect': {
        const rows = readManifest(manifestFile);
        const routes = listRouteFiles();
        const updated = rows.map(row => ({ ...row, ...expectedOutcome(routes, row) }));
        const changed = updated.filter(
          (row, index) => row.kind !== rows[index]?.kind || row.screen !== rows[index]?.screen
        );
        for (const row of changed) {
          deps.log(
            `line ${row.line}: ${row.batch} ${row.link} -> ${row.kind} ${row.screen || '-'}`
          );
        }
        if (values.write === true) {
          fs.writeFileSync(manifestFile, formatManifest(updated));
          deps.log(`expect: wrote ${manifestFile} (${changed.length} changed)`);
          return 0;
        }
        deps.log(`expect: ${changed.length} row(s) differ from the route files`);
        return changed.length > 0 ? 1 : 0;
      }
      case 'coverage': {
        const coverageFile = values.coverage ?? DEFAULT_COVERAGE;
        const routes = listRouteFiles();
        const manifest = readManifest(manifestFile);
        const committed = readCoverage(coverageFile);
        if (values.write === true) {
          const rows = generateCoverage(routes, manifest, committed);
          fs.writeFileSync(coverageFile, formatCoverage(rows));
          deps.log(`coverage: wrote ${coverageFile} (${rows.length} rows)`);
          return 0;
        }
        const problems = coverageProblems(routes, manifest, committed);
        for (const problem of problems) deps.warn(`coverage: ${problem}`);
        deps.log(`coverage: ${routes.length} route files, ${problems.length} problem(s)`);
        return problems.length > 0 ? 1 : 0;
      }
      default:
        throw new Error(`unknown batches command: ${command}`);
    }
  } catch (error) {
    deps.log(`${error instanceof Error ? error.message : String(error)}\n${BATCHES_USAGE}`);
    return 2;
  }
}
