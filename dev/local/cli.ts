import { execFileSync, execSync } from 'node:child_process';
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
  services,
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
  findServicePane,
  isPaneRunningCommand,
} from './tmux';
import {
  findRepoRoot,
  startServiceInTmux,
  startInfra,
  buildInfraDownArgs,
  readEnvValue,
  readEnvMtime,
  waitForEnvValueChange,
  probePort,
  restartServiceInTmux,
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
const CAPTURE_TIMEOUT_MS = 30_000;

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

  const envLocalPath = path.join(repoRoot, '.env.local');
  const envLocalExists = fs.existsSync(envLocalPath);
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

  // --- Check for socat when kiloclaw-docker-tcp is requested ---
  if (serviceNames.includes('kiloclaw-docker-tcp')) {
    try {
      execSync('which socat', { stdio: 'ignore' });
    } catch {
      console.error('socat is not installed. Install it with: brew install socat');
      process.exit(1);
    }
  }

  // --- Warn if grafana is enabled but CF_AE_TOKEN is not set ---
  // Grafana boots fine without the token; only dashboard queries fail. Treat
  // this as advisory so devs poking around the repo don't get blocked. Check
  // .env.local in addition to the shell so the warning doesn't fire when the
  // token is set in the file (docker compose picks it up via --env-file).
  if (serviceNames.includes('grafana')) {
    const tokenFromShell = process.env.CF_AE_TOKEN;
    const tokenFromFile = envLocalExists ? readEnvValue(envLocalPath, 'CF_AE_TOKEN') : undefined;
    if (!tokenFromShell && !tokenFromFile) {
      console.warn('⚠ CF_AE_TOKEN not set — Grafana will boot but AE queries will fail.');
      console.warn('  Create a CF user API token with "All accounts → Account Analytics: Read",');
      console.warn('  then add CF_AE_TOKEN=<token> to .env.local. See dev/grafana/README.md.');
    }
  }

  // --- Start Docker infra ---
  const hasInfra = serviceNames.some(name => getService(name).type === 'infra');
  if (hasInfra) {
    console.log(`${BOLD}Starting infrastructure…${RESET}`);
    await startInfra(repoRoot, serviceNames);
    console.log();
  }

  // --- Prepare log directory ---
  const logDir = path.join(repoRoot, 'dev', 'logs');
  fs.mkdirSync(logDir, { recursive: true });
  for (const entry of fs.readdirSync(logDir)) {
    fs.unlinkSync(path.join(logDir, entry));
  }

  // --- Create tmux session ---
  createSession(sessionName);

  // --- Start each service in its own tmux window ---
  const SIDEBAR_WIDTH = 40;

  // --- Start capture services first (tunnel, stripe) and wait for output ---
  const captureServiceSet = new Set(['kiloclaw-tunnel', 'kiloclaw-stripe', 'app-builder-tunnel']);
  const captureServices = serviceNames.filter(n => captureServiceSet.has(n));
  const otherServices = serviceNames.filter(n => !captureServiceSet.has(n));
  const startedServices: string[] = [];
  let kiloclawTunnelCaptured = true;

  if (captureServices.length > 0) {
    const oldValues = new Map<string, string | undefined>();
    const oldMtimes = new Map<string, number | undefined>();
    if (captureServices.includes('kiloclaw-tunnel')) {
      const tunnelEnvPath = path.join(repoRoot, 'services/kiloclaw/.dev.vars');
      oldValues.set('tunnel', readEnvValue(tunnelEnvPath, 'KILOCODE_API_BASE_URL'));
      oldValues.set('checkin', readEnvValue(tunnelEnvPath, 'KILOCLAW_CHECKIN_URL'));
      oldValues.set('kilochat', readEnvValue(tunnelEnvPath, 'KILOCHAT_BASE_URL'));
      oldMtimes.set('tunnel', readEnvMtime(tunnelEnvPath));
      oldMtimes.set('checkin', readEnvMtime(tunnelEnvPath));
      oldMtimes.set('kilochat', readEnvMtime(tunnelEnvPath));
    }
    if (captureServices.includes('kiloclaw-stripe')) {
      const stripeEnvPath = path.join(repoRoot, 'apps/web/.env.development.local');
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
      startedServices.push(name);
      await sleep(300);
    }

    console.log(`${BOLD}Waiting for capture services...${RESET}`);
    const waits: Promise<void>[] = [];

    if (captureServices.includes('kiloclaw-tunnel')) {
      waits.push(
        Promise.all([
          waitForEnvValueChange(
            path.join(repoRoot, 'services/kiloclaw/.dev.vars'),
            'KILOCODE_API_BASE_URL',
            oldValues.get('tunnel'),
            CAPTURE_TIMEOUT_MS,
            oldMtimes.get('tunnel')
          ),
          waitForEnvValueChange(
            path.join(repoRoot, 'services/kiloclaw/.dev.vars'),
            'KILOCLAW_CHECKIN_URL',
            oldValues.get('checkin'),
            CAPTURE_TIMEOUT_MS,
            oldMtimes.get('checkin')
          ),
          waitForEnvValueChange(
            path.join(repoRoot, 'services/kiloclaw/.dev.vars'),
            'KILOCHAT_BASE_URL',
            oldValues.get('kilochat'),
            CAPTURE_TIMEOUT_MS,
            oldMtimes.get('kilochat')
          ),
        ]).then(([gatewayReady, checkinReady, kiloChatReady]) => {
          kiloclawTunnelCaptured = gatewayReady && checkinReady && kiloChatReady;
          if (kiloclawTunnelCaptured) {
            console.log('  KiloClaw tunnel URLs captured');
            return;
          }

          if (!gatewayReady) {
            console.warn(
              '  KILOCODE_API_BASE_URL not captured after 30s - kiloclaw startup will wait for a retry'
            );
          }
          if (!checkinReady) {
            console.warn(
              '  KILOCLAW_CHECKIN_URL not captured after 30s - kiloclaw startup will wait for a retry'
            );
          }
          if (!kiloChatReady) {
            console.warn(
              '  KILOCHAT_BASE_URL not captured after 30s - kiloclaw startup will wait for a retry'
            );
          }
        })
      );
    }

    if (captureServices.includes('kiloclaw-stripe')) {
      waits.push(
        waitForEnvValueChange(
          path.join(repoRoot, 'apps/web/.env.development.local'),
          'STRIPE_WEBHOOK_SECRET',
          oldValues.get('stripe'),
          CAPTURE_TIMEOUT_MS,
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
          CAPTURE_TIMEOUT_MS,
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

  const skippedServices: string[] = [];
  for (const name of otherServices) {
    const dependsOnKiloclaw = getService(name).dependsOn.includes('kiloclaw');
    if (!kiloclawTunnelCaptured && (name === 'kiloclaw' || dependsOnKiloclaw)) {
      skippedServices.push(name);
      continue;
    }

    startServiceInTmux(sessionName, name);
    startedServices.push(name);
    await sleep(300);
  }

  if (skippedServices.length > 0) {
    console.warn(
      `Skipped startup for ${skippedServices.join(', ')} until KILOCODE_API_BASE_URL, KILOCLAW_CHECKIN_URL, and KILOCHAT_BASE_URL are captured.`
    );
    console.warn('Start or restart these services after the tunnel URL is ready.');
  }

  // --- Set up split layout in window 0: left=sidebar, right=service terminal ---
  // Join the preferred service's pane into window 0 as pane 1 (right column).
  // join-pane moves the pane process — no ghost shells.
  let initialViewedService = '';
  if (startedServices.length > 0) {
    const preferred = startedServices.includes('nextjs') ? 'nextjs' : startedServices[0];
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
  const enabledGroupIds = determineEnabledGroups(startedServices);
  const dashboardArgs = [
    JSON.stringify(startedServices),
    initialViewedService,
    JSON.stringify(enabledGroupIds),
  ];
  const dashboardCmd = `tsx dev/local/dashboard.tsx ${dashboardArgs.map(a => JSON.stringify(a)).join(' ')}`;
  sendKeys(sessionName, 0, dashboardCmd, 0);

  // --- Focus sidebar pane and attach ---
  selectPane(sessionName, 0, 0);
  selectWindow(sessionName, 0);

  // --- Write manifest for agents ---
  writeManifest(repoRoot, sessionName, startedServices);

  console.log(
    `${GREEN}Started ${startedServices.length} services in session ${sessionName}${RESET}`
  );
  attachSession(sessionName);
}

type ServiceStatus = 'up' | 'down';

type StatusEntry = {
  name: string;
  port: number;
  status: ServiceStatus;
  group: string;
};

type ManifestEntry = {
  name: string;
  port: number;
  group: string;
  type: string;
};

type Manifest = {
  session: string;
  portOffset: number;
  services: ManifestEntry[];
};

function writeManifest(repoRoot: string, sessionName: string, serviceNames: string[]): void {
  const manifest: Manifest = {
    session: sessionName,
    portOffset,
    services: serviceNames.map(name => {
      const svc = getService(name);
      return { name, port: svc.port, group: svc.group, type: svc.type };
    }),
  };
  const manifestPath = path.join(repoRoot, 'dev', 'logs', 'manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
}

async function cmdStatus(repoRoot: string, isJson = false): Promise<void> {
  const sessionName = getSessionName();
  if (!sessionExists(sessionName)) {
    if (isJson) {
      console.log(JSON.stringify({ session: sessionName, portOffset, services: [] }));
    } else {
      console.log('No dev session running');
    }
    return;
  }

  const runningServices = [...services.keys()].flatMap(name => {
    const pane = findServicePane(sessionName, name);
    return pane ? [{ name, pane }] : [];
  });
  if (runningServices.length === 0) {
    if (isJson) {
      console.log(JSON.stringify({ session: sessionName, portOffset, services: [] }));
    } else {
      console.log('No services running');
    }
    return;
  }

  const entries: StatusEntry[] = await Promise.all(
    runningServices.map(async ({ name, pane }): Promise<StatusEntry> => {
      const svc = getService(name);
      const port = svc.port;
      const isUp = port === 0 ? isPaneRunningCommand(sessionName, pane) : await probePort(port);
      const status: ServiceStatus = isUp ? 'up' : 'down';
      return {
        name,
        port,
        status,
        group: svc.group,
      };
    })
  );

  if (isJson) {
    const result = { session: sessionName, portOffset, services: entries };
    console.log(JSON.stringify(result));
    return;
  }

  const nameWidth = Math.max(...entries.map(e => e.name.length), 8);
  const portWidth = 6;
  console.log(`${'SERVICE'.padEnd(nameWidth)}  PORT    STATUS`);
  for (const e of entries) {
    const portStr = e.port > 0 ? `:${e.port}` : 'n/a';
    console.log(`${e.name.padEnd(nameWidth)}  ${portStr.padEnd(portWidth)}  ${e.status}`);
  }
}

async function cmdRestart(serviceName: string, repoRoot: string): Promise<void> {
  if (!services.has(serviceName)) {
    console.error(`Unknown service: ${serviceName}`);
    process.exit(1);
  }

  const svc = getService(serviceName);
  if (svc.type === 'infra') {
    console.error(`dev:restart does not support infrastructure service: ${serviceName}`);
    process.exit(1);
  }

  const sessionName = getSessionName();
  if (!sessionExists(sessionName)) {
    console.error('No dev session running');
    process.exit(1);
  }

  const pane = findServicePane(sessionName, serviceName);
  if (!pane) {
    console.error(`Service ${serviceName} is not running`);
    process.exit(1);
  }

  restartServiceInTmux(sessionName, serviceName);
  console.log(`Restarted ${serviceName}`);
}

async function cmdStop(repoRoot: string): Promise<void> {
  const sessionName = getSessionName();

  if (sessionExists(sessionName)) {
    killSession(sessionName);
    console.log(`Killed tmux session ${sessionName}`);
  }

  console.log('Stopping Docker infrastructure…');
  try {
    const [cmd, args] = buildInfraDownArgs();
    execFileSync(cmd, args, { cwd: repoRoot, stdio: 'inherit' });
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
  dev:status [--json]     Show running services and their ports
  dev:restart <service>   Restart a running service
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
    case 'status':
      await cmdStatus(repoRoot, args.includes('--json'));
      break;
    case 'restart': {
      const serviceName = args[1];
      if (!serviceName) {
        console.error('Usage: dev:restart <service>');
        process.exit(1);
      }
      await cmdRestart(serviceName, repoRoot);
      break;
    }
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
