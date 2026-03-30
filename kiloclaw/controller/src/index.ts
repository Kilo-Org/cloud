import http from 'node:http';
import { Duplex, Readable } from 'node:stream';
import { Hono } from 'hono';
import {
  DEFAULT_MAX_WS_CONNS,
  DEFAULT_WS_HANDSHAKE_TIMEOUT_MS,
  DEFAULT_WS_IDLE_TIMEOUT_MS,
  createHttpProxy,
  handleWebSocketUpgrade,
} from './proxy';
import { createSupervisor } from './supervisor';
import type { Supervisor } from './supervisor';
import { registerHealthRoute } from './routes/health';
import { registerGatewayRoutes } from './routes/gateway';
import { registerConfigRoutes } from './routes/config';
import { registerPairingRoutes } from './routes/pairing';
import { createPairingCache } from './pairing-cache';
import { registerEnvRoutes } from './routes/env';
import { registerGmailPushRoute } from './routes/gmail-push';
import { registerFileRoutes } from './routes/files';
import { registerKiloCliRunRoutes } from './routes/kilo-cli-run';
import { CONTROLLER_COMMIT, CONTROLLER_VERSION } from './version';
import { writeKiloCliConfig } from './kilo-cli-config';
import { writeGogCredentials } from './gog-credentials';
import { startWatchRenewal, stopWatchRenewal } from './gmail-watch-renewal';
import { bootstrap } from './bootstrap';
import type { ControllerStateRef, ControllerState } from './bootstrap';
import { getOpenclawVersion } from './openclaw-version';
import { startCheckin } from './checkin';
import { collectProductTelemetry } from './product-telemetry';

export type RuntimeConfig = {
  port: number;
  expectedToken: string;
  requireProxyToken: boolean;
  gatewayArgs: string[];
  wsIdleTimeoutMs: number;
  wsHandshakeTimeoutMs: number;
  maxWsConnections: number;
};

function parseBoolean(value: string | undefined): boolean {
  return (value ?? '').toLowerCase() === 'true';
}

function parseGatewayArgs(value: string | undefined): string[] {
  if (!value) {
    throw new Error('KILOCLAW_GATEWAY_ARGS is required');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error('KILOCLAW_GATEWAY_ARGS must be valid JSON');
  }
  if (!Array.isArray(parsed) || parsed.some(v => typeof v !== 'string')) {
    throw new Error('KILOCLAW_GATEWAY_ARGS must be a JSON array of strings');
  }
  return parsed;
}

function parsePositiveInt(value: string | undefined, fallback: number, label: string): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return parsed;
}

export function loadRuntimeConfig(env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  const expectedToken = env.OPENCLAW_GATEWAY_TOKEN;
  if (!expectedToken) {
    throw new Error('OPENCLAW_GATEWAY_TOKEN is required');
  }

  return {
    port: Number(env.PORT ?? 18789),
    expectedToken,
    requireProxyToken: parseBoolean(env.REQUIRE_PROXY_TOKEN),
    gatewayArgs: parseGatewayArgs(env.KILOCLAW_GATEWAY_ARGS),
    wsIdleTimeoutMs: parsePositiveInt(
      env.WS_IDLE_TIMEOUT_MS,
      DEFAULT_WS_IDLE_TIMEOUT_MS,
      'WS_IDLE_TIMEOUT_MS'
    ),
    wsHandshakeTimeoutMs: parsePositiveInt(
      env.WS_HANDSHAKE_TIMEOUT_MS,
      DEFAULT_WS_HANDSHAKE_TIMEOUT_MS,
      'WS_HANDSHAKE_TIMEOUT_MS'
    ),
    maxWsConnections: parsePositiveInt(env.MAX_WS_CONNS, DEFAULT_MAX_WS_CONNS, 'MAX_WS_CONNS'),
  };
}

