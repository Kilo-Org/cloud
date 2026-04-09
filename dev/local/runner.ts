import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import { getService } from './services';
import {
  createWindow,
  sendKeys,
  sendInterrupt,
  listWindows,
  killWindow,
  killPane,
  joinPane,
  breakPane,
  countPanes,
  findServicePane,
  selectPane,
  setPaneTitle,
  setMainLeftLayout,
  pipePane,
} from './tmux';

// ---------------------------------------------------------------------------
// Repo root
// ---------------------------------------------------------------------------

export function findRepoRoot(): string {
  let dir = import.meta.dirname;
  for (let i = 0; i < 20; i++) {
    const pkgPath = path.join(dir, 'package.json');
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
        if (pkg.name === 'kilocode-monorepo') return dir;
      } catch {
        // Not valid JSON, keep walking
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error("Could not find repo root (package.json with name 'kilocode-monorepo')");
}

// ---------------------------------------------------------------------------
// Port probing
// ---------------------------------------------------------------------------

export function probePort(port: number, timeoutMs = 500): Promise<boolean> {
  return new Promise(resolve => {
    const socket = new net.Socket();
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('timeout', () => {
      socket.destroy();
      resolve(false);
    });
    socket.once('error', () => {
      socket.destroy();
      resolve(false);
    });
    socket.connect(port, '127.0.0.1');
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function waitForPort(port: number, name: string, maxWaitMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    if (await probePort(port)) return;
    await sleep(500);
  }
  console.warn(`⚠ ${name} on port ${port} did not become ready within ${maxWaitMs / 1000}s`);
}

// ---------------------------------------------------------------------------
// Command building
// ---------------------------------------------------------------------------

export function buildStartCommand(serviceName: string): string {
  const svc = getService(serviceName);

  // Use pnpm --filter instead of cd to avoid cwd issues on restart —
  // after ctrl-c the shell stays in the service dir, so a relative cd
  // would try to descend into <dir>/<dir> which doesn't exist.
  if (svc.dir !== '.' && svc.command[0] === 'pnpm') {
    const [, ...rest] = svc.command;
    return `pnpm --filter {./${svc.dir}} ${rest.join(' ')}`;
  }

  const parts: string[] = [];
  if (svc.dir !== '.') parts.push(`cd ${svc.dir}`);
  parts.push(svc.command.join(' '));

  return parts.join(' && ');
}

// ---------------------------------------------------------------------------
// Tmux service lifecycle
// ---------------------------------------------------------------------------

export function startServiceInTmux(sessionName: string, serviceName: string): void {
  const svc = getService(serviceName);
  const winIndex = createWindow(sessionName, serviceName);
  if (svc.type === 'infra') {
    sendKeys(
      sessionName,
      serviceName,
      `docker compose -f dev/docker-compose.yml logs -f ${serviceName}`
    );
  } else {
    sendKeys(sessionName, serviceName, buildStartCommand(serviceName));
  }
  const logPath = path.join(findRepoRoot(), 'dev', 'logs', `${serviceName}.log`);
  pipePane(sessionName, winIndex, 0, buildLogPipeCommand(logPath));
}

function buildLogPipeCommand(logPath: string): string {
  const filterPath = path.join(findRepoRoot(), 'dev', 'local', 'log-filter.ts');
  return `tsx ${shellQuote(filterPath)} >> ${shellQuote(logPath)}`;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export function stopServiceInTmux(sessionName: string, serviceName: string): void {
  const svc = getService(serviceName);
  const windows = listWindows(sessionName);
  const win = windows.find(w => w.name === serviceName);
  if (!win) return;
  if (svc.type !== 'infra') {
    sendInterrupt(sessionName, win.index);
  }
  killWindow(sessionName, win.index);
}

const SIDEBAR_WIDTH = 40;

/**
 * Replace all right-side panes in window 0 with the given service panes.
 *
 * Uses join-pane to move each service's pane from its own window into window 0.
 * The process travels with its pane — no ghost shells.
 * Before joining, any currently joined panes are broken back out to named windows.
 *
 * currentPaneNames: comma-separated service names currently shown in panes 1+
 * (empty string if pane 1 is the initial empty split from startup, which gets killed).
 */
function setRightPanes(
  sessionName: string,
  serviceNames: string[],
  currentPaneNames: string
): void {
  // Break all current right-side panes (>= 1) back to their own named windows
  const total = countPanes(sessionName, 0);
  const current = currentPaneNames ? currentPaneNames.split(',') : [];
  // Break in reverse order to avoid index shifts
  for (let i = total - 1; i >= 1; i--) {
    const name = current[i - 1];
    if (name) {
      // Service pane — break back to its named window
      try {
        breakPane(sessionName, 0, i, name);
      } catch {
        // If break fails, just kill the pane
        try {
          killPane(sessionName, 0, i);
        } catch {
          /* ignore */
        }
      }
    } else {
      // Empty shell from initial startup split — just kill it
      try {
        killPane(sessionName, 0, i);
      } catch {
        /* ignore */
      }
    }
  }

  if (serviceNames.length === 0) return;

  // Join first service horizontally (right of sidebar pane 0)
  const firstWin = listWindows(sessionName).find(w => w.name === serviceNames[0]);
  if (!firstWin) return;
  joinPane(sessionName, firstWin.index, 0, 0, 0, 'h');

  // Join subsequent services vertically below pane 1 (stacked in the right column)
  for (let i = 1; i < serviceNames.length; i++) {
    const win = listWindows(sessionName).find(w => w.name === serviceNames[i]);
    if (!win) continue;
    try {
      joinPane(sessionName, win.index, 0, 0, i, 'v');
    } catch {
      // skip service if join fails
    }
  }

  // main-vertical keeps sidebar as the fixed left column with fixed width;
  // distributes right-column panes equally in height
  try {
    setMainLeftLayout(sessionName, 0, SIDEBAR_WIDTH);
  } catch {
    // best-effort
  }

  // Label each right-side pane so pane border titles show the service name
  for (let i = 0; i < serviceNames.length; i++) {
    try {
      setPaneTitle(sessionName, 0, i + 1, serviceNames[i]);
    } catch {
      /* best-effort */
    }
  }

  selectPane(sessionName, 0, 0);
}

/**
 * Show a single service in the right pane of window 0.
 * The service's pane is moved (join-pane) from its own window into window 0.
 * Returns the service name now shown (unchanged on failure).
 */
export function showServiceInTmux(
  sessionName: string,
  serviceName: string,
  currentPaneNames: string,
  currentViewedIsGroup: boolean
): string {
  if (serviceName === currentPaneNames && !currentViewedIsGroup) return currentPaneNames;
  try {
    setRightPanes(sessionName, [serviceName], currentPaneNames);
    return serviceName;
  } catch {
    return currentPaneNames;
  }
}

/**
 * Show all running services in a group as stacked panes in the right column of window 0.
 * Returns a comma-joined string of service names shown.
 */
export function showGroupInTmux(
  sessionName: string,
  serviceNames: string[],
  currentPaneNames: string,
  currentViewedIsGroup: boolean
): string {
  if (serviceNames.length === 0) return currentPaneNames;
  try {
    setRightPanes(sessionName, serviceNames, currentPaneNames);
    return serviceNames.join(',');
  } catch {
    return currentPaneNames;
  }
}

export function restartServiceInTmux(sessionName: string, serviceName: string): void {
  const svc = getService(serviceName);
  if (svc.type === 'infra') return;
  const cmd = buildStartCommand(serviceName);
  // Find the service wherever it lives (own window or joined into window 0)
  const pane = findServicePane(sessionName, serviceName);
  if (!pane) return;
  sendInterrupt(sessionName, pane.windowIndex, pane.paneIndex);
  setTimeout(() => sendKeys(sessionName, pane.windowIndex, cmd, pane.paneIndex), 1000);
}

// ---------------------------------------------------------------------------
// Infrastructure
// ---------------------------------------------------------------------------

export async function startInfra(repoRoot: string, serviceNames: string[]): Promise<void> {
  const infraServices = serviceNames.filter(name => getService(name).type === 'infra');
  if (infraServices.length === 0) return;
  execSync('docker compose -f dev/docker-compose.yml up -d', { cwd: repoRoot, stdio: 'inherit' });
  for (const name of infraServices) {
    const svc = getService(name);
    const maxWait = name === 'postgres' ? 30_000 : 15_000;
    await waitForPort(svc.port, name, maxWait);
  }
}

// ---------------------------------------------------------------------------
// Env value helpers (used for capture-service coordination)
// ---------------------------------------------------------------------------

export function readEnvValue(filePath: string, key: string): string | undefined {
  let content: string;
  try {
    content = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return undefined;
  }
  const match = new RegExp(`^${key}=(.*)$`, 'm').exec(content);
  return match ? match[1] : undefined;
}

export function readEnvMtime(filePath: string): number | undefined {
  try {
    return fs.statSync(filePath).mtimeMs;
  } catch {
    return undefined;
  }
}

export async function waitForEnvValueChange(
  filePath: string,
  key: string,
  previousValue: string | undefined,
  timeoutMs: number,
  previousMtimeMs?: number
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const current = readEnvValue(filePath, key);
    const currentMtimeMs = readEnvMtime(filePath);
    const fileWasRewritten =
      previousMtimeMs !== undefined &&
      currentMtimeMs !== undefined &&
      currentMtimeMs > previousMtimeMs;

    if (current !== undefined && (current !== previousValue || fileWasRewritten)) return true;
    await sleep(500);
  }
  return false;
}
