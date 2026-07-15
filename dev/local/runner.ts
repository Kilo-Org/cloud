import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import { getService, getInfraProfile, getAllInfraProfiles } from './services';
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
  paneHasRunningChild,
  selectPane,
  setPaneTitle,
  setPaneServiceIdentity,
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
  if (svc.dir !== '.') parts.push(`cd ${shellQuote(path.join(findRepoRoot(), svc.dir))}`);
  parts.push(svc.command.join(' '));

  return parts.join(' && ');
}

// ---------------------------------------------------------------------------
// Tmux service lifecycle
// ---------------------------------------------------------------------------

export function startServiceInTmux(
  sessionName: string,
  serviceName: string,
  env?: Record<string, string>
): void {
  const svc = getService(serviceName);
  const startupCommand =
    svc.type === 'infra' ? buildInfraLogCommand(serviceName) : buildStartCommand(serviceName);
  const winIndex = createWindow(sessionName, serviceName, env, startupCommand);
  setPaneServiceIdentity(sessionName, winIndex, 0, serviceName);
  const logPath = path.join(findRepoRoot(), 'dev', 'logs', `${serviceName}.log`);
  pipePane(sessionName, winIndex, 0, buildLogPipeCommand(logPath));
}

function buildInfraLogCommand(serviceName: string): string {
  // Profile-gated services need --profile on every compose subcommand,
  // including `logs`. Without it, Compose v2 filters the service out of
  // the graph and the tmux pane is silent or errors. Shell-quote the
  // profile and service names — they are safe identifiers today but the
  // quoting keeps the command robust if a future maintainer adds a name
  // containing whitespace or metacharacters.
  const profile = getInfraProfile(serviceName);
  const profileArg = profile ? `--profile ${shellQuote(profile)} ` : '';
  return `docker compose ${profileArg}-f dev/docker-compose.yml logs -f ${shellQuote(serviceName)}`;
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
): string[] {
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

  if (serviceNames.length === 0) return [];

  // Join first service horizontally (right of sidebar pane 0)
  const firstWin = listWindows(sessionName).find(w => w.name === serviceNames[0]);
  if (!firstWin) return [];
  joinPane(sessionName, firstWin.index, 0, 0, 0, 'h');
  const joinedServiceNames = [serviceNames[0]];

  // Join subsequent services vertically below pane 1 (stacked in the right column)
  for (let i = 1; i < serviceNames.length; i++) {
    const win = listWindows(sessionName).find(w => w.name === serviceNames[i]);
    if (!win) continue;
    try {
      joinPane(sessionName, win.index, 0, 0, i, 'v');
      joinedServiceNames.push(serviceNames[i]);
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
  for (let i = 0; i < joinedServiceNames.length; i++) {
    try {
      setPaneTitle(sessionName, 0, i + 1, joinedServiceNames[i]);
    } catch {
      /* best-effort */
    }
  }

  selectPane(sessionName, 0, 0);
  return joinedServiceNames;
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
    const joinedServiceNames = setRightPanes(sessionName, [serviceName], currentPaneNames);
    return joinedServiceNames.length === 1 && joinedServiceNames[0] === serviceName
      ? serviceName
      : '';
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
  currentPaneNames: string
): string {
  if (serviceNames.length === 0) return currentPaneNames;
  try {
    const joinedServiceNames = setRightPanes(sessionName, serviceNames, currentPaneNames);
    return joinedServiceNames.length > 0 ? joinedServiceNames.join(',') : '';
  } catch {
    return currentPaneNames;
  }
}

export type RestartOutcome =
  // Relaunch command sent to the service's (now idle) shell.
  | 'relaunched'
  // Pane closed with the process; the service window was recreated.
  | 'recreated'
  // Old process refused to die within the deadline; nothing relaunched.
  | 'gave-up'
  // No pane for this service (not running), or infra service.
  | 'not-running'
  // A newer restart of the same service took over this poll.
  | 'superseded';

// In-flight restart polls keyed by `session:service`. A repeated restart
// (e.g. a second keypress in the dashboard) must cancel the previous poll:
// two concurrent polls would each relaunch, and the slower one would treat
// the freshly started service as "still shutting down" and interrupt it.
const inFlightRestarts = new Map<string, () => void>();

export function restartServiceInTmux(
  sessionName: string,
  serviceName: string,
  env?: Record<string, string>
): Promise<RestartOutcome> {
  const svc = getService(serviceName);
  if (svc.type === 'infra') return Promise.resolve('not-running');
  const cmd = buildStartCommand(serviceName);
  // Find the service wherever it lives (own window or joined into window 0).
  // Bail before touching the in-flight map: if the pane is already gone, a
  // previous restart's poll may be mid-recreate and must not be cancelled.
  const pane = findServicePane(sessionName, serviceName);
  if (!pane) return Promise.resolve('not-running');
  const restartKey = `${sessionName}:${serviceName}`;
  inFlightRestarts.get(restartKey)?.();
  sendInterrupt(sessionName, pane.windowIndex, pane.paneIndex);
  // Poll until the old process is actually gone before relaunching. A fixed
  // delay is not enough: slow-shutdown services (wrangler with containers
  // takes 10s+ on SIGINT) are still in the foreground when the relaunch
  // keystrokes arrive, which feeds the command into the dying process's
  // stdin instead of the shell and leaves the service stopped.
  const POLL_MS = 500;
  const ESCALATE_AT_MS = 15_000; // second SIGINT for shutdowns stuck on children
  const GIVE_UP_AT_MS = 60_000;
  return new Promise<RestartOutcome>(resolve => {
    let elapsed = 0;
    let escalated = false;
    const settle = (outcome: RestartOutcome) => {
      clearInterval(timer);
      if (inFlightRestarts.get(restartKey) === cancel) inFlightRestarts.delete(restartKey);
      resolve(outcome);
    };
    const cancel = () => settle('superseded');
    inFlightRestarts.set(restartKey, cancel);
    const timer = setInterval(() => {
      elapsed += POLL_MS;
      const currentPane = findServicePane(sessionName, serviceName);
      if (!currentPane) {
        // The pane can close together with the process (SIGINT kills the
        // non-interactive wrapper shell before its `exec $SHELL` runs, and
        // tmux closes a pane when its process exits). Recreate the service
        // window instead of leaving the service stopped after reporting
        // "Restarted"; the new window inherits the tmux session environment.
        try {
          startServiceInTmux(sessionName, serviceName, env);
          settle('recreated');
        } catch {
          // Same policy as below: keep the TUI alive; the next explicit
          // restart/view action can retry.
          settle('gave-up');
        }
        return;
      }
      if (paneHasRunningChild(sessionName, currentPane)) {
        if (elapsed >= GIVE_UP_AT_MS) {
          // Refuses to die — typing into it would only feed its stdin.
          settle('gave-up');
        } else if (!escalated && elapsed >= ESCALATE_AT_MS) {
          // Mirror a human's second ctrl-c: wrangler and friends force-quit
          // on a repeated interrupt when a graceful shutdown hangs.
          escalated = true;
          try {
            sendInterrupt(sessionName, currentPane.windowIndex, currentPane.paneIndex);
          } catch {
            // Pane may vanish between the check and the signal; next tick
            // handles it via the recreate branch.
          }
        }
        return;
      }
      try {
        const envArgs = Object.entries(env ?? {})
          .map(([key, value]) => `${key}=${shellQuote(value)}`)
          .join(' ');
        sendKeys(
          sessionName,
          currentPane.windowIndex,
          envArgs ? `env ${envArgs} ${cmd}` : cmd,
          currentPane.paneIndex
        );
        settle('relaunched');
      } catch {
        // The dashboard may have moved or closed the pane after we resolved it.
        // Keep the TUI alive; the next explicit restart/view action can retry.
        settle('gave-up');
      }
    }, POLL_MS);
  });
}

// ---------------------------------------------------------------------------
// Infrastructure
// ---------------------------------------------------------------------------

/**
 * Build `docker compose down` argv with `--profile` flags for every known
 * infra profile so profile-gated services (e.g. grafana) are torn down
 * alongside the default set. Compose v2's `down` behaviour with
 * profile-gated services has varied across versions; passing the flags
 * explicitly makes the teardown symmetric with startInfra and avoids
 * surprises. Returned as an argv array for execFileSync — keeps the
 * shell out of the loop entirely, matching startInfra.
 */
export function buildInfraDownArgs(): [string, string[]] {
  const profileArgs = getAllInfraProfiles().flatMap(p => ['--profile', p]);
  return ['docker', ['compose', ...profileArgs, '-f', 'dev/docker-compose.yml', 'down']];
}

export async function startInfra(repoRoot: string, serviceNames: string[]): Promise<void> {
  const infraServices = serviceNames.filter(name => getService(name).type === 'infra');
  if (infraServices.length === 0) return;

  const profiles = new Set<string>();
  for (const name of infraServices) {
    const profile = getInfraProfile(name);
    if (profile) profiles.add(profile);
  }
  const profileArgs = [...profiles].flatMap(p => [`--profile`, p]);

  // Pass --env-file so docker compose substitution sees secrets like
  // CF_AE_TOKEN without polluting the runner's process.env or exposing
  // every .env.local value to sibling child processes.
  const envFileArg = fs.existsSync(path.join(repoRoot, '.env.local'))
    ? ['--env-file', '.env.local']
    : [];

  const args = ['compose', ...envFileArg, '-f', 'dev/docker-compose.yml'];
  args.push(...profileArgs, 'up', '-d');
  execFileSync('docker', args, { cwd: repoRoot, stdio: 'inherit' });

  for (const name of infraServices) {
    const svc = getService(name);
    // Grafana is slow on first boot because it downloads plugins; postgres
    // periodically needs a longer window as well. Everything else is quick.
    // waitForPort warns and returns on timeout rather than throwing — a slow
    // plugin download will not block the session; Grafana appears in the
    // sidebar once the port opens on a subsequent probe.
    const maxWait = name === 'postgres' || name === 'grafana' ? 30_000 : 15_000;
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
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`^${escapedKey}=(.*)$`, 'm').exec(content);
  if (!match) return undefined;
  // Strip matching surrounding quotes so KEY="" and KEY='' read as empty
  // strings rather than two-character strings containing the quotes.
  // Returns "" (not undefined) for explicitly-empty values so callers can
  // distinguish "key absent from file" from "key present but empty".
  return match[1].replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1');
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