async function handleHttpRequest(
  app: Hono,
  req: http.IncomingMessage,
  res: http.ServerResponse
): Promise<void> {
  const host = req.headers.host ?? 'localhost';
  const url = new URL(req.url ?? '/', `http://${host}`);
  const method = (req.method ?? 'GET').toUpperCase();

  const init: RequestInit & { duplex?: 'half' } = {
    method,
    headers: req.headers as HeadersInit,
  };
  if (method !== 'GET' && method !== 'HEAD') {
    init.body = req as unknown as ReadableStream<Uint8Array>;
    init.duplex = 'half';
  }

  const response = await app.fetch(new Request(url, init));
  res.statusCode = response.status;
  response.headers.forEach((value, key) => {
    res.setHeader(key, value);
  });

  if (!response.body) {
    res.end();
    return;
  }

  Readable.fromWeb(response.body as never).pipe(res);
}

/**
 * Build a public error string safe for the unauthenticated /_kilo/health endpoint.
 *
 * Raw error messages can contain secrets (execFileSync argv includes
 * --kilocode-api-key), filesystem paths, validation details, etc.
 * The full error is always logged to stdout for operators; this function
 * returns only a generic stage label for the health response.
 */
export function toPublicDegradedError(stage: string): string {
  return `Startup failed during ${stage}`;
}

/** Serialize a ControllerState to the health response JSON. */
function healthJson(state: ControllerState): string {
  if (state.state === 'bootstrapping') {
    return JSON.stringify({ status: 'ok', state: state.state, phase: state.phase });
  }
  if (state.state === 'degraded') {
    return JSON.stringify({ status: 'ok', state: state.state, error: state.error });
  }
  return JSON.stringify({ status: 'ok', state: state.state });
}

