import { readFile, readdir, readlink } from 'fs/promises';
import { basename, join } from 'path';
import { PREVIEW_PORT_MAX, PREVIEW_PORT_MIN } from '../../../src/shared/preview-port.js';
import {
  PREVIEW_SERVICES_MAX_COUNT,
  type PreviewService,
} from '../../../src/shared/preview-services.js';
import { isKiloServerProcess, readProcessTable, type ProcessEntry } from '../tool-cgroup.js';

/**
 * Live preview discovery inside one sandbox. It reads listening TCP sockets
 * from `/proc/net/tcp` and `/proc/net/tcp6`, attributes each socket inode to a
 * process through `/proc/<pid>/fd`, and derives a safe label from an allowlist
 * of executable/framework names. It never returns argv, environment values or
 * filesystem paths.
 */

const TCP_LISTEN_STATE = '0A';
const SOCKET_LINK = /^socket:\[(\d+)\]$/;
const SAFE_LABEL = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;
const SAFE_DIRECTORY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export const PREVIEW_SCAN_TIMEOUT_MS = 2_000;
const PREVIEW_SCAN_MAX_PROCESSES = 8_192;

/** Allowlisted framework/server labels. Matching is on an argv basename. */
const FRAMEWORK_LABELS: Record<string, string> = {
  next: 'Next.js',
  'next-server': 'Next.js',
  nextjs: 'Next.js',
  vite: 'Vite',
  webpack: 'Webpack',
  'webpack-dev-server': 'Webpack',
  'react-scripts': 'React',
  astro: 'Astro',
  nuxt: 'Nuxt',
  nuxt3: 'Nuxt',
  svelte: 'Svelte',
  sveltekit: 'SvelteKit',
  remix: 'Remix',
  angular: 'Angular',
  ng: 'Angular',
  gatsby: 'Gatsby',
  parcel: 'Parcel',
  expo: 'Expo',
  metro: 'Metro',
  storybook: 'Storybook',
  uvicorn: 'Uvicorn',
  gunicorn: 'Gunicorn',
  hypercorn: 'Hypercorn',
  flask: 'Flask',
  django: 'Django',
  'manage.py': 'Django',
  fastapi: 'FastAPI',
  rails: 'Rails',
  puma: 'Puma',
  artisan: 'PHP',
  'http-server': 'Static server',
  serve: 'Static server',
  sirv: 'Static server',
  'live-server': 'Static server',
};

const EXECUTABLE_LABELS: Record<string, string> = {
  node: 'Node.js',
  nodejs: 'Node.js',
  bun: 'Bun',
  deno: 'Deno',
  python: 'Python',
  python3: 'Python',
  php: 'PHP',
  ruby: 'Ruby',
  java: 'Java',
  go: 'Go',
  air: 'Go',
  cargo: 'Rust',
  dotnet: '.NET',
  spring: 'Spring',
  tsx: 'tsx',
};

const SHELL_BASENAMES = new Set(['bash', 'sh', 'zsh', 'fish', 'dash', 'ash']);

const FALLBACK_SERVICE_NAME = 'HTTP server';

type ListenerSocket = { inode: number; port: number };

export type PreviewServiceScanOptions = {
  procRoot?: string;
  signal?: AbortSignal;
  maxServices?: number;
  maxProcesses?: number;
  /** Ports the caller must never offer (Kilo control, provider control). */
  excludedPorts?: readonly number[];
  deadlineMs?: number;
  now?: () => number;
};

export class PreviewServiceScanTimeoutError extends Error {
  constructor() {
    super('Preview service scan exceeded its time budget');
    this.name = 'PreviewServiceScanTimeoutError';
  }
}

function safeToken(value: string | undefined): string | undefined {
  if (value === undefined || value.length === 0) return undefined;
  const leaf = value.slice(value.lastIndexOf('/') + 1);
  if (!SAFE_LABEL.test(leaf)) return undefined;
  return leaf;
}

