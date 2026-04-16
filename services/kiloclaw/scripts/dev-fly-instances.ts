#!/usr/bin/env tsx
import { execFileSync } from 'node:child_process';
import { emitKeypressEvents } from 'node:readline';

import {
  METADATA_KEY_DEV_CREATOR,
  METADATA_KEY_ORG_ID,
  METADATA_KEY_SANDBOX_ID,
  METADATA_KEY_USER_ID,
} from '../src/durable-objects/machine-config';

const FLY_API_BASE = 'https://api.machines.dev/v1';
const DEFAULT_ORG = 'kilo-dev';
const DEFAULT_CONCURRENCY = 5;

type Options = {
  org: string;
  metadataKey: string;
  creator: string | null;
  allCreators: boolean;
  destroy: boolean;
  yes: boolean;
  json: boolean;
  concurrency: number;
  allowNonDevOrg: boolean;
};

type MachineMount = {
  volume: string | null;
  path: string | null;
  name: string | null;
};

type MachineGuest = {
  cpus: number | null;
  memoryMb: number | null;
  cpuKind: string | null;
};

type MachineConfig = {
  image: string | null;
  metadata: Record<string, string>;
  guest: MachineGuest | null;
  mounts: MachineMount[];
};

type OrgMachine = {
  id: string;
  appName: string;
  name: string | null;
  state: string;
  region: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  config: MachineConfig;
};

type OrgMachinesPage = {
  machines: OrgMachine[];
  nextCursor: string | null;
};

type FlyApiClient = {
  token: string;
};

type DestroyResult = {
  machine: OrgMachine;
  ok: boolean;
  message: string;
};

type CreatorGroup = {
  creator: string;
  total: number;
  started: number;
  stopped: number;
  other: number;
};

function parseArgs(argv: string[]): Options {
  const options: Options = {
    org: DEFAULT_ORG,
    metadataKey: METADATA_KEY_DEV_CREATOR,
    creator: null,
    allCreators: false,
    destroy: false,
    yes: false,
    json: false,
    concurrency: DEFAULT_CONCURRENCY,
    allowNonDevOrg: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--':
        break;
      case '--org':
        options.org = requireArgValue(argv, i, arg);
        i += 1;
        break;
      case '--creator':
        options.creator = requireArgValue(argv, i, arg);
        i += 1;
        break;
      case '--metadata-key':
        options.metadataKey = requireArgValue(argv, i, arg);
        i += 1;
        break;
      case '--concurrency': {
        const value = Number(requireArgValue(argv, i, arg));
        if (!Number.isInteger(value) || value < 1 || value > 25) {
          throw new Error('--concurrency must be an integer between 1 and 25');
        }
        options.concurrency = value;
        i += 1;
        break;
      }
      case '--all-creators':
        options.allCreators = true;
        break;
      case '--destroy':
        options.destroy = true;
        break;
      case '--yes':
        options.yes = true;
        break;
      case '--json':
        options.json = true;
        break;
      case '--allow-non-dev-org':
        options.allowNonDevOrg = true;
        break;
      case '--help':
      case '-h':
        printHelp();
        process.exit(0);
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }

  return options;
}

