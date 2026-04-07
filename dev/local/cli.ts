import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  resolveTargets,
  getService,
  getGroups,
  getAlwaysOnGroupIds,
  getGroupServiceNames,
  resolveGroups,
  topologicalSort,
  portOffset,
} from './services';
import { syncEnvVars } from './env-sync';
import {
  getSessionName,
  sessionExists,
  findOtherKiloDevSessions,
  createSession,
  killSession,
  attachSession,
  sendKeys,
  selectWindow,
  listWindows,
  splitWindowHorizontal,
  setMainLeftLayout,
  joinPane,
  selectPane,
  setPaneTitle,
  enablePaneBorders,
  isTmuxAvailable,
} from './tmux';
import {
  findRepoRoot,
  startServiceInTmux,
  startInfra,
  readEnvValue,
  readEnvMtime,
  waitForEnvValueChange,
} from './runner';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

function determineEnabledGroups(serviceNames: string[]): string[] {
  const nameSet = new Set(serviceNames);
  const enabled: string[] = [];
  for (const group of getGroups()) {
    const members = getGroupServiceNames(group.id);
    if (members.length > 0 && members.every(m => nameSet.has(m))) {
      enabled.push(group.id);
    }
  }
  return enabled;
}

// ---------------------------------------------------------------------------
// ANSI helpers
// ---------------------------------------------------------------------------

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const GREEN = '\x1b[32m';

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function cmdUp(targets: string[], repoRoot: string): Promise<void> {
  // --- Preflight checks ---
  if (!isTmuxAvailable()) {
    console.error('tmux is not installed. Install it with: brew install tmux');
    process.exit(1);
  }

  try {
    execSync('docker info', { stdio: 'ignore' });
  } catch {
    console.error('Docker is not running. Start Docker Desktop and try again.');
    process.exit(1);
  }

  if (!fs.existsSync(path.join(repoRoot, 'node_modules'))) {
    console.error('node_modules not found. Run: pnpm install');
    process.exit(1);
  }

  const envLocalExists = fs.existsSync(path.join(repoRoot, '.env.local'));
  if (!envLocalExists) {
    console.warn('⚠ .env.local not found — worker secrets will use defaults.');
    console.warn('  To sync from Vercel: vercel env pull .env.local');
  }

  // --- Export port offset for child processes (e.g. scripts/dev.sh) ---
  process.env.KILO_PORT_OFFSET = String(portOffset);

  const otherSessions = findOtherKiloDevSessions();
  if (otherSessions.length > 0) {
    console.warn(`⚠ Other kilo-dev sessions are running: ${otherSessions.join(', ')}`);
    if (portOffset > 0) {
      console.warn(`  This worktree uses port offset ${portOffset}`);
    } else {
      console.warn(
        '  Port conflicts are likely. Set KILO_PORT_OFFSET=auto or stop other sessions.'
      );
    }
  }

  if (portOffset > 0) {
    console.log(`${DIM}Port offset: ${portOffset} (KILO_PORT_OFFSET)${RESET}`);
  }

  // --- Check for existing session ---
  const sessionName = getSessionName();
  if (sessionExists(sessionName)) {
    console.log(`Session ${sessionName} already running — attaching.`);
    attachSession(sessionName);
    return;
  }

  // --- Resolve targets ---
  // Always start core (always-on) groups; additional targets are merged in
  const coreServices = resolveGroups(getAlwaysOnGroupIds());
  const extraServices = targets.length === 0 ? [] : resolveTargets(targets);
  const serviceNames = topologicalSort([...new Set([...coreServices, ...extraServices])]);

  // --- Start Docker infra ---
  const hasInfra = serviceNames.some(name => getService(name).type === 'infra');
  if (hasInfra) {
    console.log(`${BOLD}Starting infrastructure…${RESET}`);
    await startInfra(repoRoot, serviceNames);
    console.log();
  }

  // --- Create tmux session ---
  createSession(sessionName);

  // --- Start each service in its own tmux window ---
  const SIDEBAR_WIDTH = 40;

  // --- Start capture services first (tunnel, stripe) and wait for output ---
  const captureServiceSet = new Set(['kiloclaw-tunnel', 'kiloclaw-stripe', 'app-builder-tunnel']);
  const captureServices = serviceNames.filter(n => captureServiceSet.has(n));
  const otherServices = serviceNames.filter(n => !captureServiceSet.has(n));

  if (captureServices.length > 0) {
    const oldValues = new Map<string, string | undefined>();
    const oldMtimes = new Map<string, number | undefined>();
    if (captureServices.includes('kiloclaw-tunnel')) {
      const tunnelEnvPath = path.join(repoRoot, 'services/kiloclaw/.dev.vars');
      oldValues.set('tunnel', readEnvValue(tunnelEnvPath, 'KILOCODE_API_BASE_URL'));
      oldMtimes.set('tunnel', readEnvMtime(tunnelEnvPath));
    }
    if (captureServices.includes('kiloclaw-stripe')) {
      const stripeEnvPath = path.join(repoRoot, '.env.development.local');
      oldValues.set('stripe', readEnvValue(stripeEnvPath, 'STRIPE_WEBHOOK_SECRET'));
      oldMtimes.set('stripe', readEnvMtime(stripeEnvPath));
    }
    if (captureServices.includes('app-builder-tunnel')) {
      const appBuilderEnvPath = path.join(repoRoot, 'services/app-builder/.dev.vars');
      oldValues.set('app-builder-tunnel', readEnvValue(appBuilderEnvPath, 'BUILDER_HOSTNAME'));
      oldMtimes.set('app-builder-tunnel', readEnvMtime(appBuilderEnvPath));
    }

    for (const name of captureServices) {
      startServiceInTmux(sessionName, name);
      await sleep(300);
    }

    console.log(`${BOLD}Waiting for capture services...${RESET}`);
    const waits: Promise<void>[] = [];

    if (captureServices.includes('kiloclaw-tunnel')) {
      waits.push(
        waitForEnvValueChange(
          path.join(repoRoot, 'services/kiloclaw/.dev.vars'),
          'KILOCODE_API_BASE_URL',
          oldValues.get('tunnel'),
          30_000,
          oldMtimes.get('tunnel')
        ).then(ready => {
          if (ready) {
            console.log('  Tunnel URL captured');
          } else {
            console.warn('  Tunnel URL not captured after 30s - check kiloclaw-tunnel window');
          }
        })
      );
    }

    if (captureServices.includes('kiloclaw-stripe')) {
      waits.push(
        waitForEnvValueChange(
          path.join(repoRoot, '.env.development.local'),
          'STRIPE_WEBHOOK_SECRET',
          oldValues.get('stripe'),
          30_000,
          oldMtimes.get('stripe')
        ).then(ready => {
          if (ready) {
            console.log('  Stripe webhook secret captured');
          } else {
            console.warn('  Stripe secret not captured after 30s - check kiloclaw-stripe window');
          }
        })
      );
    }

    if (captureServices.includes('app-builder-tunnel')) {
      waits.push(
        waitForEnvValueChange(
          path.join(repoRoot, 'services/app-builder/.dev.vars'),
          'BUILDER_HOSTNAME',
          oldValues.get('app-builder-tunnel'),
          30_000,
          oldMtimes.get('app-builder-tunnel')
        ).then(ready => {
          if (ready) {
            console.log('  App builder tunnel URL captured');
          } else {
            console.warn(
              '  App builder tunnel URL not captured after 30s - check app-builder-tunnel window'
            );
          }
        })
      );
    }

    await Promise.all(waits);
    console.log();
  }

  for (const name of otherServices) {
    startServiceInTmux(sessionName, name);
    await sleep(300);
  }

  // --- Set up split layout in window 0: left=sidebar, right=service terminal ---
  // Join the preferred service's pane into window 0 as pane 1 (right column).
  // join-pane moves the pane process — no ghost shells.
  let initialViewedService = '';
  if (serviceNames.length > 0) {
    const preferred = serviceNames.includes('nextjs') ? 'nextjs' : serviceNames[0];
    const windows = listWindows(sessionName);
    const preferredWin = windows.find(w => w.name === preferred);
    if (preferredWin) {
      joinPane(sessionName, preferredWin.index, 0, 0, 0, 'h');
      initialViewedService = preferred;
    }
  } else {
    // No services — create an empty right pane so window 0 has a split
    splitWindowHorizontal(sessionName, 0);
  }

  // Use main-vertical layout so the sidebar stays at SIDEBAR_WIDTH even after terminal resizes.
  setMainLeftLayout(sessionName, 0, SIDEBAR_WIDTH);

  // Show service names in pane border titles
  enablePaneBorders(sessionName, 0);
  if (initialViewedService) {
    setPaneTitle(sessionName, 0, 1, initialViewedService);
  }

  // --- Start sidebar TUI in left pane (0.0) ---
  const enabledGroupIds = determineEnabledGroups(serviceNames);
  const dashboardArgs = [
    JSON.stringify(serviceNames),
    initialViewedService,
    JSON.stringify(enabledGroupIds),
  ];
  const dashboardCmd = `tsx dev/local/dashboard.tsx ${dashboardArgs.map(a => JSON.stringify(a)).join(' ')}`;
  sendKeys(sessionName, 0, dashboardCmd, 0);

  // --- Focus sidebar pane and attach ---
  selectPane(sessionName, 0, 0);
  selectWindow(sessionName, 0);
  console.log(`${GREEN}Started ${serviceNames.length} services in session ${sessionName}${RESET}`);
  attachSession(sessionName);
}