function assertNotAborted(
  signal: AbortSignal | undefined,
  now: () => number,
  deadline: number
): void {
  if (signal?.aborted === true || now() >= deadline) throw new PreviewServiceScanTimeoutError();
}

function withDeadline<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
  now: () => number,
  deadline: number
): Promise<T> {
  if (signal?.aborted === true || now() >= deadline) {
    return Promise.reject(new PreviewServiceScanTimeoutError());
  }
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (action: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      action();
    };
    const onAbort = (): void => {
      finish(() => reject(new PreviewServiceScanTimeoutError()));
    };
    const timer = setTimeout(onAbort, Math.max(0, deadline - now()));
    signal?.addEventListener('abort', onAbort, { once: true });
    promise.then(
      value => finish(() => resolve(value)),
      error => finish(() => reject(error))
    );
  });
}

function parseTcpFile(text: string): ListenerSocket[] {
  const listeners: ListenerSocket[] = [];
  for (const line of text.split('\n')) {
    const fields = line.trim().split(/\s+/);
    // sl local_address rem_address st ... uid timeout inode
    if (fields.length < 10 || fields[3] !== TCP_LISTEN_STATE) continue;
    const local = fields[1];
    const separator = local.lastIndexOf(':');
    if (separator === -1) continue;
    const port = Number.parseInt(local.slice(separator + 1), 16);
    const inode = Number.parseInt(fields[9], 10);
    if (!Number.isInteger(port) || !Number.isInteger(inode) || inode <= 0) continue;
    if (port < PREVIEW_PORT_MIN || port > PREVIEW_PORT_MAX) continue;
    listeners.push({ inode, port });
  }
  return listeners;
}

async function readListenerSockets(
  procRoot: string,
  signal: AbortSignal | undefined,
  now: () => number,
  deadline: number
): Promise<ListenerSocket[]> {
  const listeners: ListenerSocket[] = [];
  let readAnyTable = false;
  for (const name of ['tcp', 'tcp6']) {
    assertNotAborted(signal, now, deadline);
    let text: string;
    try {
      text = await readFile(join(procRoot, 'net', name), 'utf8');
      readAnyTable = true;
    } catch {
      continue;
    }
    listeners.push(...parseTcpFile(text));
  }
  if (!readAnyTable) throw new Error('The sandbox TCP listener tables are not readable');
  return listeners;
}

async function readOwners(
  procRoot: string,
  table: Map<number, ProcessEntry>,
  inodes: ReadonlySet<number>,
  maxProcesses: number,
  signal: AbortSignal | undefined,
  now: () => number,
  deadline: number
): Promise<Map<number, ProcessEntry>> {
  const owners = new Map<number, ProcessEntry>();
  if (inodes.size === 0) return owners;
  const candidates = [...table.values()]
    .sort((left, right) => left.pid - right.pid)
    .slice(0, maxProcesses);

  for (const entry of candidates) {
    if (owners.size >= inodes.size) break;
    assertNotAborted(signal, now, deadline);
    let names: string[];
    try {
      names = await readdir(join(procRoot, String(entry.pid), 'fd'));
    } catch {
      continue;
    }
    for (const name of names) {
      assertNotAborted(signal, now, deadline);
      let target: string;
      try {
        target = await readlink(join(procRoot, String(entry.pid), 'fd', name));
      } catch {
        continue;
      }
      const match = SOCKET_LINK.exec(target);
      if (match === null) continue;
      const inode = Number.parseInt(match[1], 10);
      if (!inodes.has(inode) || owners.has(inode)) continue;
      owners.set(inode, entry);
      if (owners.size >= inodes.size) return owners;
    }
  }
  return owners;
}

async function readDirectoryLabel(procRoot: string, pid: number): Promise<string | undefined> {
  try {
    const target = await readlink(join(procRoot, String(pid), 'cwd'));
    const leaf = basename(target);
    return SAFE_DIRECTORY.test(leaf) && leaf !== '/' ? leaf : undefined;
  } catch {
    return undefined;
  }
}