export async function startController(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  // Mutable state ref — read by the health endpoint on every request,
  // updated by bootstrap as it progresses through phases.
  const controllerState: ControllerStateRef = {
    current: { state: 'bootstrapping', phase: 'init' },
  };

  // ── Phase 1: Start HTTP server ──────────────────────────────────────
  // The server starts FIRST so /_kilo/health is always reachable, even
  // during bootstrap. During bootstrap, a lightweight inline handler
  // serves health probes directly. After bootstrap, the Hono app with
  // full routes takes over.
  let app: Hono | null = null;

  const server = http.createServer((req, res) => {
    // Once bootstrap has completed and the Hono app is ready, delegate all requests.
    if (app) {
      void handleHttpRequest(app, req, res).catch(error => {
        console.error('[controller] HTTP handler failed:', error);
        res.statusCode = 500;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ error: 'Internal Server Error' }));
      });
      return;
    }

    // Pre-bootstrap: serve health probes inline without Hono.
    // Strip query string so e.g. /_kilo/health?ts=123 still matches.
    const pathname = (req.url ?? '/').split('?')[0];
    if (pathname === '/_kilo/health' || pathname === '/health') {
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      if (pathname === '/health') {
        // Bare /health for Fly probes — no state details
        res.end(JSON.stringify({ status: 'ok' }));
      } else {
        res.end(healthJson(controllerState.current));
      }
      return;
    }

    // All other routes: 503 during bootstrap
    res.statusCode = 503;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ error: 'Service starting', state: controllerState.current.state }));
  });

  // Mutable ref for the WebSocket upgrade handler. Set once the Hono app and
  // supervisor are ready. Registered on the server early so connections during
  // bootstrap or degraded mode get a clean 503 rejection instead of hanging.
  const wsUpgradeRef: {
    handler: ((req: http.IncomingMessage, socket: Duplex, head: Buffer) => void) | null;
  } = { handler: null };

  server.on('upgrade', (req, socket, head) => {
    if (wsUpgradeRef.handler) {
      wsUpgradeRef.handler(req, socket, head);
      return;
    }
    // No handler ready — reject the upgrade cleanly.
    socket.write(
      'HTTP/1.1 503 Service Unavailable\r\n' +
        'Content-Type: application/json\r\n' +
        'Connection: close\r\n\r\n' +
        JSON.stringify({ error: 'Service starting', state: controllerState.current.state })
    );
    socket.destroy();
  });

  const initialPort = Number(env.PORT ?? 18789);
  await new Promise<void>(resolve => {
    server.listen(initialPort, '0.0.0.0', () => {
      console.log(`[controller] HTTP server listening on :${initialPort}, starting bootstrap...`);
      resolve();
    });
  });

  // Register shutdown handlers early so degraded mode can still be killed cleanly.
  let shuttingDown = false;
  let supervisor: Supervisor | undefined;
  let gmailWatchSupervisor: Supervisor | undefined;
  let pairingCache: ReturnType<typeof createPairingCache> | undefined;
  let stopCheckin: (() => void) | undefined;

  const onSignal = async (signal: NodeJS.Signals): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[controller] Received ${signal}, shutting down`);

    pairingCache?.cleanup();
    stopCheckin?.();
    stopWatchRenewal();
    const shutdowns: Promise<void>[] = [];
    if (supervisor) shutdowns.push(supervisor.shutdown(signal));
    if (gmailWatchSupervisor) shutdowns.push(gmailWatchSupervisor.shutdown(signal));
    await Promise.all(shutdowns);
    await new Promise<void>(resolve => {
      server.close(() => resolve());
    });
    process.exit(0);
  };

  process.on('SIGTERM', () => {
    void onSignal('SIGTERM').catch(err => {
      console.error('[controller] Shutdown failed:', err);
      process.exit(1);
    });
  });
  process.on('SIGINT', () => {
    void onSignal('SIGINT').catch(err => {
      console.error('[controller] Shutdown failed:', err);
      process.exit(1);
    });
  });

  // ── Phase 2: Bootstrap ──────────────────────────────────────────────
  // Decrypts env vars, sets up directories, applies feature flags, runs
  // onboard/doctor, patches config, builds gateway args. Updates
  // controllerState as it progresses through each phase.
  try {
    await bootstrap(env, phase => {
      controllerState.current = { state: 'bootstrapping', phase };
    });
  } catch (err) {
    const fullError = err instanceof Error ? err.message : String(err);
    controllerState.current = { state: 'degraded', error: toPublicDegradedError('bootstrap') };
    console.error('[controller] Bootstrap failed, running in degraded mode:', fullError);
    return; // HTTP server stays alive for health probes
  }

  // ── Phase 3: Load runtime config ────────────────────────────────────
  let config: RuntimeConfig;
  try {
    config = loadRuntimeConfig(env);
  } catch (err) {
    const fullError = err instanceof Error ? err.message : String(err);
    controllerState.current = { state: 'degraded', error: toPublicDegradedError('runtime-config') };
    console.error('[controller] Runtime config failed, running in degraded mode:', fullError);
    return;
  }

  // ── Phase 4: Best-effort pre-gateway setup ──────────────────────────
  try {
    writeKiloCliConfig(env as Record<string, string | undefined>);
  } catch (err) {
    console.error('[kilo-cli] Failed to write config:', err);
  }

  try {
    await writeGogCredentials(env as Record<string, string | undefined>);
  } catch (err) {
    console.error('[gog] Failed to write credentials:', err);
  }

  // ── Phase 5: Create supervisors and register routes ─────────────────
  // Routes are registered unconditionally so /_kilo/version, /_kilo/config/*,
  // and /_kilo/env/* are available even if the gateway fails to start.
  // The catch-all proxy returns 503 "Gateway not ready" when the supervisor
  // isn't running, which is the correct behavior for degraded mode.
  const pc = createPairingCache();
  pairingCache = pc;

  supervisor = createSupervisor({
    args: ['gateway', ...config.gatewayArgs],
    onStdoutLine: line => pc.onPairingLogLine(line),
  });

  let googleAccountEmail: string | null = null;
  const hasGogCredentials = Boolean(env.KILOCLAW_GOG_CONFIG_TARBALL);

  if (hasGogCredentials) {
    const email = env.KILOCLAW_GOOGLE_ACCOUNT_EMAIL;
    const hooksToken = env.KILOCLAW_HOOKS_TOKEN;
    if (!email || !hooksToken) {
      console.warn(
        `[controller] KILOCLAW_GOG_CONFIG_TARBALL present but missing: ${!email ? 'KILOCLAW_GOOGLE_ACCOUNT_EMAIL' : ''} ${!hooksToken ? 'KILOCLAW_HOOKS_TOKEN' : ''}, skipping gmail watch`
      );
    } else {
      googleAccountEmail = email;
      gmailWatchSupervisor = createSupervisor({
        command: 'gog',
        args: [
          'gmail',
          'watch',
          'serve',
          '--account',
          googleAccountEmail,
          '--bind',
          '127.0.0.1',
          '--port',
          '3002',
          '--path',
          '/gmail-pubsub',
          '--token',
          config.expectedToken,
          '--hook-url',
          `http://127.0.0.1:3001/hooks/gmail`,
          '--hook-token',
          hooksToken,
          '--include-body',
          '--max-bytes',
          '20000',
        ],
      });
    }
  }

  const honoApp = new Hono();
  registerHealthRoute(honoApp, supervisor, config.expectedToken, controllerState);
  registerGatewayRoutes(honoApp, supervisor, config.expectedToken);
  registerConfigRoutes(honoApp, supervisor, config.expectedToken);
  registerPairingRoutes(honoApp, pairingCache, config.expectedToken);
  registerEnvRoutes(honoApp, supervisor, config.expectedToken);
  registerGmailPushRoute(honoApp, gmailWatchSupervisor ?? null, config.expectedToken);
  registerFileRoutes(honoApp, config.expectedToken, '/root/.openclaw');
  registerKiloCliRunRoutes(honoApp, config.expectedToken);
  honoApp.all(
    '*',
    createHttpProxy({
      expectedToken: config.expectedToken,
      requireProxyToken: config.requireProxyToken,
      supervisor,
    })
  );

  // Activate the Hono app and WebSocket handler.
  app = honoApp;
  const wsState = { activeConnections: 0 };
  wsUpgradeRef.handler = (req, socket, head) => {
    handleWebSocketUpgrade(req, socket, head, {
      expectedToken: config.expectedToken,
      requireProxyToken: config.requireProxyToken,
      supervisor,
      wsIdleTimeoutMs: config.wsIdleTimeoutMs,
      wsHandshakeTimeoutMs: config.wsHandshakeTimeoutMs,
      maxWsConnections: config.maxWsConnections,
      wsState,
    });
  };

  // ── Phase 6: Start gateway ──────────────────────────────────────────
  controllerState.current = { state: 'starting' };
  console.log('[controller] Bootstrap complete, starting gateway...');

  try {
    await supervisor.start();
    pc.start();
    if (gmailWatchSupervisor && googleAccountEmail) {
      await gmailWatchSupervisor.start();
      startWatchRenewal(googleAccountEmail);
      console.log('[controller] Gmail watch process started');
    }

    controllerState.current = { state: 'ready' };

    stopCheckin = startCheckin({
      getApiKey: () => env.KILOCODE_API_KEY ?? '',
      getGatewayToken: () => config.expectedToken,
      getSandboxId: () => env.KILOCLAW_SANDBOX_ID ?? '',
      getCheckinUrl: () => env.KILOCLAW_CHECKIN_URL ?? '',
      getSupervisorStats: () => supervisor.getStats(),
      getOpenclawVersion,
      getProductTelemetry: openclawVersion => collectProductTelemetry(openclawVersion),
    });

    console.log(
      `[controller] Ready version=${CONTROLLER_VERSION} commit=${CONTROLLER_COMMIT} requireProxyToken=${config.requireProxyToken} wsIdleTimeoutMs=${config.wsIdleTimeoutMs} wsHandshakeTimeoutMs=${config.wsHandshakeTimeoutMs} maxWsConnections=${config.maxWsConnections}`
    );
  } catch (err) {
    const fullError = err instanceof Error ? err.message : String(err);
    controllerState.current = { state: 'degraded', error: toPublicDegradedError('gateway-start') };
    console.error('[controller] Gateway start failed, running in degraded mode:', fullError);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startController().catch(error => {
    console.error('[controller] Fatal startup error:', error);
    process.exit(1);
  });
}