function requireArgValue(argv: string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function printHelp(): void {
  console.log(`Usage:
  pnpm kiloclaw:dev-fly-instances [options]

Identifies Fly Machines in the dev Fly org that were tagged with KiloClaw's
creator metadata. By default this is a read-only report for the current Fly user.

Options:
  --org <slug>              Fly org slug (default: ${DEFAULT_ORG})
  --creator <value>         Creator metadata value (default: DEV_CREATOR or fly auth whoami)
  --metadata-key <key>      Metadata key (default: ${METADATA_KEY_DEV_CREATOR})
  --all-creators            Report all creator groups instead of one creator
  --destroy                 Select matched machines in a TUI, then force-destroy them
  --yes                     With --destroy, skip selection and destroy all matched machines
  --concurrency <n>         Destroy concurrency, 1-25 (default: ${DEFAULT_CONCURRENCY})
  --json                    Print machine details as JSON
  --allow-non-dev-org       Allow --destroy when --org is not ${DEFAULT_ORG}
  --help                    Show this help

Examples:
  pnpm kiloclaw:dev-fly-instances
  pnpm kiloclaw:dev-fly-instances -- --all-creators
  pnpm kiloclaw:dev-fly-instances -- --creator remon@example.com --destroy
  pnpm kiloclaw:dev-fly-instances -- --creator remon@example.com --destroy --yes`);
}

function readEnv(name: string): string | null {
  const value = process.env[name];
  if (!value) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function runFly(args: string[]): string | null {
  try {
    const output = execFileSync('fly', args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return output.length > 0 ? output : null;
  } catch {
    return null;
  }
}

function resolveToken(): string {
  const tokenFromEnv = readEnv('FLY_API_TOKEN');
  if (tokenFromEnv) return tokenFromEnv;

  const tokenFromFlyCli = runFly(['auth', 'token']);
  if (tokenFromFlyCli) return tokenFromFlyCli;

  throw new Error('Missing Fly API token. Set FLY_API_TOKEN or log in with `fly auth login`.');
}

function resolveCreator(explicitCreator: string | null): string | null {
  if (explicitCreator) return explicitCreator;

  const creatorFromEnv = readEnv('DEV_CREATOR');
  if (creatorFromEnv) return creatorFromEnv;

  return runFly(['auth', 'whoami']);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getString(value: Record<string, unknown>, key: string): string | null {
  const field = value[key];
  return typeof field === 'string' ? field : null;
}

function getNumber(value: Record<string, unknown>, key: string): number | null {
  const field = value[key];
  return typeof field === 'number' && Number.isFinite(field) ? field : null;
}

function parseStringRecord(value: unknown): Record<string, string> {
  if (!isObject(value)) return {};

  const result: Record<string, string> = {};
  for (const [key, recordValue] of Object.entries(value)) {
    if (typeof recordValue === 'string') {
      result[key] = recordValue;
    }
  }
  return result;
}

function parseGuest(value: unknown): MachineGuest | null {
  if (!isObject(value)) return null;
  return {
    cpus: getNumber(value, 'cpus'),
    memoryMb: getNumber(value, 'memory_mb'),
    cpuKind: getString(value, 'cpu_kind'),
  };
}

function parseMounts(value: unknown): MachineMount[] {
  if (!Array.isArray(value)) return [];

  const mounts: MachineMount[] = [];
  for (const item of value) {
    if (!isObject(item)) continue;
    mounts.push({
      volume: getString(item, 'volume'),
      path: getString(item, 'path'),
      name: getString(item, 'name'),
    });
  }
  return mounts;
}

function parseMachineConfig(value: unknown): MachineConfig {
  if (!isObject(value)) {
    return { image: null, metadata: {}, guest: null, mounts: [] };
  }

  return {
    image: getString(value, 'image'),
    metadata: parseStringRecord(value.metadata),
    guest: parseGuest(value.guest),
    mounts: parseMounts(value.mounts),
  };
}

function parseMachine(value: unknown): OrgMachine | null {
  if (!isObject(value)) return null;

  const id = getString(value, 'id');
  const appName = getString(value, 'app_name');
  const state = getString(value, 'state');

  if (!id || !appName || !state) return null;

  return {
    id,
    appName,
    name: getString(value, 'name'),
    state,
    region: getString(value, 'region'),
    createdAt: getString(value, 'created_at'),
    updatedAt: getString(value, 'updated_at'),
    config: parseMachineConfig(value.config),
  };
}

function parseOrgMachinesPage(value: unknown): OrgMachinesPage {
  if (!isObject(value)) {
    throw new Error('Fly API returned a non-object org machines response');
  }

  const machines: OrgMachine[] = [];
  if (Array.isArray(value.machines)) {
    for (const item of value.machines) {
      const machine = parseMachine(item);
      if (machine) machines.push(machine);
    }
  }

  return {
    machines,
    nextCursor: getString(value, 'next_cursor'),
  };
}

async function flyJson(client: FlyApiClient, path: string): Promise<unknown> {
  const response = await fetch(`${FLY_API_BASE}${path}`, {
    headers: {
      Authorization: `Bearer ${client.token}`,
      'Content-Type': 'application/json',
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Fly API request failed (${response.status}) for ${path}: ${body}`);
  }

  const json: unknown = await response.json();
  return json;
}

async function flyDelete(client: FlyApiClient, path: string): Promise<string> {
  const response = await fetch(`${FLY_API_BASE}${path}`, {
    method: 'DELETE',
    headers: {
      Authorization: `Bearer ${client.token}`,
      'Content-Type': 'application/json',
    },
  });

  const body = await response.text();
  if (response.status === 404) return 'already deleted';
  if (!response.ok) {
    throw new Error(`Fly API delete failed (${response.status}): ${body}`);
  }
  return body.trim().length > 0 ? body.trim() : 'destroy requested';
}

async function listOrgMachines(client: FlyApiClient, org: string): Promise<OrgMachine[]> {
  const machines: OrgMachine[] = [];
  let cursor: string | null = null;

  for (let page = 1; page <= 100; page += 1) {
    const params = new URLSearchParams({ include_deleted: 'false', limit: '1000' });
    if (cursor) params.set('cursor', cursor);

    const json = await flyJson(client, `/orgs/${encodeURIComponent(org)}/machines?${params}`);
    const parsed = parseOrgMachinesPage(json);
    machines.push(...parsed.machines);

    if (!parsed.nextCursor) return machines;
    cursor = parsed.nextCursor;
  }

  throw new Error('Fly API pagination did not finish after 100 pages');
}

function isKiloClawMachine(machine: OrgMachine): boolean {
  const metadata = machine.config.metadata;
  return Boolean(
    metadata[METADATA_KEY_USER_ID] ||
    metadata[METADATA_KEY_SANDBOX_ID] ||
    metadata[METADATA_KEY_ORG_ID] ||
    metadata[METADATA_KEY_DEV_CREATOR]
  );
}

function groupByCreator(machines: OrgMachine[], metadataKey: string): CreatorGroup[] {
  const groups = new Map<string, CreatorGroup>();

  for (const machine of machines) {
    const creator = machine.config.metadata[metadataKey] ?? '(missing)';
    const existing = groups.get(creator) ?? {
      creator,
      total: 0,
      started: 0,
      stopped: 0,
      other: 0,
    };

    existing.total += 1;
    if (machine.state === 'started') {
      existing.started += 1;
    } else if (machine.state === 'stopped') {
      existing.stopped += 1;
    } else {
      existing.other += 1;
    }
    groups.set(creator, existing);
  }

  return Array.from(groups.values()).sort(
    (a, b) => b.total - a.total || a.creator.localeCompare(b.creator)
  );
}

function machineToReport(machine: OrgMachine, metadataKey: string): Record<string, unknown> {
  const metadata = machine.config.metadata;
  const mountedVolumes = machine.config.mounts
    .map(mount => mount.volume)
    .filter(volume => typeof volume === 'string' && volume.length > 0);

  return {
    app: machine.appName,
    machine: machine.id,
    state: machine.state,
    region: machine.region,
    creator: metadata[metadataKey] ?? null,
    userId: metadata[METADATA_KEY_USER_ID] ?? null,
    sandboxId: metadata[METADATA_KEY_SANDBOX_ID] ?? null,
    orgId: metadata[METADATA_KEY_ORG_ID] ?? null,
    image: machine.config.image,
    guest: machine.config.guest,
    volumes: mountedVolumes,
    createdAt: machine.createdAt,
    updatedAt: machine.updatedAt,
  };
}

function printTextReport(params: {
  org: string;
  metadataKey: string;
  targetCreator: string | null;
  allMachines: OrgMachine[];
  kiloClawMachines: OrgMachine[];
  matchedMachines: OrgMachine[];
  groups: CreatorGroup[];
  destroy: boolean;
}): void {
  const {
    org,
    metadataKey,
    targetCreator,
    allMachines,
    kiloClawMachines,
    matchedMachines,
    groups,
    destroy,
  } = params;

  console.log(`Fly org: ${org}`);
  console.log(`Metadata key: ${metadataKey}`);
  if (targetCreator) console.log(`Target creator: ${targetCreator}`);
  console.log(`Org machines: ${allMachines.length}`);
  console.log(`KiloClaw-tagged machines: ${kiloClawMachines.length}`);
  console.log(`Matched machines: ${matchedMachines.length}`);
  console.log(`Mode: ${destroy ? 'destroy' : 'dry-run report'}`);

  console.log('\nCreator groups:');
  printRows(groups.map(group => ({ ...group })));

  if (matchedMachines.length === 0) return;

  console.log('\nMatched machines:');
  printRows(
    matchedMachines.map((machine, index) => ({
      '#': index + 1,
      app: machine.appName,
      machine: machine.id,
      state: machine.state,
      region: machine.region ?? '',
      userId: machine.config.metadata[METADATA_KEY_USER_ID] ?? '',
      sandboxId: machine.config.metadata[METADATA_KEY_SANDBOX_ID] ?? '',
      createdAt: machine.createdAt ?? '',
      updatedAt: machine.updatedAt ?? '',
    }))
  );
}

function printRows(rows: Record<string, unknown>[]): void {
  if (rows.length === 0) {
    console.log('(none)');
    return;
  }

  const headers = Object.keys(rows[0] ?? {});
  console.log(headers.join('\t'));
  for (const row of rows) {
    console.log(headers.map(header => String(row[header] ?? '')).join('\t'));
  }
}

const ANSI_CLEAR_SCREEN = '\x1b[2J';
const ANSI_CURSOR_HOME = '\x1b[H';
const ANSI_HIDE_CURSOR = '\x1b[?25l';
const ANSI_SHOW_CURSOR = '\x1b[?25h';

function selectedMachines(machines: OrgMachine[], selected: boolean[]): OrgMachine[] {
  return machines.filter((_, index) => selected[index]);
}

function machineSelectionLine(
  machine: OrgMachine,
  index: number,
  selected: boolean[],
  cursor: number
): string {
  const pointer = index === cursor ? '>' : ' ';
  const checked = selected[index] ? 'x' : ' ';
  const region = machine.region ?? '-';
  const updatedAt = machine.updatedAt ?? '-';
  const userId = machine.config.metadata[METADATA_KEY_USER_ID] ?? '-';
  return `${pointer} [${checked}] ${index + 1}. ${machine.appName} ${machine.id} ${machine.state} ${region} ${userId} ${updatedAt}`;
}

function truncateLine(line: string): string {
  const terminalWidth =
    process.stdout.columns && process.stdout.columns > 20 ? process.stdout.columns : 120;
  if (line.length <= terminalWidth) return line;
  return `${line.slice(0, terminalWidth - 3)}...`;
}

function renderMachineSelector(machines: OrgMachine[], selected: boolean[], cursor: number): void {
  const selectedCount = selected.filter(Boolean).length;
  const lines = [
    'Select machines to destroy',
    'Space: toggle  Up/Down or j/k: move  a: toggle all  Enter: submit  q: cancel',
    `Selected: ${selectedCount}/${machines.length}`,
    '',
    '  [ ] #. app machine state region userId updatedAt',
    ...machines.map((machine, index) => machineSelectionLine(machine, index, selected, cursor)),
  ];

  process.stdout.write(
    `${ANSI_HIDE_CURSOR}${ANSI_CLEAR_SCREEN}${ANSI_CURSOR_HOME}${lines.map(truncateLine).join('\n')}`
  );
}

function printDestroySelection(machines: OrgMachine[]): void {
  printRows(
    machines.map((machine, index) => ({
      '#': index + 1,
      app: machine.appName,
      machine: machine.id,
      state: machine.state,
      region: machine.region ?? '',
      userId: machine.config.metadata[METADATA_KEY_USER_ID] ?? '',
      sandboxId: machine.config.metadata[METADATA_KEY_SANDBOX_ID] ?? '',
      updatedAt: machine.updatedAt ?? '',
    }))
  );
}

type Keypress = {
  name?: string;
  ctrl?: boolean;
};

async function selectMachinesForDestroy(
  machines: OrgMachine[],
  destroyAll: boolean
): Promise<OrgMachine[]> {
  if (destroyAll || machines.length === 0) return machines;

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(
      'Interactive destroy requires a TTY. Pass --yes to destroy all matched machines non-interactively.'
    );
  }

  return new Promise(resolve => {
    const selected = Array.from({ length: machines.length }, () => false);
    let cursor = 0;
    let resolved = false;

    const cleanup = (): void => {
      process.stdin.off('keypress', onKeypress);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write(`${ANSI_SHOW_CURSOR}${ANSI_CLEAR_SCREEN}${ANSI_CURSOR_HOME}`);
    };

    const finish = (selection: OrgMachine[]): void => {
      if (resolved) return;
      resolved = true;
      cleanup();
      resolve(selection);
    };

    const moveCursor = (delta: number): void => {
      cursor = (cursor + delta + machines.length) % machines.length;
      renderMachineSelector(machines, selected, cursor);
    };

    const toggleCurrent = (): void => {
      selected[cursor] = !selected[cursor];
      renderMachineSelector(machines, selected, cursor);
    };

    const toggleAll = (): void => {
      const nextValue = !selected.every(Boolean);
      selected.fill(nextValue);
      renderMachineSelector(machines, selected, cursor);
    };

    function onKeypress(_str: string, key: Keypress): void {
      if (key.ctrl && key.name === 'c') {
        finish([]);
        return;
      }

      switch (key.name) {
        case 'up':
        case 'k':
          moveCursor(-1);
          break;
        case 'down':
        case 'j':
          moveCursor(1);
          break;
        case 'space':
          toggleCurrent();
          break;
        case 'a':
          toggleAll();
          break;
        case 'return':
        case 'enter':
          finish(selectedMachines(machines, selected));
          break;
        case 'q':
        case 'escape':
          finish([]);
          break;
      }
    }

    emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('keypress', onKeypress);
    renderMachineSelector(machines, selected, cursor);
  });
}

async function destroyMachine(client: FlyApiClient, machine: OrgMachine): Promise<DestroyResult> {
  try {
    if (machine.state === 'destroyed' || machine.state === 'destroying') {
      return { machine, ok: true, message: `skipped ${machine.state}` };
    }

    const message = await flyDelete(
      client,
      `/apps/${encodeURIComponent(machine.appName)}/machines/${encodeURIComponent(machine.id)}?force=true`
    );
    return { machine, ok: true, message };
  } catch (err) {
    return { machine, ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

async function destroyMachines(
  client: FlyApiClient,
  machines: OrgMachine[],
  concurrency: number
): Promise<DestroyResult[]> {
  const queue = [...machines];
  const results: DestroyResult[] = [];
  const workerCount = Math.min(concurrency, machines.length);

  async function worker(): Promise<void> {
    while (queue.length > 0) {
      const machine = queue.shift();
      if (!machine) return;
      const result = await destroyMachine(client, machine);
      results.push(result);
      console.log(
        `${result.ok ? 'ok' : 'fail'}\t${machine.appName}\t${machine.id}\t${result.message}`
      );
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  if (options.destroy && options.allCreators) {
    throw new Error('--destroy cannot be combined with --all-creators; pass a specific --creator');
  }
  if (options.destroy && options.json && !options.yes) {
    throw new Error(
      '--json --destroy is non-interactive; pass --yes or omit --json for interactive selection.'
    );
  }
  if (options.destroy && options.org !== DEFAULT_ORG && !options.allowNonDevOrg) {
    throw new Error(`Refusing to destroy outside ${DEFAULT_ORG} without --allow-non-dev-org`);
  }

  const targetCreator = options.allCreators ? null : resolveCreator(options.creator);
  if (!options.allCreators && !targetCreator) {
    throw new Error(
      'Could not resolve creator. Pass --creator, set DEV_CREATOR, or log in with `fly auth login`.'
    );
  }

  const client = { token: resolveToken() } satisfies FlyApiClient;
  const allMachines = await listOrgMachines(client, options.org);
  const kiloClawMachines = allMachines.filter(isKiloClawMachine);
  const matchedMachines = options.allCreators
    ? kiloClawMachines
    : kiloClawMachines.filter(
        machine => machine.config.metadata[options.metadataKey] === targetCreator
      );
  const groups = groupByCreator(kiloClawMachines, options.metadataKey);

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          org: options.org,
          metadataKey: options.metadataKey,
          targetCreator,
          counts: {
            orgMachines: allMachines.length,
            kiloClawMachines: kiloClawMachines.length,
            matchedMachines: matchedMachines.length,
          },
          groups,
          machines: matchedMachines.map(machine => machineToReport(machine, options.metadataKey)),
        },
        null,
        2
      )
    );
  } else {
    printTextReport({
      org: options.org,
      metadataKey: options.metadataKey,
      targetCreator,
      allMachines,
      kiloClawMachines,
      matchedMachines,
      groups,
      destroy: options.destroy,
    });
  }

  if (!options.destroy) return;

  const machinesToDestroy = await selectMachinesForDestroy(matchedMachines, options.yes);
  if (machinesToDestroy.length === 0) {
    console.log('\nNo machines selected; nothing destroyed.');
    return;
  }

  console.log('\nDestroying selected machines:');
  const results = await destroyMachines(client, machinesToDestroy, options.concurrency);
  const failures = results.filter(result => !result.ok);

  console.log(
    `\nDestroy complete: ${results.length - failures.length} ok, ${failures.length} failed`
  );
  if (failures.length > 0) {
    process.exitCode = 1;
  }
}

main().catch(err => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