function frameworkLabel(argv: readonly string[]): string | undefined {
  const executable = safeToken(argv[0]);
  if (executable !== undefined && SHELL_BASENAMES.has(executable.toLowerCase())) {
    return undefined;
  }
  for (const argument of argv) {
    const token = safeToken(argument)?.toLowerCase();
    if (token === undefined || !Object.hasOwn(FRAMEWORK_LABELS, token)) continue;
    const label = FRAMEWORK_LABELS[token];
    if (label !== undefined) return label;
  }
  return undefined;
}

function executableLabel(entry: ProcessEntry): string | undefined {
  const executable = safeToken(entry.argv[0]);
  if (executable === undefined) return undefined;
  const token = executable.toLowerCase();
  return Object.hasOwn(EXECUTABLE_LABELS, token) ? EXECUTABLE_LABELS[token] : undefined;
}

function deriveServiceName(entry: ProcessEntry | undefined): string {
  if (entry === undefined) return FALLBACK_SERVICE_NAME;
  const framework = frameworkLabel(entry.argv);
  if (framework !== undefined) return framework;
  return executableLabel(entry) ?? FALLBACK_SERVICE_NAME;
}

/**
 * Discovers live listening services. Callers get a deterministic, deduplicated
 * and sorted list. A successful scan with no listeners returns an empty list;
 * a timeout throws so the caller can distinguish "nothing listening" from "could
 * not look".
 */
export async function scanPreviewServices(
  options: PreviewServiceScanOptions = {}
): Promise<PreviewService[]> {
  const now = options.now ?? Date.now;
  const deadline = now() + (options.deadlineMs ?? PREVIEW_SCAN_TIMEOUT_MS);
  const procRoot = options.procRoot ?? '/proc';
  const maxServices = options.maxServices ?? PREVIEW_SERVICES_MAX_COUNT;
  const maxProcesses = options.maxProcesses ?? PREVIEW_SCAN_MAX_PROCESSES;
  const excludedPorts = new Set(options.excludedPorts ?? []);

  const listeners = (await readListenerSockets(procRoot, options.signal, now, deadline)).filter(
    listener => !excludedPorts.has(listener.port)
  );
  if (listeners.length === 0) return [];
  assertNotAborted(options.signal, now, deadline);

  const table = await withDeadline(readProcessTable(procRoot), options.signal, now, deadline);
  assertNotAborted(options.signal, now, deadline);
  const inodes = new Set(listeners.map(listener => listener.inode));
  const owners = await readOwners(
    procRoot,
    table,
    inodes,
    maxProcesses,
    options.signal,
    now,
    deadline
  );
  const kiloPids = new Set(
    [...table.values()].filter(entry => isKiloServerProcess(entry.argv)).map(entry => entry.pid)
  );
  const discoverable = listeners.filter(listener => {
    const owner = owners.get(listener.inode);
    return owner !== undefined && !kiloPids.has(owner.pid);
  });

  const inodesByPort = new Map<number, number[]>();
  for (const listener of discoverable) {
    const portInodes = inodesByPort.get(listener.port);
    if (portInodes === undefined) {
      inodesByPort.set(listener.port, [listener.inode]);
    } else if (!portInodes.includes(listener.inode)) {
      portInodes.push(listener.inode);
    }
  }

  const services: PreviewService[] = [];
  for (const port of [...inodesByPort.keys()].sort((left, right) => left - right)) {
    if (services.length >= maxServices) break;
    assertNotAborted(options.signal, now, deadline);
    const portInodes = inodesByPort.get(port) ?? [];
    const entry = portInodes
      .map(inode => owners.get(inode))
      .filter((candidate): candidate is ProcessEntry => candidate !== undefined)
      .sort((left, right) => left.pid - right.pid)[0];
    const name = deriveServiceName(entry);
    const directory =
      entry === undefined ? undefined : await readDirectoryLabel(procRoot, entry.pid);
    services.push({
      port,
      name,
      ...(directory === undefined ? {} : { description: `in ${directory}` }),
    });
  }

  return services;
}