async function cmdStop(repoRoot: string): Promise<void> {
  const sessionName = getSessionName();

  if (sessionExists(sessionName)) {
    killSession(sessionName);
    console.log(`Killed tmux session ${sessionName}`);
  }

  console.log('Stopping Docker infrastructure…');
  try {
    execSync('docker compose -f dev/docker-compose.yml down', { cwd: repoRoot, stdio: 'inherit' });
  } catch {
    // docker compose down may fail if nothing is running
  }

  console.log(`${GREEN}All services stopped.${RESET}`);
}

async function cmdEnv(args: string[], repoRoot: string): Promise<void> {
  const check = args.includes('--check') || args.includes('check');
  const yes = args.includes('--yes') || args.includes('-y');
  const targets = args.filter(a => !a.startsWith('-') && a !== 'check');

  const result = await syncEnvVars({
    repoRoot,
    check,
    yes,
    targets: targets.length > 0 ? targets : undefined,
  });

  if (!result.ok) {
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

function printUsage(): void {
  console.log(`
Usage:
  dev:start [targets...]  Start services (default: core)
  dev:stop                Stop all services
  dev:env [targets...]    Sync env vars (.dev.vars + .env.development.local)
  dev:env --check         Validate env vars (CI mode)
  dev:env -y              Sync without confirmation

Targets: app, app-builder, agents, all, or any service/group name
Multiple targets can be specified: dev:start kiloclaw agents`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];
  const repoRoot = findRepoRoot();

  switch (command) {
    case 'up':
      await cmdUp(args.slice(1), repoRoot);
      break;
    case 'stop':
      await cmdStop(repoRoot);
      break;
    case 'env':
      await cmdEnv(args.slice(1), repoRoot);
      break;
    default:
      if (command) {
        console.error(`Unknown command: ${command}`);
      }
      printUsage();
      process.exit(1);
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
